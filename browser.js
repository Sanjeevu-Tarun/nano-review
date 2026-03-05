import chromium from '@sparticuz/chromium';
import { chromium as playwrightCore } from 'playwright-core';
import { chromium as playwrightLocal } from 'playwright';

// Persistent browser instance — reused across all requests
let _browser = null;
let _context = null;
let _initPromise = null;

const BROWSER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--no-first-run',
    '--no-zygote',
    '--mute-audio',
    '--hide-scrollbars',
];

const CONTEXT_OPTIONS = {
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
};

const STEALTH_SCRIPT = () => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);
};

async function createBrowser() {
    const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true';
    if (isVercel) {
        const executablePath = await chromium.executablePath();
        return playwrightCore.launch({
            args: [...chromium.args, ...BROWSER_ARGS],
            executablePath: executablePath || undefined,
            headless: true,
            timeout: 30000,
        });
    }
    return playwrightLocal.launch({
        headless: true,
        args: BROWSER_ARGS,
        timeout: 30000,
    });
}

// Returns shared persistent browser context — only creates once, reuses on every request
export const getBrowserContext = async () => {
    if (_browser && _context) return { browser: _browser, context: _context };
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        _browser = await createBrowser();
        _context = await _browser.newContext(CONTEXT_OPTIONS);
        await _context.addInitScript(STEALTH_SCRIPT);

        _browser.on('disconnected', () => {
            _browser = null;
            _context = null;
            _initPromise = null;
        });

        return { browser: _browser, context: _context };
    })();

    return _initPromise;
};

// Graceful shutdown
export const closeBrowser = async () => {
    if (_browser) {
        await _browser.close().catch(() => {});
        _browser = null;
        _context = null;
        _initPromise = null;
    }
};

export const waitForCloudflare = async (page, selector, timeout = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const title = await page.title().catch(() => '');
            const url = await page.url().catch(() => '');
            const isChallenge = /just a moment|attention required|cloudflare|verify|human|checking your browser/i.test(title);
            const isChallengeUrl = /cdn-cgi|challenge-platform/i.test(url);
            if (!isChallenge && !isChallengeUrl) {
                try {
                    await page.waitForSelector(selector, { timeout: 1500, state: 'attached' });
                    return true;
                } catch {
                    const hasContent = await page.evaluate(() => document.body?.innerHTML.length > 100).catch(() => false);
                    if (hasContent) return true;
                }
            }
            await page.waitForTimeout(500);
        } catch {
            await page.waitForTimeout(500);
        }
    }
    const hasContent = await page.evaluate(() => document.body?.innerHTML.length > 100).catch(() => false);
    if (hasContent) return true;
    throw new Error(`Cloudflare timeout after ${timeout}ms`);
};

export const safeNavigate = async (page, url, options = {}) => {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000, ...options });
        return true;
    } catch (error) {
        const hasContent = await page.evaluate(() => document.body?.innerHTML.length > 100).catch(() => false);
        if (hasContent) return true;
        throw error;
    }
};
