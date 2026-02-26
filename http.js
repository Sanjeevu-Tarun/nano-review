/**
 * http.js - Direct HTTP client with CF cookie support + gzip decompression
 *
 * When CF cookies are available (after browser warmup), direct HTTP works
 * fine — no browser needed. This is ~10x faster than browser navigation.
 */
import https from 'https';
import http from 'http';
import zlib from 'zlib';

// Persistent connection pool — critical for speed
const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 30,
    maxFreeSockets: 15,
    timeout: 8000,
    keepAliveMsecs: 60000,
    scheduling: 'fifo',
});

function buildHeaders(extraCookies = '', isJson = false) {
    return {
        'Accept': isJson ? 'application/json, */*;q=0.8' : 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://nanoreview.net/',
        'Origin': 'https://nanoreview.net',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': isJson ? 'empty' : 'document',
        'sec-fetch-mode': isJson ? 'cors' : 'navigate',
        'sec-fetch-site': 'same-origin',
        ...(extraCookies ? { Cookie: extraCookies } : {}),
    };
}

function decompress(buffer, encoding) {
    return new Promise((resolve, reject) => {
        if (!encoding || encoding === 'identity') return resolve(buffer.toString('utf8'));
        const fn = { gzip: zlib.gunzip, deflate: zlib.inflate, br: zlib.brotliDecompress }[encoding];
        if (!fn) return resolve(buffer.toString('utf8'));
        fn(buffer, (err, decoded) => err ? reject(err) : resolve(decoded.toString('utf8')));
    });
}

function fetchRaw(url, headers, timeoutMs = 6000, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) return reject(new Error('Too many redirects'));

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
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                const loc = res.headers.location.startsWith('http')
                    ? res.headers.location
                    : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
                return resolve(fetchRaw(loc, headers, timeoutMs, redirectCount + 1));
            }

            if (res.statusCode === 403 || res.statusCode === 429 || res.statusCode === 503) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} - blocked`));
            }

            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', async () => {
                try {
                    const text = await decompress(Buffer.concat(chunks), res.headers['content-encoding'] || '');
                    resolve({ status: res.statusCode, text, headers: res.headers });
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
 * Search nanoreview API — runs all type queries in parallel.
 * @param {string} cookies - CF cookies from browser (optional but greatly helps)
 */
export async function directSearch(query, limit = 5, types = ['phone', 'laptop', 'cpu', 'gpu', 'soc', 'tablet'], cookies = '') {
    const headers = buildHeaders(cookies, true);
    const results = await Promise.all(types.map(async type => {
        const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
        try {
            const res = await fetchRaw(url, headers, 5000);
            if (res.status !== 200) return [];
            const data = JSON.parse(res.text);
            return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
        } catch { return []; }
    }));
    return results.flat();
}

/**
 * Fetch page HTML directly — needs CF cookies to bypass challenge.
 */
export async function directFetchHtml(url, cookies = '', timeoutMs = 6000) {
    const res = await fetchRaw(url, buildHeaders(cookies, false), timeoutMs);
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    if (/just a moment|checking your browser|cf-browser-verification/i.test(res.text)) {
        throw new Error('Cloudflare challenge');
    }
    return res.text;
}
