/**
 * fetch.js — lightweight HTTP client
 * Vercel IPs are not flagged by Cloudflare, so plain fetch works fine.
 */
import https from 'https';
import zlib from 'zlib';
import { promisify } from 'util';

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });

async function decompress(buf, enc) {
    if (!enc || enc === 'identity') return buf.toString('utf8');
    if (enc === 'gzip')    return (await gunzip(buf)).toString('utf8');
    if (enc === 'deflate') return (await inflate(buf)).toString('utf8');
    if (enc === 'br')      return (await brotliDecompress(buf)).toString('utf8');
    return buf.toString('utf8');
}

export function request(url, { isJson = false, timeout = 10000 } = {}) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch(e) { return reject(e); }

        const req = https.request({
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            agent,
            timeout,
            headers: {
                'accept': isJson ? 'application/json' : 'text/html,application/xhtml+xml,*/*;q=0.8',
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
            },
        }, (res) => {
            if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
                const loc = res.headers.location;
                res.resume();
                return request(loc.startsWith('http') ? loc : `${parsed.origin}${loc}`, { isJson, timeout }).then(resolve, reject);
            }
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

export async function fetchJson(url) {
    const { status, text } = await request(url, { isJson: true });
    if (status === 403) throw new Error(`CF blocked (403) — ${url}`);
    if (status >= 400)  throw new Error(`HTTP ${status} — ${url}`);
    if (!text.startsWith('[') && !text.startsWith('{')) throw new Error(`Non-JSON response from ${url}`);
    return JSON.parse(text);
}

export async function fetchHtml(url) {
    const { status, text } = await request(url, { isJson: false });
    if (status === 403) throw new Error(`CF blocked (403) — ${url}`);
    if (status >= 400)  throw new Error(`HTTP ${status} — ${url}`);
    return text;
}
