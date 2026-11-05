import bcrypt from 'bcryptjs';
import moment from 'moment';
import crypto from 'crypto';
import { db, serverTimestamp } from '../config/sqlite.js';

import { env } from '../config/env.js';
import { errors } from '../utils/index.js';

const usersRef = db.collection('users');

const normalizeEmail = (email) => email?.trim()?.toLowerCase();

export const registerUser = async ({ name, email, password, role = 'user' }) => {
  const user = await getUserByEmail(normalizeEmail(email));
  if (user?.email) {
    throw errors.badRequest('Email already in use');
  }

  const hashed = await bcrypt.hash(password, env.SALT_ROUNDS);
  return createUser({
    name,
    email: normalizeEmail(email),
    password: hashed,
    role,
    limitTrades: '10',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
};

export const validateCredentials = async (email, password) => {
  const user = await getUserByEmail(normalizeEmail(email));
  if (!user || !user?.email) {
    throw errors.unauthorized('Email does not exist');
  }
  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    throw errors.unauthorized('Invalid email or password');
  }
  return user;
};

export const saveRefreshToken = async (userId, token) => {
  await updateUser(userId, { refreshToken: token });
};

export const clearRefreshToken = async (userId) => {
  await updateUser(userId, { refreshToken: null });
};

export const getUserByRefreshToken = async (token) => {
  const snapshot = await usersRef
    .where('refreshToken', '==', token)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
};

function makeOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export const generateEmailOtp = async (email) => {
  const user = await getUserByEmail(normalizeEmail(email));
  if (!user) {
    throw errors.notFound('User not found');
  }
  const otp = makeOtp();
  const expiryTime = moment().add(env.LINK_AND_OTP_EXPIRY_MINUTES, 'minutes').valueOf();
  const otpCode = {
    value: otp,
    expiryTime,
  }
  await updateUser(user.id, { otpCode });
  return { otp, expiryTime };
};

export const validateEmailOtp = async (email, otp) => {
  const user = await getUserByEmail(normalizeEmail(email));
  if (!user || !user.otpCode || !user.otpCode.expiryTime) return false;
  if (moment().isAfter(user.otpCode.expiryTime)) return false;
  const match = otp === user.otpCode.value;
  if (match) {
    await updateUser(user.id, { otpCode: null, verified: true });
  }
  return match;
};

export const generatePasswordResetToken = async (email) => {
  const user = await getUserByEmail(normalizeEmail(email));
  if (!user) {
    throw errors.notFound('User not found');
  }
  // generate a random token and store a hashed version
  const token = crypto.randomBytes(32).toString('hex');
  // const hashed = await bcrypt.hash(token, env.SALT_ROUNDS);
  const expiryTime = moment().add(env.LINK_AND_OTP_EXPIRY_MINUTES, 'minutes').valueOf();
  const resetToken = {
    value: token,
    expiryTime,
  }
  await updateUser(user.id, { resetToken });
  return { token, expiryTime };
};

export const resetPasswordWithToken = async (email, token, newPassword) => {
  const user = await getUserByEmail(normalizeEmail(email));
  if (!user || !user?.resetToken?.value || !user?.resetToken?.expiryTime) return false;
  if (moment().isAfter(user.resetToken.expiryTime)) return false;
  // const match = await bcrypt.compare(token, user.resetToken.value);
  const match = (token === user.resetToken.value);
  if (!match) return false;
  const hashedPass = await bcrypt.hash(newPassword, env.SALT_ROUNDS);
  await updateUser(user.id, { password: hashedPass, resetToken: null });
  return true;
};

export const generateEmailVerificationToken = async (email) => {
  const user = await getUserByEmail(normalizeEmail(email));
  if (!user) {
    throw errors.notFound('User not found');
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiryTime = moment().add(env.LINK_AND_OTP_EXPIRY_MINUTES, 'minutes').valueOf();
  const verificationToken = {
    value: token,
    expiryTime,
  }
  await updateUser(user.id, { verificationToken });
  return { token, expiryTime };
};

export const validateEmailVerificationToken = async (email, token) => {
  const user = await getUserByEmail(normalizeEmail(email));
  if (!user || !user.verificationToken || !user.verificationToken.expiryTime) return false;
  if (moment().isAfter(user.verificationToken.expiryTime)) return false;
  const match = token === user.verificationToken.value;
  if (match) {
    await updateUser(user.id, { otpCode: null, verificationToken: null, verified: true });
  }
  return match;
};

export const createUser = async (userData) => {
  const ref = await usersRef.add(userData);
  const snap = await ref.get();
  return { id: snap.id, ...snap.data() };
};

export const getUserById = async (id) => {
  try {
    const doc = await usersRef.doc(id).get();

    if (!doc.exists) return null;

    return { id: doc.id, ...doc.data() };
  } catch (error) {
    console.error("Error fetching user by ID:", error);
    return null;
  }
};

export const getUserByEmail = async (email) => {
  const query = await usersRef.where('email', '==', email.toLowerCase()).limit(1).get();
  if (query.empty) return null;
  const doc = query.docs[0];
  return { id: doc.id, ...doc.data() };
};

export const updateUser = async (id, updates) => {
  // if password is being changed, hash it before saving
  if (updates.password) {
    updates.password = await bcrypt.hash(updates.password, env.SALT_ROUNDS);
  }
  await usersRef.doc(id).update(updates);
  return getUserById(id);
};

export const deleteUser = async (id) => {
  await usersRef.doc(id).delete();
};

export const listUsers = async () => {
  const snapshot = await usersRef.get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
};
