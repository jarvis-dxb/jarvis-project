import moment from 'moment';

// local memory to track last trigger times
const triggerHistory = new Map();

/**
 * Check karta hai ke kya cooldown period khatam ho chuka hai ya nahi.
 * @param {Object} setup - Setup object jis mein updatedAt aur countdown ho.
 * @returns {Boolean} - True agar cooldown khatam ho gaya (ya kabhi shuru hi nahi hua).
 */
export const isCooldownOver = (setup) => {
    // If triggeredCounter is 0, then no need to check for cooldown
    if (!setup.triggeredCounter || !setup.countdown) {
        return true;
    }

    const now = moment();
    let lastUpdate;

    // Pehle Local Memory (Map) check karo
    if (triggerHistory.has(setup.id)) {
        lastUpdate = triggerHistory.get(setup.id);
    } else {
        // Agar local memory mein nahi hai, to Firestore backup use karo — sab handle hoga
        const ts = setup.updatedAt;
        lastUpdate = ts?.seconds ? moment.unix(ts.seconds) : ts?._seconds ? moment.unix(ts._seconds) : moment(ts);
    }

    // Fallback: Agar time valid nahi mil raha
    if (!lastUpdate || !lastUpdate.isValid()) return true;

    const duration = moment.duration(setup.countdown);
    const nextAllowedTime = lastUpdate.clone().add(duration);

    // Agr current time nextAllowedTime se pehle ka hai to cooldown remaining hai
    if (now.isBefore(nextAllowedTime)) {
        const diff = moment.utc(nextAllowedTime.diff(now)).format("mm:ss");
        console.log(`⏳ ${setup.triggerSymbol} (${setup.timeframe}) ${setup.side}: resuming in ${diff}`);
        return false;
    }

    return true;
};

/**
 * Jab trigger confirm ho jaye, tab local memory update karne ke liye
 */
export const updateCooldown = (setupId) => {
    triggerHistory.set(setupId, moment());
};