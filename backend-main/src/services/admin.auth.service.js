import bcrypt from 'bcryptjs';
import { db } from '../config/sqlite.js';

const adminsRef = db.collection('admins');

export const validateAdminCredentials = async (email, password) => {
  const query = await adminsRef.where('email', '==', email).limit(1).get();
  if (query.empty) return null;
  const doc = query.docs[0];
  const admin = { id: doc.id, ...doc.data() };
  const match = await bcrypt.compare(password, admin.password);
  return match ? admin : null;
};

export const saveAdminRefreshToken = async (adminId, token) => {
  await adminsRef.doc(adminId).update({ refreshToken: token });
};

export const clearAdminRefreshToken = async (adminId) => {
  await adminsRef.doc(adminId).update({ refreshToken: null });
};

export const getAdminByRefreshToken = async (token) => {
  const snapshot = await adminsRef.where('refreshToken', '==', token).limit(1).get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
};

export const getAdminById = async (id) => {
  const snap = await adminsRef.doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
};
