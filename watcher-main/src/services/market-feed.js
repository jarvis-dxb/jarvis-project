import { EventEmitter } from 'node:events';
import { normalizeInterval, withIndicators } from '../logics/market-utils.js';

export const dataFeed = new EventEmitter();
const cleanSymbol = value => /^BINANCE:[A-Z0-9]+USDT\.P$/.test(value || '') ? value.slice(8, -2) : null;
export function streamKeys(setups) {
    return [...new Set(setups.filter(s => !s.isCompleted && !s.watcherPaused).map(s => {
        const symbol = cleanSymbol(s.triggerSymbol), interval = normalizeInterval(s.timeframe);
        return symbol && interval ? `${symbol.toLowerCase()}@kline_${interval}` : null;
    }).filter(Boolean))].sort();
}
export function restBar(row, now = Date.now()) {
    return { time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), closeTime: Number(row[6]), isBarClosed: Number(row[6]) < now, isLastBar: Number(row[6]) >= now };
}
export function mergeBars(history, incoming) {
    const bars = new Map(history.map(b => [b.time, b]));
    for (const bar of incoming) {
        if (!(bar.time > 0 && bar.open > 0 && bar.close > 0 && Number.isFinite(bar.volume) && bar.volume >= 0)) continue;
        const existing = bars.get(bar.time);
        if (existing?.isBarClosed && !bar.isBarClosed) continue;
        bars.set(bar.time, bar);
    }
    return [...bars.values()].sort((a,b) => a.time - b.time).slice(-240);
}

// Only saved Binance symbol/timeframe pairs are streamed. REST is used for initial
// history and gap recovery, never for per-tick polling. No credentials are needed.
export async function launchMarketFeed({ getSetups, onData = value => dataFeed.emit('incoming-data', JSON.stringify(value)), fetcher = globalThis.fetch, socketFactory = url => new WebSocket(url), now = Date.now, restBase = 'https://fapi.binance.com', wsBase = 'wss://fstream.binance.com/market/stream' }) {
    let stopped = false, socket = null, version = 0, signature = '', reconnectTimer, reconnectDelay = 1000, reconnectAt = 0, restCooldownUntil = 0, lastError = null, unsupported = 0;
    const states = new Map(), controllers = new Set();
    const send = (key, closedBarTime) => {
        const state = states.get(key);
        if (!state?.seeded || !state.eventTime || now() - state.eventTime > 60000 || now() - state.receivedAt > 30000) return;
        onData({ symbol: `BINANCE:${state.symbol}.P`, interval: state.interval, eventTime: state.eventTime, receivedAt: state.receivedAt, source: 'binance-kline', closedBarTime, data: withIndicators(state.bars) });
    };
    const seed = async key => {
        const state = states.get(key);
        if (!state || state.seeding || now() < restCooldownUntil || now() - state.seedAttempt < 60000) return;
        state.seeding = true; state.seedAttempt = now();
        const controller = new AbortController(); controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetcher(`${restBase}/fapi/v1/klines?symbol=${state.symbol}&interval=${state.interval}&limit=200`, { signal: controller.signal });
            if (!response.ok) {
                const message = (await response.text()).slice(0,300);
                if ([418,429].includes(response.status)) {
                    const seconds = Number(response.headers.get('retry-after'));
                    const until = Number(message.match(/until\s+(\d{13})/i)?.[1]);
                    restCooldownUntil = Math.max(now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60000), until || 0);
                }
                throw new Error(`History request failed (HTTP ${response.status}); retry is delayed`);
            }
            const rows = await response.json();
            if (!Array.isArray(rows) || !rows.length) throw new Error('No candle history received');
            if (stopped || states.get(key) !== state) return;
            // Updates arriving while REST is in flight win over its older snapshot.
            state.bars = mergeBars(rows.map(row => restBar(row, now())), state.bars);
            state.seeded = state.bars.length >= state.minBars; state.recovering = false;
            if (state.seeded) { lastError = null; send(key); }
        } catch (error) { if (!stopped) lastError = error.message; }
        finally { clearTimeout(timeout); controllers.delete(controller); state.seeding = false; }
    };
    const detach = () => { version++; const old = socket; socket = null; old?.close(); };
    const scheduleReconnect = () => {
        if (stopped || reconnectTimer || !states.size) return;
        reconnectAt = now() + reconnectDelay;
        reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
        reconnectDelay = Math.min(60000, reconnectDelay * 2);
    };
    const connect = () => {
        if (stopped || !states.size) return;
        reconnectAt = now();
        detach(); const generation = version;
        try {
            socket = socketFactory(`${wsBase}?streams=${[...states.keys()].join('/')}`);
            socket.addEventListener('message', event => {
                if (stopped || generation !== version) return;
                try {
                    const payload = JSON.parse(String(event.data)), data = payload.data || payload, k = data.k;
                    if (data.e !== 'kline' || !k || !Number.isFinite(Number(data.E)) || Math.abs(now() - Number(data.E)) > 60000) return;
                    const key = `${String(k.s).toLowerCase()}@kline_${k.i}`, state = states.get(key);
                    if (!state || k.s !== state.symbol || k.i !== state.interval || Number(data.E) < state.eventTime) return;
                    const bar = { time: Number(k.t), closeTime: Number(k.T), open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v), isBarClosed: k.x === true, isLastBar: k.x !== true };
                    if (!(bar.time > 0 && bar.open > 0 && bar.close > 0 && Number.isFinite(bar.volume) && bar.volume >= 0)) return;
                    const previousBar=state.bars.at(-1);
                    const missedClose=previousBar && bar.time>previousBar.time && previousBar.isBarClosed===false;
                    state.bars = mergeBars(state.bars, [bar]); state.eventTime = Number(data.E); state.receivedAt = now();
                    reconnectDelay = 1000; lastError = null;
                    if (missedClose) { state.seeded=false; state.recovering=true; void seed(key); }
                    else if (!state.recovering && state.bars.length >= state.minBars) state.seeded = true;
                    send(key, bar.isBarClosed ? bar.time : undefined);
                } catch { /* Ignore malformed packets, without marking the feed healthy. */ }
            });
            socket.addEventListener('close', () => { if (generation === version) scheduleReconnect(); });
            socket.addEventListener('error', () => { if (generation === version) { lastError = 'Market stream disconnected; reconnecting'; detach(); scheduleReconnect(); } });
            for (const key of states.keys()) void seed(key);
        } catch (error) { lastError = error.message; scheduleReconnect(); }
    };
    let refreshing = false;
    const refresh = async () => {
        if (stopped || refreshing) return;
        refreshing = true;
        try {
            const setups = await getSetups();
            if (stopped) return;
            const keys = streamKeys(setups), next = keys.join('/');
            unsupported = setups.filter(s=>!cleanSymbol(s.triggerSymbol)||!normalizeInterval(s.timeframe)).length;
            if (next !== signature) {
                signature = next;
                for (const key of states.keys()) if (!keys.includes(key)) states.delete(key);
                for (const key of keys) {
                    if (states.has(key)) continue;
                    const [symbol, interval] = key.split('@kline_');
                    const relevant = setups.filter(s => cleanSymbol(s.triggerSymbol)?.toLowerCase() === symbol && normalizeInterval(s.timeframe) === interval);
                    const minBars = Math.max(1, ...relevant.map(s => s.logicType === 'rsi' ? 15 : s.logicType === 'candle_strike' ? Number(s.candleRange || 1) + 1 : 1));
                    states.set(key, { symbol: symbol.toUpperCase(), interval, minBars, bars: [], seeded: false, seedAttempt: -Infinity, receivedAt: 0, eventTime: 0 });
                }
                clearTimeout(reconnectTimer); reconnectTimer = null; detach(); if (states.size) connect();
            }
            for (const [key,state] of states) if (!state.seeded) void seed(key);
            if (states.size && !reconnectTimer && [...states.values()].some(s => now() - (s.receivedAt || reconnectAt) > 30000)) { lastError = 'Market data is stale; reconnecting'; detach(); scheduleReconnect(); }
        } finally { refreshing = false; }
    };
    await refresh();
    const timer = setInterval(() => { void refresh().catch(error => { lastError = error.message; }); }, 5000);
    return {
        health() {
            const fresh = [...states.values()].filter(s => s.seeded && now() - s.receivedAt <= 30000 && now() - s.eventTime <= 60000).length;
            return { healthy: fresh === states.size && !unsupported, streams: states.size, freshStreams: fresh, unsupported, lastMarketAt: Math.max(0,...[...states.values()].map(s => s.receivedAt)), error: unsupported?'Unsupported trigger symbol or timeframe':lastError || (fresh < states.size ? 'Waiting for fresh candle data' : null), source: 'binance-kline' };
        },
        async stop() { stopped = true; clearInterval(timer); clearTimeout(reconnectTimer); for (const c of controllers) c.abort(); detach(); states.clear(); },
    };
}
