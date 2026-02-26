/**
 * browser.js - Persistent browser with warmup gate + CF cookie extraction
 *
 * COLD START FIX:
 * - warmUpPromise is set immediately on module load
 * - First request awaits warmUpPromise before proceeding
 * - Subsequent requests skip the gate (warmup done)
 * - Self keep-alive in server.js prevents Render from sleeping
 */
import { chromium as playwrightLocal } from 'playwright';

let _browser = null;
let _context = null;
let _launching = null;
let _cfCookies = null;
let _cfCookieExpiry = 0;
let _warmUpDone = false;
let _warmUpPromise = null;

const pagePool = [];
const PAGE_POOL_SIZE = 3;
const BLOCKED_TYPES = new Set(['font', 'media', 'image', 'stylesheet']);

async function applyPageOptimizations(page) {
    await page.route('**/*', route => {
        BLOCKED_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue();
    });
}

async function fillPagePool() {
    while (pagePool.length < PAGE_POOL_SIZE) {
        try {
            const page = await _context.newPage();
            await applyPageOptimizations(page);
            pagePool.push(page);
        } catch { break; }
    }
}

export async function getPooledPage() {
    if (pagePool.length > 0) {
        const page = pagePool.shift();
        fillPagePool().catch(() => {});
        return page;
    }
    const context = await getPersistentContext();
    const page = await context.newPage();
    await applyPageOptimizations(page);
    return page;
}

export async function returnPage(page) {
    try {
        if (!page.isClosed() && pagePool.length < PAGE_POOL_SIZE) {
            await page.goto('about:blank', { waitUntil: 'commit', timeout: 3000 }).catch(() => {});
            pagePool.push(page);
        } else {
            await page.close().catch(() => {});
        }
    } catch { await page.close().catch(() => {}); }
}

export async function getPersistentContext() {
    if (_context && _browser?.isConnected()) return _context;
    if (_launching) return _launching;

    _launching = (async () => {
        console.log('[browser] Launching...');
        _browser = await playwrightLocal.launch({
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage', '--disable-extensions',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--no-first-run', '--no-zygote', '--disable-gpu',
                '--single-process', '--memory-pressure-off',
                '--disable-ipc-flooding-protection',
            ],
            timeout: 30000,
        });

        _context = await _browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            locale: 'en-US',
            timezoneId: 'America/New_York',
            ignoreHTTPSErrors: true,
        });

        await _context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            window.chrome = { runtime: {} };
        });

        _browser.on('disconnected', () => {
            console.log('[browser] Disconnected — relaunching...');
            _browser = null; _context = null; _launching = null;
            _cfCookies = null; _cfCookieExpiry = 0;
            _warmUpDone = false;
            pagePool.length = 0;
            // Auto re-warmup on disconnect
            warmUp().catch(() => {});
        });

        console.log('[browser] Launched');
        _launching = null;
        return _context;
    })();

    return _launching;
}

async function refreshCFCookies() {
    if (!_context) return;
    try {
        const cookies = await _context.cookies('https://nanoreview.net');
        const cf = cookies.filter(c => c.name.startsWith('cf_') || c.name.startsWith('__cf') || c.name === '_cfuvid');
        if (cf.length > 0) {
            _cfCookies = cf.map(c => `${c.name}=${c.value}`).join('; ');
            _cfCookieExpiry = Date.now() + 25 * 60 * 1000;
            console.log('[browser] CF cookies:', cf.map(c => c.name).join(', '));
        }
    } catch {}
}

export async function getCFCookies() {
    if (_cfCookies && Date.now() < _cfCookieExpiry) return _cfCookies;
    return null;
}

/**
 * Wait for warmup to complete before handling requests.
 * Only the first few requests block — after that it's instant.
 */
export async function awaitWarmUp() {
    if (_warmUpDone) return;
    if (_warmUpPromise) return _warmUpPromise;
    return; // warmup not started yet (shouldn't happen)
}

export function setWarmUpDone() {
    _warmUpDone = true;
}

export async function warmUp() {
    console.log('[browser] Warming up...');
    _warmUpPromise = (async () => {
        await getPersistentContext();
        const page = await getPooledPage();
        try {
            await page.goto('https://nanoreview.net/en/', {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
            await waitForCloudflare(page, 15000);
            await refreshCFCookies();
            console.log('[browser] Warm-up complete');
        } finally {
            await returnPage(page);
        }
        await fillPagePool();
        _warmUpDone = true;
        console.log(`[browser] Ready. Pool: ${pagePool.length} pages. CF cookies: ${!!_cfCookies}`);
    })();
    return _warmUpPromise;
}

export async function waitForCloudflare(page, timeout = 12000) {
    try {
        const title = await page.title();
        if (!/just a moment|attention required|cloudflare|checking your browser/i.test(title)) return true;
    } catch { return true; }

    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const title = await page.title();
            const url = page.url();
            if (!/just a moment|attention required|cloudflare|checking your browser/i.test(title)
                && !/cdn-cgi|challenge-platform/i.test(url)) {
                await refreshCFCookies();
                return true;
            }
            await page.waitForTimeout(300);
        } catch { return true; }
    }
    return true;
}

export async function safeNavigate(page, url, options = {}) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000, ...options });
        await refreshCFCookies();
    } catch {
        const ok = await page.evaluate(() => document.body?.innerHTML.length > 100).catch(() => false);
        if (!ok) throw new Error(`Navigation failed: ${url}`);
    }
}

export async function browserFetchDirect(url) {
    // Wait for warmup if not done — ensures CF cookies exist before we try
    if (!_warmUpDone && _warmUpPromise) {
        await _warmUpPromise.catch(() => {});
    }
    const page = await getPooledPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForCloudflare(page, 8000);
        return await page.content();
    } finally {
        await returnPage(page);
    }
}

export async function browserSearchDirect(query, limit, types) {
    if (!_warmUpDone && _warmUpPromise) {
        await _warmUpPromise.catch(() => {});
    }
    const page = await getPooledPage();
    try {
        const currentUrl = page.url();
        if (!currentUrl.includes('nanoreview.net')) {
            await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });
            await waitForCloudflare(page, 8000);
        }
        return await page.evaluate(async ({ query, limit, types }) => {
            const all = await Promise.all(types.map(async type => {
                try {
                    const r = await fetch(
                        `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`,
                        { headers: { Accept: 'application/json' } }
                    );
                    if (!r.ok) return [];
                    const d = await r.json();
                    return Array.isArray(d) ? d.map(x => ({ ...x, content_type: x.content_type || type })) : [];
                } catch { return []; }
            }));
            return all.flat();
        }, { query, limit, types });
    } finally {
        await returnPage(page);
    }
}
