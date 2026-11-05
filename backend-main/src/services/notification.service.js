import nodemailer from 'nodemailer';

import { db } from '../config/sqlite.js';
import { decrypt, encrypt } from '../utils/encryption.js';

const DEFAULT_SETTINGS = Object.freeze({
  emailEnabled: false,
  recipientEmail: '',
  emailOnActivation: true,
  emailOnExecution: true,
  includeProfitLoss: true,
  browserPopupEnabled: true,
  browserNotificationEnabled: true,
  soundEnabled: true,
  soundId: 'digital',
  soundVolume: 0.55,
});

const SETTINGS_COLLECTION = 'notificationSettings';
const SMTP_COLLECTION = 'smtpSettings';

const clampVolume = (value) => Math.min(1, Math.max(0, Number(value) || 0));
const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const getUser = async (userId) => {
  const snapshot = await db.collection('users').doc(userId).get();
  return snapshot.data() || {};
};

export const getNotificationSettings = async (userId, fallbackEmail = '') => {
  const snapshot = await db.collection(SETTINGS_COLLECTION).doc(userId).get();
  const user = fallbackEmail ? {} : await getUser(userId);
  const stored = snapshot.data() || {};

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    recipientEmail: stored.recipientEmail || fallbackEmail || user.email || '',
    soundVolume: clampVolume(stored.soundVolume ?? DEFAULT_SETTINGS.soundVolume),
  };
};

export const saveNotificationSettings = async (userId, values, fallbackEmail = '') => {
  const current = await getNotificationSettings(userId, fallbackEmail);
  const allowed = {
    emailEnabled: Boolean(values.emailEnabled),
    recipientEmail: String(values.recipientEmail || current.recipientEmail || '').trim(),
    emailOnActivation: values.emailOnActivation !== false,
    emailOnExecution: values.emailOnExecution !== false,
    includeProfitLoss: values.includeProfitLoss !== false,
    browserPopupEnabled: values.browserPopupEnabled !== false,
    browserNotificationEnabled: values.browserNotificationEnabled !== false,
    soundEnabled: values.soundEnabled !== false,
    soundId: ['digital', 'chime', 'bell', 'pulse', 'success'].includes(values.soundId)
      ? values.soundId
      : current.soundId,
    soundVolume: clampVolume(values.soundVolume ?? current.soundVolume),
    updatedAt: new Date(),
  };

  await db.collection(SETTINGS_COLLECTION).doc(userId).set(allowed, { merge: true });
  return getNotificationSettings(userId, fallbackEmail);
};

export const getSmtpSettings = async (userId, { includeSecret = false } = {}) => {
  const snapshot = await db.collection(SMTP_COLLECTION).doc(userId).get();
  const stored = snapshot.data() || {};
  const publicSettings = {
    host: stored.host || '',
    port: Number(stored.port) || 587,
    secure: Boolean(stored.secure),
    username: stored.username || '',
    fromEmail: stored.fromEmail || '',
    fromName: stored.fromName || 'Jarvis Trading',
    passwordConfigured: Boolean(stored.passwordEncrypted),
    verifiedAt: stored.verifiedAt || null,
    lastError: stored.lastError || '',
  };

  if (!includeSecret) return publicSettings;

  return {
    ...publicSettings,
    password: stored.passwordEncrypted ? decrypt(stored.passwordEncrypted) : '',
  };
};

export const saveSmtpSettings = async (userId, values) => {
  const currentSnapshot = await db.collection(SMTP_COLLECTION).doc(userId).get();
  const current = currentSnapshot.data() || {};
  const password = String(values.password || '');
  const host = String(values.host || '').trim();
  const username = String(values.username || '').trim();
  const fromEmail = String(values.fromEmail || '').trim();
  const port = Number(values.port);

  if (!host) throw new Error('SMTP host is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP port is invalid');
  if (!username) throw new Error('SMTP username is required');
  if (!fromEmail) throw new Error('From email is required');
  if (!password && !current.passwordEncrypted) throw new Error('SMTP password is required');

  await db.collection(SMTP_COLLECTION).doc(userId).set({
    host,
    port,
    secure: Boolean(values.secure),
    username,
    fromEmail,
    fromName: String(values.fromName || 'Jarvis Trading').trim(),
    passwordEncrypted: password ? encrypt(password) : current.passwordEncrypted,
    verifiedAt: null,
    lastError: '',
    updatedAt: new Date(),
  }, { merge: true });

  return getSmtpSettings(userId);
};

const createUserTransporter = async (userId, timeouts = {}) => {
  const settings = await getSmtpSettings(userId, { includeSecret: true });
  if (!settings.host || !settings.username || !settings.password) {
    throw new Error('SMTP settings are incomplete');
  }

  return {
    settings,
    transporter: nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure || settings.port === 465,
      auth: {
        user: settings.username,
        pass: settings.password,
      },
      ...timeouts,
    }),
  };
};

const setSmtpVerification = async (userId, { verifiedAt = null, lastError = '' }) => {
  await db.collection(SMTP_COLLECTION).doc(userId).set({
    verifiedAt,
    lastError,
    updatedAt: new Date(),
  }, { merge: true });
};

export const testSmtpConnection = async (userId, recipientOverride = '') => {
  try {
    const { transporter, settings } = await createUserTransporter(userId);
    await transporter.verify();

    const notificationSettings = await getNotificationSettings(userId);
    const recipient = String(recipientOverride || notificationSettings.recipientEmail || settings.username).trim();
    if (!recipient) throw new Error('Recipient email is required');

    const info = await transporter.sendMail({
      from: `"${settings.fromName || 'Jarvis Trading'}" <${settings.fromEmail}>`,
      to: recipient,
      subject: 'Jarvis SMTP connection successful',
      html: '<h2>SMTP connected successfully</h2><p>Your Jarvis trade email alerts are ready.</p>',
    });

    const verifiedAt = new Date();
    await setSmtpVerification(userId, { verifiedAt, lastError: '' });
    return { success: true, messageId: info.messageId || info.response, verifiedAt };
  } catch (error) {
    await setSmtpVerification(userId, { verifiedAt: null, lastError: error.message });
    throw error;
  }
};

const formatTarget = (value, mode) => {
  if (value === undefined || value === null || value === '') return 'Not configured';
  if (mode === '%') return `${value}%`;
  if (mode === 'pnl') return `$${value} PnL`;
  return `${value} price`;
};

const summarizeResults = (results = []) => results.map((result) => ({
  account: result.account,
  exchange: result.exchange,
  symbol: result.symbol,
  side: result.side,
  success: Boolean(result.success),
  orderId: result.order?.id || result.order?.orderId || '',
  entryPrice: result.order?.average || result.order?.price || '',
  filledQuantity: result.order?.filled || result.order?.amount || '',
  stopLossOrderId: result.slOrder?.id || result.slOrder?.orderId || '',
  takeProfitOrderId: result.tpOrder?.id || result.tpOrder?.orderId || '',
  error: result.error || '',
  stopLossError: result.slError || '',
  takeProfitError: result.tpError || '',
}));

export const buildTradeNotification = ({ type, setup = {}, results = [] }) => {
  const isActivation = type === 'trade_activated';
  const title = isActivation ? 'Trade automation activated' : 'Trade executed';
  const symbol = Array.isArray(setup.tradingSymbol)
    ? setup.tradingSymbol.join(', ')
    : (setup.tradingSymbol || setup.triggerSymbol || 'Unknown symbol');
  const details = {
    setupId: setup.id || '',
    setupName: setup.setupName || 'Trading setup',
    symbol,
    triggerSymbol: setup.triggerSymbol || '',
    side: setup.side || '',
    margin: setup.margin || '',
    leverage: setup.leverage || '',
    takeProfit: formatTarget(setup.TP, setup.TP_mode),
    stopLoss: formatTarget(setup.SL, setup.SL_mode),
    repeatProgress: `${Number(setup.triggeredCounter || 0)}/${Number(setup.repeatCounter || 1)}`,
    results: summarizeResults(results),
    timestamp: new Date().toISOString(),
  };

  return {
    type,
    title,
    message: `${details.setupName} · ${symbol} · ${String(details.side || '').toUpperCase()}`,
    details,
  };
};

const renderTradeEmail = (notification, includeProfitLoss) => {
  const { details } = notification;
  const resultRows = details.results.length
    ? details.results.map((result) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #27272a">${escapeHtml(result.exchange || result.account)}</td>
        <td style="padding:8px;border-bottom:1px solid #27272a">${escapeHtml(result.symbol)}</td>
        <td style="padding:8px;border-bottom:1px solid #27272a;color:${result.success ? '#22c55e' : '#ef4444'}">${result.success ? 'Executed' : `Failed: ${escapeHtml(result.error)}`}</td>
        <td style="padding:8px;border-bottom:1px solid #27272a">${escapeHtml(result.entryPrice || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #27272a">${escapeHtml(result.orderId || '-')}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" style="padding:8px">Automation is active and waiting for its trigger.</td></tr>';

  return `
    <div style="max-width:720px;margin:20px auto;padding:28px;border-radius:14px;background:#111214;color:#f4f4f5;font-family:Arial,sans-serif;border:1px solid #2a2a2a">
      <div style="font-size:12px;color:#60a5fa;text-transform:uppercase;letter-spacing:.12em">Jarvis Trade Alert</div>
      <h2 style="margin:8px 0 4px">${escapeHtml(notification.title)}</h2>
      <p style="margin:0 0 22px;color:#a1a1aa">${escapeHtml(notification.message)}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <tr><td style="padding:7px;color:#a1a1aa">Margin</td><td style="padding:7px">$${escapeHtml(details.margin || '-')}</td><td style="padding:7px;color:#a1a1aa">Leverage</td><td style="padding:7px">${escapeHtml(details.leverage || '-')}x</td></tr>
        ${includeProfitLoss ? `<tr><td style="padding:7px;color:#a1a1aa">Take profit</td><td style="padding:7px;color:#22c55e">${escapeHtml(details.takeProfit)}</td><td style="padding:7px;color:#a1a1aa">Stop loss</td><td style="padding:7px;color:#ef4444">${escapeHtml(details.stopLoss)}</td></tr>` : ''}
      </table>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="text-align:left;color:#a1a1aa"><th style="padding:8px">Exchange</th><th style="padding:8px">Symbol</th><th style="padding:8px">Status</th><th style="padding:8px">Entry</th><th style="padding:8px">Order ID</th></tr></thead>
        <tbody>${resultRows}</tbody>
      </table>
      <p style="margin:22px 0 0;color:#71717a;font-size:12px">${escapeHtml(details.timestamp)}</p>
    </div>`;
};

export const sendTradeAlert = async ({ userId, type, setup, results = [] }) => {
  const user = await getUser(userId);
  const settings = await getNotificationSettings(userId, user.email);
  const eventEnabled = type === 'trade_activated'
    ? settings.emailOnActivation
    : settings.emailOnExecution;

  if (!settings.emailEnabled || !eventEnabled) {
    return { success: false, skipped: true, reason: 'Trade email alert is disabled' };
  }

  const recipient = settings.recipientEmail || user.email;
  if (!recipient) return { success: false, skipped: true, reason: 'Recipient email is missing' };

  const { transporter, settings: smtp } = await createUserTransporter(userId);
  const notification = buildTradeNotification({ type, setup, results });
  const info = await transporter.sendMail({
    from: `"${smtp.fromName || 'Jarvis Trading'}" <${smtp.fromEmail}>`,
    to: recipient,
    subject: `[Jarvis] ${notification.title}: ${notification.details.symbol}`,
    html: renderTradeEmail(notification, settings.includeProfitLoss),
  });

  return { success: true, messageId: info.messageId || info.response };
};

export async function sendApprovalEmail({userId,subject,text}) {
  const preferences=await getNotificationSettings(userId);
  if(!preferences.emailEnabled || !preferences.recipientEmail) return {status:'not_configured',reason:'Enable email notifications and select a recipient in Settings.'};
  // Bound network waits; uncertain mail outcomes are not automatically retried.
  const {transporter,settings:smtp}=await createUserTransporter(userId,{connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000});
  const info=await transporter.sendMail({from:`"${smtp.fromName || 'Jarvis Trading'}" <${smtp.fromEmail}>`,to:preferences.recipientEmail,subject,text});
  return {status:'submitted',messageId:info.messageId || ''};
}

export const defaultNotificationSettings = DEFAULT_SETTINGS;
