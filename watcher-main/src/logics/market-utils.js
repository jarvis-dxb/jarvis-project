const intervals = { '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m', '60': '1h', '120': '2h', '240': '4h', '360': '6h', '480': '8h', '720': '12h', '1d': '1d', '1w': '1w' };
export function normalizeInterval(value) {
    const key = String(value ?? '').toLowerCase();
    return intervals[key] || (Object.values(intervals).includes(key) ? key : null);
}
export const candleTime = value => {
    const time = Number(value);
    return Number.isFinite(time) && time > 0 ? (time < 1e12 ? time * 1000 : time) : null;
};
export const candleColor = bar => {
    const open = Number(bar?.open), close = Number(bar?.close);
    if (!Number.isFinite(open) || !Number.isFinite(close)) return null;
    return close > open ? 'green' : close < open ? 'red' : 'neutral';
};
export function lastClosedIndex(candles) {
    const live = candles.findLastIndex(bar => bar.isLastBar === true || bar.isBarClosed === false);
    if (live >= 0) return live - 1;
    return candles.at(-1)?.isBarClosed === true ? candles.length - 1 : candles.length - 2;
}
export function closedStreak(candles, color, index = lastClosedIndex(candles)) {
    let count = 0;
    for (let i = index; i >= 0; i--) {
        if (candles[i].isBarClosed === false || candleColor(candles[i]) !== color) break;
        count++;
    }
    return count;
}
export function withIndicators(bars, period = 14) {
    let gain = 0, loss = 0;
    return bars.map((bar, index) => {
        const indicators = { Volume: bar.volume };
        if (index > 0) {
            const change = bar.close - bars[index - 1].close;
            if (index <= period) { gain += Math.max(0, change) / period; loss += Math.max(0, -change) / period; }
            else { gain = (gain * (period - 1) + Math.max(0, change)) / period; loss = (loss * (period - 1) + Math.max(0, -change)) / period; }
            if (index >= period) indicators['Relative Strength Index (14)'] = gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
        }
        return { ...bar, indicators };
    });
}
