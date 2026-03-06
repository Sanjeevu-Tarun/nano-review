import chromium from '@sparticuz/chromium';
import { chromium as playwrightCore } from 'playwright-core';
import { chromium as playwrightLocal } from 'playwright';

// ─── Persistent Browser Pool ──────────────────────────────────────────────────
// Instead of launching a new browser per request (expensive ~1-2s overhead),
// we keep one browser alive and hand out contexts from a pool.

const POOL_SIZE = 3; // max concurrent idle contexts to keep warm
const pool = [];
let sharedBrowser = null;
let browserInitPromise = null;

const PERF_ARGS = [
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
    '--metrics-recording-only',
    '--mute-audio',
    '--no-first-run',
    '--safebrowsing-disable-auto-update',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--blink-settings=imagesEnabled=false', // skip image decoding at engine level
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
    window.navigator.permissions.query = (p) =>
        p.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(p);
};

// ─── Launch the shared browser once ──────────────────────────────────────────
const ensureBrowser = async () => {
    if (sharedBrowser?.isConnected()) return sharedBrowser;
    if (browserInitPromise) return browserInitPromise;

    browserInitPromise = (async () => {
        const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true';

        if (isVercel) {
            const executablePath = await chromium.executablePath();
            sharedBrowser = await playwrightCore.launch({
                args: [...chromium.args, ...PERF_ARGS],
                executablePath: executablePath || undefined,
                headless: true,
                timeout: 30000,
            });
        } else {
            sharedBrowser = await playwrightLocal.launch({
                headless: true,
                args: PERF_ARGS,
                timeout: 30000,
            });
        }

        // Respawn on crash
        sharedBrowser.on('disconnected', () => {
            sharedBrowser = null;
            browserInitPromise = null;
            pool.length = 0;
        });

        return sharedBrowser;
    })();

    return browserInitPromise;
};

// ─── Context pool: acquire / release ─────────────────────────────────────────
/**
 * Acquire a browser context from the pool (or create a new one).
 * Returns an entry with { context, release() }.
 * Caller MUST call entry.release() when done.
 */
export const acquireContext = async () => {
    const browser = await ensureBrowser();

    // Reuse an idle pooled context
    if (pool.length > 0) {
        return pool.pop();
    }

    // Create a fresh context (cheap compared to launching a browser)
    const context = await browser.newContext(CONTEXT_OPTIONS);
    await context.addInitScript(STEALTH_SCRIPT);

    // Warm up CF cookies once per new context
    await warmUpCookies(context);

    const entry = {
        context,
        release() {
            if (pool.length < POOL_SIZE) {
                pool.push(entry);
            } else {
                context.close().catch(() => {});
            }
        },
    };
    return entry;
};

// ─── One-time CF cookie warm-up per context ───────────────────────────────────
// searchDevices used to navigate to the homepage on EVERY search just to get
// cookies. We do it once here when a context is first created instead.
const warmedContexts = new WeakSet();

export const warmUpCookies = async (context) => {
    if (warmedContexts.has(context)) return;
    warmedContexts.add(context);

    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
            else route.continue();
        });
        await safeNavigate(page, 'https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForCloudflare(page, 'body', 10000).catch(() => {});
    } finally {
        await page.close();
    }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const waitForCloudflare = async (page, selector, timeout = 20000) => {
    const start = Date.now();
    let lastError;

    while (Date.now() - start < timeout) {
        try {
            const title = await page.title().catch(() => '');
            const url = await page.url().catch(() => '');

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

            await page.waitForTimeout(500); // was 1000ms — halved poll interval
        } catch (error) {
            lastError = error;
            await page.waitForTimeout(500);
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
