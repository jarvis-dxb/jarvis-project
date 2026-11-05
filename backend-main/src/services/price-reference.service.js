import { db } from '../config/sqlite.js';
import { normalizeInterval } from '../../../watcher-main/src/logics/market-utils.js';

export const usesResettingReference = setup => setup?.logicType === 'price_movement' && setup.resetReferenceOnTrigger === true;

// Call only for a confirmed automatic/monitoring signal, never for a manual
// Execute click or a raw check suppressed by the monitoring alert gate.
export function resetPriceReferenceOnTrigger(setup, datasource) {
    if (!usesResettingReference(setup)) return true;
    const price = Number(datasource?.data?.at(-1)?.close), at = Date.now();
    if (!Number.isFinite(price) || price <= 0 || !datasource.eventTime ||
        at - datasource.eventTime > 60000 || datasource.eventTime > at + 5000 ||
        datasource.symbol !== setup.triggerSymbol ||
        normalizeInterval(datasource.interval) !== normalizeInterval(setup.timeframe)) return false;
    const fields = ['userId', 'logicType', 'resetReferenceOnTrigger', 'watchPrice', 'triggerSymbol',
        'timeframe', 'usdChange', 'direction', 'countdown', 'repeatCounter', 'triggeredCounter', 'accounts'];
    return db.collection('setups').doc(setup.id).updateIf({
        watchPrice: price,
        priceReferenceResetAt: at,
        priceReferencePrevious: setup.watchPrice ?? null,
    }, saved => !saved.isCompleted && !saved.watcherPaused && fields.every(key =>
        JSON.stringify(saved[key]) === JSON.stringify(setup[key])));
}
