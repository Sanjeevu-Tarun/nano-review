// Persistent in-memory cache shared across all modules
// TTL: 10 minutes for device pages (data doesn't change often)
const store = new Map();
const TTL = 10 * 60 * 1000;

export const cacheGet = (key) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > TTL) { store.delete(key); return null; }
    return entry.val;
};

export const cacheSet = (key, val) => {
    store.set(key, { val, ts: Date.now() });
    // Evict oldest if over 200 entries
    if (store.size > 200) store.delete(store.keys().next().value);
};

export const cacheStats = () => ({ size: store.size, keys: [...store.keys()] });
