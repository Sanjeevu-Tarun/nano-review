/**
 * tlsclient.js - Chrome TLS fingerprint HTTP client
 *
 * WHY THIS EXISTS:
 * Cloudflare Bot Management uses JA3/JA4 TLS fingerprinting.
 * Node.js has a DIFFERENT TLS fingerprint than Chrome → instant CF block.
 * tls-client wraps a Go library that sends IDENTICAL TLS as Chrome 131.
 * CF cannot distinguish it from a real browser → no challenge → instant response.
 *
 * This eliminates the browser entirely for most requests.
 *
 * FALLBACK CHAIN:
 * tls-client → got-scraping → browser (last resort)
 */

let tlsClient = null;
let tlsClientError = null;
let gotScraping = null;

// Try to load tls-client (Go-based Chrome TLS spoofer)
try {
    const mod = await import('tls-client');
    tlsClient = mod.default || mod;
    console.log('[tls] tls-client loaded');
} catch (e) {
    tlsClientError = e.message;
    console.log('[tls] tls-client not available:', e.message);
}

// Try got-scraping as secondary option
try {
    const mod = await import('got-scraping');
    gotScraping = mod.gotScraping || mod.default;
    console.log('[tls] got-scraping loaded');
} catch (e) {
    console.log('[tls] got-scraping not available:', e.message);
}

// Shared tls-client session (keeps connection alive, reuses TLS session)
let _tlsSession = null;

function getTlsSession() {
    if (_tlsSession) return _tlsSession;
    if (!tlsClient) return null;
    try {
        _tlsSession = new tlsClient.Session({
            clientIdentifier: 'chrome_131',  // Exact Chrome 131 TLS fingerprint
            timeoutSeconds: 10,
            followRedirects: true,
            insecureSkipVerify: false,
        });
        return _tlsSession;
    } catch (e) {
        console.log('[tls] session creation failed:', e.message);
        return null;
    }
}

const CF_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'cache-control': 'max-age=0',
};

const JSON_HEADERS = {
    ...CF_HEADERS,
    'Accept': 'application/json, */*;q=0.8',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'Referer': 'https://nanoreview.net/',
};

/**
 * Fetch with Chrome TLS fingerprint.
 * Returns { status, text } or throws.
 */
export async function tlsFetch(url, isJson = false, timeoutMs = 8000) {
    const session = getTlsSession();
    if (session) {
        try {
            const resp = await session.get(url, {
                headers: isJson ? JSON_HEADERS : CF_HEADERS,
                timeoutSeconds: Math.floor(timeoutMs / 1000),
            });
            if (resp.status === 403 || resp.status === 503 || resp.status === 429) {
                throw new Error(`HTTP ${resp.status}`);
            }
            const text = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
            // Detect CF challenge
            if (/just a moment|checking your browser|cf-browser-verification/i.test(text)) {
                throw new Error('CF challenge');
            }
            return { status: resp.status, text };
        } catch (e) {
            if (e.message === 'CF challenge' || e.message.startsWith('HTTP')) throw e;
            // Network error - try got-scraping
            console.log('[tls] tls-client error, trying got-scraping:', e.message);
        }
    }

    // got-scraping fallback (also uses browser TLS fingerprints)
    if (gotScraping) {
        try {
            const resp = await gotScraping({
                url,
                headers: isJson ? JSON_HEADERS : CF_HEADERS,
                timeout: { request: timeoutMs },
                followRedirect: true,
            });
            if (/just a moment|checking your browser/i.test(resp.body)) {
                throw new Error('CF challenge');
            }
            return { status: resp.statusCode, text: resp.body };
        } catch (e) {
            throw new Error(`got-scraping failed: ${e.message}`);
        }
    }

    throw new Error('No TLS client available');
}

/**
 * Search nanoreview API with Chrome TLS fingerprint — all types in parallel.
 */
export async function tlsSearch(query, limit, types) {
    const results = await Promise.all(types.map(async type => {
        const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
        try {
            const { text } = await tlsFetch(url, true, 5000);
            const data = JSON.parse(text);
            return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
        } catch { return []; }
    }));
    return results.flat();
}

/**
 * Fetch page HTML with Chrome TLS fingerprint.
 */
export async function tlsFetchHtml(url, timeoutMs = 7000) {
    const { text } = await tlsFetch(url, false, timeoutMs);
    return text;
}

export const hasTlsClient = () => !!tlsClient || !!gotScraping;
