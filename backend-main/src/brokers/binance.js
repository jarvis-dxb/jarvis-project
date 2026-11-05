import ccxt from 'ccxt';
import Big from 'big.js';

/**
 * Binance broker using CCXT (v4.0+)
 * Singleton per exchange instance, supports testnet switching.
 * Uses Big.js for financial precision.
 */

const instances = new Map();

/**
 * Get a Binance exchange instance (cached per credentials to support multi-user).
 * @param {Object} credentials - { apiKey, apiSecret }
 * @param {boolean} isTestnet - whether to use testnet (sandbox)
 * @returns {ccxt.binance} exchange instance
 */
const getExchange = (credentials, isTestnet = false) => {
    const key = `${credentials?.apiKey || 'public'}:${credentials?.apiSecret || 'public'}:${isTestnet}`;

    if (!instances.has(key)) {
        const exchange = new ccxt.binance({
            apiKey: credentials?.apiKey,
            secret: credentials?.apiSecret,
            defaultType: 'future', // perpetual swap trading
            options: {
                defaultType: 'future',
            },
        });
        instances.set(key, exchange);
    }

    const binanceInstance = instances.get(key);

    // Use demo trading instead of sandbox mode, as Binance deprecated sandbox for futures
    if (isTestnet) {
        if (typeof binanceInstance.enableDemoTrading === 'function') {
            binanceInstance.enableDemoTrading(true);
        }
        
        // Prevent CCXT loadMarkets() from calling fetchCurrencies() -> sapi endpoints, 
        // which do not exist in test/demo and would crash fetchPositions/createOrder
        binanceInstance.fetchCurrencies = async () => ({});
    } else {
        // Ensure demo trading is disabled for mainnet
        if (typeof binanceInstance.enableDemoTrading === 'function') {
            binanceInstance.enableDemoTrading(false);
        }
    }

    return binanceInstance;
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
        // fetchTime() is often public; use a private endpoint to verify credentials
        // Using raw fapi call to avoid CCXT loadMarkets loops as noted in fetchBalance
        await exchange.fapiPrivateV2GetAccount();
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

    // Direct raw API call bypasses CCXT fetchCurrencies/loadMarkets exception loops entirely
    const account = await exchange.fapiPrivateV2GetAccount();
    const usdt = account.assets.find(a => a.asset === 'USDT');

    const total = new Big(usdt ? usdt.walletBalance : 0);
    const free = new Big(usdt ? usdt.availableBalance : 0);
    const unrealized = new Big(usdt ? usdt.unrealizedProfit : 0);

    return {
        exchangeId: 'binance',
        exchangeType: 'binance',
        availableBalance: free.toNumber(),
        walletBalance: total.toNumber(),
        unrealizedPnl: unrealized.toNumber(),
        lastSync: new Date().toISOString(),
        raw: account,
    };
};

/**
 * Start real-time WebSocket streams using ccxt.pro for PRIVATE DATA ONLY.
 * Public market data should be fetched via REST API from frontend.
 * @param {Object} credentials
 * @param {boolean} isTestnet
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

    // Start balance stream (PRIVATE DATA)
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
        console.log('Balance stream terminated');
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
        console.log('Positions stream terminated');
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
        console.log('Orders stream terminated');
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
                    console.warn('Error closing exchange connection:', err);
                }
            }

            // Wait a short time for streams to terminate gracefully
            await new Promise(resolve => setTimeout(resolve, 100));

            console.log('All Binance private streams stopped');
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

    const order = await exchange.createOrder(
        symbol,
        type,
        side,
        amountVal,
        priceVal,
        params
    );
    if (String(type).toLowerCase() === 'market'
        && (!(Number(order.average) > 0) || !(Number(order.filled) > 0))) {
        // Demo may acknowledge a fill before returning avgPrice. Query the
        // existing order; never submit another entry to obtain its fill.
        const orderId = order.id || order.info?.orderId;
        if (orderId) {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const fill = await exchange.fapiPrivateGetOrder({
                        symbol: exchange.market(symbol).id, orderId,
                    });
                    const quantity = Number(fill.executedQty);
                    const quote = Number(fill.cumQuote);
                    const average = Number(fill.avgPrice) || (quantity > 0 ? quote / quantity : 0);
                    if (fill.status === 'FILLED' && quantity > 0 && average > 0) {
                        return { ...order, average, filled: quantity, cost: quote,
                            status: 'closed', info: { ...order.info, ...fill } };
                    }
                } catch { /* The already-placed entry must never be retried. */ }
                if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250));
            }
        }
        return { ...order, executionUnverified: true };
    }
    return order;
};

const setLeverage = async (credentials, isTestnet = false, leverage, symbol) => {
    const exchange = getExchange(credentials, isTestnet);
    if (exchange.has['setLeverage']) {
        return await exchange.setLeverage(leverage, symbol);
    }
    return null;
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

export const binance = {
    getExchange,
    ping,
    fetchBalance,
    startStreams,
    createOrder,
    cancelOrder,
    fetchOpenOrders,
    fetchPositions,
    setLeverage,
};
