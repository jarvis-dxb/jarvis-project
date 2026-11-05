import express from 'express';

import * as controller from '../controllers/notification.controller.js';
import { authenticateUser } from '../middlewares/index.js';

const router = express.Router();

router.use(authenticateUser);
router.get('/settings', controller.getSettings);
router.put('/settings', controller.updateNotificationSettings);
router.put('/smtp', controller.updateSmtpSettings);
router.post('/smtp/test', controller.testSmtp);

export default router;
