// Explicitly invoked demo-only smoke test; never run as part of npm test.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../src/config/sqlite.js';
import { binance } from '../src/brokers/binance.js';
import { executeMarketOrder } from '../src/services/exchange.service.js';

if (!process.argv.includes('--run-demo-smoke')) throw Error('Requires --run-demo-smoke');
const reportIndex = process.argv.indexOf('--report');
if (reportIndex < 0) throw Error('An absolute --report path is required');
const reportPath = process.argv[reportIndex + 1];
if (!reportPath || !path.isAbsolute(reportPath)) throw Error('An absolute --report path is required');
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const side = option('--side', 'long');
const tp = Number(option('--tp-pnl', '0.05'));
const sl = Number(option('--sl-pnl', '0.05'));
if (!['long', 'short'].includes(side) || !(tp > 0 && tp <= 2) || !(sl > 0 && sl <= 2)) throw Error('Invalid bounded demo test options');
const accountDoc = await db.collection('userAccounts').doc('local-demo-account').get();
const account = accountDoc.data();
const controls = (await db.collection('watcherControls').doc(account.userId).get()).data();
if (account.network !== 'testnet' || account.exchangeType !== 'binance' || !controls?.monitorOnly
    || !account.ping || !account.apiKey || !account.apiSecret) {
    throw Error('Requires Binance Testnet account with saved strategies in monitoring mode');
}
const credentials = { apiKey: account.apiKey, apiSecret: account.apiSecret };
const sanitize = value => String(value).replaceAll(credentials.apiKey, '[key]').replaceAll(credentials.apiSecret, '[secret]')
    .replace(/signature=[^&\s"]+/g, 'signature=[redacted]');
for (const method of ['log', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(...args.map(value => typeof value === 'string' ? sanitize(value) : value));
}
const exchange = binance.getExchange(credentials, true);
if (!new URL(exchange.urls.api.fapiPrivate).hostname.startsWith('demo-fapi.')) throw Error('Non-demo endpoint blocked');
const beforeSetups = await db.collection('setups').get();
const hashes = snapshot => Object.fromEntries(snapshot.docs.map(doc => [doc.id, crypto.createHash('sha256').update(JSON.stringify(doc.data())).digest('hex')]));
const beforeHashes = hashes(beforeSetups);
const symbol = 'BTC/USDT:USDT';
const rawSymbol = 'BTCUSDT';
const report = { demoOnly: true, side, startedAt: new Date().toISOString(), endpoint: exchange.urls.api.fapiPrivate,
    orders: {}, cleanup: {}, savedStrategies: beforeSetups.docs.length };
let priorLeverage;
let safeToClean = false;
const algoIds = [];
const accountState = () => exchange.fapiPrivateV2GetAccount();
const btcPositions = state => state.positions.filter(p => p.symbol === rawSymbol && Number(p.positionAmt) !== 0);
const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
try {
    const state = await accountState();
    if (btcPositions(state).length) throw Error('Existing BTC position: test will not touch it');
    if ((await exchange.fapiPrivateGetOpenOrders({ symbol: rawSymbol })).length
        || (await exchange.fapiPrivateGetOpenAlgoOrders({ symbol: rawSymbol })).length) {
        throw Error('Existing BTC orders: test will not touch them');
    }
    if (Number(state.assets.find(a => a.asset === 'USDT')?.availableBalance) < 300) throw Error('Insufficient virtual USDT');
    priorLeverage = Number(state.positions.find(p => p.symbol === rawSymbol)?.leverage);
    safeToClean = true;
    report.initialWalletBalance = Number(state.assets.find(a => a.asset === 'USDT')?.walletBalance);
    const [result] = await executeMarketOrder({ userId: account.userId, accounts: [accountDoc.id],
        tradingSymbol: ['BINANCE:BTCUSDT.P'], side, margin: 200, leverage: 1,
        TP: tp, TP_mode: 'pnl', SL: sl, SL_mode: 'pnl' });
    if (!result?.success) throw Error(result?.error || 'Entry failed');
    report.orders.entry = { id: result.order.id, status: result.order.status, average: result.order.average, filled: result.order.filled };
    for (const [role, order] of [['sl', result.slOrder], ['tp', result.tpOrder]]) {
        if (!order?.id) continue;
        algoIds.push(String(order.id));
        const verified = await exchange.fapiPrivateGetAlgoOrder({ algoId: order.id });
        report.orders[role] = { id: String(order.id), status: verified.algoStatus, type: verified.orderType,
            triggerPrice: Number(verified.triggerPrice), side: verified.side, closePosition: verified.closePosition };
    }
    report.protectionComplete = result.protectionComplete;
    if (!result.protectionComplete || algoIds.length !== 2) throw Error('TP/SL incomplete: ' + (result.slError || result.tpError || 'missing orders'));
    const correctlyDirected = side === 'long'
        ? report.orders.sl.triggerPrice < report.orders.entry.average && report.orders.tp.triggerPrice > report.orders.entry.average
        : report.orders.sl.triggerPrice > report.orders.entry.average && report.orders.tp.triggerPrice < report.orders.entry.average;
    if (!correctlyDirected) {
        throw Error('Exit levels were not on correct sides of the actual fill');
    }
    save();
    console.log(JSON.stringify({ stage: 'entry-and-exits-verified', ...report.orders }));
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
        const current = await accountState();
        if (!btcPositions(current).length) break;
        await new Promise(resolve => setTimeout(resolve, 2500));
    }
    for (const id of algoIds) {
        const latest = await exchange.fapiPrivateGetAlgoOrder({ algoId: id });
        const role = report.orders.sl.id === id ? 'sl' : 'tp';
        report.orders[role].finalStatus = latest.algoStatus;
        report.orders[role].actualOrderId = latest.actualOrderId;
        if (latest.actualOrderId && String(latest.actualOrderId) !== '0') {
            const filled = await exchange.fapiPrivateGetOrder({ symbol: rawSymbol, orderId: latest.actualOrderId });
            report.orders[role].executionStatus = filled.status;
            report.orders[role].executedQty = Number(filled.executedQty);
        }
    }
    report.passed = true;
} catch (error) {
    report.passed = false;
    report.error = sanitize(error.message);
} finally {
    if (safeToClean) {
        // No pre-existing BTC position/orders existed. Cancel only this run's exits.
        for (const id of algoIds) {
            try {
                const current = await exchange.fapiPrivateGetAlgoOrder({ algoId: id });
                if (current.algoStatus === 'NEW') await exchange.fapiPrivateDeleteAlgoOrder({ algoId: id });
            } catch (error) { report.cleanup['algo-' + id] = sanitize(error.message); }
        }
        try {
            const remaining = btcPositions(await accountState());
            for (const position of remaining) {
                const amount = Number(position.positionAmt);
                const params = { newOrderRespType: 'RESULT' };
                if (position.positionSide && position.positionSide !== 'BOTH') params.positionSide = position.positionSide;
                else params.reduceOnly = true;
                const close = await binance.createOrder(credentials, true, symbol, amount > 0 ? 'sell' : 'buy',
                    'market', Math.abs(amount), undefined, params);
                report.cleanup.closeOrder = { id: close.id, status: close.status, filled: close.filled };
            }
            if (Number.isInteger(priorLeverage) && priorLeverage > 0) await binance.setLeverage(credentials, true, priorLeverage, symbol);
            const final = await accountState();
            report.cleanup.openPositions = btcPositions(final).length;
            report.cleanup.openOrders = (await exchange.fapiPrivateGetOpenOrders({ symbol: rawSymbol })).length;
            report.cleanup.openAlgoOrders = (await exchange.fapiPrivateGetOpenAlgoOrders({ symbol: rawSymbol })).length;
            report.finalWalletBalance = Number(final.assets.find(a => a.asset === 'USDT')?.walletBalance);
        } catch (error) { report.cleanup.error = sanitize(error.message); report.passed = false; }
    }
    report.strategySettingsUnchanged = JSON.stringify(beforeHashes) === JSON.stringify(hashes(await db.collection('setups').get()));
    report.monitorOnly = (await db.collection('watcherControls').doc(account.userId).get()).data()?.monitorOnly;
    report.finishedAt = new Date().toISOString();
    save();
    console.log(JSON.stringify(report));
    if (!report.passed || report.cleanup.openPositions || report.cleanup.openAlgoOrders || report.cleanup.openOrders) process.exitCode = 1;
}
