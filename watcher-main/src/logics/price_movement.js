import chalk from 'chalk';
import Big from 'big.js';

export const usesClosedPriceMovement = setup =>
    setup?.logicType?.toLowerCase() === 'price_movement' && setup.resetReferenceOnTrigger === false;

/**
 * Price Movement Logic
 * Compare a closed candle body, or use the saved live reference in reset mode.
 * 
 * @param {Object} setup - Firebase setup object (usdChange, direction, watchPrice)
 * @param {Object} lastBar - Live candle object (open, close, time)
 * @returns {Boolean} - true if movement condition met, false otherwise
 */
export const checkPriceMovement = (setup, lastBar) => {
    if (!lastBar || !setup) return false;

    const { triggerSymbol, timeframe, usdChange, direction, watchPrice } = setup;

    const threshold = parseFloat(usdChange);
    const open = parseFloat(lastBar.open);
    const close = parseFloat(lastBar.close);
    const refPrice = parseFloat(watchPrice);

    if (![threshold, open, close].every(Number.isFinite) || threshold <= 0) return false;

    const closed = usesClosedPriceMovement(setup);
    if (closed && lastBar.isBarClosed !== true) return false;
    const price = !closed && Number.isFinite(refPrice) ? refPrice : open;
    const diff = new Big(close).minus(price);

    // Determine if condition is met
    let isConditionMet = false;
    const dir = String(direction || '').toLowerCase();

    if (dir === 'up') {
        isConditionMet = diff.gte(threshold);
    } else if (dir === 'down') {
        isConditionMet = diff.lte(-threshold);
    }

    // Tracking Log
    console.log(
        `[Price Movement] Watching ${triggerSymbol} (${timeframe}) | ` +
        `Price: ${price.toFixed(2)} | ` +
        `Current: ${close.toFixed(2)} | ` +
        `Difference: ${isConditionMet ? chalk.yellow(diff.toFixed(2)) : chalk.red(diff.toFixed(2))}` + ' USD | ' +
        `Target: ${threshold} USD (${dir.toUpperCase()})`
    );

    return isConditionMet;
};
