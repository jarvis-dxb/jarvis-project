import Big from 'big.js';
import { validateOrderConfiguration, validateTargets, floorToStep, targetForOrder } from './order-rules.js';
import axios from 'axios';

import { BROKERS } from '../brokers/index.js';
import { errors } from '../utils/index.js';
import { db } from '../config/sqlite.js';
import { acquireEntryLock, checkBinanceEntryIsolation } from './binance-entry-isolation.js';

/**
 * Get decimal precision from a step size string or number.
 * e.g., "0.001" -> 3, 0.1 -> 1, "1" -> 0
 */
const getPrecision = (stepSize) => {
    if (!stepSize) return 0;
    const str = stepSize.toString();
    if (!str.includes('.')) return 0;
    return str.split('.')[1].length;
};

/**
 * Helper to get the configuration for a specific exchange, account type, and network.
 */
export const getExchangeUrlConfig = (exchangeId, accountType = 'futures', network = 'testnet') => {
    const broker = BROKERS[exchangeId];
    if (!broker) return null;

    // Get CCXT instance to extract URLs
    const exchange = broker.getExchange({}, false);
    const u = exchange.urls;

    let config = {};

    switch (exchangeId) {
        case 'binance':
            if (network === 'testnet') {
                config.apiBaseUrl = u?.demo?.fapiPublic || 'https://demo-fapi.binance.com/fapi/v1'
            } else {
                config.apiBaseUrl = u?.api?.fapiPublic || 'https://fapi.binance.com/fapi/v1';
            }
            break;

        case 'bybit':
            const replaceHostname = (url) => {
                if (typeof url === 'string') {
                    return url.replace('{hostname}', 'bybit.com').replace('api.api.', 'api.');
                }
                return url || '';
            };
            if (network === 'testnet') {
                config.apiBaseUrl = replaceHostname(u?.test?.public) || 'https://api-testnet.bybit.com';
            } else {
                config.apiBaseUrl = replaceHostname(u?.api?.public) || 'https://api.bybit.com';
            }
            break;

        case 'mexc':
            if (network === 'testnet') {
                config.apiBaseUrl = u?.test?.contract?.public || 'https://contract.mexc.com/api/v1/contract';
                config.wsBaseUrl = 'wss://contract.mexc.com/ws';
            } else {
                config.apiBaseUrl = u?.api?.contract?.public || 'https://api.mexc.com/api/v1/contract';
                config.wsBaseUrl = 'wss://wbs.mexc.com/ws/it';
            }
            break;

        default:
            break;
    }

    return config;
};

export const getAvailableExchanges = async () => {
    const exchanges = Object.keys(BROKERS);

    if (!exchanges || exchanges.length === 0) return [];

    const result = await Promise.all(
        exchanges.map(async (exchangeId) => {
            try {
                const broker = BROKERS[exchangeId];
                if (!broker) return null;
                // Get CCXT instance
                const ex = broker.getExchange({}, false);

                return {
                    id: exchangeId,
                    name: ex.name || exchangeId,
                    logo: ex.urls?.logo || '',
                    type: 'exchange',
                    disabled: false,
                };
            } catch (error) {
                console.error(`Error loading exchange ${exchangeId}:`, error);
                return null; // Agar koi exchange fail ho jaye
            }
        })
    );

    return result;
};

export const getExchangeAccountTypes = async (exchangeId) => {
    const exchanges = Object.keys(BROKERS);

    if (!exchangeId || !exchanges || exchanges.length === 0) return [];

    const result = [
        {
            id: 'futures',
            name: 'Futures',
            exchangeId: exchangeId,
            type: 'accountType',
            disabled: false,
        },
        {
            id: 'spot',
            name: 'Spot',
            exchangeId: exchangeId,
            type: 'accountType',
            disabled: true,
        },
    ]

    return result
};

export const getExchangeNetworks = async (exchangeId) => {
    const exchanges = Object.keys(BROKERS);

    if (!exchangeId || !exchanges || exchanges.length === 0) return [];

    const result = [
        {
            id: 'testnet',
            name: 'Testnet',
            exchangeId: exchangeId,
            type: 'network',
            disabled: false,
        },
        {
            id: 'mainnet',
            name: 'Mainnet',
            exchangeId: exchangeId,
            type: 'network',
            disabled: false,
        },
    ]

    return result
};

/**
 * Fetch and unify symbol information for a specific exchange.
 */
export const getAllTradingSymbols = async (exchangeId, accountType = 'futures', network = 'testnet') => {
    const config = getExchangeUrlConfig(exchangeId, accountType, network);

    // console.log('\n', JSON.stringify({ exchangeId, accountType, network, ...config }, null, 2), '\n');

    if (!config || !config.apiBaseUrl) {
        throw errors.notFound(`Configuration not found for exchange: ${exchangeId}, accountType: ${accountType}, network: ${network}`);
    }

    const { apiBaseUrl } = config;
    let symbols = [];

    try {
        if (exchangeId === 'binance') {
            const response = await axios.get(`${apiBaseUrl}/exchangeInfo`);
            symbols = response.data.symbols.map(s => {
                const marketLot = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
                const lotSizeFilter = marketLot && Number(marketLot.stepSize)>0 ? marketLot : s.filters.find(f => f.filterType === 'LOT_SIZE');
                const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
                const notionalFilter = s.filters.find(f => ['MIN_NOTIONAL','NOTIONAL'].includes(f.filterType));
                return {
                    symbol: s.symbol,
                    baseAsset: s.baseAsset,
                    quoteAsset: s.quoteAsset,
                    pricePrecision: s.pricePrecision,
                    quantityPrecision: s.quantityPrecision,
                    minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : 0,
                    stepSize: lotSizeFilter?.stepSize,
                    tickSize: priceFilter?.tickSize,
                    minNotional: Number(notionalFilter?.notional || notionalFilter?.minNotional || 0),
                    status: s.status
                };
            });
        }
        else if (exchangeId === 'bybit') {
            let cursor = '';
            let hasMore = true;

            while (hasMore) {
                const response = await axios.get(`${apiBaseUrl}/v5/market/instruments-info`, {
                    params: {
                        category: 'linear',
                        limit: 1000,
                        cursor: cursor || undefined
                    }
                });

                const list = response.data.result.list;
                const mapped = list.map(s => ({
                    symbol: s.symbol,
                    baseAsset: s.baseCoin,
                    quoteAsset: s.quoteCoin,
                    pricePrecision: parseInt(s.priceScale),
                    quantityPrecision: getPrecision(s.lotSizeFilter.qtyStep),
                    minQty: parseFloat(s.lotSizeFilter.minOrderQty),
                    status: s.status.toUpperCase() === 'TRADING' ? 'TRADING' : s.status.toUpperCase()
                }));

                symbols = [...symbols, ...mapped];
                cursor = response.data.result.nextPageCursor;
                hasMore = !!cursor;
            }
        }
        else if (exchangeId === 'mexc') {
            const response = await axios.get(`${apiBaseUrl}/detail`);
            const data = Array.isArray(response.data.data) ? response.data.data : [response.data.data];
            symbols = data.map(s => ({
                symbol: s.symbol,
                baseAsset: s.baseCoin,
                quoteAsset: s.quoteCoin,
                pricePrecision: s.priceScale,
                quantityPrecision: s.volScale, // MEXC volScale is quantity decimals
                minQty: s.minVol,
                status: 'TRADING' // MEXC detail usually returns active contracts
            }));
        }
        else {
            throw errors.badRequest(`Exchange ${exchangeId} not supported for unified info`);
        }

        return symbols;

    } catch (error) {
        // If it's already an ErrorResponse, just rethrow it
        if (error.statusCode) throw error;

        console.error(`Error fetching exchange info for ${exchangeId}:`, error.message);
        throw errors.serverError(`Failed to fetch exchange info for ${exchangeId}: ${error.message}`);
    }
};

/**
 * Fetch the last price for a specific symbol using CCXT
 * @param {string} exchangeId - e.g., 'binance', 'bybit'
 * @param {string} symbol - trading symbol (e.g., 'BTCUSDT', 'BTC/USDT')
 * @param {string} accountType - 'futures' or 'spot' (default: 'futures')
 * @param {string} network - 'testnet' or 'mainnet' (default: 'mainnet')
 */
export const getTradingSymbolLastPrice = async (exchangeId, symbol, accountType = 'futures', network = 'mainnet') => {
    if (!exchangeId) throw errors.badRequest('exchangeId is required');
    if (!symbol) throw errors.badRequest('symbol is required');

    const broker = BROKERS[exchangeId];
    if (!broker) {
        throw errors.badRequest(`Exchange ${exchangeId} not supported`);
    }

    // Get CCXT instance (public, no credentials)
    const isTestnet = network === 'testnet';
    const exchange = broker.getExchange({}, isTestnet);

    // Configure exchange type based on accountType
    // Note: CCXT v4+ uses options.defaultType for futures/spot
    if (accountType === 'spot') {
        // For spot trading, we need to adjust defaultType
        // This may require reloading markets with new type
        exchange.options.defaultType = 'spot';
        exchange.defaultType = 'spot';
    } else {
        // futures (default)
        exchange.options.defaultType = 'future';
        exchange.defaultType = 'future';
    }

    try {
        // Ensure markets are loaded (required for symbol normalization)
        await exchange.loadMarkets();

        // Normalize symbol: CCXT expects format like 'BTC/USDT' or 'BTC/USDT:USDT' for futures
        // The input symbol might be 'BTCUSDT' or 'BTC/USDT'
        let normalizedSymbol = symbol;

        // If symbol doesn't contain a slash, try to infer from markets
        if (!symbol.includes('/')) {
            // Look for market with this symbol
            const market = exchange.markets[symbol];
            if (market) {
                normalizedSymbol = market.symbol;
            } else {
                // Try common pattern: insert '/' before USDT
                if (symbol.endsWith('USDT')) {
                    const base = symbol.slice(0, -4);
                    normalizedSymbol = `${base}/USDT`;
                }
            }
        }

        // Fetch ticker using CCXT
        if (accountType !== 'spot' && normalizedSymbol.endsWith('/USDT')) normalizedSymbol += ':USDT';
        const ticker = await exchange.fetchTicker(normalizedSymbol);

        if (!ticker || ticker.last === undefined) {
            throw errors.notFound(`Ticker not found for symbol: ${symbol}`);
        }

        return {
            exchangeId,
            symbol: normalizedSymbol,
            lastPrice: ticker.last,
            bid: ticker.bid,
            ask: ticker.ask,
            high: ticker.high,
            low: ticker.low,
            volume: ticker.quoteVolume || ticker.baseVolume,
            timestamp: ticker.timestamp,
            datetime: ticker.datetime
        };
    } catch (error) {
        if (error.statusCode) throw error;
        console.error(`Error fetching last price for ${exchangeId}:${symbol}:`, error.message);
        throw errors.serverError(`Failed to fetch last price: ${error.message}`);
    }
};

/**
 * Create a new trading setup in SQLite
 * @param {object} setupData - setup details
 */
export const createSetup = async (setupData) => {
    try {
        const docRef = await db.collection('setups').add({
            ...setupData,
            createdAt: new Date(),
            updatedAt: new Date()
        });

        const newDoc = await docRef.get();
        return {
            id: docRef.id,
            ...newDoc.data()
        };
    } catch (error) {
        console.error('Error creating setup in SQLite:', error.message);
        throw errors.serverError(`Failed to create setup: ${error.message}`);
    }
};

/**
 * Fetch setups by userId from SQLite
 * @param {string} userId - owner of the setups
 */
export const getSetupsByUserId = async (userId) => {
    try {
        const snapshot = await db.collection('setups')
            .where('userId', '==', userId)
            .get();

        const setups = [];
        snapshot.forEach((doc) => {
            setups.push({
                id: doc.id,
                ...doc.data()
            });
        });
        return setups;
    } catch (error) {
        console.error('Error fetching setups from SQLite:', error.message);
        throw errors.serverError(`Failed to fetch setups: ${error.message}`);
    }
};

export const updateSetup = async (setupId, updates) => {
    try {
        const docRef = db.collection('setups').doc(setupId);
        await docRef.update({
            ...updates,
            updatedAt: new Date()
        });

        const updatedDoc = await docRef.get();
        return {
            id: setupId,
            ...updatedDoc.data()
        };
    } catch (error) {
        console.error('Error updating setup in SQLite:', error.message);
        throw errors.serverError(`Failed to update setup: ${error.message}`);
    }
};

/**
 * Delete a trading setup from SQLite
 * @param {string} setupId - document ID to delete
 */
export const deleteSetup = async (setupId) => {
    try {
        await db.collection('setups').doc(setupId).delete();
        return { id: setupId, success: true };
    } catch (error) {
        console.error('Error deleting setup in SQLite:', error.message);
        throw errors.serverError(`Failed to delete setup: ${error.message}`);
    }
};

/**
 * Batch delete trading setups from SQLite
 * @param {string[]} setupIds - array of document IDs to delete
 */
export const batchDeleteSetups = async (setupIds) => {
    try {
        const batch = db.batch();
        setupIds.forEach((id) => {
            const docRef = db.collection('setups').doc(id);
            batch.delete(docRef);
        });
        await batch.commit();
        return { count: setupIds.length, success: true };
    } catch (error) {
        console.error('Error batch deleting setups in SQLite:', error.message);
        throw errors.serverError(`Failed to batch delete setups: ${error.message}`);
    }
};

/**
 * Replicates frontend getEstimatedPnLDisplay logic for calculating target prices.
 */
/**
 * Execute a market buy (long) or sell (short) order dynamically across exchanges.
 */
export const executeMarketOrder = async (payload) => {
    try { validateOrderConfiguration(payload); } catch(error) { throw errors.badRequest(error.message); }
    const {
        accounts,
        SL,
        SL_mode,
        TP,
        TP_mode,
        leverage,
        margin,
        side, // 'long' or 'short'
        tradingSymbol,
        userId,
        action
    } = payload;

    if (!userId) throw errors.badRequest('userId is required');
    if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
        throw errors.badRequest('accounts is required');
    }
    if (!tradingSymbol) throw errors.badRequest('tradingSymbol is required');
    if (!side || !['long', 'short'].includes(side.toLowerCase())) {
        throw errors.badRequest('side must be long or short');
    }

    // Handle backward compatibility where tradingSymbol is string
    const tradingSymbolsArray = Array.isArray(tradingSymbol)
        ? tradingSymbol
        : (typeof tradingSymbol === 'string' && tradingSymbol ? [tradingSymbol] : []);

    if (tradingSymbolsArray.length === 0) {
        throw errors.badRequest('tradingSymbol array or string is required');
    }

    // Get all user accounts
    const { getUserAccountsByUserId } = await import('./user.account.service.js');
    const userAccounts = await getUserAccountsByUserId(userId);

    const results = [];

    for (const rawSymbol of tradingSymbolsArray) {
        // Normalize TradingView symbol (e.g., BINANCE:BTCUSDT.P -> BTCUSDT)
        let cleanSymbol = rawSymbol;
        if (cleanSymbol.includes(':')) {
            cleanSymbol = cleanSymbol.split(':')[1];
        }
        if (cleanSymbol.endsWith('.P') || cleanSymbol.endsWith('.S')) {
            cleanSymbol = cleanSymbol.slice(0, -2);
        }

        for (const accountId of accounts) {
            let exchangeType = 'unknown';
            let releaseEntry;
            try {
                // Find the ping account for this exchange and network
                const account = userAccounts.find(a => a.id === accountId);

                if (!account) {
                    results.push({ account: accountId, symbol: rawSymbol, success: false, error: 'Account not found' });
                    continue;
                }
                if (!account.ping) {
                    results.push({ account: accountId, symbol: rawSymbol, exchange: account.exchangeType, success: false, error: 'Account is not connected (ping failed)' });
                    continue;
                }

                exchangeType = account.exchangeType;
                const net = account.network;
                const isTestnet = net === 'testnet';
                const credentials = { apiKey: account.apiKey, apiSecret: account.apiSecret };
                const { brokerManager } = await import('../brokers/index.js');

                let verifiedHedgeMode;
                if (exchangeType === 'binance') {
                    releaseEntry = await acquireEntryLock(account, cleanSymbol);
                    const instance = brokerManager._getExchangeInstance(exchangeType, credentials, isTestnet);
                    verifiedHedgeMode = (await checkBinanceEntryIsolation(instance, cleanSymbol, side.toLowerCase())).hedged;
                }

                // Set Leverage if supported
                if (leverage && leverage > 0) {
                    try {
                        await brokerManager.setLeverage(exchangeType, credentials, isTestnet, leverage, cleanSymbol);
                    } catch (levErr) { throw new Error(`Leverage could not be set; entry was not placed: ${levErr.message}`); }
                }

                // Get Current Price
                const priceData = await getTradingSymbolLastPrice(exchangeType, cleanSymbol, account.accountType || 'futures', net);
                const currentPriceBig = new Big(priceData.lastPrice);

                // Get Symbol Info for Precisions
                const symbolsInfo = await getAllTradingSymbols(exchangeType, account.accountType || 'futures', net);
                // In Binance, it might be BTCUSDT. Let's find it.
                let symbolInfo = symbolsInfo.find(s => s.symbol === cleanSymbol);
                if (!symbolInfo) {
                    // Try to find normalized
                    symbolInfo = symbolsInfo.find(s => s.symbol.replace('/', '') === cleanSymbol.replace('/', ''));
                }

                if (!symbolInfo) {
                    throw new Error(`Symbol info not found for ${cleanSymbol}`);
                }

                // Calculate quantity based on margin and leverage
                const marginBig = new Big(margin);
                const leverageBig = new Big(leverage || 1);
                let qtyBig = marginBig.times(leverageBig).div(currentPriceBig);

                // Apply precision and minQty
                const qtyPrecision = symbolInfo.quantityPrecision || 0;
                const minQty = symbolInfo.minQty || 0;

                // Fix precision using Big.js roundDown mode (0)
                qtyBig = qtyBig.round(qtyPrecision, 0);
                qtyBig = floorToStep(qtyBig,symbolInfo.stepSize);
                const qty = qtyBig.toNumber();

                if (qty < minQty) {
                    throw new Error(`Calculated quantity ${qty} is less than minimum quantity ${minQty}`);
                }
                if (qty <= 0 || currentPriceBig.times(qty).lt(symbolInfo.minNotional || 0)) throw new Error('Trade amount is below the exchange minimum notional');
                validateTargets(payload,currentPriceBig.toNumber(),qty);

                // CCXT symbol format is typically BTC/USDT.
                let ccxtSymbol = symbolInfo.symbol;
                if (exchangeType === 'binance' && !ccxtSymbol.includes('/')) {
                    if (symbolInfo.baseAsset && symbolInfo.quoteAsset) {
                        ccxtSymbol = `${symbolInfo.baseAsset}/${symbolInfo.quoteAsset}:${symbolInfo.quoteAsset}`;
                    } else if (cleanSymbol.endsWith('USDT')) {
                        ccxtSymbol = `${cleanSymbol.replace('USDT', '')}/USDT:USDT`;
                    }
                }

                const currentSide = side.toLowerCase();
                const orderSide = currentSide === 'long' ? 'buy' : 'sell';

                // Check if hedge mode is enabled on exchange
                let isHedgeMode = verifiedHedgeMode ?? false;
                if (verifiedHedgeMode === undefined) try {
                    const exchangeInstance = brokerManager._getExchangeInstance(exchangeType, credentials, isTestnet);
                    if (exchangeInstance && typeof exchangeInstance.fetchPositionMode === 'function') {
                        const pm = await exchangeInstance.fetchPositionMode(ccxtSymbol);
                        if (pm && (pm.hedged === true || pm.positionMode === 'hedge' || pm.info?.dualSidePosition === true || pm.info?.dualSidePosition === 'true')) {
                            isHedgeMode = true;
                        }
                    }
                } catch (e) {
                    console.warn(`Could not fetch position mode for ${exchangeType}:`, e.message);
                }

                const baseOrderParams = {};
                if (isHedgeMode) {
                    baseOrderParams.positionSide = currentSide.toUpperCase();
                }

                // Place initial market order
                const order = await brokerManager.createOrder(
                    exchangeType,
                    credentials,
                    isTestnet,
                    ccxtSymbol,
                    orderSide,
                    'market',
                    qty,
                    undefined,
                    { ...baseOrderParams, ...(exchangeType==='binance'?{newOrderRespType:'RESULT'}:{}) }
                );

                const closeSide = orderSide === 'buy' ? 'sell' : 'buy';
                if (order.executionUnverified) {
                    results.push({ account: accountId, symbol: rawSymbol, exchange: exchangeType,
                        side: currentSide, success: true, order, protectionComplete: false,
                        slError: 'Entry was placed but its fill could not be verified. Check the exchange position.',
                        tpError: 'TP/SL were not calculated from an unverified fill.' });
                    continue;
                }
                let slOrder = null;
                let tpOrder = null;
                let slError = null;
                let tpError = null;
                const pricePrecision = symbolInfo.pricePrecision || 2;

                // Use actual execution price and quantity if available
                const entryPrice = order.average || priceData.lastPrice;
                const entryQty = order.filled || qty;

                // Place SL Order
                const parsedSL = (SL !== undefined && SL !== null && SL !== '') ? new Big(SL) : null;
                if (parsedSL && parsedSL.gt(0)) {
                    const slMode = SL_mode ? SL_mode.toLowerCase() : 'price';
                    let slValue = parsedSL;
                    // For PnL/%, SL is negative movement
                    if (slMode !== 'price') slValue = parsedSL.times(-1);

                let slPriceBig = targetForOrder(currentSide, entryPrice, leverage, margin, { type: slMode, value: slValue.toNumber() }, entryQty,symbolInfo.tickSize,pricePrecision);
                    
                    // Safety check for SL side
                    const isInvalidSL = currentSide === 'long' ? slPriceBig.gte(entryPrice) : slPriceBig.lte(entryPrice);
                    
                    if (slPriceBig.gt(0) && !isInvalidSL) {
                        try {
                            slOrder = await brokerManager.createOrder(
                                exchangeType,
                                credentials,
                                isTestnet,
                                ccxtSymbol,
                                closeSide,
                                'stop_market',
                                undefined,
                                undefined,
                                { stopPrice: slPriceBig.toNumber(), closePosition: true, ...baseOrderParams }
                            );
                        } catch (err) {
                            slError = err.message;
                            console.error(`SL Order failed for ${exchangeType} (${currentSide}):`, slError);
                        }
                    } else if (isInvalidSL) {
                        slError = `Invalid SL price ${slPriceBig.toNumber()} for ${currentSide} entry ${entryPrice}`;
                        console.warn(slError);
                    }
                }

                // Place TP Order
                const parsedTP = (TP !== undefined && TP !== null && TP !== '') ? new Big(TP) : null;
                if (parsedTP && parsedTP.gt(0)) {
                    const tpMode = TP_mode ? TP_mode.toLowerCase() : 'price';
                    let tpPriceBig = targetForOrder(currentSide, entryPrice, leverage, margin, { type: tpMode, value: parsedTP.toNumber() }, entryQty,symbolInfo.tickSize,pricePrecision);
                    
                    // Safety check for TP side
                    const isInvalidTP = currentSide === 'long' ? tpPriceBig.lte(entryPrice) : tpPriceBig.gte(entryPrice);

                    if (tpPriceBig.gt(0) && !isInvalidTP) {
                        try {
                            tpOrder = await brokerManager.createOrder(
                                exchangeType,
                                credentials,
                                isTestnet,
                                ccxtSymbol,
                                closeSide,
                                'take_profit_market',
                                undefined,
                                undefined,
                                { stopPrice: tpPriceBig.toNumber(), closePosition: true, ...baseOrderParams }
                            );
                        } catch (err) {
                            tpError = err.message;
                            console.error(`TP Order failed for ${exchangeType} (${currentSide}):`, tpError);
                        }
                    } else if (isInvalidTP) {
                        tpError = `Invalid TP price ${tpPriceBig.toNumber()} for ${currentSide} entry ${entryPrice}`;
                        console.warn(tpError);
                    }
                }

                results.push({
                    account: accountId,
                    symbol: rawSymbol,
                    exchange: exchangeType,
                    side: currentSide,
                    success: true,
                    order,
                    slOrder,
                    tpOrder,
                    slError,
                    tpError,
                    protectionComplete:!slError && !tpError
                });

            } catch (error) {
                results.push({
                    account: accountId,
                    symbol: rawSymbol,
                    exchange: exchangeType,
                    success: false,
                    error: error.message
                });
            } finally {
                releaseEntry?.();
            }
        }
    }

    return results;
};
