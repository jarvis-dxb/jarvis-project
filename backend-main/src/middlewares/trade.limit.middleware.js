import { db } from '../config/sqlite.js';
import { errors } from '../utils/index.js';

// Local cache of users synced in real-time with SQLite
const users = new Map();

// User IDs in this array will bypass all trade and setup creation limit checks
const ALLOWED_UNLIMITED_TRADES_USER_IDS = [
  // 'awais@gmail.com',
  // 'tahir@gmail.com',
  // 'bilal@gmail.com',
  // 'saboor@gmail.com',
  // 'kamran@gmail.com',
  // 'khurram@gmail.com',
  // 'salman@gmail.com',
  // 'ahmed@gmail.com',
  // 'iqra@gmail.com',
];

// Initialize one-time subscription to 'users' collection
db.collection('users').onSnapshot(
  (snapshot) => {
    users.clear();
    snapshot.docs.forEach((document) => {
      users.set(document.id, document.data());
    });
  },
  (error) => {
    console.error("Trade Limit Middleware Error:", error);
  }
);

export const checkTradeLimit = async (req, res, next) => {
  try {
    const userId = req.user?.id || req.body?.userId;
    if (!userId) {
      return next();
    }

    // Bypass all limit checks if the user is allowed unlimited trades
    if (ALLOWED_UNLIMITED_TRADES_USER_IDS.includes(userId)) {
      return next();
    }

    // Retrieve user data from local cache with a database fallback
    let userData = users.get(userId);
    if (!userData) {
      const userDoc = await db.collection('users').doc(userId).get();
      if (!userDoc.exists) {
        return next(errors.notFound('User not found'));
      }
      userData = userDoc.data();
      users.set(userId, userData); // Update local cache
    }

    // Check if user's role is authorized (should be 'user' or 'admin')
    const allowedRoles = ['user', 'admin'];
    if (!userData.role || !allowedRoles.includes(userData.role)) {
      return next(errors.forbidden('Unauthorized role'));
    }

    // Update req.user's role if present to match the SQLite data
    if (req.user) {
      req.user.role = userData.role;
    }

    const limitTrades = parseInt(userData.limitTrades || 10, 10);

    // Fetch total setups count
    const setupsSnapshot = await db.collection('setups')
      .where('userId', '==', userId)
      .get();
    const setupsCount = setupsSnapshot.size;

    const method = req.method;
    const path = req.path;

    if (method === 'POST') {
      if (path === '/setups') {
        // Setup creation: Block if we've reached or exceeded limitTrades
        if (setupsCount >= limitTrades) {
          return next(errors.forbidden('limit reached'));
        }
      } else if (path === '/order/market/buy') {
        // Trade execution: Block if setups count exceeds limitTrades
        if (setupsCount > limitTrades) {
          return next(errors.forbidden('limit reached'));
        }
      }
    }

    next();
  } catch (error) {
    console.error("Trade Limit Middleware Error:", error);
    next(error);
  }
};
