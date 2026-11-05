/**
 * Volume Logic
 * Trigger when volume is greater than or equal to the specified volume threshold.
 *
 * @param {Object} setup   - Firebase setup object (timeframe, triggerSymbol, indicators)
 * @param {Object} lastBar - Latest completed candle (should contain `volume`)
 * @returns {Boolean}      - true if volume condition met, false otherwise
 */
export const checkVolume = (setup, lastBar) => {
  if (!lastBar.indicators || !setup.indicators) return false;

  const { timeframe, triggerSymbol, indicators, direction } = setup;

  // Dynamically find the key that contains "Volume" (e.g., "Volume · BTC", "Volume (20)")
  let volumeKey = null;
  if (indicators) {
    for (const key of Object.keys(indicators)) {
      if (key.toLowerCase().includes('volume')) {
        volumeKey = key;
        break;
      }
    }
  }

  if (!volumeKey) return false;

  // Read threshold from setup.indicators using the found key
  const volumeThreshold = parseFloat(indicators[volumeKey]);
  if (isNaN(volumeThreshold)) return false;

  // Read live volume from lastBar
  const volume = parseFloat(lastBar.volume);
  if (isNaN(volume)) return false;

  // Check if live volume meets or exceeds the threshold
  let isTriggered = volume >= volumeThreshold;

  console.log(`[Volume] ${triggerSymbol} (${timeframe}) | Trigger when ${volumeKey} ${volumeThreshold} ${direction} occurs | Live: ${volume.toFixed(2)}`);

  const open = parseFloat(lastBar.open);
  const close = parseFloat(lastBar.close);
  const bearish = close < open
  const bullish = close > open

  if (direction.toLowerCase() === "up") {
    if (bullish && isTriggered) {
      return true;
    }
  }

  if (direction.toLowerCase() === "down") {
    if (bearish && isTriggered) {
      return true;
    }
  }

  return false;
};
