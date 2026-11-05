import express from 'express';
import { requiredFields } from '../middlewares/index.js';
import { userAuthHandler, loginLimiter } from '../config/index.js';

import * as userAuthController from '../controllers/user.auth.controller.js';

const router = express.Router();

router.post('/register', (req,res,next)=>process.env.ALLOW_REGISTRATION==='false'?res.status(403).json({success:false,message:'Registration is disabled for this private deployment'}):next(), requiredFields('name', 'email', 'password'), userAuthController.register);
router.post('/verify-email/generate', requiredFields('email'), userAuthController.sendVerificationOtp);
router.post('/verify-email/send-link', requiredFields('email'), userAuthController.sendVerificationLink);
router.get('/verify-email/confirm', userAuthController.verifyEmailLink);
router.post('/resend-otp', requiredFields('email'), userAuthController.sendVerificationOtp);
router.post('/verify-email/validate', requiredFields('email', 'otp'), userAuthController.verifyEmailOtp);
router.post('/forgot-password', requiredFields('email'), userAuthController.forgotPassword);
router.post('/reset-password', requiredFields('email', 'token', 'newPassword'), userAuthController.resetPassword);

// complete login, logout, session & callbacks handler by auth.js
router.use("/callback/credentials", loginLimiter);
router.use('/*', userAuthHandler);

export default router;
