/**
 * http.js - Direct HTTP client for nanoreview.net API calls (no browser needed)
 * Falls back gracefully if blocked by Cloudflare.
 */
import https from 'https';
import http from 'http';

// Persistent HTTPS agent for connection reuse
const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 10,
    timeout: 8000,
});

const BASE_HEADERS = {
    'Accept': 'application/json, text/html,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Referer': 'https://nanoreview.net/',
    'Origin': 'https://nanoreview.net',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'Cache-Control': 'no-cache',
};

function fetchUrl(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.get(
            {
                hostname: parsed.hostname,
                path: parsed.pathname + parsed.search,
                headers: BASE_HEADERS,
                agent: parsed.protocol === 'https:' ? agent : undefined,
                timeout: timeoutMs,
            },
            (res) => {
                // Follow redirects
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return resolve(fetchUrl(res.headers.location, timeoutMs));
                }

                if (res.statusCode === 403 || res.statusCode === 429 || res.statusCode === 503) {
                    return reject(new Error(`HTTP ${res.statusCode} - blocked`));
                }

                const chunks = [];
                let encoding = res.headers['content-encoding'] || '';

                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    // Try to decode gzip/deflate if needed
                    // For simplicity, just try to parse as-is (Node handles this via zlib sometimes)
                    try {
                        const text = buf.toString('utf8');
                        resolve({ status: res.statusCode, text, headers: res.headers });
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.on('error', reject);
    });
}

/**
 * Try to call nanoreview search API directly (no browser).
 * Returns array of results or throws if blocked.
 */
export async function directSearch(query, limit = 5, types = ['phone', 'laptop', 'cpu', 'gpu', 'soc', 'tablet']) {
    const fetchType = async (type) => {
        const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
        try {
            const res = await fetchUrl(url, 4000);
            if (res.status !== 200) return [];
            const data = JSON.parse(res.text);
            return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
        } catch {
            return [];
        }
    };

    const results = await Promise.all(types.map(fetchType));
    return results.flat();
}

/**
 * Try to fetch a page's HTML directly (no browser).
 * Returns HTML string or throws.
 */
export async function directFetchHtml(url, timeoutMs = 6000) {
    const res = await fetchUrl(url, timeoutMs);
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    // Quick Cloudflare detection
    if (/just a moment|checking your browser|cf-browser-verification/i.test(res.text)) {
        throw new Error('Cloudflare challenge detected');
    }
    return res.text;
}
