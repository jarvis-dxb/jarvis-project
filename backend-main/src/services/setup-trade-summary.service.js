import { waDb, ownedAccounts, ownedSetups, parse, runtime, symbolKey } from '../whatsapp/store.js';

const sideOf = value => ({ buy: 'long', sell: 'short' }[String(value).toLowerCase()] || String(value || '').toLowerCase());
const bucket = (account, symbol, side) => [account, symbolKey(symbol), sideOf(side)].join('|');
const real = event => !['sample', 'test', 'report'].includes(event.source);
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;

// Display-only attribution. Never infer a fill from a signal, or infer an open
// trade merely because a different strategy trades the same coin.
export function summarizeSetupTrades({ setups, accounts, events, positions = {}, coverage = {}, at = Date.now() }) {
    const owners = new Map(accounts.map(account => [account.id, account]));
    const summaries = Object.fromEntries(setups.map(setup => [setup.id, {
        running: [], blocked: [], closed: [], unverified: [], closedCount: 0, openedCount: 0, lastExecutionAt: null,
    }]));
    const entries = new Map(), latestAttempts = new Map(), closedAt = new Map();
    const rows = events.filter(event => real(event) && owners.has(event.account_id) && event.occurred_at <= at)
        .sort((a, b) => a.occurred_at - b.occurred_at);
    for (const event of rows) {
        const data = event.data || {}, symbol = symbolKey(data.symbol), side = sideOf(data.side);
        if (!symbol || !['long', 'short'].includes(side)) continue;
        const key = bucket(event.account_id, symbol, side);
        // A complete position closure covers every earlier entry in that
        // exchange position, including old merged entries from one strategy.
        if (event.source === 'exchange' && event.kind === 'trade_closed' && Number(data.remainingQuantity) === 0)
            closedAt.set(key, Math.max(closedAt.get(key) || 0, event.occurred_at));
        if (!summaries[event.setup_id]) continue;
        if (['order_accepted', 'order_failed'].includes(event.kind))
            latestAttempts.set([event.setup_id, event.account_id, symbol].join('|'), event);
        const isEntry = event.kind === 'order_accepted' && data.status === 'closed'
            || event.kind === 'trade_filled' && data.role === 'entry';
        if (!isEntry || !data.orderId || !positive(data.quantity)) continue;
        summaries[event.setup_id].lastExecutionAt = Math.max(summaries[event.setup_id].lastExecutionAt || 0, event.occurred_at);
        const orderKey = [event.account_id, symbol, data.orderId].join('|');
        let entry = entries.get(orderKey);
        if (!entry) {
            entry = { setupId: event.setup_id, accountId: event.account_id, account: owners.get(event.account_id).name,
                symbol, side, orderId: String(data.orderId), at: event.occurred_at, quantity: 0, price: Number(data.price), fills: new Map() };
            entries.set(orderKey, entry);
        }
        entry.at = Math.min(entry.at, event.occurred_at);
        if (event.kind === 'order_accepted') { entry.quantity = Math.max(entry.quantity, Number(data.quantity)); entry.price = Number(data.price); }
        else entry.fills.set(String(data.fillId || event.id), { quantity: Number(data.quantity), price: Number(data.price) });
    }
    for (const event of latestAttempts.values()) {
        if (event.kind !== 'order_failed') continue;
        summaries[event.setup_id].blocked.push({ symbol: symbolKey(event.data.symbol), accountId: event.account_id,
            account: owners.get(event.account_id).name, at: event.occurred_at,
            reason: event.data.error || 'The last entry attempt failed; no new trade was opened.' });
    }
    const pending = new Map();
    for (const entry of entries.values()) {
        const fills = [...entry.fills.values()], fillQuantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
        if (fillQuantity > entry.quantity) {
            entry.quantity = fillQuantity;
            entry.price = fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0) / fillQuantity;
        }
        const summary = summaries[entry.setupId], key = bucket(entry.accountId, entry.symbol, entry.side);
        summary.openedCount++;
        if ((closedAt.get(key) || 0) > entry.at) {
            summary.closed.push({ symbol: entry.symbol, accountId: entry.accountId, account: entry.account, orderId: entry.orderId });
            continue;
        }
        const group = pending.get(key) || []; group.push(entry); pending.set(key, group);
    }
    for (const [key, group] of pending) {
        const first = group[0], account = owners.get(first.accountId), receipt = coverage[first.accountId];
        const fresh = account.ping && account.apiKey && account.apiSecret && receipt?.complete === true
            && Number(receipt.at) <= at && at - Number(receipt.at) < 120000;
        const snapshot = Object.values(positions).find(position => bucket(position.accountId, position.symbol, position.side) === key);
        const quantity = snapshot ? Number(snapshot.contracts) : 0;
        const observed = fresh && Number(receipt.at) >= Math.max(...group.map(entry => entry.at)) && Number.isFinite(quantity);
        if (observed && quantity === 0) {
            for (const entry of group) summaries[entry.setupId].closed.push({ symbol: entry.symbol, accountId: entry.accountId, account: entry.account, orderId: entry.orderId });
            continue;
        }
        const recorded = group.reduce((sum, entry) => sum + entry.quantity, 0);
        const average = group.reduce((sum, entry) => sum + entry.price * entry.quantity, 0) / recorded;
        const uniqueSetup = new Set(group.map(entry => entry.setupId)).size === 1;
        const matches = observed && quantity > 0 && uniqueSetup
            && Math.abs(recorded - quantity) <= Math.max(1e-8, quantity * 1e-7)
            && Number.isFinite(average) && positive(snapshot.entryPrice)
            && Math.abs(average - Number(snapshot.entryPrice)) <= Math.max(1e-8, average * 1e-7);
        for (const setupId of new Set(group.map(entry => entry.setupId))) {
            const item = { symbol: first.symbol, accountId: first.accountId, account: first.account };
            if (matches) summaries[setupId].running.push(item);
            else summaries[setupId].unverified.push({ ...item, reason: !observed
                ? 'Waiting for a fresh complete exchange position snapshot.'
                : 'The exchange position is shared or differs from recorded entries; strategy ownership needs verification.' });
        }
    }
    for (const summary of Object.values(summaries)) summary.closedCount = summary.closed.length;
    return { at, setups: summaries };
}

export async function setupTradeSummary(userId) {
    const [setups, accounts] = await Promise.all([ownedSetups(userId), ownedAccounts(userId)]);
    const events = waDb.prepare(`SELECT id,kind,account_id,setup_id,source,occurred_at,data_json FROM jarvis_trade_events
        WHERE user_id=? AND kind IN ('order_accepted','order_failed','trade_filled','trade_closed') ORDER BY occurred_at,rowid`)
        .all(userId).map(row => ({ ...row, data: parse(row.data_json) }));
    return summarizeSetupTrades({ setups, accounts, events, positions: runtime('positions:' + userId),
        coverage: Object.fromEntries(accounts.map(account => [account.id, runtime('position-snapshot:' + account.id)])) });
}
