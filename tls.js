/**
 * tls.js — HTTP client with curl-impersonate + native HTTPS fallback
 *
 * PRIMARY: curl-impersonate (curl_chrome131) — impersonates Chrome 131
 *   TLS/JA3/HTTP2 fingerprint to bypass Cloudflare. Requires Docker build.
 *
 * FALLBACK: Native Node HTTPS with Chrome-like headers — works in dev/bare
 *   environments without curl-impersonate installed. May hit CF on some
 *   pages but works fine for /api/search and most device pages.
 *
 * /api/search always uses raw Node HTTPS (no CF block there) for max speed.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import https from 'https';
import http from 'http';
import zlib from 'zlib';

const execFileAsync    = promisify(execFile);
const gunzip           = promisify(zlib.gunzip);
const inflate          = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);

const CURL_BIN = process.env.CURL_IMPERSONATE_BIN || 'curl_chrome131';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── curl-impersonate availability check ───────────────────────────────────

let _curlAvailable = null;

async function isCurlAvailable() {
    if (_curlAvailable !== null) return _curlAvailable;
    try {
        await execFileAsync(CURL_BIN, ['--version'], { timeout: 3000 });
        _curlAvailable = true;
        console.log(`[tls] curl-impersonate (${CURL_BIN}) available ✅`);
    } catch {
        _curlAvailable = false;
        console.warn(`[tls] curl-impersonate not found — using native HTTPS fallback ⚠️`);
    }
    return _curlAvailable;
}

// ── CF Cookie Store ───────────────────────────────────────────────────────

let _cfCookies = '';
let _cfExpiry  = 0;
const CF_TTL   = 25 * 60 * 1000;

export function getCFCookies() {
    if (_cfCookies && Date.now() < _cfExpiry) return _cfCookies;
    return '';
}

function parseCFCookies(lines) {
    const pairs = [];
    for (const line of lines) {
        const m = line.match(/^([^=\s]+)=([^;]*)/);
        if (!m) continue;
        const name = m[1].trim();
        if (name === 'cf_clearance' || name.startsWith('__cf') || name === '_cfuvid') {
            pairs.push(`${name}=${m[2]}`);
        }
    }
    if (pairs.length) {
        _cfCookies = pairs.join('; ');
        _cfExpiry  = Date.now() + CF_TTL;
        console.log('[tls] CF cookies captured:', pairs.map(p => p.split('=')[0]).join(', '));
    }
}

// ── Native HTTPS fetch (fallback) ─────────────────────────────────────────

const _agentHTTPS = new https.Agent({ keepAlive: true, maxSockets: 40, keepAliveMsecs: 30000 });
const _agentHTTP  = new http.Agent({ keepAlive: true, maxSockets: 10 });

async function decompress(buf, enc) {
    if (!enc || enc === 'identity') return buf.toString('utf8');
    try {
        if (enc === 'gzip')    return (await gunzip(buf)).toString('utf8');
        if (enc === 'deflate') return (await inflate(buf)).toString('utf8');
        if (enc === 'br')      return (await brotliDecompress(buf)).toString('utf8');
    } catch {}
    return buf.toString('utf8');
}

function nativeRequest(url, { cookies = '', timeout = 10000, isJson = false } = {}) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch(e) { return reject(e); }
        const isHTTPS = parsed.protocol === 'https:';
        const lib = isHTTPS ? https : http;
        const agent = isHTTPS ? _agentHTTPS : _agentHTTP;
        const cfCookies = getCFCookies();
        const allCookies = [cfCookies, cookies].filter(Boolean).join('; ');

        const reqHeaders = {
            'accept': isJson
                ? 'application/json, */*;q=0.8'
                : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            'accept-encoding': 'gzip, deflate, br',
            'user-agent': UA,
            'referer': 'https://nanoreview.net/',
            'sec-fetch-dest': isJson ? 'empty' : 'document',
            'sec-fetch-mode': isJson ? 'cors' : 'navigate',
            'sec-fetch-site': 'same-origin',
            'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        };
        if (allCookies) reqHeaders['cookie'] = allCookies;

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHTTPS ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            agent,
            timeout,
            headers: reqHeaders,
        };

        const req = lib.request(options, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                const loc = res.headers.location;
                const redirectUrl = loc.startsWith('http') ? loc : `${parsed.origin}${loc}`;
                res.resume();
                return nativeRequest(redirectUrl, { cookies, timeout, isJson }).then(resolve, reject);
            }

            const setCookies = [].concat(res.headers['set-cookie'] || []);
            if (setCookies.length) parseCFCookies(setCookies.map(c => c.split(';')[0]));

            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', async () => {
                try {
                    const text = await decompress(Buffer.concat(chunks), res.headers['content-encoding'] || '');
                    resolve({ status: res.statusCode, text: text.trim() });
                } catch (e) { reject(e); }
            });
            res.on('error', reject);
        });

        req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
        req.on('error', reject);
        req.end();
    });
}

// ── Core fetch — curl or native fallback ─────────────────────────────────

export async function curlFetch(url, { cookies = '', timeout = 10, isJson = false } = {}) {
    const useCurl = await isCurlAvailable();

    if (!useCurl) {
        const { status, text } = await nativeRequest(url, { cookies, timeout: timeout * 1000, isJson });
        if (status === 403 || status === 429 || status === 503) {
            throw new Error(`HTTP ${status} from ${url}`);
        }
        if (/just a moment|checking your browser|_cf_chl_opt/i.test(text)) {
            throw new Error('CF JS challenge — deploy with Docker + curl-impersonate for full bypass');
        }
        return { status, text };
    }

    const allCookies = [getCFCookies(), cookies].filter(Boolean).join('; ');

    const args = [
        '--impersonate', 'chrome131',
        '--silent',
        '--compressed',
        '--location',
        '--max-redirs', '5',
        '--max-time', String(timeout),
        '--write-out', '\n__HTTPCODE__%{http_code}',
        '-D', '-',
        '-H', isJson
            ? 'accept: application/json, */*;q=0.8'
            : 'accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        '-H', 'accept-language: en-US,en;q=0.9',
        '-H', 'referer: https://nanoreview.net/',
        ...(allCookies ? ['-H', `cookie: ${allCookies}`] : []),
        url,
    ];

    const { stdout } = await execFileAsync(CURL_BIN, args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: (timeout + 5) * 1000,
    });

    const codeMatch = stdout.match(/__HTTPCODE__(\d+)/);
    const status = codeMatch ? parseInt(codeMatch[1]) : 200;
    const body = stdout.replace(/\n?__HTTPCODE__\d+\s*$/, '');

    const headerEnd = body.indexOf('\r\n\r\n');
    const headersRaw = headerEnd > -1 ? body.slice(0, headerEnd) : '';
    const text = headerEnd > -1 ? body.slice(headerEnd + 4) : body;

    const setCookies = headersRaw
        .split('\r\n')
        .filter(l => /^set-cookie:/i.test(l))
        .map(l => l.slice(l.indexOf(':') + 1).trim());
    if (setCookies.length) parseCFCookies(setCookies);

    if (status === 403 || status === 429 || status === 503) {
        throw new Error(`HTTP ${status} — Cloudflare block`);
    }
    if (/just a moment|checking your browser|_cf_chl_opt/i.test(text)) {
        throw new Error('CF JS challenge returned');
    }

    return { status, text: text.trim() };
}

// ── High-level helpers ────────────────────────────────────────────────────

export async function fetchHtml(url, { cookies = '', timeout = 10 } = {}) {
    const { status, text } = await curlFetch(url, { cookies, timeout, isJson: false });
    if (status >= 400) throw new Error(`HTTP ${status} from ${url}`);
    return text;
}

export async function fetchJson(url, { cookies = '', timeout = 8 } = {}) {
    const { status, text } = await curlFetch(url, { cookies, timeout, isJson: true });
    if (status >= 400) throw new Error(`HTTP ${status} from ${url}`);
    return JSON.parse(text);
}

// ── Parallel search — raw Node HTTPS (fastest, no CF block on /api/search) ─

export function parallelSearch(query, limit, types) {
    const cfCookies = getCFCookies();
    const headers = {
        'accept': 'application/json',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        'user-agent': UA,
        'referer': 'https://nanoreview.net/',
        ...(cfCookies ? { cookie: cfCookies } : {}),
    };
    return Promise.all(types.map(type => new Promise(resolve => {
        const path = `/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
        const req = https.request({
            hostname: 'nanoreview.net', path, method: 'GET',
            headers: { ...headers, host: 'nanoreview.net' },
            agent: _agentHTTPS, timeout: 6000,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', async () => {
                try {
                    const text = await decompress(Buffer.concat(chunks), res.headers['content-encoding'] || '');
                    const data = JSON.parse(text);
                    resolve(Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : []);
                } catch { resolve([]); }
            });
            res.on('error', () => resolve([]));
        });
        req.on('timeout', () => { req.destroy(); resolve([]); });
        req.on('error', () => resolve([]));
        req.end();
    }))).then(a => a.flat());
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

export async function warmupTLS() {
    const useCurl = await isCurlAvailable();
    console.log(`[tls] Warming up (${useCurl ? 'curl-impersonate' : 'native HTTPS'})...`);
    const t = Date.now();
    try {
        await fetchHtml('https://nanoreview.net/en/', { timeout: 15 });
        console.log(`[tls] Warm-up done in ${Date.now() - t}ms. CF: ${!!getCFCookies()}`);
    } catch (err) {
        console.warn('[tls] Warm-up error (non-fatal, continuing):', err.message);
    }
}

export async function destroyTLS() {}
