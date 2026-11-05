/**
 * Email Service
 * Handles all email sending operations for the application
 * Currently logs to console; replace with nodemailer/SendGrid/AWS SES as needed
 */

// In production, configure with actual email provider:
// import nodemailer from 'nodemailer';
// const transporter = nodemailer.createTransport({ ... });

import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const EMAIL_FROM = env.EMAIL_FROM || 'noreply@example.com';

let transporter = null;
const createTransporter = () => {
  if (!env.EMAIL_HOST || !env.EMAIL_PORT || !env.EMAIL_USER || !env.EMAIL_PASS) {
    console.warn('Email transport disabled: SMTP settings are not configured');
    return null;
  }
  try {
    const options = {
      host: env.EMAIL_HOST,
      // service: process.env.SERVICE, //comment this line if you use custom server/domain
      port: Number(env.EMAIL_PORT),
      secure: (env.EMAIL_SECURE === 'true') || Number(env.EMAIL_PORT) === 465,
      auth: {
        user: env.EMAIL_USER,
        pass: env.EMAIL_PASS,
      },
    };

    return nodemailer.createTransport(options);
  } catch (err) {
    console.error('❌ [EMAIL TRANSPORT ERROR]', err);
    return null;
  }
};

transporter = createTransporter();

// verify connection configuration (useful for debugging during startup)
if (transporter) {
  transporter
    .verify()
    .then(() => console.log('Connected to email server'))
    .catch(() => {
      console.error('Unable to connect to email server; email features remain disabled');
      transporter = null;
    });
}

export const sendVerificationOtpEmail = async (email, otp) => {
  const subject = `${env.APP_NAME} Verification ${otp}`;
  const html = `
    <div style="max-width: 450px; margin: 20px auto; padding: 32px; border: 1px solid #e4e4e7; border-radius: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #ffffff; color: #09090b;">
        <div style="margin-bottom: 24px;">
            <h2 style="margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.025em; color: #09090b;">
                Verify email
            </h2>
            <p style="margin: 8px 0 0; font-size: 15px; color: #71717a; line-height: 1.5;">
                Thanks for signing up! Use the verification code below to complete your registration.
            </p>
        </div>
        
        <div style="margin: 32px 0; padding: 8px; background-color: #f4f4f5; border-radius: 8px; text-align: center; border: 1px dashed #d1d1d6;">
            <span style="font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #18181b;">
            ${otp}
            </span>
        </div>

        <div style="padding: 16px; background-color: #fffaf0; border: 1px solid #feebc8; border-radius: 8px; margin-bottom: 24px;">
            <p style="margin: 0; font-size: 13px; color: #9c4221; line-height: 1.5;">
                <strong>Note:</strong> This code is valid for <b>${env.LINK_AND_OTP_EXPIRY_MINUTES} minute(s)</b>. If you didn't request this, you can safely ignore this email.
            </p>
        </div>
        
        <div style="height: 1px; background-color: #e4e4e7; margin-bottom: 24px;"></div>

        <div style="text-align: center;">
            <p style="margin: 0; font-size: 12px; color: #a1a1aa;">
            &copy; 2026 ${env.APP_NAME} Automation.
            </p>
        </div>
    </div>
  `;

  return sendEmail(email, subject, html);
};

export const sendPasswordResetLink = async (email, token, expiryTime) => {
  const BASE = env.FRONTEND_ORIGIN;
  const expiryMinutes = env.LINK_AND_OTP_EXPIRY_MINUTES;
  const link = `${BASE.replace(/\/$/, '')}/auth/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}&expiryTime=${expiryTime}`;
  const subject = `${env.APP_NAME} Password Reset`;
  const html = `
    <div style="max-width: 450px; margin: 20px auto; padding: 32px; border: 1px solid #e4e4e7; border-radius: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #ffffff; color: #09090b;">
        <div style="margin-bottom: 24px;">
            <h2 style="margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.025em; color: #09090b;">
                Reset password
            </h2>
            <p style="margin: 8px 0 0; font-size: 15px; color: #71717a; line-height: 1.5;">
                Click the button below to reset your password. This link is valid for ${expiryMinutes} minute(s).
            </p>
        </div>

        <div style="margin: 32px 0; text-align: center;">
            <a href="${link}" style="display: block; background-color: #18181b; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 8px; font-size: 15px; font-weight: 500; text-align: center;">
                Reset Password
            </a>
        </div>

        <div style="padding: 16px; background-color: #fffaf0; border: 1px solid #feebc8; border-radius: 8px; margin-bottom: 24px;">
            <p style="margin: 0; font-size: 13px; color: #9c4221; line-height: 1.5;">
                <strong>Tip:</strong> If the button above doesn't work, copy and paste the following link into your browser.
            </p>
            <br />
            <a href="${link}" style="color: #9c4221; word-break: break-all;">${link}</a>
        </div>

        <div style="height: 1px; background-color: #e4e4e7; margin-bottom: 24px;"></div>

        <div style="text-align: center;">
            <p style="margin: 0; font-size: 12px; color: #a1a1aa;">
                &copy; 2026 ${env.APP_NAME} Automation.
            </p>
        </div>
    </div>
  `;

  return sendEmail(email, subject, html);
};

export const sendWelcomeEmail = async (email, name) => {
  const subject = `Welcome to ${env.APP_NAME}!`;
  const html = `
    <h2>Welcome, ${name}!</h2>
    <p>Thank you for signing up. Your account is ready to use.</p>
    <p>If you have any questions, feel free to reach out to our support team.</p>
  `;

  return sendEmail(email, subject, html);
};

export const sendPasswordChangedSuccess = async (email, name) => {
  const subject = `${env.APP_NAME} Password Changed Successfully`;
  const html = `
    <div style="max-width: 450px; margin: 20px auto; padding: 32px; border: 1px solid #e4e4e7; border-radius: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #ffffff; color: #09090b;">
        <div style="margin-bottom: 24px;">
            <h2 style="margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.025em; color: #09090b;">
                Password changed
            </h2>
            <p style="margin: 8px 0 0; font-size: 15px; color: #71717a; line-height: 1.5;">
                Hi ${name}, your password has been changed successfully. If you didn't make this change, please secure your account immediately.
            </p>
        </div>

        <div style="padding: 16px; background-color: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; margin-bottom: 24px;">
            <p style="margin: 0; font-size: 13px; color: #15803d; line-height: 1.5;">
                <strong>✓ Success:</strong> Your account password has been updated successfully.
            </p>
        </div>

        <div style="padding: 16px; background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; margin-bottom: 24px;">
            <p style="margin: 0; font-size: 13px; color: #991b1b; line-height: 1.5;">
                <strong>Important:</strong> If you did not make this change, please contact our support team immediately.
            </p>
        </div>

        <div style="height: 1px; background-color: #e4e4e7; margin-bottom: 24px;"></div>

        <div style="text-align: center;">
            <p style="margin: 0; font-size: 12px; color: #a1a1aa;">
                &copy; 2026 ${env.APP_NAME} Automation.
            </p>
        </div>
    </div>
  `;

  return sendEmail(email, subject, html);
};

const sendEmail = async (to, subject, html) => {

  try {
    if (!transporter) {
      throw new Error('Email transport is not configured');
    }
    const info = await transporter.sendMail({
      from: EMAIL_FROM,
      to,
      subject,
      html,
    });

    return { success: true, messageId: info.messageId || info.response, raw: info };
  } catch (err) {
    console.error('❌ [EMAIL ERROR]', err);
    // rethrow so callers may handle failures
    throw err;
  }
};

export const sendVerificationLinkEmail = async (email, token, expiryTime) => {
  const BASE = process.env.APP_ORIGIN || env.SERVER_ORIGIN;
  const expiryMinutes = env.LINK_AND_OTP_EXPIRY_MINUTES;
  const link = `${BASE.replace(/\/$/, '')}/api/v1/user/auth/verify-email/confirm?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}&expiryTime=${expiryTime}`;
  const subject = `${env.APP_NAME} Email Verification`;
  const html = `
    <div style="max-width: 450px; margin: 20px auto; padding: 32px; border: 1px solid #e4e4e7; border-radius: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #ffffff; color: #09090b;">
        <div style="margin-bottom: 24px;">
            <h2 style="margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.025em; color: #09090b;">
                Verify your email
            </h2>
            <p style="margin: 8px 0 0; font-size: 15px; color: #71717a; line-height: 1.5;">
                Click the button below to verify your email address. This link is valid for ${expiryMinutes} minute(s).
            </p>
        </div>

        <div style="margin: 32px 0; text-align: center;">
            <a href="${link}" style="display: block; background-color: #18181b; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 8px; font-size: 15px; font-weight: 500; text-align: center;">
                Verify Email
            </a>
        </div>

        <div style="padding: 16px; background-color: #fffaf0; border: 1px solid #feebc8; border-radius: 8px; margin-bottom: 24px;">
            <p style="margin: 0; font-size: 13px; color: #9c4221; line-height: 1.5;">
                <strong>Tip:</strong> If the button above doesn't work, copy and paste the following link into your browser.
            </p>
            <br />
            <a href="${link}" style="color: #9c4221; word-break: break-all;">${link}</a>
        </div>

        <div style="height: 1px; background-color: #e4e4e7; margin-bottom: 24px;"></div>

        <div style="text-align: center;">
            <p style="margin: 0; font-size: 12px; color: #a1a1aa;">
                &copy; 2026 ${env.APP_NAME} Automation.
            </p>
        </div>
    </div>
  `;

  return sendEmail(email, subject, html);
};

export default {
  sendVerificationOtpEmail,
  sendVerificationLinkEmail,
  sendPasswordResetLink,
  sendWelcomeEmail,
  sendPasswordChangedSuccess,
  sendEmail,
};
