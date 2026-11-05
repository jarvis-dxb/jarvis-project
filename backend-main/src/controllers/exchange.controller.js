import * as service from '../services/exchange.service.js';
import { errors } from '../utils/index.js';
import appCache from '../cache.js';
import { db } from '../config/sqlite.js';
import { getIO } from '../socket.js';
import { buildTradeNotification, sendTradeAlert } from '../services/notification.service.js';
import { randomUUID } from 'node:crypto';
import { captureAppEvent } from '../whatsapp/events.js';
import { validateApprovalOptions, confirmationRequired } from '../services/trade-approval-options.js';
import { demoAutoEnabled } from '../services/watcher-execution-mode.js';
import { getUserAccountsByUserId } from '../services/user.account.service.js';

const captureWhatsApp = async (event) => {
    try { await captureAppEvent(event); }
    catch { console.warn('[WhatsApp] Trade event could not be recorded'); }
};

const deliverTradeAlert = ({ type, userId, setup, results = [], browser = false }) => {
    if (!userId) return;
    if (type === 'trade_activated') void captureWhatsApp({ type, userId, setup });

    if (browser) {
        try {
            getIO().to(`u:${userId}`).emit('trade_notification', buildTradeNotification({ type, setup, results }));
        } catch (error) {
            console.warn('[Trade Notification] Socket delivery skipped:', error.message);
        }
    }

    void sendTradeAlert({ userId, type, setup, results })
        .catch((error) => console.error('[Trade Notification] Email delivery failed:', error.message));
};

export const getAvailableExchanges = async (req, res, next) => {
    try {
        const exchanges = await service.getAvailableExchanges();
        res.status(200).json({
            status: 'success',
            data: exchanges,
        });
    } catch (error) {
        next(error);
    }
};

export const getExchangeAccountTypes = async (req, res, next) => {
    try {
        const { exchangeId } = req.params;

        if (!exchangeId) {
            return next(errors.badRequest('exchangeId is required'));
        }

        const accountTypes = await service.getExchangeAccountTypes(exchangeId);

        res.status(200).json({
            status: 'success',
            data: accountTypes,
        });
    } catch (error) {
        next(error);
    }
};

export const getExchangeNetworks = async (req, res, next) => {
    try {
        const { exchangeId } = req.params;

        if (!exchangeId) {
            return next(errors.badRequest('exchangeId is required'));
        }

        const networks = await service.getExchangeNetworks(exchangeId);

        res.status(200).json({
            status: 'success',
            data: networks,
        });
    } catch (error) {
        next(error);
    }
};

export const getAllTradingSymbols = async (req, res, next) => {
    try {
        const { exchangeId, accountType, network } = req.query;

        if (!exchangeId) {
            return next(errors.badRequest('exchangeId is required'));
        }

        const cacheKey = `tradingSymbols:${exchangeId}:${accountType || 'futures'}:${network || 'testnet'}`;

        // Check cache first
        const cachedData = await appCache.get(cacheKey);
        if (cachedData !== undefined) {
            console.log(`Retrieving from cache..`);
            return res.status(200).json({
                status: 'success',
                data: cachedData,
            });
        }

        // If not in cache, fetch from service
        const symbols = await service.getAllTradingSymbols(
            exchangeId,
            accountType || 'futures',
            network || 'mainnet'
        );

        // Store in cache
        appCache.set(cacheKey, symbols);
        console.log(`✓ Caching... (${symbols.length} symbols) for ${cacheKey}`);

        res.status(200).json({
            status: 'success',
            data: symbols,
        });
    } catch (error) {
        next(error);
    }
};

export const getPositions = async (req, res, next) => {
    try {
    } catch (error) {
        next(error);
    }
};

export const marketBuy = async (req, res, next) => {
    try {
        console.log('\n\n\n\>>>>>>>>>>>>>>>>>>>>>>>>>>> ORDER REQUEST RECEIVED <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n\n\n');
        const payload = req.body;
        const control = (await db.collection('watcherControls').doc(req.user?.id || payload.userId).get()).data() || {};
        const saved=payload.id?(await db.collection('setups').doc(String(payload.id)).get()).data():null;
        if (control.forceMonitoringOnly || saved?.executionMode === 'monitoring' || payload.executionMode === 'monitoring') {
            return next(errors.forbidden('Monitoring Only is enabled. No order was placed.'));
        }
        // The marker is set only by authenticated local watcher middleware. A
        // browser body cannot grant this scoped Testnet permission.
        const demoAuto = req.demoAutoExecution === true && saved?.userId === req.user?.id
            && demoAutoEnabled({...saved,id:payload.id},control,await getUserAccountsByUserId(req.user.id));
        if (control.monitorOnly && !req.approvedTrade && !demoAuto) {
            return next(errors.forbidden('Monitoring mode does not place orders. Use an approved Demo test or explicitly enable trading.'));
        }
        // A saved confirmation setup cannot bypass approval via the manual
        // Execute button, a stale browser payload, or a watcher API request.
        if ((confirmationRequired(saved)||confirmationRequired(payload)) && !req.approvedTrade) {
            return next(errors.forbidden('This setup requires its private Yes/No approval link before execution.'));
        }
        const executionId = payload.notificationExecutionId || randomUUID();
        // Optionally inject userId from req.user if authenticated, otherwise rely on payload
        if (req.user && req.user.id && !payload.userId) {
            payload.userId = req.user.id;
        }
        const results = await service.executeMarketOrder(payload);

        const allFailed = Array.isArray(results) && results.length > 0 && results.every(r => r.success === false);

        if (allFailed) {
            await captureWhatsApp({ userId: payload.userId, type: 'trade_executed', setup: payload, results, executionId });
            return res.status(400).json({
                status: 'error',
                message: 'Order failed on all exchanges',
                data: results,
            });
        }

        // ── Update SQLite setup after successful order ──
        let notificationSetup = { ...payload };
        if (payload.id) {
            const repeatCounter = parseInt(payload.repeatCounter, 10) || 1;
            const triggeredCounter = parseInt(payload.triggeredCounter, 10) || 0;

            if (triggeredCounter < repeatCounter) {
                const newTriggeredCount = triggeredCounter + 1;
                const isCompleted = newTriggeredCount >= repeatCounter;

                await db.collection('setups').doc(payload.id).update({
                    updatedAt: new Date(),
                    triggeredCounter: newTriggeredCount,
                    isCompleted,
                });

                notificationSetup = {
                    ...payload,
                    triggeredCounter: newTriggeredCount,
                    isCompleted,
                };

                console.log(`[Firebase] Setup ${payload.id} → ${newTriggeredCount}/${repeatCounter}${isCompleted ? ' ✓ Completed' : ''}`);
            }
        }

        await captureWhatsApp({ userId: payload.userId, type: 'trade_executed', setup: notificationSetup, results, executionId });
        deliverTradeAlert({
            type: 'trade_executed',
            userId: payload.userId,
            setup: notificationSetup,
            results,
            browser: true,
        });

        res.status(200).json({
            status: 'success',
            data: results,
        });
    } catch (error) {
        if (Array.isArray(req.body?.accounts)) await captureWhatsApp({ userId: req.body.userId || req.user?.id, type: 'trade_executed', setup: req.body, executionId: randomUUID(), results: req.body.accounts.map(account => ({ account, symbol: Array.isArray(req.body.tradingSymbol) ? req.body.tradingSymbol.join(', ') : req.body.tradingSymbol, success: false, error: 'Trade execution failed: ' + error.message })) });
        next(error);
    }
};

export const marketSell = async (req, res, next) => {
    try {
    } catch (error) {
        next(error);
    }
};

export const reducePosition = async (req, res, next) => {
    try {
    } catch (error) {
        next(error);
    }
};

export const getTradingSymbolLastPrice = async (req, res, next) => {
    try {
        const { symbol } = req.params;
        const { exchangeId, accountType, network } = req.query;

        if (!symbol) {
            return next(errors.badRequest('symbol is required'));
        }

        if (!exchangeId) {
            return next(errors.badRequest('exchangeId is required'));
        }

        if (!accountType) {
            return next(errors.badRequest('accountType is required'));
        }

        if (!network) {
            return next(errors.badRequest('network is required'));
        }

        // Normalize symbol: remove exchange prefix and .P/.S suffix
        let cleanSymbol = symbol;

        // Remove exchange prefix if present (e.g., BINANCE:BTCUSDT.P → BTCUSDT.P)
        if (symbol.includes(':')) {
            const parts = symbol.split(':');
            cleanSymbol = parts[1]; // Get symbol part after colon
        }

        // Remove .P or .S suffix if present
        if (cleanSymbol.endsWith('.P') || cleanSymbol.endsWith('.S')) {
            cleanSymbol = cleanSymbol.slice(0, -2); // Remove last 2 characters (.P or .S)
        }

        // Call service with provided parameters (already validated)
        const data = await service.getTradingSymbolLastPrice(
            exchangeId.toLowerCase(),
            cleanSymbol,
            accountType,
            network
        );

        res.status(200).json({
            status: 'success',
            data: {
                ...data,
                meta: {
                    exchangeId: exchangeId.toLowerCase(),
                    originalSymbol: symbol,
                    cleanSymbol,
                    accountType,
                    network
                }
            },
        });
    } catch (error) {
        next(error);
    }
};

export const createSetup = async (req, res, next) => {
    try {
        const setupData = req.body;

        if (!setupData) {
            return next(errors.badRequest('Trading setup details required'));
        }
        try {validateApprovalOptions(setupData);} catch(error) {return next(errors.badRequest(error.message));}

        if (setupData.resetReferenceOnTrigger !== undefined && typeof setupData.resetReferenceOnTrigger !== 'boolean') {
            return next(errors.badRequest('resetReferenceOnTrigger must be a boolean'));
        }
        delete setupData.priceReferenceResetAt;
        delete setupData.priceReferencePrevious;

        const newSetup = await service.createSetup({
            ...setupData,
            isCompleted: false,
            triggeredCounter: 0,
            userId: req.user.id
        });

        deliverTradeAlert({
            type: 'trade_activated',
            userId: req.user.id,
            setup: newSetup,
        });

        void import('../services/watcher-session.service.js')
            .then(({ startSessionWatcher }) => startSessionWatcher(req.user.id))
            .catch(() => console.warn('[Watcher] Could not start after setup creation'));

        res.status(201).json({
            status: 'success',
            data: newSetup,
        });
    } catch (error) {
        next(error);
    }
};

export const getSetupsByUserId = async (req, res, next) => {
    try {
        const setups = await service.getSetupsByUserId(req.user.id);
        res.status(200).json({
            status: 'success',
            data: setups,
        });
    } catch (error) {
        next(error);
    }
};

export const deleteSetup = async (req, res, next) => {
    try {
        const { setupId } = req.params;

        if (!setupId) {
            return next(errors.badRequest('setupId is required'));
        }

        // Optional: Check if setup belongs to user before deleting
        const setupDoc = await db.collection('setups').doc(setupId).get();
        if (!setupDoc.exists) {
            return next(errors.notFound('Setup not found'));
        }

        if (setupDoc.data().userId !== req.user.id) {
            return next(errors.forbidden('You do not have permission to delete this setup'));
        }

        await service.deleteSetup(setupId);

        res.status(200).json({
            status: 'success',
            message: 'Setup deleted successfully',
        });
    } catch (error) {
        next(error);
    }
};

export const batchDeleteSetups = async (req, res, next) => {
    try {
        const { setupIds } = req.body;

        if (!setupIds || !Array.isArray(setupIds) || setupIds.length === 0) {
            return next(errors.badRequest('setupIds array is required'));
        }

        // Verify ownership for each setup (could be optimized with a single query)
        const snapshots = await Promise.all(setupIds.map(id => db.collection('setups').doc(id).get()));
        
        for (const setupDoc of snapshots) {
            if (!setupDoc.exists) {
                return next(errors.notFound(`Setup ${setupDoc.id} not found`));
            }
            if (setupDoc.data().userId !== req.user.id) {
                return next(errors.forbidden(`You do not have permission to delete setup ${setupDoc.id}`));
            }
        }

        await service.batchDeleteSetups(setupIds);

        res.status(200).json({
            status: 'success',
            message: `${setupIds.length} setups deleted successfully`,
        });
    } catch (error) {
        next(error);
    }
};

export const updateSetup = async (req, res, next) => {
    try {
        const { setupId } = req.params;
        const updates = req.body;

        if (updates.resetReferenceOnTrigger !== undefined && typeof updates.resetReferenceOnTrigger !== 'boolean') {
            return next(errors.badRequest('resetReferenceOnTrigger must be a boolean'));
        }
        delete updates.priceReferenceResetAt;
        delete updates.priceReferencePrevious;

        if (!setupId) {
            return next(errors.badRequest('setupId is required'));
        }

        // Optional: Check if setup belongs to user before updating
        const setupDoc = await db.collection('setups').doc(setupId).get();
        if (!setupDoc.exists) {
            return next(errors.notFound('Setup not found'));
        }

        if (setupDoc.data().userId !== req.user.id) {
            return next(errors.forbidden('You do not have permission to update this setup'));
        }

        const setupData = setupDoc.data();
        try {validateApprovalOptions({...setupData,...updates});} catch(error) {return next(errors.badRequest(error.message));}
        if (setupData.isCompleted || (setupData.triggeredCounter && setupData.triggeredCounter > 0)) {
            return next(errors.forbidden('Cannot update setup, trigger already initiated.'));
        }

        const updatedSetup = await service.updateSetup(setupId, updates);

        res.status(200).json({
            status: 'success',
            data: updatedSetup,
        });
    } catch (error) {
        next(error);
    }
};
