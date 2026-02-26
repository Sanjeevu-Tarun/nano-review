/**
 * http.js - Pure axios-style HTTP client (no browser needed)
 * Mimics exactly what GSM Arena API does: axios + cheerio, no Playwright.
 * Uses a persistent cookie jar so CF cookies from search carry to device pages.
 */
import https from 'https';
import http from 'http';
import zlib from 'zlib';

// Persistent HTTPS agent — reuses TCP connections (key for speed)
const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 10,
    timeout: 10000,
});

// Simple in-memory cookie jar keyed by domain
const cookieJar = new Map();

function setCookies(domain, setCookieHeaders) {
    if (!setCookieHeaders) return;
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    const existing = cookieJar.get(domain) || {};
    for (const header of headers) {
        const [pair] = header.split(';');
        const [name, ...rest] = pair.split('=');
        if (name) existing[name.trim()] = rest.join('=').trim();
    }
    cookieJar.set(domain, existing);
}

function getCookies(domain) {
    const jar = cookieJar.get(domain) || {};
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': 'https://nanoreview.net/',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
};

function fetchUrl(url, timeoutMs = 8000, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const domain = parsed.hostname;
        const cookies = getCookies(domain);

        const headers = {
            ...BASE_HEADERS,
            ...extraHeaders,
            ...(cookies ? { Cookie: cookies } : {}),
        };

        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.get({
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            headers,
            agent: parsed.protocol === 'https:' ? agent : undefined,
            timeout: timeoutMs,
        }, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectUrl = res.headers.location.startsWith('http')
                    ? res.headers.location
                    : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
                setCookies(domain, res.headers['set-cookie']);
                res.resume();
                return resolve(fetchUrl(redirectUrl, timeoutMs, extraHeaders));
            }

            if (res.statusCode === 403 || res.statusCode === 429 || res.statusCode === 503) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} blocked`));
            }

            // Store cookies
            setCookies(domain, res.headers['set-cookie']);

            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                const enc = res.headers['content-encoding'] || '';

                const decode = (b) => {
                    try { return b.toString('utf8'); } catch { return ''; }
                };

                if (enc.includes('gzip')) {
                    zlib.gunzip(buf, (err, result) => {
                        if (err) return reject(err);
                        resolve({ status: res.statusCode, text: decode(result), headers: res.headers });
                    });
                } else if (enc.includes('deflate')) {
                    zlib.inflate(buf, (err, result) => {
                        if (err) return reject(err);
                        resolve({ status: res.statusCode, text: decode(result), headers: res.headers });
                    });
                } else if (enc.includes('br')) {
                    zlib.brotliDecompress(buf, (err, result) => {
                        if (err) return reject(err);
                        resolve({ status: res.statusCode, text: decode(result), headers: res.headers });
                    });
                } else {
                    resolve({ status: res.statusCode, text: decode(buf), headers: res.headers });
                }
            });
            res.on('error', reject);
        });

        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.on('error', reject);
    });
}

export function isCloudflareBlock(text) {
    return /just a moment|checking your browser|cf-browser-verification|enable javascript|_cf_chl/i.test(text);
}

export async function directSearch(query, limit = 5, types = ['phone', 'laptop', 'cpu', 'gpu', 'soc', 'tablet']) {
    const results = await Promise.all(types.map(async (type) => {
        try {
            const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
            const res = await fetchUrl(url, 4000, { Accept: 'application/json', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' });
            if (res.status !== 200) return [];
            const data = JSON.parse(res.text);
            return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
        } catch { return []; }
    }));
    return results.flat();
}

export async function directFetchHtml(url, timeoutMs = 8000) {
    const res = await fetchUrl(url, timeoutMs);
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    if (isCloudflareBlock(res.text)) throw new Error('Cloudflare challenge');
    return res.text;
}
