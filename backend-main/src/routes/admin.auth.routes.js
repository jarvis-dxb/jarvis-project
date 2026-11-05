import express from 'express';
import { adminAuthHandler, loginLimiter } from '../config/index.js';

const router = express.Router();

// complete login, logout, session & callbacks handler by auth.js
router.use("/callback/credentials", loginLimiter);
router.use('/*', adminAuthHandler);

export default router;
