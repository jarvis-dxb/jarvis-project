import express from 'express';
import userAuthRoutes from './user.auth.routes.js';
import adminAuthRoutes from './admin.auth.routes.js';
import userAccountRoutes from './user.account.routes.js';
import exchangeRoutes from './exchange.routes.js';
import watcherRoutes from './watcher.routes.js';
import notificationRoutes from './notification.routes.js';
import whatsappRoutes from './whatsapp.routes.js';
import portfolioRoutes from './portfolio.routes.js';
import tradeCalendarRoutes from './trade-calendar.routes.js';
import setupBackupRoutes from './setup-backup.routes.js';
import tradeApprovalRoutes from './trade-approval.routes.js';

const router = express.Router();

// authentication system
router.use('/user/auth', userAuthRoutes);
router.use('/admin/auth', adminAuthRoutes);

router.use('/platform/exchanges/rest', exchangeRoutes);
router.use('/user/portal/accounts', userAccountRoutes);
router.use('/watcher', watcherRoutes);
router.use('/notifications', notificationRoutes);
router.use('/whatsapp', whatsappRoutes);
router.use('/portfolio', portfolioRoutes);
router.use('/trade-calendar', tradeCalendarRoutes);
router.use('/setup-backups', setupBackupRoutes);
router.use('/trade-approvals', tradeApprovalRoutes);

export default router;
