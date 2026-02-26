/**
 * cache.js - Pure in-memory LRU cache with async file persistence
 *
 * File cache reads are async and non-blocking.
 * On startup, preloads all valid file cache entries into memory.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), '.cache');
const MEM_MAX = 1000;

export const TTL = {
    search:  60 * 60 * 1000,        // 1h
    device:  6  * 60 * 60 * 1000,   // 6h
    compare: 6  * 60 * 60 * 1000,   // 6h
    ranking: 24 * 60 * 60 * 1000,   // 24h
    http:    10 * 60 * 1000,         // 10m
};

// Pure in-memory LRU (Map preserves insertion order, delete+re-insert = move to tail)
const mem = new Map();

function evict() {
    if (mem.size >= MEM_MAX) {
        mem.delete(mem.keys().next().value);
    }
}

function ckey(namespace, key) {
    return `${namespace}_${createHash('md5').update(key).digest('hex')}`;
}

function fpath(k) {
    return path.join(CACHE_DIR, `${k}.json`);
}

// Preload file cache into memory on startup (async, non-blocking)
async function preload() {
    try {
        await fsp.mkdir(CACHE_DIR, { recursive: true });
        const files = await fsp.readdir(CACHE_DIR);
        let loaded = 0;
        await Promise.all(files.map(async (f) => {
            try {
                const raw = await fsp.readFile(path.join(CACHE_DIR, f), 'utf8');
                const entry = JSON.parse(raw);
                if (Date.now() < entry.expires) {
                    const k = f.replace('.json', '');
                    evict();
                    mem.set(k, entry);
                    loaded++;
                } else {
                    fsp.unlink(path.join(CACHE_DIR, f)).catch(() => {});
                }
            } catch {}
        }));
        if (loaded > 0) console.log(`[cache] Preloaded ${loaded} entries from disk`);
    } catch {}
}

// Fire and forget preload
preload();

export const cache = {
    get(namespace, key) {
        const k = ckey(namespace, key);
        const entry = mem.get(k);
        if (!entry) return null;
        if (Date.now() >= entry.expires) {
            mem.delete(k);
            fsp.unlink(fpath(k)).catch(() => {});
            return null;
        }
        // LRU: move to tail
        mem.delete(k);
        mem.set(k, entry);
        return entry.value;
    },

    set(namespace, key, value, ttl) {
        const k = ckey(namespace, key);
        const entry = { value, expires: Date.now() + ttl };
        evict();
        mem.set(k, entry);
        // Persist async
        fsp.mkdir(CACHE_DIR, { recursive: true })
            .then(() => fsp.writeFile(fpath(k), JSON.stringify(entry)))
            .catch(() => {});
    },

    del(namespace, key) {
        const k = ckey(namespace, key);
        mem.delete(k);
        fsp.unlink(fpath(k)).catch(() => {});
    },

    stats() {
        return { memEntries: mem.size };
    },
};

// Periodic sweep of expired memory entries (every 10 min)
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of mem) {
        if (now >= v.expires) {
            mem.delete(k);
            fsp.unlink(fpath(k)).catch(() => {});
        }
    }
}, 10 * 60 * 1000).unref();
