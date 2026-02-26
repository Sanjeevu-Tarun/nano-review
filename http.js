/**
 * http.js - HTTP client with TLS fingerprint spoofing
 *
 * Priority:
 * 1. tls-client / got-scraping (Chrome TLS fingerprint) → bypasses CF natively
 * 2. Direct Node https (only works with valid CF cookies)
 *
 * The key insight: CF blocks Node.js by JA3/JA4 TLS hash, not by cookies alone.
 * With a Chrome TLS fingerprint, CF cookies aren't even needed.
 */
import https from 'https';
import http from 'http';
import zlib from 'zlib';
import { tlsFetch, tlsSearch, tlsFetchHtml, hasTlsClient } from './tlsclient.js';

export { tlsSearch, tlsFetchHtml };

// Persistent connection pool for Node fallback
const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 30,
    maxFreeSockets: 15,
    keepAliveMsecs: 60000,
});

function buildHeaders(cookies = '', isJson = false) {
    return {
        'Accept': isJson ? 'application/json, */*;q=0.8' : 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://nanoreview.net/',
        'sec-ch-ua': '"Google Chrome";v="131"',
        'sec-fetch-dest': isJson ? 'empty' : 'document',
        'sec-fetch-mode': isJson ? 'cors' : 'navigate',
        'sec-fetch-site': 'same-origin',
        ...(cookies ? { Cookie: cookies } : {}),
    };
}

function decompress(buf, enc) {
    return new Promise((res, rej) => {
        if (!enc || enc === 'identity') return res(buf.toString('utf8'));
        const fn = { gzip: zlib.gunzip, deflate: zlib.inflate, br: zlib.brotliDecompress }[enc];
        if (!fn) return res(buf.toString('utf8'));
        fn(buf, (e, d) => e ? rej(e) : res(d.toString('utf8')));
    });
}

function nodeRequest(url, headers, timeoutMs = 6000, hops = 0) {
    return new Promise((resolve, reject) => {
        if (hops > 5) return reject(new Error('Too many redirects'));
        let parsed;
        try { parsed = new URL(url); } catch (e) { return reject(e); }
        const isHttps = parsed.protocol === 'https:';
        const req = (isHttps ? https : http).request({
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: { ...headers, Host: parsed.hostname },
            agent: isHttps ? agent : undefined,
            timeout: timeoutMs,
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                const loc = res.headers.location.startsWith('http') ? res.headers.location
                    : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
                return resolve(nodeRequest(loc, headers, timeoutMs, hops + 1));
            }
            if ([403, 429, 503].includes(res.statusCode)) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', async () => {
                try {
                    const text = await decompress(Buffer.concat(chunks), res.headers['content-encoding'] || '');
                    resolve({ status: res.statusCode, text });
                } catch (e) { reject(e); }
            });
            res.on('error', reject);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Search API - tries TLS spoof first, falls back to Node with cookies
 */
export async function directSearch(query, limit = 5, types = ['phone','laptop','cpu','gpu','soc','tablet'], cookies = '') {
    // Try TLS spoof first (no cookies needed)
    if (hasTlsClient()) {
        try {
            const results = await tlsSearch(query, limit, types);
            if (results.length > 0) return results;
        } catch {}
    }

    // Fallback: Node.js with CF cookies
    const headers = buildHeaders(cookies, true);
    const results = await Promise.all(types.map(async type => {
        const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
        try {
            const { status, text } = await nodeRequest(url, headers, 5000);
            if (status !== 200) return [];
            const data = JSON.parse(text);
            return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
        } catch { return []; }
    }));
    return results.flat();
}

/**
 * Fetch HTML - tries TLS spoof first, falls back to Node with cookies
 */
export async function directFetchHtml(url, cookies = '', timeoutMs = 7000) {
    // Try TLS spoof (no cookies needed)
    if (hasTlsClient()) {
        try {
            return await tlsFetchHtml(url, timeoutMs);
        } catch (e) {
            console.log('[http] TLS spoof failed:', e.message);
        }
    }

    // Fallback: Node with CF cookies
    const { status, text } = await nodeRequest(url, buildHeaders(cookies, false), timeoutMs);
    if (status >= 400) throw new Error(`HTTP ${status}`);
    if (/just a moment|checking your browser/i.test(text)) throw new Error('CF challenge');
    return text;
}
