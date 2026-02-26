/**
 * browser.js - Persistent browser with CF cookie extraction + page pool
 *
 * KEY INSIGHT: After warmup, extract CF cookies and use them for direct HTTP.
 * Only use browser as last resort — direct HTTP with CF cookies is 10x faster.
 */
import { chromium as playwrightLocal } from 'playwright';

let _browser = null;
let _context = null;
let _launching = null;
let _cfCookies = null; // Cached CF cookies for direct HTTP use
let _cfCookieExpiry = 0;

const pagePool = [];
const PAGE_POOL_SIZE = 3;

// Resource blocking filter
const BLOCKED_TYPES = new Set(['font', 'media', 'image', 'stylesheet']);

async function applyPageOptimizations(page) {
    await page.route('**/*', route => {
        if (BLOCKED_TYPES.has(route.request().resourceType()))
            route.abort();
        else
            route.continue();
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
    } catch {
        await page.close().catch(() => {});
    }
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
            console.log('[browser] Disconnected');
            _browser = null; _context = null; _launching = null;
            _cfCookies = null; _cfCookieExpiry = 0;
            pagePool.length = 0;
        });

        console.log('[browser] Ready');
        _launching = null;
        return _context;
    })();

    return _launching;
}

/**
 * Get CF cookies for direct HTTP requests.
 * Returns cookie string like "cf_clearance=xxx; __cf_bm=yyy"
 */
export async function getCFCookies() {
    if (_cfCookies && Date.now() < _cfCookieExpiry) return _cfCookies;
    return null; // Not available yet
}

/**
 * Update CF cookies after a successful browser navigation.
 */
async function refreshCFCookies() {
    if (!_context) return;
    try {
        const cookies = await _context.cookies('https://nanoreview.net');
        const cfCookies = cookies.filter(c =>
            c.name.startsWith('cf_') || c.name.startsWith('__cf') || c.name === '_cfuvid'
        );
        if (cfCookies.length > 0) {
            _cfCookies = cfCookies.map(c => `${c.name}=${c.value}`).join('; ');
            _cfCookieExpiry = Date.now() + 25 * 60 * 1000; // 25 min
            console.log('[browser] CF cookies updated:', cfCookies.map(c => c.name).join(', '));
        }
    } catch {}
}

export async function warmUp() {
    console.log('[browser] Warming up...');
    await getPersistentContext();
    const page = await getPooledPage();
    try {
        await page.goto('https://nanoreview.net/en/', {
            waitUntil: 'domcontentloaded',
            timeout: 25000,
        });
        await waitForCloudflare(page, 12000);
        await refreshCFCookies();
        console.log('[browser] Warm-up complete, CF cookies captured');
    } finally {
        await returnPage(page);
    }
    await fillPagePool();
    console.log(`[browser] Pool ready (${pagePool.length} pages)`);
}

export async function waitForCloudflare(page, timeout = 12000) {
    try {
        const title = await page.title();
        if (!/just a moment|attention required|cloudflare|checking your browser/i.test(title))
            return true;
    } catch { return true; }

    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const title = await page.title();
            const url = page.url();
            const isChallenge = /just a moment|attention required|cloudflare|checking your browser/i.test(title);
            const isChallengeUrl = /cdn-cgi|challenge-platform/i.test(url);
            if (!isChallenge && !isChallengeUrl) {
                await refreshCFCookies(); // Capture cookies as soon as CF clears
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

/**
 * Fetch HTML using browser — goes directly to target URL (no homepage warmup needed
 * since CF cookies are already in the context from warmup).
 */
export async function browserFetchDirect(url) {
    const page = await getPooledPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForCloudflare(page, 8000);
        return await page.content();
    } finally {
        await returnPage(page);
    }
}

/**
 * Run search API calls directly inside the browser context.
 * Faster than navigating to homepage first — reuses existing CF session.
 */
export async function browserSearchDirect(query, limit, types) {
    const page = await getPooledPage();
    try {
        // Go directly to a lightweight page (or reuse current) and run fetch from there
        // If page is at about:blank, navigate to nanoreview first
        const currentUrl = page.url();
        if (!currentUrl.includes('nanoreview.net')) {
            await page.goto('https://nanoreview.net/en/', {
                waitUntil: 'domcontentloaded',
                timeout: 20000,
            });
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

export const getBrowserContext = async () => ({
    browser: _browser || await getPersistentContext().then(() => _browser),
    context: await getPersistentContext(),
});
