/**
 * tls.js — HTTP client using curl-impersonate (lexiforest fork)
 *
 * IMPORTANT — two curl-impersonate forks exist, very different APIs:
 *
 *   lwthiker fork:  single binary `curl-impersonate`, uses --impersonate chrome131
 *   lexiforest fork: separate binaries per target, e.g. `curl_chrome131`
 *                   NO --impersonate flag — the binary itself IS the impersonation
 *
 * The Dockerfile installs lexiforest v1.2.2. So we call curl_chrome131 directly
 * WITHOUT --impersonate. Passing --impersonate causes "unknown option" and
 * falls back to plain curl — breaking CF bypass entirely.
 *
 * FALLBACK: native Node HTTPS with Chrome headers when binary isn't present.
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

// ── Availability check ────────────────────────────────────────────────────
// Check if the binary exists AND supports curl-impersonate (not plain curl).
// We detect by running --version and checking the output contains "impersonate"
// or by trying a known-good flag. Simpler: just check the binary name works.

let _curlAvailable = null;

function checkCurl() {
    if (_curlAvailable !== null) return _curlAvailable;
    try {
        const out = execFileSync(CURL_BIN, ['--version'], { timeout: 3000, stdio: 'pipe' }).toString();
        // lexiforest curl-impersonate --version output contains "curl-impersonate"
        // plain curl --version just says "curl X.Y.Z"
        if (out.toLowerCase().includes('impersonate')) {
            _curlAvailable = true;
            console.log(`[tls] curl-impersonate (${CURL_BIN}) available ✅`);
        } else {
            _curlAvailable = false;
            console.warn(`[tls] ${CURL_BIN} found but is plain curl, not curl-impersonate ⚠️`);
            console.warn(`[tls] Using native HTTPS fallback. Cloudflare may block some requests.`);
        }
    } catch {
        _curlAvailable = false;
        console.warn(`[tls] ${CURL_BIN} not found — using native HTTPS fallback ⚠️`);
    }
    return _curlAvailable;
}

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

// ── Native HTTPS fallback ─────────────────────────────────────────────────

const _agent = new https.Agent({ keepAlive: true, maxSockets: 40, keepAliveMsecs: 30000 });

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

        const allCookies = [getCFCookies(), cookies].filter(Boolean).join('; ');
        const lib = parsed.protocol === 'https:' ? https : http;

        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            agent: _agent,
            timeout,
            headers: {
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
            },
        }, (res) => {
            if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
                const loc = res.headers.location;
                res.resume();
                return nativeRequest(
                    loc.startsWith('http') ? loc : `${parsed.origin}${loc}`,
                    { cookies, timeout, isJson }
                ).then(resolve, reject);
            }
            [].concat(res.headers['set-cookie'] || []).forEach(c => parseCFCookies([c.split(';')[0]]));
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

// ── Core fetch ────────────────────────────────────────────────────────────

export async function curlFetch(url, { cookies = '', timeout = 10, isJson = false } = {}) {
    if (!isCurlAvailable()) {
        const { status, text } = await nativeRequest(url, { cookies, timeout: timeout * 1000, isJson });
        if (status === 403 || status === 429 || status === 503) {
            throw new Error(`HTTP ${status} from ${url}`);
        }
        if (/just a moment|checking your browser|_cf_chl_opt/i.test(text)) {
            throw new Error(`CF challenge at ${url}`);
        }
        return { status, text };
    }

    const allCookies = [getCFCookies(), cookies].filter(Boolean).join('; ');

    // ⚠️  NO --impersonate flag — curl_chrome131 from lexiforest IS chrome131.
    //     Passing --impersonate makes it fail with "unknown option".
    const args = [
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

    headersRaw.split('\r\n')
        .filter(l => /^set-cookie:/i.test(l))
        .forEach(l => parseCFCookies([l.slice(l.indexOf(':') + 1).trim().split(';')[0]]));

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

// ── Parallel search — through curlFetch for CF bypass ────────────────────

export async function parallelSearch(query, limit, types) {
    const results = await Promise.all(types.map(async type => {
        const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
        try {
            const { text } = await curlFetch(url, { timeout: 8, isJson: true });
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
