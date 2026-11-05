import { brokerManager } from '../brokers/index.js';
import { getUserAccountsByUserId } from '../services/user.account.service.js';

// Track active streams per user
const userAccountStreams = new Map();

/**
 * Start private streams for a user's account and broadcast via Socket.io room
 */
const startPrivateStreamsForAccount = async (io, userId, accountId, exchangeType, credentials, isTestnet) => {
    const roomName = `user:${userId}:account:${accountId}`;

    // Create callbacks that broadcast to the room
    const callbacks = {
        onBalance: (balance) => {
            // Frontend expects an array of balances
            io.to(roomName).emit('account:balances', [{
                accountId,
                walletBalance: balance.walletBalance,
                unrealizedPnl: balance.unrealizedPnl,
                availableBalance: balance.availableBalance,
                lastSync: balance.lastSync || new Date().toISOString()
            }]);
        },
        onPositions: (positions) => {
            io.to(roomName).emit('account:positions', {
                userId,
                accountId,
                exchangeType,
                positions,
                timestamp: new Date().toISOString()
            });
        },
        onOrders: (orders) => {
            io.to(roomName).emit('account:orders', {
                userId,
                accountId,
                exchangeType,
                orders,
                timestamp: new Date().toISOString()
            });
        }
    };

    try {
        // Start private streams via BrokerManager
        const streamController = await brokerManager.startStreams(
            userId,
            accountId,
            exchangeType,
            credentials,
            isTestnet,
            callbacks
        );

        // Store stream controller for cleanup
        if (!userAccountStreams.has(userId)) {
            userAccountStreams.set(userId, new Map());
        }
        userAccountStreams.get(userId).set(accountId, streamController);

        console.log(`Started private streams for user ${userId}, account ${accountId} (${exchangeType})`);
        return streamController;
    } catch (error) {
        console.error(`Failed to start private streams for ${userId}/${accountId}:`, error);
        throw error;
    }
};

/**
 * Stop private streams for a user's account
 */
const stopPrivateStreamsForAccount = async (userId, accountId) => {
    if (userAccountStreams.has(userId)) {
        const userStreams = userAccountStreams.get(userId);
        if (userStreams.has(accountId)) {
            const controller = userStreams.get(accountId);
            // Call stop method if available
            if (controller && typeof controller.stop === 'function') {
                await controller.stop();
            }
            userStreams.delete(accountId);
            console.log(`Stopped private streams for user ${userId}, account ${accountId}`);
        }

        // Clean up empty user map
        if (userStreams.size === 0) {
            userAccountStreams.delete(userId);
        }
    }
};

/**
 * Stop all streams for a user
 */
const stopAllPrivateAccountStreamsForUser = async (userId) => {
    if (userAccountStreams.has(userId)) {
        const userStreams = userAccountStreams.get(userId);
        const promises = [];

        for (const [accountId, controller] of userStreams.entries()) {
            if (controller && typeof controller.stop === 'function') {
                promises.push(controller.stop());
            }
        }

        await Promise.all(promises);
        userAccountStreams.delete(userId);
        console.log(`Stopped all private streams for user ${userId}`);
    }
};

export const registerAccountPageEvents = (io, socket) => {
    const userId = socket.userId;

    if (!userId) {
        console.warn('Socket connected without userId');
        return;
    }

    console.log(`[Socket] User ${userId} connected to account events`);

    // 1. Join user's account room
    socket.on('account:join', async (data) => {
        const { accountId, exchangeType, credentials, isTestnet = false } = data;

        if (!accountId || !exchangeType || !credentials) {
            socket.emit('account:error', { message: 'Missing required fields' });
            return;
        }

        const roomName = `user:${userId}:account:${accountId}`;

        try {
            // Join the room
            socket.join(roomName);
            console.log(`User ${userId} joined account room ${roomName}`);

            // Start private streams for this account
            await startPrivateStreamsForAccount(
                io,
                userId,
                accountId,
                exchangeType,
                credentials,
                isTestnet
            );

            socket.emit('account:joined', {
                success: true,
                room: roomName,
                accountId,
                exchangeType
            });
        } catch (error) {
            console.error(`Error joining account room ${roomName}:`, error);
            socket.emit('account:error', {
                message: `Failed to join account room: ${error.message}`
            });
        }
    });

    // 2. Leave account room
    socket.on('account:leave', async (data) => {
        const { accountId } = data;

        if (!accountId) {
            socket.emit('account:error', { message: 'Missing accountId' });
            return;
        }

        const roomName = `user:${userId}:account:${accountId}`;

        try {
            // Leave the room
            socket.leave(roomName);
            console.log(`User ${userId} left account room ${roomName}`);

            // Stop private streams for this account
            await stopPrivateStreamsForAccount(userId, accountId);

            socket.emit('account:left', {
                success: true,
                room: roomName,
                accountId
            });
        } catch (error) {
            console.error(`Error leaving account room ${roomName}:`, error);
            socket.emit('account:error', {
                message: `Failed to leave account room: ${error.message}`
            });
        }
    });

    // 3. Unified balances sync (handles both one-time and real-time polling)
    socket.on('account:balances', async (data) => {
        const { mode = 'once' } = data || {};
        console.log(`[Socket] Balance sync request (account:balances, mode: ${mode}) for user: ${userId}`);

        try {
            // Get user's accounts from database
            const userAccounts = await getUserAccountsByUserId(userId);

            let accountsToFetch = userAccounts;

            // If mode is realtime, only fetch connected accounts
            if (mode === 'realtime') {
                accountsToFetch = userAccounts.filter(ex => ex.connected);
                if (accountsToFetch.length === 0) return;
            }

            const balancesPromises = accountsToFetch.map(async (account) => {
                // Check if API keys are present
                if (!account.apiKey || !account.apiSecret) {
                    return {
                        accountId: account.id,
                        walletBalance: 0,
                        unrealizedPnl: 0,
                        availableBalance: 0,
                        lastSync: new Date().toISOString(),
                        error: 'Missing API credentials'
                    };
                }

                try {
                    const balance = await brokerManager.fetchBalance(
                        account.exchangeType,
                        {
                            apiKey: account.apiKey,
                            apiSecret: account.apiSecret
                        },
                        account.network === 'testnet'
                    );

                    return {
                        accountId: account.id,
                        walletBalance: balance.walletBalance,
                        unrealizedPnl: balance.unrealizedPnl,
                        availableBalance: balance.availableBalance,
                        lastSync: balance.lastSync || new Date().toISOString()
                    };
                } catch (error) {
                    console.error(`[Socket] Error fetching balance for account ${account.id}:`, error.message);
                    return {
                        accountId: account.id,
                        walletBalance: 0,
                        unrealizedPnl: 0,
                        availableBalance: 0,
                        lastSync: new Date().toISOString(),
                        error: error.message
                    };
                }
            });

            const balances = await Promise.all(balancesPromises);

            // Emit balances back to the same event name
            socket.emit('account:balances', balances);

        } catch (error) {
            console.error(`[Socket] Error in account:balances for user ${userId}:`, error);
            if (mode === 'once') {
                socket.emit('account:error', {
                    message: `Failed to fetch accounts: ${error.message}`
                });
            }
        }
    });

    // 4. Request current balance
    socket.on('account:balance:get', async (data) => {
        const { accountId, exchangeType, credentials, isTestnet = false } = data;

        if (!accountId || !exchangeType || !credentials) {
            socket.emit('account:error', { message: 'Missing required fields' });
            return;
        }

        try {
            const balance = await brokerManager.fetchBalance(exchangeType, credentials, isTestnet);
            socket.emit('account:balance:response', {
                success: true,
                userId,
                accountId,
                exchangeType,
                balance,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error(`Error fetching balance for ${userId}/${accountId}:`, error);
            socket.emit('account:error', {
                message: `Failed to fetch balance: ${error.message}`
            });
        }
    });

    // 5. Request current positions
    socket.on('account:positions:get', async (data) => {
        const { accountId, exchangeType, credentials, isTestnet = false, symbols } = data;

        if (!accountId || !exchangeType || !credentials) {
            socket.emit('account:error', { message: 'Missing required fields' });
            return;
        }

        try {
            const positions = await brokerManager.fetchPositions(exchangeType, credentials, isTestnet, symbols);
            socket.emit('account:positions:response', {
                success: true,
                userId,
                accountId,
                exchangeType,
                positions,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error(`Error fetching positions for ${userId}/${accountId}:`, error);
            socket.emit('account:error', {
                message: `Failed to fetch positions: ${error.message}`
            });
        }
    });

    // 6. Request current orders
    socket.on('account:orders:get', async (data) => {
        const { accountId, exchangeType, credentials, isTestnet = false, symbol } = data;

        if (!accountId || !exchangeType || !credentials) {
            socket.emit('account:error', { message: 'Missing required fields' });
            return;
        }

        try {
            const orders = await brokerManager.fetchOpenOrders(exchangeType, credentials, isTestnet, symbol);
            socket.emit('account:orders:response', {
                success: true,
                userId,
                accountId,
                exchangeType,
                orders,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error(`Error fetching orders for ${userId}/${accountId}:`, error);
            socket.emit('account:error', {
                message: `Failed to fetch orders: ${error.message}`
            });
        }
    });

    // 7. Handle disconnection
    socket.on('disconnect', async () => {
        console.log(`[Socket] User ${userId} disconnected from account events`);

        // Stop all private streams for this user
        await stopAllPrivateAccountStreamsForUser(userId);
    });
};
