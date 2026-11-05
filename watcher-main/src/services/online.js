import chalk from 'chalk';
import { db } from '../config/database.js';

export async function setOnlineStatus(isOnline, details = {}) {
    console.log(`${chalk.yellow('[Watcher]')} online: ${isOnline}\n`);
    try {
        const watcherRef = db.collection('watcher').doc('status');
        await watcherRef.set({
            online: isOnline,
            state: isOnline ? 'running' : 'offline',
            database: 'sqlite',
            timestamp: new Date(),
            ...details,
        }, { merge: true });
    } catch (err) {
        console.error(`${chalk.yellow('[Watcher] Error setting online status')}`);
    }
}
