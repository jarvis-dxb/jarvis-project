import {
  getNotificationSettings,
  getSmtpSettings,
  saveNotificationSettings,
  saveSmtpSettings,
  testSmtpConnection,
} from '../services/notification.service.js';
import { errors } from '../utils/index.js';

export const getSettings = async (req, res, next) => {
  try {
    const [notifications, smtp] = await Promise.all([
      getNotificationSettings(req.user.id, req.user.email),
      getSmtpSettings(req.user.id),
    ]);

    res.json({ status: 'success', data: { notifications, smtp } });
  } catch (error) {
    next(error);
  }
};

export const updateNotificationSettings = async (req, res, next) => {
  try {
    const notifications = await saveNotificationSettings(req.user.id, req.body || {}, req.user.email);
    res.json({ status: 'success', data: notifications });
  } catch (error) {
    next(error);
  }
};

export const updateSmtpSettings = async (req, res, next) => {
  try {
    const smtp = await saveSmtpSettings(req.user.id, req.body || {});
    res.json({ status: 'success', data: smtp });
  } catch (error) {
    next(error.statusCode ? error : errors.badRequest(error.message));
  }
};

export const testSmtp = async (req, res, next) => {
  try {
    const result = await testSmtpConnection(req.user.id, req.body?.recipientEmail);
    res.json({ status: 'success', message: 'SMTP connected and test email sent', data: result });
  } catch (error) {
    next(error.statusCode ? error : errors.badRequest(error.message));
  }
};
