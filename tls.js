/**
 * tls.js — TLS-fingerprint-impersonation HTTP client
 *
 * WHY THIS EXISTS:
 * Cloudflare blocks standard Node.js HTTPS because Node's TLS stack produces
 * a recognizable JA3 fingerprint (different from real Chrome/Firefox).
 * `node-tls-client` wraps `bogdanfinn/tls-client` (Go FFI) which impersonates
 * the exact TLS ClientHello, cipher suites, extensions and HTTP/2 SETTINGS
 * frames of Chrome 131 — making us indistinguishable from a real browser at
 * the TLS layer, bypassing Cloudflare without launching any headless browser.
 *
 * SPEED:
 * Pure HTTP/2 connection — no Chrome process, no JS execution overhead.
 * Cold request: ~300-600ms (TLS handshake + CF check + data)
 * Warm (session reuse): ~80-200ms
 *
 * CF COOKIE STRATEGY:
 * - First request to nanoreview.net sets cf_clearance in the session
 * - We extract and cache it for 25 min (CF default is 30 min)
 * - All subsequent requests attach the cookie → skips JS challenge
 * - Session is reused (keep-alive) for maximum speed
 */
import { Session, initTLS } from 'node-tls-client';
import zlib from 'zlib';
import { promisify } from 'util';
import https from 'https';

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);

// ── TLS Session (singleton, reused across all requests) ───────────────────
let _session = null;
let _tlsReady = false;
let _tlsInitPromise = null;

async function getSession() {
    if (_session && _tlsReady) return _session;
    if (_tlsInitPromise) return _tlsInitPromise;

    _tlsInitPromise = (async () => {
        try {
            await initTLS();
        } catch {
            // initTLS may be optional in some versions
        }
        _session = new Session({
            clientIdentifier: 'chrome_131',
            // Randomize to avoid fingerprint clustering
            randomTlsExtensionOrder: true,
            // Keep-alive for session reuse
            headerOrder: ['accept', 'accept-language', 'accept-encoding', 'user-agent'],
            forceHttp1: false,
            catchPanics: false,
            debug: false,
        });
        _tlsReady = true;
        _tlsInitPromise = null;
        return _session;
    })();

    return _tlsInitPromise;
}

// ── Cookie Store ──────────────────────────────────────────────────────────
let _cfCookies = '';
let _cfExpiry = 0;
const CF_TTL = 25 * 60 * 1000; // 25 min (CF clears at 30)

export function getCFCookies() {
    if (_cfCookies && Date.now() < _cfExpiry) return _cfCookies;
    return '';
}

function extractCFCookies(setCookieHeaders) {
    if (!setCookieHeaders) return;
    const headers = Array.isArray(setCookieHeaders)
        ? setCookieHeaders
        : [setCookieHeaders];

    const cfPairs = [];
    for (const h of headers) {
        const m = h.match(/^([^=]+)=([^;]*)/);
        if (!m) continue;
        const name = m[1].trim();
        if (name === 'cf_clearance' || name.startsWith('__cf') || name === '_cfuvid') {
            cfPairs.push(`${name}=${m[2]}`);
        }
    }

    if (cfPairs.length) {
        _cfCookies = cfPairs.join('; ');
        _cfExpiry = Date.now() + CF_TTL;
        console.log('[tls] CF cookies captured:', cfPairs.map(p => p.split('=')[0]).join(', '));
    }
}

// ── Core Request ──────────────────────────────────────────────────────────
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function buildHeaders(cookies, isJson = false) {
    const all = getCFCookies();
    const merged = [all, cookies].filter(Boolean).join('; ');
    return {
        'Accept': isJson
            ? 'application/json, */*;q=0.8'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': CHROME_UA,
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': isJson ? 'empty' : 'document',
        'sec-fetch-mode': isJson ? 'cors' : 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
        'Referer': 'https://nanoreview.net/',
        ...(merged ? { 'Cookie': merged } : {}),
    };
}

async function decompressBody(buffer, encoding) {
    if (!encoding || encoding === 'identity') return buffer.toString('utf8');
    try {
        if (encoding === 'gzip')    return (await gunzip(buffer)).toString('utf8');
        if (encoding === 'deflate') return (await inflate(buffer)).toString('utf8');
        if (encoding === 'br')      return (await brotliDecompress(buffer)).toString('utf8');
    } catch {}
    return buffer.toString('utf8');
}

/**
 * tlsGet — main HTTP fetch using TLS impersonation
 * Falls back to raw Node HTTPS if TLS client fails (shouldn't happen)
 */
export async function tlsGet(url, { cookies = '', isJson = false, timeout = 8000 } = {}) {
    const session = await getSession();
    const headers = buildHeaders(cookies, isJson);

    try {
        const resp = await session.get(url, {
            headers,
            timeoutSeconds: Math.ceil(timeout / 1000),
            followRedirects: true,
        });

        // Extract CF cookies from response
        const sc = resp.headers?.['set-cookie'] || resp.headers?.['Set-Cookie'];
        if (sc) extractCFCookies(sc);

        if (resp.status === 403 || resp.status === 429) {
            throw new Error(`HTTP ${resp.status} — CF may have blocked`);
        }
        if (resp.status === 503) {
            throw new Error(`HTTP 503 — CF challenge`);
        }

        const text = typeof resp.body === 'string'
            ? resp.body
            : await decompressBody(Buffer.from(resp.body || ''), resp.headers?.['content-encoding']);

        if (/just a moment|checking your browser|_cf_chl_opt/i.test(text)) {
            throw new Error('CF JS challenge — TLS impersonation insufficient');
        }

        return { status: resp.status, text };

    } catch (err) {
        // If it's our own thrown error, rethrow
        if (err.message?.includes('CF')) throw err;
        // Network-level error — try once with raw Node HTTPS as last resort
        console.warn('[tls] Session error, falling back to raw https:', err.message);
        return rawHttpsGet(url, headers, timeout);
    }
}

// ── Raw HTTPS fallback (no TLS impersonation, may be blocked by CF) ───────
const _agent = new https.Agent({ keepAlive: true, maxSockets: 30 });

function rawHttpsGet(url, headers, timeout) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch (e) { return reject(e); }
        const req = https.request({
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: { ...headers, Host: parsed.hostname },
            agent: _agent,
            timeout,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', async () => {
                const text = await decompressBody(
                    Buffer.concat(chunks),
                    res.headers['content-encoding'] || ''
                );
                resolve({ status: res.statusCode, text });
            });
            res.on('error', reject);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.on('error', reject);
        req.end();
    });
}

// ── High-level helpers ────────────────────────────────────────────────────

/** Fetch HTML page, throw if CF-blocked */
export async function fetchHtml(url, { cookies = '', timeout = 7000 } = {}) {
    const { status, text } = await tlsGet(url, { cookies, isJson: false, timeout });
    if (status >= 400) throw new Error(`HTTP ${status}`);
    return text;
}

/** Fetch JSON endpoint (nanoreview /api/search) */
export async function fetchJson(url, { cookies = '', timeout = 5000 } = {}) {
    const { status, text } = await tlsGet(url, { cookies, isJson: true, timeout });
    if (status >= 400) throw new Error(`HTTP ${status}`);
    return JSON.parse(text);
}

/**
 * Parallel search across all types — fires simultaneously, race to finish.
 * The /api/search endpoint doesn't need CF clearance in practice.
 */
export async function parallelSearch(query, limit, types) {
    // Search endpoint doesn't usually require CF cookies — use raw Node for speed
    const cfCookies = getCFCookies();
    const headers = buildHeaders(cfCookies, true);
    const agent = _agent;

    const results = await Promise.all(types.map(type => {
        const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
        return new Promise(resolve => {
            let parsed;
            try { parsed = new URL(url); } catch { return resolve([]); }
            const req = https.request({
                hostname: parsed.hostname,
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: { ...headers, Host: parsed.hostname },
                agent,
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
        });
    }));

    return results.flat();
}

/** Warm up: make one request to nanoreview.net to establish session + get CF cookies */
export async function warmupTLS() {
    console.log('[tls] Warming up TLS session...');
    const t = Date.now();
    try {
        await fetchHtml('https://nanoreview.net/en/', { timeout: 15000 });
        console.log(`[tls] Warm-up done in ${Date.now() - t}ms. CF cookies: ${!!getCFCookies()}`);
    } catch (err) {
        console.warn('[tls] Warm-up error:', err.message);
    }
}
