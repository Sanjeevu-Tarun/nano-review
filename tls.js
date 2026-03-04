/**
 * tls.js — HTTP client using curl-impersonate-chrome
 *
 * STRATEGY:
 * curl-impersonate is a patched curl binary compiled to produce the EXACT same
 * TLS ClientHello (JA3/JA4) and HTTP/2 SETTINGS as a real Chrome 131 browser.
 * It's installed directly in the Docker image — no runtime downloads, no npm
 * packages that phone home to GitHub, 100% offline capable.
 *
 * Cloudflare sees Chrome's fingerprint → issues cf_clearance → cached 25 min.
 *
 * FALLBACK:
 * /api/search on nanoreview.net works fine with plain Node HTTPS (no CF block),
 * so we use raw https.request for parallel search — much faster than curl spawn.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import https from 'https';
import zlib from 'zlib';

const execFileAsync = promisify(execFile);
const gunzip           = promisify(zlib.gunzip);
const inflate          = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);

// Path to curl-impersonate-chrome binary (installed in Dockerfile)
const CURL_BIN = process.env.CURL_IMPERSONATE_BIN || 'curl_chrome131';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── CF Cookie Store ───────────────────────────────────────────────────────

let _cfCookies = '';
let _cfExpiry  = 0;
const CF_TTL   = 25 * 60 * 1000;

export function getCFCookies() {
    if (_cfCookies && Date.now() < _cfExpiry) return _cfCookies;
    return '';
}

function parseCFCookies(setCookieLines) {
    const cfPairs = [];
    for (const line of setCookieLines) {
        const m = line.match(/^([^=\s]+)=([^;]*)/);
        if (!m) continue;
        const name = m[1].trim();
        if (name === 'cf_clearance' || name.startsWith('__cf') || name === '_cfuvid') {
            cfPairs.push(`${name}=${m[2]}`);
        }
    }
    if (cfPairs.length) {
        _cfCookies = cfPairs.join('; ');
        _cfExpiry  = Date.now() + CF_TTL;
        console.log('[curl] CF cookies captured:', cfPairs.map(p => p.split('=')[0]).join(', '));
    }
}

// ── curl-impersonate fetch ────────────────────────────────────────────────

/**
 * curlFetch — spawns curl_chrome131 to fetch a URL with Chrome's TLS fingerprint.
 * Returns { status, text, setCookies }.
 */
export async function curlFetch(url, { cookies = '', timeout = 10 } = {}) {
    const allCookies = [getCFCookies(), cookies].filter(Boolean).join('; ');

    const args = [
        '--silent',
        '--compressed',                   // handle gzip/br automatically
        '--location',                      // follow redirects
        '--max-redirs', '5',
        '--max-time', String(timeout),
        '--write-out', '\n__STATUS__%{http_code}',  // append status at end
        '-D', '-',                         // dump headers to stdout too
        '-H', `accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8`,
        '-H', `accept-language: en-US,en;q=0.9`,
        '-H', `user-agent: ${UA}`,
        '-H', `sec-ch-ua: "Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`,
        '-H', `sec-ch-ua-mobile: ?0`,
        '-H', `sec-ch-ua-platform: "Windows"`,
        '-H', `sec-fetch-dest: document`,
        '-H', `sec-fetch-mode: navigate`,
        '-H', `sec-fetch-site: same-origin`,
        '-H', `sec-fetch-user: ?1`,
        '-H', `referer: https://nanoreview.net/`,
        ...(allCookies ? ['-H', `cookie: ${allCookies}`] : []),
        url,
    ];

    const { stdout, stderr } = await execFileAsync(CURL_BIN, args, {
        maxBuffer: 10 * 1024 * 1024, // 10MB
        timeout: (timeout + 5) * 1000,
    });

    // Parse: headers block + body + status marker
    const statusMatch = stdout.match(/__STATUS__(\d+)$/m);
    const status = statusMatch ? parseInt(statusMatch[1]) : 200;

    // Split headers from body (separated by \r\n\r\n)
    const headerEnd = stdout.indexOf('\r\n\r\n');
    const headersRaw = headerEnd > -1 ? stdout.slice(0, headerEnd) : '';
    const body = headerEnd > -1
        ? stdout.slice(headerEnd + 4).replace(/__STATUS__\d+$/, '').trim()
        : stdout.replace(/__STATUS__\d+$/, '').trim();

    // Extract set-cookie lines
    const setCookies = [];
    for (const line of headersRaw.split('\r\n')) {
        if (/^set-cookie:/i.test(line)) {
            setCookies.push(line.slice(line.indexOf(':') + 1).trim());
        }
    }
    if (setCookies.length) parseCFCookies(setCookies);

    if (status === 403 || status === 429 || status === 503) {
        throw new Error(`HTTP ${status} — Cloudflare block`);
    }

    if (/just a moment|checking your browser|_cf_chl_opt/i.test(body)) {
        throw new Error('CF JS challenge page returned');
    }

    return { status, text: body };
}

// ── High-level helpers ────────────────────────────────────────────────────

export async function fetchHtml(url, { cookies = '', timeout = 10 } = {}) {
    const { status, text } = await curlFetch(url, { cookies, timeout });
    if (status >= 400) throw new Error(`HTTP ${status} from ${url}`);
    return text;
}

export async function fetchJson(url, { cookies = '', timeout = 8 } = {}) {
    const allCookies = [getCFCookies(), cookies].filter(Boolean).join('; ');

    const args = [
        '--silent', '--compressed', '--location', '--max-redirs', '3',
        '--max-time', String(timeout),
        '--write-out', '\n__STATUS__%{http_code}',
        '-H', `accept: application/json, */*;q=0.8`,
        '-H', `accept-language: en-US,en;q=0.9`,
        '-H', `user-agent: ${UA}`,
        '-H', `sec-fetch-dest: empty`,
        '-H', `sec-fetch-mode: cors`,
        '-H', `sec-fetch-site: same-origin`,
        '-H', `referer: https://nanoreview.net/`,
        ...(allCookies ? ['-H', `cookie: ${allCookies}`] : []),
        url,
    ];

    const { stdout } = await execFileAsync(CURL_BIN, args, {
        maxBuffer: 5 * 1024 * 1024,
        timeout: (timeout + 5) * 1000,
    });

    const statusMatch = stdout.match(/__STATUS__(\d+)$/m);
    const status = statusMatch ? parseInt(statusMatch[1]) : 200;
    const text = stdout.replace(/__STATUS__\d+$/, '').trim();

    if (status >= 400) throw new Error(`HTTP ${status} from ${url}`);
    return JSON.parse(text);
}

// ── Parallel search — raw Node HTTPS ─────────────────────────────────────
// /api/search doesn't need TLS impersonation, so use fast Node native HTTPS

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
    const baseHeaders = {
        'accept': 'application/json, */*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        'user-agent': UA,
        'referer': 'https://nanoreview.net/',
        ...(cfCookies ? { cookie: cfCookies } : {}),
    };

    return Promise.all(types.map(type => new Promise(resolve => {
        const path = `/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
        const req = https.request({
            hostname: 'nanoreview.net',
            path,
            method: 'GET',
            headers: { ...baseHeaders, host: 'nanoreview.net' },
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

// ── Warmup ────────────────────────────────────────────────────────────────

export async function warmupTLS() {
    console.log('[curl] Warming up (establishing CF clearance)...');
    const t = Date.now();
    try {
        await fetchHtml('https://nanoreview.net/en/', { timeout: 15 });
        console.log(`[curl] Warm-up done in ${Date.now() - t}ms. CF cookies: ${!!getCFCookies()}`);
    } catch (err) {
        console.warn('[curl] Warm-up error:', err.message);
    }
}

export async function destroyTLS() {
    // No-op for curl approach — no persistent connections to clean up
}
