import { binance } from './binance.js';
import { bybit } from './bybit.js';
import Big from 'big.js';

/**
 * Centralized Exchange Manager (Orchestrator)
 * Provides a unified interface for multi-exchange trading via CCXT.
 */

export const BROKERS = {
    binance,
    bybit,
};

/**
 * Get broker by exchange type.
 * @param {string} exchangeType
 * @returns {Object} broker instance
 */
const getBroker = (exchangeType) => {
    const broker = BROKERS[exchangeType?.toLowerCase()];
    if (!broker) {
        throw new Error(`Broker ${exchangeType} not implemented`);
    }
    return broker;
};

/**
 * BrokerManager class - singleton for managing all exchange interactions.
 */
class BrokerManager {
    constructor() {
        this.activeStreams = new Map(); // userId -> Map(exchangeId -> streamController)
        this.exchangeInstances = new Map(); // exchangeType+credentials hash -> exchange instance
    }

    /**
     * Ping exchange connectivity.
     * @param {string} exchangeType
     * @param {Object} credentials
     * @param {boolean} isTestnet
     * @returns {Promise<Object>}
     */
    async ping(exchangeType, credentials, isTestnet = false) {
        const broker = getBroker(exchangeType);
        return await broker.ping(credentials, isTestnet);
    }

    /**
     * Fetch balance for an exchange.
     * @param {string} exchangeType
     * @param {Object} credentials
     * @param {boolean} isTestnet
     * @returns {Promise<Object>}
     */
    async fetchBalance(exchangeType, credentials, isTestnet = false) {
        const broker = getBroker(exchangeType);
        return await broker.fetchBalance(credentials, isTestnet);
    }

    /**
     * Start real-time streams for a user's exchange account (PRIVATE DATA ONLY).
     * Public market data should be fetched via REST API from frontend.
     * @param {string} userId
     * @param {string} exchangeId
     * @param {string} exchangeType
     * @param {Object} credentials
     * @param {boolean} isTestnet
     * @param {Object} callbacks - { onBalance, onPositions, onOrders }
     * @returns {Promise<Object>} stream controller
     */
    async startStreams(
        userId,
        exchangeId,
        exchangeType,
        credentials,
        isTestnet = false,
        callbacks = {}
    ) {
        const broker = getBroker(exchangeType);
        const { onBalance = () => { }, onPositions = () => { }, onOrders = () => { } } = callbacks;

        // Ensure user map exists
        if (!this.activeStreams.has(userId)) {
            this.activeStreams.set(userId, new Map());
        }
        const userStreams = this.activeStreams.get(userId);

        // Stop existing stream for this exchangeId if any
        if (userStreams.has(exchangeId)) {
            await this.stopStreams(userId, exchangeId);
        }

        // Start PRIVATE streams via broker (no ticker streams)
        const streamController = await broker.startStreams(
            credentials,
            isTestnet,
            onBalance,
            onPositions,
            onOrders
        );

        userStreams.set(exchangeId, { controller: streamController, exchangeType, credentials, isTestnet });

        return streamController;
    }

    /**
     * Stop streams for a user's exchange.
     * @param {string} userId
     * @param {string} exchangeId
     */
    async stopStreams(userId, exchangeId) {
        const userStreams = this.activeStreams.get(userId);
        if (!userStreams || !userStreams.has(exchangeId)) {
            return;
        }
        const { controller } = userStreams.get(exchangeId);
        if (controller && typeof controller.stop === 'function') {
            controller.stop();
        }
        userStreams.delete(exchangeId);
    }

    /**
     * Stop all streams for a user.
     * @param {string} userId
     */
    async stopAllStreams(userId) {
        const userStreams = this.activeStreams.get(userId);
        if (!userStreams) return;
        for (const [exchangeId, { controller }] of userStreams.entries()) {
            if (controller && typeof controller.stop === 'function') {
                controller.stop();
            }
        }
        this.activeStreams.delete(userId);
    }

    /**
     * Create an order with financial precision using Big.js.
     * @param {string} exchangeType
     * @param {Object} credentials
     * @param {boolean} isTestnet
     * @param {string} symbol
     * @param {string} side
     * @param {string} type
     * @param {number} amount
     * @param {number} price
     * @returns {Promise<Object>} order result
     */
    async createOrder(
        exchangeType,
        credentials,
        isTestnet = false,
        symbol,
        side,
        type,
        amount,
        price = undefined,
        params = {}
    ) {
        const broker = getBroker(exchangeType);
        return await broker.createOrder(credentials, isTestnet, symbol, side, type, amount, price, params);
    }

    /**
     * Set Leverage.
     */
    async setLeverage(exchangeType, credentials, isTestnet = false, leverage, symbol) {
        const broker = getBroker(exchangeType);
        if (broker.setLeverage) {
            return await broker.setLeverage(credentials, isTestnet, leverage, symbol);
        }
        return null;
    }

    /**
     * Cancel an order.
     */
    async cancelOrder(exchangeType, credentials, isTestnet = false, orderId, symbol) {
        const broker = getBroker(exchangeType);
        return await broker.cancelOrder(credentials, isTestnet, orderId, symbol);
    }

    /**
     * Fetch open orders.
     */
    async fetchOpenOrders(exchangeType, credentials, isTestnet = false, symbol = undefined) {
        const broker = getBroker(exchangeType);
        return await broker.fetchOpenOrders(credentials, isTestnet, symbol);
    }

    /**
     * Fetch positions.
     */
    async fetchPositions(exchangeType, credentials, isTestnet = false, symbols = undefined) {
        const broker = getBroker(exchangeType);
        return await broker.fetchPositions(credentials, isTestnet, symbols);
    }


    /**
     * Get exchange instance (singleton per credentials).
     * @private
     */
    _getExchangeInstance(exchangeType, credentials, isTestnet) {
        const hash = `${exchangeType}:${credentials.apiKey}:${isTestnet}`;
        if (!this.exchangeInstances.has(hash)) {
            const broker = getBroker(exchangeType);
            const exchange = broker.getExchange(credentials, isTestnet);
            this.exchangeInstances.set(hash, exchange);
        }
        return this.exchangeInstances.get(hash);
    }
}

// Export singleton instance
export const brokerManager = new BrokerManager();