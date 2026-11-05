import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processSetups } from '../watcher-main/src/services/process.js';

const boundary = Math.floor(Date.now() / 60_000) * 60_000;
const setup = {
    id: 'closed-price-movement',
    logicType: 'price_movement',
    triggerSymbol: 'BINANCE:BTCUSDT.P',
    timeframe: '1',
    direction: 'up',
    usdChange: '50',
    watchPrice: 80_000,
    resetReferenceOnTrigger: false,
};
const closed = { time: boundary - 60_000, closeTime: boundary - 1, open: '79591.2', close: '79641.2', isBarClosed: true };
const feed = { symbol: setup.triggerSymbol, interval: '1m', eventTime: Date.now() };

test('price movement matches the closed candle body once, independently of watchPrice', () => {
    assert.deepEqual(processSetups([setup], { ...feed, data: [{ ...closed, isBarClosed: false }] }), []);
    assert.deepEqual(processSetups([setup], { ...feed, data: [closed] }), []);
    assert.deepEqual(processSetups([setup], { ...feed, closedBarTime: closed.time, data: [{ ...closed, close: '79641.19' }] }), []);
    const closeEvent = { ...feed, closedBarTime: closed.time, data: [closed] };
    assert.deepEqual(processSetups([setup], closeEvent), [setup]);
    assert.deepEqual(processSetups([setup], closeEvent), []);
    assert.deepEqual(processSetups([{ ...setup, id: 'persisted', lastSignalCandleAt: closed.time }], closeEvent), []);
    assert.deepEqual(processSetups([{ ...setup, id: 'new', createdAt: new Date(boundary).toISOString() }], closeEvent), []);
});

test('reference-reset mode retains live price comparisons', () => {
    const live = { ...setup, id: 'live-reference', resetReferenceOnTrigger: true, watchPrice: 79591.2 };
    assert.deepEqual(processSetups([live], { ...feed, data: [{ ...closed, isBarClosed: false }] }), [live]);
});
