/**
 * tls.js — Chrome TLS fingerprint impersonation client
 *
 * Uses node-tls-client@2.1.0 (CJS package wrapping bogdanfinn/tls-client in Go).
 * Imported via createRequire — the standard ESM pattern for CJS-only packages.
 *
 * Impersonates Chrome 131 JA3 + HTTP/2 fingerprint → bypasses Cloudflare without
 * a browser. CF cookies cached 25 min, reused on every subsequent request.
 *
 * Speed: ~80-200ms warm, ~300-600ms cold. RAM: ~30-50MB (vs 300-500MB Playwright).
 */
import { createRequire } from 'module';
import https from 'https';
import zlib from 'zlib';
import { promisify } from 'util';

const require = createRequire(import.meta.url);
const { Session, initTLS, destroyTLS: _destroyTLS } = require('node-tls-client');

const gunzip           = promisify(zlib.gunzip);
const inflate          = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);

// ── Session singleton ─────────────────────────────────────────────────────

let _session = null;
let _initPromise = null;

async function getSession() {
    if (_session) return _session;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        await initTLS();
        _session = new Session({
            clientIdentifier: 'chrome_131',
            randomTlsExtensionOrder: true,
            timeout: 10,        // seconds
            insecureSkipVerify: false,
            forceHttp1: false,
            debug: false,
        });
        _initPromise = null;
        console.log('[tls] node-tls-client session ready (chrome_131)');
        return _session;
    })();

    return _initPromise;
}

// ── CF Cookie Store ───────────────────────────────────────────────────────

let _cfCookies = '';
let _cfExpiry  = 0;
const CF_TTL   = 25 * 60 * 1000;

export function getCFCookies() {
    if (_cfCookies && Date.now() < _cfExpiry) return _cfCookies;
    return '';
}

function extractCFCookies(resp) {
    // node-tls-client stores cookies on the session automatically,
    // but we also extract them from headers for manual injection
    const raw = resp.headers?.['set-cookie'] || '';
    const lines = Array.isArray(raw) ? raw : (raw ? raw.split('\n') : []);

    const cfPairs = [];
    for (const line of lines) {
        const m = line.match(/^([^=]+)=([^;]*)/);
        if (!m) continue;
        const name = m[1].trim();
        if (name === 'cf_clearance' || name.startsWith('__cf') || name === '_cfuvid') {
            cfPairs.push(`${name}=${m[2]}`);
        }
    }

    if (cfPairs.length) {
        _cfCookies = cfPairs.join('; ');
        _cfExpiry  = Date.now() + CF_TTL;
        console.log('[tls] CF cookies captured:', cfPairs.map(p => p.split('=')[0]).join(', '));
    }
}

// ── Header builder ────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function buildHeaders(extraCookies = '', isJson = false) {
    const allCookies = [getCFCookies(), extraCookies].filter(Boolean).join('; ');
    return {
        'accept': isJson
            ? 'application/json, */*;q=0.8'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        'user-agent': UA,
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': isJson ? 'empty' : 'document',
        'sec-fetch-mode': isJson ? 'cors' : 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
        'referer': 'https://nanoreview.net/',
        ...(allCookies ? { 'cookie': allCookies } : {}),
    };
}

// ── Core GET ──────────────────────────────────────────────────────────────

export async function tlsGet(url, { cookies = '', isJson = false, timeout = 8000 } = {}) {
    const session = await getSession();
    const headers = buildHeaders(cookies, isJson);

    const resp = await session.get(url, { headers });

    // Extract any CF cookies from response
    extractCFCookies(resp);

    const status = resp.status;
    if (status === 403 || status === 429 || status === 503) {
        throw new Error(`HTTP ${status} — Cloudflare block`);
    }

    const text = await resp.text();

    if (/just a moment|checking your browser|_cf_chl_opt/i.test(text)) {
        throw new Error('CF JS challenge — TLS fingerprint not sufficient');
    }

    return { status, text };
}

// ── High-level helpers ────────────────────────────────────────────────────

export async function fetchHtml(url, { cookies = '', timeout = 7000 } = {}) {
    const { status, text } = await tlsGet(url, { cookies, isJson: false, timeout });
    if (status >= 400) throw new Error(`HTTP ${status} from ${url}`);
    return text;
}

export async function fetchJson(url, { cookies = '', timeout = 5000 } = {}) {
    const { status, text } = await tlsGet(url, { cookies, isJson: true, timeout });
    if (status >= 400) throw new Error(`HTTP ${status} from ${url}`);
    return JSON.parse(text);
}

// ── Parallel search — raw Node HTTPS (no TLS spoof needed for /api/search) ─

const _agent = new https.Agent({ keepAlive: true, maxSockets: 40, keepAliveMsecs: 30000 });

async function decompressBody(buf, enc) {
    if (!enc || enc === 'identity') return buf.toString('utf8');
    try {
        if (enc === 'gzip')    return (await gunzip(buf)).toString('utf8');
        if (enc === 'deflate') return (await inflate(buf)).toString('utf8');
        if (enc === 'br')      return (await brotliDecompress(buf)).toString('utf8');
    } catch {}
    return buf.toString('utf8');
}

export function parallelSearch(query, limit, types) {
    const cfCookies = getCFCookies();
    const headers = {
        'accept': 'application/json, */*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        'user-agent': UA,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'referer': 'https://nanoreview.net/',
        ...(cfCookies ? { cookie: cfCookies } : {}),
    };

    return Promise.all(types.map(type => new Promise(resolve => {
        const path = `/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
        const req = https.request({
            hostname: 'nanoreview.net',
            path,
            method: 'GET',
            headers: { ...headers, host: 'nanoreview.net' },
            agent: _agent,
            timeout: 4000,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', async () => {
                try {
                    const text = await decompressBody(
                        Buffer.concat(chunks),
                        res.headers['content-encoding'] || ''
                    );
                    const data = JSON.parse(text);
                    resolve(Array.isArray(data)
                        ? data.map(r => ({ ...r, content_type: r.content_type || type }))
                        : []);
                } catch { resolve([]); }
            });
            res.on('error', () => resolve([]));
        });
        req.on('timeout', () => { req.destroy(); resolve([]); });
        req.on('error', () => resolve([]));
        req.end();
    }))).then(arrays => arrays.flat());
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

export async function warmupTLS() {
    console.log('[tls] Warming up (establishing CF clearance)...');
    const t = Date.now();
    try {
        await fetchHtml('https://nanoreview.net/en/', { timeout: 15000 });
        console.log(`[tls] Warm-up done in ${Date.now() - t}ms. CF cookies: ${!!getCFCookies()}`);
    } catch (err) {
        console.warn('[tls] Warm-up error (will retry on first request):', err.message);
    }
}

export async function destroyTLS() {
    try {
        if (_session) await _session.close();
        await _destroyTLS();
    } catch {}
    _session = null;
}
