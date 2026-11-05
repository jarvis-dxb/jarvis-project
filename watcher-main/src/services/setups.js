import { db } from '../config/database.js';

let setups = [];

export function subscribeToSetups() {
    const query = db.collection('setups').where('isCompleted', '==', false);
    let resolveReady,rejectReady;
    const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});

    const unsubscribe = query.onSnapshot(async (snapshot) => {
        setups = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (snapshot.empty) {
            console.log('[SQLite] No active setups to watch.');
        } else {
            console.log(`[SQLite] Monitoring ${setups.length} setups.`);
        }

        setups.sort((a, b) => {
            const aTime = a.createdAt?.toDate?.()?.getTime() || new Date(a.createdAt || 0).getTime();
            const bTime = b.createdAt?.toDate?.()?.getTime() || new Date(b.createdAt || 0).getTime();
            return bTime - aTime;
        });
        resolveReady();
    }, err => {
        console.error('[SQLite] Subscription failed:', err);
        rejectReady(err);
    });

    unsubscribe.ready=ready;
    return unsubscribe;
}

export const getSetupsFromMemory = () => setups;

