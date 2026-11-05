import { isCooldownOver } from './cooldown.js';

import { checkRSI } from '../logics/rsi.js';
import { checkCandleStrike } from '../logics/candle_strike.js';
import { checkPriceMovement, usesClosedPriceMovement } from '../logics/price_movement.js';
import { checkVolume } from '../logics/volume.js';
import { candleTime, normalizeInterval } from '../logics/market-utils.js';

// 1-minute anti-spam block to prevent multiple triggers for the same setup while Firestore is updating
const internalCooldowns = new Map();
const closedPriceSignals = new Map();

/**
 * Process all active setups against incoming live datasource
 * @param {Array} setups - List of active setups from Firestore
 * @param {Object} datasource - Live data stream from browser
 * @returns {Array} - List of setups that triggered their conditions
 */
export function processSetups(setups, datasource) {
    if (!datasource || !datasource.symbol || !datasource.data?.length) return [];

    const dsSymbol = datasource.symbol;
    const dsInterval = normalizeInterval(datasource.interval);
    if (!dsInterval || (datasource.eventTime && (Date.now() - datasource.eventTime > 60000 || datasource.eventTime > Date.now() + 5000))) return [];

    // on filter: always return true (for matched), false (if not matched or condition not met)
    return setups.filter(setup => {
        // 0. Internal Anti-Spam Check (1 minute)
        const closedPriceMovement = usesClosedPriceMovement(setup);
        if (!closedPriceMovement && internalCooldowns.has(setup.id)) {
            const timeSinceTrigger = Date.now() - internalCooldowns.get(setup.id);
            if (timeSinceTrigger < 60000) { // 60 seconds
                return false;
            } else {
                // Expired, remove from map
                internalCooldowns.delete(setup.id);
            }
        }

        // 1. Basic match
        if (setup.isCompleted || setup.watcherPaused || Number(setup.triggeredCounter || 0) >= Number(setup.repeatCounter || 1) || setup.triggerSymbol !== dsSymbol || normalizeInterval(setup.timeframe) !== dsInterval) {
            return false;
        }

        // 2. Cooldown check - agar abhi cooldown active hai to skip karo
        if (!isCooldownOver(setup)) {
            return false;
        }

        // 3. Execute logic
        const logicType = setup.logicType?.toLowerCase();
        const lastBar = datasource.data?.[datasource.data.length - 1]; // Last bar in array is the most recent
        let isTriggered = false;

        switch (logicType) {
            case 'rsi':
                if (!lastBar) return false;
                isTriggered = checkRSI(setup, lastBar);
                break;

            case 'volume':
                if (!lastBar) return false;
                isTriggered = checkVolume(setup, lastBar);
                break;

            case 'candle_strike':
                isTriggered = checkCandleStrike(setup, datasource.data);
                break;

            case 'price_movement':
                if (!lastBar) return false;
                if (closedPriceMovement) {
                    const time = candleTime(lastBar.time);
                    const closeTime = candleTime(lastBar.closeTime);
                    if (!time || !closeTime || candleTime(datasource.closedBarTime) !== time ||
                        closeTime < new Date(setup.createdAt || 0).getTime() ||
                        time <= Math.max(closedPriceSignals.get(setup.id) || 0, candleTime(setup.lastSignalCandleAt) || 0)) return false;
                    if (!checkPriceMovement(setup, lastBar)) return false;
                    closedPriceSignals.set(setup.id, time);
                    if (closedPriceSignals.size > 10000) closedPriceSignals.delete(closedPriceSignals.keys().next().value);
                    return true;
                }
                isTriggered = checkPriceMovement(setup, lastBar);
                break;

            default:
                return false;
        }

        if (isTriggered) {
            // Setup trigger ho gaya hai, ab isay 1-minute ke cooldown pe daal do
            internalCooldowns.set(setup.id, Date.now());
            return true;
        }

        return false;
    });
}
