import { db, serverTimestamp, formatTimestamp } from '../config/sqlite.js';

const dbRef = db.collection('userAccounts');

export const createUserAccount = async (accountData) => {
    const { createdAt, updatedAt, ...cleanData } = accountData;
    const ref = await dbRef.add({
        ...cleanData,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    });
    return getUserAccountById(ref.id);
};

export const getUserAccountsByUserId = async (userId) => {
    const snapshot = await dbRef.where('userId', '==', userId).get();
    return snapshot.docs.map(doc => {
        const data = doc.data();

        data.createdAt = formatTimestamp(data.createdAt);
        data.updatedAt = formatTimestamp(data.updatedAt);

        return { id: doc.id, ...data };
    });
};

export const getUserAccountById = async (id) => {
    const doc = await dbRef.doc(id).get();
    if (!doc.exists) return null;

    const data = doc.data();
    data.createdAt = formatTimestamp(data.createdAt);
    data.updatedAt = formatTimestamp(data.updatedAt);

    return { id: doc.id, ...data };
};

export const updateUserAccount = async (id, updates) => {
    const { createdAt, updatedAt, ...cleanData } = updates;
    await dbRef.doc(id).update({
        ...cleanData,
        updatedAt: serverTimestamp(),
    });
    return getUserAccountById(id);
};

export const deleteUserAccount = async (id) => {
    await dbRef.doc(id).delete();
    return true;
};
