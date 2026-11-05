import { db } from '../config/sqlite.js';

// Track active SQLite listeners per user
const userSetupListeners = new Map();

/**
 * Start SQLite subscription for user's setups
 */
const startSetupSubscription = async (io, userId) => {
    if (!userId) {
        console.error('Cannot start setup subscription: userId is required');
        return;
    }

    // If user already has an active listener, remove it first
    if (userSetupListeners.has(userId)) {
        const unsubscribe = userSetupListeners.get(userId);
        unsubscribe();
        userSetupListeners.delete(userId);
    }

    try {
        const setupsRef = db.collection('setups');
        // Create query for this user's setups
        const query = setupsRef.where('userId', '==', userId)
        // .orderBy('createdAt', 'desc');

        // Set up real-time listener
        const unsubscribe = query.onSnapshot(
            (snapshot) => {
                const setups = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                if (snapshot.empty) {
                    console.log(`[Setup Events] No active setups found for user ${userId}.`);
                }

                setups.sort((a, b) => {
                    const aTime = a.createdAt?.toDate?.()?.getTime() || 0
                    const bTime = b.createdAt?.toDate?.()?.getTime() || 0
                    // return aTime - bTime
                    return bTime - aTime
                })

                // Emit to the specific user via their user room
                io.to(`u:${userId}`).emit('subscribe_setups', {
                    success: true,
                    userId,
                    setups,
                    timestamp: new Date().toISOString()
                });

                console.log(`[Setup Events] Sent ${setups.length} setups to user ${userId}`);
            },
            (error) => {
                console.error(`[Setup Events] Error in SQLite subscription for user ${userId}:`, error);

                // Notify user of error
                io.to(`u:${userId}`).emit('subscribe_setups', {
                    success: false,
                    userId,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        );

        // Store the unsubscribe function for cleanup
        userSetupListeners.set(userId, unsubscribe);
        console.log(`[Setup Events] Started SQLite subscription for user ${userId}`);

    } catch (error) {
        console.error(`[Setup Events] Failed to start subscription for user ${userId}:`, error);
    }
};

/**
 * Stop SQLite subscription for a user
 */
const stopSetupSubscription = (userId) => {
    if (userSetupListeners.has(userId)) {
        const unsubscribe = userSetupListeners.get(userId);
        unsubscribe();
        userSetupListeners.delete(userId);
        console.log(`[Setup Events] Stopped SQLite subscription for user ${userId}`);
    }
};

/**
 * Stop all setup subscriptions (cleanup on server shutdown)
 */
export const stopAllSetupSubscriptions = () => {
    for (const [userId, unsubscribe] of userSetupListeners.entries()) {
        unsubscribe();
        console.log(`[Setup Events] Cleaned up subscription for user ${userId}`);
    }
    userSetupListeners.clear();
};

/**
 * Register setup-related socket events
 */
export const registerSetupPageEvents = (io, socket) => {
    const userId = socket.userId;

    if (!userId) {
        console.warn('[Setup Events] Socket connected without userId, skipping setup events');
        return;
    }

    console.log(`[Setup Events] User ${userId} connected to setup events`);

    // Handle subscribe_setups request
    socket.on('subscribe_setups', async (data = {}) => {
        console.log(`[Setup Events] User ${userId} requested setup subscription`);

        try {
            await startSetupSubscription(io, userId);

            // Send immediate acknowledgment
            socket.emit('subscribe_setups', {
                success: true,
                userId,
                message: 'Setup subscription started',
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error(`[Setup Events] Failed to start setup subscription for user ${userId}:`, error);
            socket.emit('subscribe_setups', {
                success: false,
                userId,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    });

    // Handle unsubscribe_setups request
    socket.on('unsubscribe_setups', () => {
        console.log(`[Setup Events] User ${userId} requested setup unsubscription`);
        stopSetupSubscription(userId);

        socket.emit('unsubscribe_setups', {
            success: true,
            userId,
            message: 'Setup subscription stopped',
            timestamp: new Date().toISOString()
        });
    });

    // Clean up on socket disconnect
    socket.on('disconnect', () => {
        console.log(`[Setup Events] User ${userId} disconnected, cleaning up setup subscription`);
        stopSetupSubscription(userId);
    });
};
