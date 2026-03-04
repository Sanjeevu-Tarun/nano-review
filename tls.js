/**
 * tls.js — HTTP client with curl-impersonate + native HTTPS fallback
 *
 * PRIMARY (Docker): curl_chrome131 impersonates Chrome 131 TLS fingerprint
 *   → bypasses Cloudflare on ALL endpoints including /api/search
 *
 * FALLBACK (dev/bare): native Node HTTPS with Chrome headers
 *   → works if Cloudflare isn't blocking (e.g. IP not flagged)
 *   → if CF blocks, you'll see empty results; use Docker for production
 *
 * KEY FIX: parallelSearch now routes through curlFetch (not raw https.request)
 *   so it benefits from curl-impersonate when available.
 */
import { execFile, execFileSync } from 'child_process';
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

// ── curl-impersonate availability check (sync, once at startup) ───────────

let _curlAvailable = null;

function checkCurl() {
    if (_curlAvailable !== null) return _curlAvailable;
    try {
        execFileSync(CURL_BIN, ['--version'], { timeout: 3000, stdio: 'pipe' });
        _curlAvailable = true;
        console.log(`[tls] curl-impersonate (${CURL_BIN}) available ✅`);
    } catch {
        _curlAvailable = false;
        console.warn(`[tls] curl-impersonate NOT found — using native HTTPS fallback ⚠️`);
        console.warn(`[tls] For production, use Docker (see Dockerfile). CF may block bare requests.`);
    }
    return _curlAvailable;
}

// Check immediately on module load
checkCurl();

export function isCurlAvailable() { return _curlAvailable === true; }

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

// ── Native HTTPS (fallback) ───────────────────────────────────────────────

const _agentHTTPS = new https.Agent({ keepAlive: true, maxSockets: 40, keepAliveMsecs: 30000 });

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

        const cfCookies = getCFCookies();
        const allCookies = [cfCookies, cookies].filter(Boolean).join('; ');
        const isHTTPS = parsed.protocol === 'https:';
        const lib = isHTTPS ? https : http;

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
            ...(allCookies ? { cookie: allCookies } : {}),
        };

        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port || (isHTTPS ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            agent: _agentHTTPS,
            timeout,
            headers: reqHeaders,
        }, (res) => {
            if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
                const loc = res.headers.location;
                const redir = loc.startsWith('http') ? loc : `${parsed.origin}${loc}`;
                res.resume();
                return nativeRequest(redir, { cookies, timeout, isJson }).then(resolve, reject);
            }

            const setCookies = [].concat(res.headers['set-cookie'] || []);
            if (setCookies.length) parseCFCookies(setCookies.map(c => c.split(';')[0]));

            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', async () => {
                try {
                    const text = await decompress(Buffer.concat(chunks), res.headers['content-encoding'] || '');
                    resolve({ status: res.statusCode, text: text.trim() });
                } catch(e) { reject(e); }
            });
            res.on('error', reject);
        });

        req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
        req.on('error', reject);
        req.end();
    });
}

// ── Core fetch (curl or native) ───────────────────────────────────────────

export async function curlFetch(url, { cookies = '', timeout = 10, isJson = false } = {}) {
    if (!isCurlAvailable()) {
        const { status, text } = await nativeRequest(url, { cookies, timeout: timeout * 1000, isJson });
        if (status === 403 || status === 429 || status === 503) {
            throw new Error(`HTTP ${status} from ${url} — Cloudflare blocking. Deploy via Docker for full bypass.`);
        }
        if (/just a moment|checking your browser|_cf_chl_opt/i.test(text)) {
            throw new Error(`CF challenge at ${url} — use Docker + curl-impersonate for production`);
        }
        return { status, text };
    }

    const allCookies = [getCFCookies(), cookies].filter(Boolean).join('; ');
    const args = [
        '--impersonate', 'chrome131',
        '--silent', '--compressed', '--location',
        '--max-redirs', '5',
        '--max-time', String(timeout),
        '--write-out', '\n__HTTPCODE__%{http_code}',
        '-D', '-',
        '-H', isJson ? 'accept: application/json, */*;q=0.8'
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

    const setCookies = headersRaw.split('\r\n')
        .filter(l => /^set-cookie:/i.test(l))
        .map(l => l.slice(l.indexOf(':') + 1).trim());
    if (setCookies.length) parseCFCookies(setCookies);

    if (status === 403 || status === 429 || status === 503) throw new Error(`HTTP ${status} — CF block`);
    if (/just a moment|checking your browser|_cf_chl_opt/i.test(text)) throw new Error('CF JS challenge');

    return { status, text: text.trim() };
}

// ── High-level helpers ────────────────────────────────────────────────────

export async function fetchHtml(url, opts = {}) {
    const { status, text } = await curlFetch(url, { ...opts, isJson: false });
    if (status >= 400) throw new Error(`HTTP ${status} from ${url}`);
    return text;
}

export async function fetchJson(url, opts = {}) {
    const { status, text } = await curlFetch(url, { ...opts, isJson: true });
    if (status >= 400) throw new Error(`HTTP ${status} from ${url}`);
    return JSON.parse(text);
}

// ── Parallel search — ALL requests through curlFetch for CF bypass ────────
//
// CRITICAL FIX: Previously used raw https.request which bypasses curl-impersonate.
// The /api/search endpoint IS behind Cloudflare WAF and returns empty []
// when the TLS fingerprint doesn't match Chrome. Route through curlFetch.

export async function parallelSearch(query, limit, types) {
    const results = await Promise.all(types.map(async type => {
        const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
        try {
            const { text } = await curlFetch(url, { timeout: 8, isJson: true });
            // Guard: CF sometimes returns HTML challenge instead of JSON
            if (!text.startsWith('[') && !text.startsWith('{')) return [];
            const data = JSON.parse(text);
            return Array.isArray(data)
                ? data.map(r => ({ ...r, content_type: r.content_type || type }))
                : [];
        } catch (err) {
            console.warn(`[search] ${type} failed:`, err.message);
            return [];
        }
    }));
    return results.flat();
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

export async function warmupTLS() {
    console.log(`[tls] Warming up (${isCurlAvailable() ? 'curl-impersonate' : 'native HTTPS'})...`);
    const t = Date.now();
    try {
        await fetchHtml('https://nanoreview.net/en/', { timeout: 15 });
        console.log(`[tls] Warm-up done in ${Date.now() - t}ms. CF cookies: ${!!getCFCookies()}`);
    } catch (err) {
        console.warn('[tls] Warm-up failed (non-fatal):', err.message);
    }
}

export async function destroyTLS() {}
