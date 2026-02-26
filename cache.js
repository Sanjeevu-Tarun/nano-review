/**
 * cache.js - Two-tier cache: in-memory (fast) + file-based (persistent across restarts)
 * TTLs: search=1h, device=6h, compare=6h, ranking=24h
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), '.cache');
const MEM_MAX = 500; // max in-memory entries

// TTLs in ms
export const TTL = {
    search: 60 * 60 * 1000,        // 1 hour
    device: 6 * 60 * 60 * 1000,    // 6 hours
    compare: 6 * 60 * 60 * 1000,   // 6 hours
    ranking: 24 * 60 * 60 * 1000,  // 24 hours
    http: 10 * 60 * 1000,           // 10 min for raw HTTP API responses
};

// In-memory LRU-ish store
const memCache = new Map();

function ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

function cacheKey(namespace, key) {
    const hash = createHash('md5').update(key).digest('hex');
    return `${namespace}_${hash}`;
}

function filePath(k) {
    return path.join(CACHE_DIR, `${k}.json`);
}

// Evict oldest entries if memory cache too big
function evictMem() {
    if (memCache.size >= MEM_MAX) {
        const oldestKey = memCache.keys().next().value;
        memCache.delete(oldestKey);
    }
}

export const cache = {
    get(namespace, key) {
        const k = cacheKey(namespace, key);
        
        // Check memory first
        const mem = memCache.get(k);
        if (mem) {
            if (Date.now() < mem.expires) {
                return mem.value;
            }
            memCache.delete(k);
        }

        // Check file cache
        try {
            const fp = filePath(k);
            if (fs.existsSync(fp)) {
                const raw = fs.readFileSync(fp, 'utf8');
                const entry = JSON.parse(raw);
                if (Date.now() < entry.expires) {
                    // Warm memory cache
                    evictMem();
                    memCache.set(k, entry);
                    return entry.value;
                }
                // Expired - delete async
                fs.unlink(fp, () => {});
            }
        } catch {}

        return null;
    },

    set(namespace, key, value, ttl) {
        const k = cacheKey(namespace, key);
        const entry = { value, expires: Date.now() + ttl };
        
        // Memory
        evictMem();
        memCache.set(k, entry);

        // File (async, non-blocking)
        try {
            ensureCacheDir();
            fs.writeFile(filePath(k), JSON.stringify(entry), () => {});
        } catch {}
    },

    del(namespace, key) {
        const k = cacheKey(namespace, key);
        memCache.delete(k);
        try { fs.unlink(filePath(k), () => {}); } catch {}
    },

    // Stats for /health endpoint
    stats() {
        let fileCount = 0;
        try {
            ensureCacheDir();
            fileCount = fs.readdirSync(CACHE_DIR).length;
        } catch {}
        return { memEntries: memCache.size, fileEntries: fileCount };
    },

    // Clean expired file entries (run periodically)
    sweep() {
        try {
            ensureCacheDir();
            const files = fs.readdirSync(CACHE_DIR);
            let cleaned = 0;
            for (const f of files) {
                try {
                    const fp = path.join(CACHE_DIR, f);
                    const raw = fs.readFileSync(fp, 'utf8');
                    const entry = JSON.parse(raw);
                    if (Date.now() >= entry.expires) {
                        fs.unlinkSync(fp);
                        cleaned++;
                    }
                } catch {
                    // Remove corrupt files
                    try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {}
                }
            }
            return cleaned;
        } catch {
            return 0;
        }
    }
};

// Sweep expired entries every 30 minutes
setInterval(() => cache.sweep(), 30 * 60 * 1000).unref();
