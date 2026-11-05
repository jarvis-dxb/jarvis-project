export const USER_ROLES = {
    ADMIN: 'admin',
    USER: 'user',
};

export const USER_STATUS = {
    PENDING: 'pending',
    ACTIVE: 'active',
};

export const USER_PLANS = {
    PLAN_1: '1 day (Free)',
    PLAN_15: '15 days ($15)',
    PLAN_30: '30 days ($25)',
};

export const EXCHANGES = {
    BINANCE: 'binance',
    BYBIT: 'bybit',
    MEXC: 'mexc'
};

/**
 * Validate if an exchange type is supported
 * @param {string} exchangeType - The exchange type to validate
 * @returns {boolean} True if valid, false otherwise
 */
export const validateExchangeType = (exchangeType) => {
    return Object.values(EXCHANGES).includes(exchangeType?.toLowerCase());
};

/**
 * Get all supported exchange types
 * @returns {string[]} Array of supported exchange types
 */
export const getSupportedExchanges = () => {
    return Object.values(EXCHANGES);
};
