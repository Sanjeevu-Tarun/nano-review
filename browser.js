/**
 * browser.js - Persistent browser singleton with page pool
 *
 * OPTIMIZATIONS:
 * 1. Page pool — pre-open pages ready to use instantly (no newPage() overhead)
 * 2. Parallel warm-up — passes CF and pre-opens pool pages simultaneously
 * 3. CF check is instant — checks title once, doesn't poll if already clear
 * 4. networkidle removed — domcontentloaded is faster and enough
 */
import { chromium as playwrightLocal } from 'playwright';

let _browser = null;
let _context = null;
let _launching = null;

// Pool of pre-opened idle pages ready to use immediately
const pagePool = [];
const PAGE_POOL_SIZE = 3;

async function fillPagePool() {
    while (pagePool.length < PAGE_POOL_SIZE) {
        try {
            const page = await _context.newPage();
            await page.route('**/*', route => {
                if (['font', 'media', 'image', 'stylesheet'].includes(route.request().resourceType()))
                    route.abort();
                else route.continue();
            });
            pagePool.push(page);
        } catch { break; }
    }
}

export async function getPooledPage() {
    // Return a pre-opened page instantly if available
    if (pagePool.length > 0) {
        const page = pagePool.shift();
        // Refill pool in background
        fillPagePool().catch(() => {});
        return page;
    }
    // Pool empty — open a new one
    const context = await getPersistentContext();
    return context.newPage();
}

export async function getPersistentContext() {
    if (_context && _browser?.isConnected()) return _context;
    if (_launching) return _launching;

    _launching = (async () => {
        console.log('[browser] Launching...');
        _browser = await playwrightLocal.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-ipc-flooding-protection',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--single-process',
                '--memory-pressure-off',
            ],
            timeout: 30000,
        });

        _context = await _browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            locale: 'en-US',
            timezoneId: 'America/New_York',
            // Ignore HTTPS errors to avoid cert-related delays
            ignoreHTTPSErrors: true,
        });

        await _context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            window.chrome = { runtime: {} };
        });

        _browser.on('disconnected', () => {
            console.log('[browser] Disconnected — will relaunch');
            _browser = null; _context = null; _launching = null;
            pagePool.length = 0;
        });

        console.log('[browser] Ready');
        _launching = null;
        return _context;
    })();

    return _launching;
}

export async function getNewPage() {
    const context = await getPersistentContext();
    return context.newPage();
}

export async function warmUp() {
    console.log('[browser] Warming up...');
    await getPersistentContext();
    const page = await getNewPage();
    try {
        await page.route('**/*', route => {
            if (['font', 'media', 'image', 'stylesheet'].includes(route.request().resourceType()))
                route.abort();
            else route.continue();
        });
        await page.goto('https://nanoreview.net/en/', {
            waitUntil: 'domcontentloaded',
            timeout: 25000,
        });
        await waitForCloudflare(page, 12000);
        console.log('[browser] CF cookies cached');
    } finally {
        await page.close().catch(() => {});
    }
    // Pre-fill page pool after warm-up
    await fillPagePool();
    console.log(`[browser] Page pool ready (${pagePool.length} pages)`);
}

/**
 * Optimized CF check — returns immediately if page is already clear.
 * Only polls if we're actually on a challenge page.
 */
export async function waitForCloudflare(page, timeout = 12000) {
    // Quick check first — if already past CF, return immediately
    try {
        const title = await page.title();
        const isChallenge = /just a moment|attention required|cloudflare|checking your browser/i.test(title);
        if (!isChallenge) return true;
    } catch { return true; }

    // Actually on CF challenge — poll until clear
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const title = await page.title();
            const url = page.url();
            const isChallenge = /just a moment|attention required|cloudflare|checking your browser/i.test(title);
            const isChallengeUrl = /cdn-cgi|challenge-platform/i.test(url);
            if (!isChallenge && !isChallengeUrl) return true;
            await page.waitForTimeout(300);
        } catch { return true; }
    }
    return true; // Proceed anyway
}

export async function safeNavigate(page, url, options = {}) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000, ...options });
    } catch {
        // Timeout is OK if content loaded
        const ok = await page.evaluate(() => document.body?.innerHTML.length > 100).catch(() => false);
        if (!ok) throw new Error(`Navigation failed: ${url}`);
    }
}

export const getBrowserContext = async () => ({
    browser: _browser || await getPersistentContext().then(() => _browser),
    context: await getPersistentContext(),
});
