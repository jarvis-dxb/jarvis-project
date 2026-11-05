const history = new Map();

/**
 * RSI Logic
 * Trigger when the RSI crossover or crossdown a certain rsi value
 *
 * @param {Object} setup - Firebase setup object
 * @param {Object} lastBar - Object having isLastBar: true
 * @returns {Boolean} - true if rsi crossover or crossdown, false otherwise
 */
export const checkRSI = (setup, lastBar) => {
    if (!lastBar.indicators || !setup.indicators) return false;

    const historyId = setup.id;
    const { triggerSymbol, timeframe, indicators, side, leverage } = setup;

    const rsiKey = 'Relative Strength Index (14)';
    const setupRSI = parseFloat(indicators[rsiKey]);
    const incomingRSI = parseFloat(lastBar.indicators[rsiKey]);

    // 0. Validation: Agar RSI data nahi hai to skip karein
    if (isNaN(incomingRSI)) return false;

    // 1. Pehle se save shuda RSI value uthao (history se)
    const prevRSI = history.get(historyId);

    // 2. Optimization: Agar value same hai to skip karein (log spam se bachne ke liye)
    // toFixed(4) use kiya hai taaki minor floating point differences ignore ho sakein
    if (prevRSI !== undefined && prevRSI.toFixed(4) === incomingRSI.toFixed(4)) {
        return false;
    }

    // DEBUG: Logs to see what's happening (only when value changes)
    console.log(`[RSI Logic] Checking ${triggerSymbol} (${timeframe}) | Target: ${setupRSI} | Prev: ${prevRSI?.toFixed(2) || '-'} | Live: ${incomingRSI.toFixed(2)} | ${side} ${leverage}x`);

    // 3. Current value ko save karna (yehi value next update mein prevRSI banegi)
    history.set(historyId, incomingRSI);

    // Agar pichla data nahi hai to crossover check nahi ho sakta
    if (prevRSI === undefined) {
        console.log(`[RSI Logic] Initializing first RSI point for ${triggerSymbol}...`);
        return false;
    }

    // Crossover check
    if (side.toLowerCase() === "long") {
        // Pehle incomingRSI setupRSI se niche thi, ab upar ya barabar hai
        if (prevRSI < setupRSI && incomingRSI >= setupRSI) {
            history.delete(historyId);
            return true;
        }
    }

    // Crossdown check
    if (side.toLowerCase() === "short") {
        // Pehle incomingRSI setupRSI se upar thi, ab niche ya barabar hai
        if (prevRSI > setupRSI && incomingRSI <= setupRSI) {
            history.delete(historyId);
            return true;
        }
    }

    return false;
};
