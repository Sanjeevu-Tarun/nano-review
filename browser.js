/**
 * browser.js
 * Persistent browser singleton — launched ONCE, reused forever.
 * This only works on persistent servers (Railway, Render, VPS).
 * On Vercel (serverless) each request is a new process so this has no benefit.
 */
import { chromium as playwrightLocal } from 'playwright';

let _browser = null;
let _context = null;
let _launching = null;

export async function getPersistentContext() {
    // If already ready, return immediately
    if (_context && _browser.isConnected()) return _context;

    // If launching in progress, wait for it
    if (_launching) return _launching;

    _launching = (async () => {
        console.log('[browser] Launching persistent browser...');
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
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
            ],
            timeout: 30000,
        });

        _context = await _browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            locale: 'en-US',
            timezoneId: 'America/New_York',
        });

        await _context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            window.chrome = { runtime: {} };
        });

        // Handle browser crash — relaunch
        _browser.on('disconnected', () => {
            console.log('[browser] Browser disconnected, will relaunch on next request');
            _browser = null;
            _context = null;
            _launching = null;
        });

        console.log('[browser] Persistent browser ready');
        _launching = null;
        return _context;
    })();

    return _launching;
}

export async function getNewPage() {
    const context = await getPersistentContext();
    const page = await context.newPage();
    return page;
}

// Warm up: navigate to nanoreview once at startup to get CF cookies
export async function warmUp() {
    console.log('[browser] Warming up — passing Cloudflare...');
    const page = await getNewPage();
    try {
        await page.route('**/*', route => {
            if (['font', 'media', 'image', 'stylesheet'].includes(route.request().resourceType())) route.abort();
            else route.continue();
        });
        await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await waitForCloudflare(page, 'body', 15000).catch(() => {});
        console.log('[browser] Warm-up complete — CF cookies cached in browser context');
    } finally {
        await page.close().catch(() => {});
    }
}

export const waitForCloudflare = async (page, selector, timeout = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const title = await page.title().catch(() => '');
            const url = page.url();
            const isChallenge = /just a moment|attention required|cloudflare|verify|human|checking your browser/i.test(title);
            const isChallengeUrl = /cdn-cgi|challenge-platform/i.test(url);
            if (!isChallenge && !isChallengeUrl) {
                try { await page.waitForSelector(selector, { timeout: 1000, state: 'attached' }); return true; } catch {}
                const ok = await page.evaluate(() => document.body?.innerHTML.length > 100).catch(() => false);
                if (ok) return true;
            }
            await page.waitForTimeout(500);
        } catch { await page.waitForTimeout(500); }
    }
    throw new Error(`CF timeout after ${timeout}ms`);
};

export const safeNavigate = async (page, url, options = {}) => {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000, ...options });
        return true;
    } catch {
        const ok = await page.evaluate(() => document.body?.innerHTML.length > 100).catch(() => false);
        if (ok) return true;
        throw new Error(`Navigation failed: ${url}`);
    }
};

// Legacy: for Vercel compatibility
export const getBrowserContext = async () => {
    const context = await getPersistentContext();
    return {
        browser: _browser,
        context,
    };
};
