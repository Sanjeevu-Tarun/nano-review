/**
 * browser.js - Persistent browser singleton with page pool
 *
 * OPTIMIZATIONS:
 * 1. Page pool — pre-open pages ready to use instantly
 * 2. Return pages to pool after use instead of closing them
 * 3. CF check is instant — returns immediately if already past challenge
 * 4. domcontentloaded (not networkidle) — faster
 * 5. Removed all waitForTimeout calls — unnecessary delays
 */
import { chromium as playwrightLocal } from 'playwright';

let _browser = null;
let _context = null;
let _launching = null;

const pagePool = [];
const PAGE_POOL_SIZE = 4;
const pageInUse = new WeakSet();

async function applyPageOptimizations(page) {
    await page.route('**/*', route => {
        const type = route.request().resourceType();
        if (['font', 'media', 'image', 'stylesheet'].includes(type))
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

/**
 * Get a pooled page. Call returnPage(page) when done instead of page.close().
 */
export async function getPooledPage() {
    if (pagePool.length > 0) {
        const page = pagePool.shift();
        pageInUse.add(page);
        // Refill pool in background
        fillPagePool().catch(() => {});
        return page;
    }
    const context = await getPersistentContext();
    const page = await context.newPage();
    await applyPageOptimizations(page);
    pageInUse.add(page);
    return page;
}

/**
 * Return a page to the pool for reuse. Navigate away to blank to reset state.
 */
export async function returnPage(page) {
    try {
        pageInUse.delete(page);
        if (!page.isClosed() && pagePool.length < PAGE_POOL_SIZE) {
            // Reset the page to a clean state
            await page.goto('about:blank', { waitUntil: 'commit' }).catch(() => {});
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
        await applyPageOptimizations(page);
        await page.goto('https://nanoreview.net/en/', {
            waitUntil: 'domcontentloaded',
            timeout: 25000,
        });
        await waitForCloudflare(page, 12000);
        console.log('[browser] CF cookies cached');
    } finally {
        await page.close().catch(() => {});
    }
    await fillPagePool();
    console.log(`[browser] Page pool ready (${pagePool.length} pages)`);
}

/**
 * Optimized CF check — returns immediately if page is already clear.
 */
export async function waitForCloudflare(page, timeout = 12000) {
    try {
        const title = await page.title();
        const isChallenge = /just a moment|attention required|cloudflare|checking your browser/i.test(title);
        if (!isChallenge) return true;
    } catch { return true; }

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
    return true;
}

export async function safeNavigate(page, url, options = {}) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000, ...options });
    } catch {
        const ok = await page.evaluate(() => document.body?.innerHTML.length > 100).catch(() => false);
        if (!ok) throw new Error(`Navigation failed: ${url}`);
    }
}

export const getBrowserContext = async () => ({
    browser: _browser || await getPersistentContext().then(() => _browser),
    context: await getPersistentContext(),
});
