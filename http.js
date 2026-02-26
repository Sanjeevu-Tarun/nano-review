/**
 * http.js - Direct HTTP client for nanoreview.net (no browser needed)
 * Properly handles gzip/br/deflate decompression.
 * Falls back gracefully if blocked by Cloudflare.
 */
import https from 'https';
import http from 'http';
import zlib from 'zlib';

// Persistent HTTPS agent — connection reuse dramatically speeds up repeated requests
const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 20,
    maxFreeSockets: 10,
    timeout: 8000,
    keepAliveMsecs: 30000,
});

const BASE_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Referer': 'https://nanoreview.net/',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
};

const JSON_HEADERS = {
    ...BASE_HEADERS,
    'Accept': 'application/json, */*;q=0.8',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
};

function decompress(buffer, encoding) {
    return new Promise((resolve, reject) => {
        if (!encoding || encoding === 'identity') return resolve(buffer.toString('utf8'));
        const decompressors = {
            gzip: zlib.gunzip,
            deflate: zlib.inflate,
            br: zlib.brotliDecompress,
        };
        const fn = decompressors[encoding];
        if (!fn) return resolve(buffer.toString('utf8'));
        fn(buffer, (err, decoded) => {
            if (err) reject(err);
            else resolve(decoded.toString('utf8'));
        });
    });
}

function fetchRaw(url, headers = BASE_HEADERS, timeoutMs = 6000, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) return reject(new Error('Too many redirects'));

        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;

        const req = lib.request(
            {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: { ...headers, Host: parsed.hostname },
                agent: isHttps ? agent : undefined,
                timeout: timeoutMs,
            },
            (res) => {
                // Follow redirects
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const redirectUrl = res.headers.location.startsWith('http')
                        ? res.headers.location
                        : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
                    res.resume();
                    return resolve(fetchRaw(redirectUrl, headers, timeoutMs, redirectCount + 1));
                }

                if (res.statusCode === 403 || res.statusCode === 429 || res.statusCode === 503) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode} - blocked`));
                }

                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', async () => {
                    try {
                        const buf = Buffer.concat(chunks);
                        const encoding = res.headers['content-encoding'] || '';
                        const text = await decompress(buf, encoding);
                        resolve({ status: res.statusCode, text, headers: res.headers });
                    } catch (e) {
                        reject(e);
                    }
                });
                res.on('error', reject);
            }
        );

        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Search nanoreview API directly — no browser needed.
 * Runs all type queries in parallel for maximum speed.
 */
export async function directSearch(query, limit = 5, types = ['phone', 'laptop', 'cpu', 'gpu', 'soc', 'tablet']) {
    const fetchType = async (type) => {
        const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
        try {
            const res = await fetchRaw(url, JSON_HEADERS, 5000);
            if (res.status !== 200) return [];
            const data = JSON.parse(res.text);
            return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
        } catch {
            return [];
        }
    };

    // Run all type searches in parallel — critical for speed
    const results = await Promise.all(types.map(fetchType));
    return results.flat();
}

/**
 * Fetch a page's HTML directly — no browser.
 * Throws if CF challenge detected.
 */
export async function directFetchHtml(url, timeoutMs = 6000) {
    const res = await fetchRaw(url, BASE_HEADERS, timeoutMs);
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    if (/just a moment|checking your browser|cf-browser-verification/i.test(res.text)) {
        throw new Error('Cloudflare challenge detected');
    }
    return res.text;
}
