import { createHash } from 'node:crypto';
import { brokerManager } from '../brokers/index.js';
import { getUserAccountsByUserId } from './user.account.service.js';

const locks = new Map();
export async function acquireEntryLock(account, symbol) {
    const key = [account.exchangeType, account.network,
        createHash('sha256').update(account.apiKey || '').digest('hex'), symbol].join(':');
    const previous = locks.get(key) || Promise.resolve();
    let unlock;
    const held = new Promise(resolve => { unlock = resolve; });
    const tail = previous.then(() => held);
    locks.set(key, tail);
    await previous;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        unlock();
        if (locks.get(key) === tail) locks.delete(key);
    };
}

export class EntryIsolationError extends Error {
    constructor(message, code = 'ENTRY_CONFLICT') {
        super(message); this.name = 'EntryIsolationError'; this.code = code;
    }
}

// Read-only. Never cancel, resize or replace someone else's position or exits.
export async function checkBinanceEntryIsolation(exchange, symbol, side) {
    let mode, state, regular, conditional;
    try {
        mode = await exchange.fetchPositionMode();
        [state, regular, conditional] = await Promise.all([
            exchange.fapiPrivateV2GetAccount(),
            exchange.fapiPrivateGetOpenOrders({ symbol }),
            exchange.fapiPrivateGetOpenAlgoOrders({ symbol }),
        ]);
        if (!Array.isArray(state?.positions) || !Array.isArray(regular) || !Array.isArray(conditional)) throw Error();
    } catch {
        throw new EntryIsolationError(`Cannot verify ${symbol} positions and pending exits; no new order was placed.`, 'STATE_UNAVAILABLE');
    }
    const hedged = mode?.hedged === true || mode?.positionMode === 'hedge'
        || mode?.info?.dualSidePosition === true || mode?.info?.dualSidePosition === 'true';
    const oneWay = mode?.hedged === false || mode?.positionMode === 'oneway'
        || mode?.info?.dualSidePosition === false || mode?.info?.dualSidePosition === 'false';
    if (!hedged && !oneWay) throw new EntryIsolationError(`Cannot verify ${symbol} position mode; no new order was placed.`, 'STATE_UNAVAILABLE');
    const positionSide = hedged ? side.toUpperCase() : 'BOTH';
    const relevant = item => item.symbol === symbol && (!hedged || !item.positionSide
        || item.positionSide === 'BOTH' || item.positionSide === positionSide);
    const positions = state.positions.filter(relevant);
    for (const position of positions) {
        const amount = Number(position.positionAmt);
        if (!Number.isFinite(amount)) throw new EntryIsolationError(`Cannot verify ${symbol} quantity; no new order was placed.`, 'STATE_UNAVAILABLE');
        if (amount !== 0) {
            const opposite = !hedged && ((side === 'long' && amount < 0) || (side === 'short' && amount > 0));
            throw new EntryIsolationError(`${opposite ? 'An opposite' : 'An existing'} ${symbol} position is open${hedged ? ' on ' + positionSide : ' in One-way mode'}; no new order was placed. Existing positions and TP/SL are unchanged.`);
        }
    }
    if ([...regular, ...conditional].some(relevant)) {
        throw new EntryIsolationError(`${symbol} has pending orders or TP/SL; no new order was placed. Existing orders are unchanged.`);
    }
    return { hedged, positionSide };
}

export async function preflightApprovedEntries(setup) {
    const accounts = await getUserAccountsByUserId(setup.userId);
    const conflicts = [];
    for (const accountId of setup.accounts || []) {
        const account = accounts.find(a => a.id === accountId);
        if (!account || !account.ping || !account.apiKey || !account.apiSecret) {
            return { ok: false, status: 409, message: 'Selected account is not connected; no order was placed.' };
        }
        if (account.exchangeType !== 'binance') continue;
        const exchange = brokerManager._getExchangeInstance('binance', { apiKey: account.apiKey, apiSecret: account.apiSecret }, account.network === 'testnet');
        for (const raw of [].concat(setup.tradingSymbol || [])) {
            const symbol = raw.replace(/^\w+:/, '').replace(/\.[PS]$/, '').replace('/', '').replace(/:USDT$/, '');
            try { await checkBinanceEntryIsolation(exchange, symbol, setup.side.toLowerCase()); }
            catch (error) {
                if (!(error instanceof EntryIsolationError) || error.code === 'STATE_UNAVAILABLE') {
                    return { ok: false, status: 503, message: `Could not verify ${symbol} protection state; no orders were placed.` };
                }
                conflicts.push({ accountId, symbol, reason: error.message });
            }
        }
    }
    return conflicts.length ? { ok: false, status: 409, conflicts,
        message: 'Trade blocked before entry: ' + conflicts.map(c => c.reason).join(' ') }
        : { ok: true };
}
