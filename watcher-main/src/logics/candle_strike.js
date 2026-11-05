import { closedStreak, lastClosedIndex, candleTime, normalizeInterval } from './market-utils.js';
const history = new Map();
export const checkCandleStrike = (setup, candles) => {
    if (!setup?.id || !Array.isArray(candles) || !candles.length) return false;
    const count = Number(setup.candleRange), color = setup.candleColor?.toLowerCase();
    if (!Number.isInteger(count) || count < 1 || !['red', 'green'].includes(color)) return false;
    const index = lastClosedIndex(candles), time = candleTime(candles[index]?.time);
    if (index < 0 || !time) return false;
    const signature = [setup.triggerSymbol, normalizeInterval(setup.timeframe), count, color].join('|');
    const previous = history.get(setup.id);
    const lastTriggered = previous?.signature === signature ? previous.time : 0;
    if (time <= Math.max(lastTriggered || 0, candleTime(setup.lastSignalCandleAt) || 0)) return false;
    if (closedStreak(candles, color, index) < count) return false;
    history.set(setup.id, { signature, time });
    if (history.size > 10000) history.delete(history.keys().next().value);
    return true;
};
