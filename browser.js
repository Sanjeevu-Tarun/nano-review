import { chromium } from 'playwright';

// ─── Single persistent browser ────────────────────────────────────────────────
let _browser = null;
let _launchPromise = null;

const LAUNCH_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
];

export const getBrowser = async () => {
    if (_browser?.isConnected()) return _browser;
    if (_launchPromise) return _launchPromise;
    _launchPromise = chromium.launch({ headless: true, args: LAUNCH_ARGS, timeout: 30000 })
        .then(b => {
            _browser = b;
            _launchPromise = null;
            b.on('disconnected', () => { _browser = null; _launchPromise = null; });
            return b;
        });
    return _launchPromise;
};

// Pre-warm browser at startup so first request pays no launch cost
getBrowser().catch(() => {});

// ─── Context pool ─────────────────────────────────────────────────────────────
const POOL_SIZE = 3;
const _pool = [];

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

const STEALTH = () => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
    const orig = window.navigator.permissions.query;
    window.navigator.permissions.query = (p) =>
        p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : orig(p);
};

export const acquireContext = async () => {
    if (_pool.length > 0) return _pool.pop();
    const browser = await getBrowser();
    const context = await browser.newContext(CONTEXT_OPTIONS);
    await context.addInitScript(STEALTH);
    const entry = {
        context,
        release() {
            if (_pool.length < POOL_SIZE) _pool.push(entry);
            else context.close().catch(() => {});
        },
    };
    return entry;
};

// Legacy export kept for compatibility
export const getBrowserContext = async () => {
    const entry = await acquireContext();
    return { browser: { close: () => entry.release() }, context: entry.context };
};

// ─── Helpers (identical logic to original, poll interval halved) ──────────────
export const waitForCloudflare = async (page, selector, timeout = 20000) => {
    const start = Date.now();
    let lastError;
    while (Date.now() - start < timeout) {
        try {
            const title = await page.title().catch(() => '');
            const url = page.url();
            const isChallenge = /just a moment|attention required|cloudflare|verify|human|checking your browser/i.test(title);
            const isChallengeUrl = /cdn-cgi|challenge-platform/i.test(url);
            if (!isChallenge && !isChallengeUrl) {
                try {
                    await page.waitForSelector(selector, { timeout: 2000, state: 'attached' });
                    return true;
                } catch {
                    const hasContent = await page.evaluate(() => document.body && document.body.innerHTML.length > 100);
                    if (hasContent) return true;
                }
            }
            await page.waitForTimeout(300); // was 1000ms
        } catch (error) {
            lastError = error;
            await page.waitForTimeout(300);
        }
    }
    try {
        const hasContent = await page.evaluate(() => document.body && document.body.innerHTML.length > 100);
        if (hasContent) return true;
    } catch {}
    throw new Error(`Cloudflare timeout after ${timeout}ms: ${lastError?.message || 'Unknown error'}`);
};

export const safeNavigate = async (page, url, options = {}) => {
    const defaultOptions = { waitUntil: 'domcontentloaded', timeout: 25000 };
    try {
        await page.goto(url, { ...defaultOptions, ...options });
        return true;
    } catch (error) {
        try {
            const hasContent = await page.evaluate(() => document.body && document.body.innerHTML.length > 100);
            if (hasContent) return true;
        } catch {}
        throw error;
    }
};
