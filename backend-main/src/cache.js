import NodeCache from 'node-cache';

// Singleton instance create karein
// stdTTL: Default time (seconds) jiske baad data expire ho jaye (24 hours = 86400)
// checkperiod: Har 1 ghante baad check karega expired data delete karne ke liye
const appCache = new NodeCache({
    stdTTL: 86400, // 24 hours in seconds
    checkperiod: 3600, // Check every hour
    useClones: false // Performance ke liye behtar hai agar aap data modify nahi kar rahe
});

console.log("✓ Cache Service Initialized with 24-hour TTL");

export default appCache;