import { env } from '../config/env.js';
import { errors } from '../utils/index.js';
import {
  registerUser,
  generateEmailOtp,
  validateEmailOtp,
  sendPasswordResetLink,
  resetPasswordWithToken,
  sendVerificationOtpEmail,
  generatePasswordResetToken,
  generateEmailVerificationToken,
  validateEmailVerificationToken,
  sendVerificationLinkEmail,
} from '../services/index.js';

export const register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    await registerUser({ name, email, password });
    await sendVerificationOtp(req, res, next)
  } catch (err) {
    next(err);
  }
};

export const sendVerificationOtp = async (req, res, next) => {
  try {
    const { email } = req.body;
    const { otp, expiryTime } = await generateEmailOtp(email);
    await sendVerificationOtpEmail(email, otp);
    res.status(201).json({
      success: true,
      message: 'Verification OTP sent to email.',
      data: { email, expiryTime }
    });
  } catch (err) {
    next(err);
  }
};

export const verifyEmailOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    const ok = await validateEmailOtp(email, otp);
    if (!ok) {
      return next(errors.badRequest('Invalid or expired OTP'));
    }
    res.json({ success: true, message: 'Email verified' });
  } catch (err) {
    next(err);
  }
};

export const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const { token, expiryTime } = await generatePasswordResetToken(email);
    // Send reset link via email (uses FRONTEND_URL as base)
    await sendPasswordResetLink(email, token, expiryTime);
    res.json({ success: true, message: 'Password reset link sent to email' });
  } catch (err) {
    next(err);
  }
};

export const resetPassword = async (req, res, next) => {
  try {
    const { email, token, newPassword } = req.body;
    const ok = await resetPasswordWithToken(email, token, newPassword);
    if (!ok) {
      return next(errors.badRequest('Invalid or expired reset token'));
    }
    res.json({ success: true, message: 'Password has been reset' });
  } catch (err) {
    next(err);
  }
};

export const sendVerificationLink = async (req, res, next) => {
  try {
    const { email } = req.body;
    const { token, expiryTime } = await generateEmailVerificationToken(email);
    console.log(token, expiryTime)
    await sendVerificationLinkEmail(email, token, expiryTime);
    res.json({
      success: true,
      message: 'Verification link sent to email.',
    });
  } catch (err) {
    next(err);
  }
};

export const verifyEmailLink = async (req, res, next) => {
  try {
    const { email, token } = req.query;
    const ok = await validateEmailVerificationToken(email, token);
    if (!ok) {
      return res.redirect(`${env.FRONTEND_ORIGIN}/auth/sign-in-2?error=InvalidToken`);
    }
    res.redirect(`${env.FRONTEND_ORIGIN}/auth/sign-in-2?verified=true`);
  } catch (err) {
    next(err);
  }
};

