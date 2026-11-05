import ccxt from 'ccxt';
import Big from 'big.js';

/**
 * Bybit broker using CCXT (v4.0+)
 * Singleton per exchange instance, supports testnet switching.
 * Uses Big.js for financial precision.
 */

const instances = new Map();

/**
 * Get a Bybit exchange instance (cached per credentials to support multi-user).
 * @param {Object} credentials - { apiKey, apiSecret }
 * @param {boolean} isTestnet - whether to use testnet (sandbox)
 * @returns {ccxt.bybit} exchange instance
 */
const getExchange = (credentials, isTestnet = false) => {
    const key = `${credentials?.apiKey || 'public'}:${credentials?.apiSecret || 'public'}:${isTestnet}`;

    if (!instances.has(key)) {
        const exchange = new ccxt.bybit({
            apiKey: credentials?.apiKey,
            secret: credentials?.apiSecret,
            defaultType: 'future', // perpetual swap trading
            options: {
                defaultType: 'future',
            },
        });
        instances.set(key, exchange);
    }

    const bybitInstance = instances.get(key);

    // Dynamic sandbox mode switching
    if (isTestnet) {
        bybitInstance.setSandboxMode(true);
    } else {
        bybitInstance.setSandboxMode(false);
    }

    return bybitInstance;
};

/**
 * Ping exchange connectivity.
 * @param {Object} credentials
 * @param {boolean} isTestnet
 * @returns {Promise<Object>} { success, message }
 */
const ping = async (credentials, isTestnet = false) => {
    try {
        const exchange = getExchange(credentials, isTestnet);
        // fetchTime() is often public; use fetchBalance() to verify credentials
        await exchange.fetchBalance();
        return { success: true, message: 'Connected' };
    } catch (error) {
        return { success: false, message: error.message };
    }
};

/**
 * Fetch account balance via REST.
 * @param {Object} credentials
 * @param {boolean} isTestnet
 * @returns {Promise<Object>} normalized balance
 */
const fetchBalance = async (credentials, isTestnet = false) => {
    const exchange = getExchange(credentials, isTestnet);
    const balance = await exchange.fetchBalance();
    // Use Big.js for calculations
    const total = new Big(balance.total?.USDT || 0);
    const free = new Big(balance.free?.USDT || 0);
    const used = new Big(balance.used?.USDT || 0);

    return {
        exchangeId: 'bybit',
        exchangeType: 'bybit',
        availableBalance: free.toNumber(),
        walletBalance: total.toNumber(),
        unrealizedPnl: 0, // need positions to compute
        lastSync: new Date().toISOString(),
        raw: balance,
    };
};

/**
 * Start real-time WebSocket streams using ccxt.pro.
 * @param {Object} credentials
 * @param {boolean} isTestnet
 * @param {Function} onTicker - callback for ticker updates
 * @param {Function} onBalance - callback for balance updates
 * @param {Function} onPositions - callback for positions updates
 * @param {Function} onOrders - callback for orders updates
 * @returns {Promise<Object>} stream controller with stop method
 */
const startStreams = async (
    credentials,
    isTestnet = false,
    onBalance = () => { },
    onPositions = () => { },
    onOrders = () => { }
) => {
    const exchange = getExchange(credentials, isTestnet);
    const streams = {};
    const stopFlags = {
        balance: false,
        positions: false,
        orders: false
    };

    // Start balance stream (PRIVATE DATA ONLY - no ticker stream)
    const balanceStream = async () => {
        while (!stopFlags.balance) {
            try {
                const balance = await exchange.watchBalance();
                onBalance(balance);
            } catch (error) {
                if (stopFlags.balance) break;
                console.error('Balance stream error:', error);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        console.log('Bybit balance stream terminated');
    };

    // Start positions stream
    const positionsStream = async () => {
        while (!stopFlags.positions) {
            try {
                const positions = await exchange.watchPositions();
                onPositions(positions);
            } catch (error) {
                if (stopFlags.positions) break;
                console.error('Positions stream error:', error);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        console.log('Bybit positions stream terminated');
    };

    // Start orders stream
    const ordersStream = async () => {
        while (!stopFlags.orders) {
            try {
                const orders = await exchange.watchOrders();
                onOrders(orders);
            } catch (error) {
                if (stopFlags.orders) break;
                console.error('Orders stream error:', error);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        console.log('Bybit orders stream terminated');
    };

    // Start all PRIVATE streams in background (no public ticker streams)
    streams.balance = balanceStream();
    streams.positions = positionsStream();
    streams.orders = ordersStream();

    return {
        stop: async () => {
            // Set stop flags to terminate loops
            stopFlags.balance = true;
            stopFlags.positions = true;
            stopFlags.orders = true;

            // Close WebSocket connections if possible
            if (exchange.close && typeof exchange.close === 'function') {
                try {
                    exchange.close();
                } catch (err) {
                    console.warn('Error closing Bybit exchange connection:', err);
                }
            }

            // Wait a short time for streams to terminate gracefully
            await new Promise(resolve => setTimeout(resolve, 100));

            console.log('All Bybit private streams stopped');
        },
        // Expose stop flags for testing
        _stopFlags: stopFlags,
        // Expose stream promises for cleanup tracking
        _streamPromises: [streams.balance, streams.positions, streams.orders]
    };
};

/**
 * Place an order with Big.js precision.
 * @param {Object} credentials
 * @param {boolean} isTestnet
 * @param {string} symbol
 * @param {string} side
 * @param {string} type
 * @param {number} amount
 * @param {number} price
 * @returns {Promise<Object>} order result
 */
const createOrder = async (
    credentials,
    isTestnet = false,
    symbol,
    side,
    type,
    amount,
    price = undefined,
    params = {}
) => {
    const exchange = getExchange(credentials, isTestnet);
    const amountVal = (amount !== undefined && amount !== null) ? new Big(amount).toNumber() : undefined;
    const priceVal = (price !== undefined && price !== null) ? new Big(price).toNumber() : undefined;

    return await exchange.createOrder(
        symbol,
        type,
        side,
        amountVal,
        priceVal,
        params
    );
};

/**
 * Cancel order.
 */
const cancelOrder = async (credentials, isTestnet = false, orderId, symbol) => {
    const exchange = getExchange(credentials, isTestnet);
    return await exchange.cancelOrder(orderId, symbol);
};

/**
 * Fetch open orders.
 */
const fetchOpenOrders = async (credentials, isTestnet = false, symbol = undefined) => {
    const exchange = getExchange(credentials, isTestnet);
    return await exchange.fetchOpenOrders(symbol);
};

/**
 * Fetch positions.
 */
const fetchPositions = async (credentials, isTestnet = false, symbols = undefined) => {
    const exchange = getExchange(credentials, isTestnet);
    return await exchange.fetchPositions(symbols);
};

export const bybit = {
    getExchange,
    ping,
    fetchBalance,
    startStreams,
    createOrder,
    cancelOrder,
    fetchOpenOrders,
    fetchPositions,
};