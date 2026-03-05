import chromium from '@sparticuz/chromium';
import { chromium as playwrightCore } from 'playwright-core';
import { chromium as playwrightLocal } from 'playwright';

let _browser  = null;
let _context  = null;
let _initPromise = null;

// A persistent "session page" kept open on nanoreview.net to maintain CF cookies
let _sessionPage = null;
let _sessionReady = false;

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
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
    },
};

const STEALTH_SCRIPT = () => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    const orig = window.navigator.permissions.query;
    window.navigator.permissions.query = (p) =>
        p.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : orig(p);
};

async function launchBrowser() {
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

// Open a persistent page on nanoreview.net to keep CF cookies alive
async function ensureSessionPage(context) {
    if (_sessionPage && _sessionReady) return;

    // Close stale session page if it exists
    if (_sessionPage) {
        await _sessionPage.close().catch(() => {});
        _sessionPage = null;
    }

    console.log('[session] Opening persistent nanoreview session page...');
    _sessionPage = await context.newPage();

    // Block heavy resources on the session page
    await _sessionPage.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
        else route.continue();
    });

    try {
        await _sessionPage.goto('https://nanoreview.net/en/', {
            waitUntil: 'domcontentloaded',
            timeout: 25000,
        });

        // Wait for CF to clear
        for (let i = 0; i < 10; i++) {
            const title = await _sessionPage.title().catch(() => '');
            if (!/just a moment|attention required/i.test(title)) {
                console.log('[session] CF cleared, session page ready');
                _sessionReady = true;
                break;
            }
            console.log(`[session] CF challenge active (attempt ${i + 1}/10)...`);
            await _sessionPage.waitForTimeout(2000);
        }

        if (!_sessionReady) {
            // Check for any real content
            const hasContent = await _sessionPage.evaluate(
                () => document.body?.innerHTML.length > 1000
            ).catch(() => false);
            if (hasContent) _sessionReady = true;
        }

        if (!_sessionReady) {
            console.warn('[session] Could not clear CF challenge on session page');
        }
    } catch (err) {
        console.warn('[session] Failed to load session page:', err.message);
        _sessionReady = false;
    }
}

export const getBrowserContext = async () => {
    if (_browser && _context) return { browser: _browser, context: _context, get sessionPage() { return _sessionPage; }, get sessionReady() { return _sessionReady; } };
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        _browser = await launchBrowser();
        _context = await _browser.newContext(CONTEXT_OPTIONS);
        await _context.addInitScript(STEALTH_SCRIPT);

        _browser.on('disconnected', () => {
            _browser = null;
            _context = null;
            _initPromise = null;
            _sessionPage = null;
            _sessionReady = false;
        });

        // Establish session immediately
        await ensureSessionPage(_context);

        // Refresh session every 5 minutes (CF cookie TTL is typically ~10 min)
        setInterval(async () => {
            if (!_context) return;
            _sessionReady = false;
            await ensureSessionPage(_context).catch(err =>
                console.warn('[session] Refresh failed:', err.message)
            );
        }, 5 * 60 * 1000);

        const result = {
            browser: _browser,
            context: _context,
            get sessionPage() { return _sessionPage; },
            get sessionReady() { return _sessionReady; },
        };
        return result;
    })();

    return _initPromise;
};

// Called before a scrape if CF is blocking — refreshes session page
export const reWarmCloudflare = async () => {
    if (!_context) return;
    _sessionReady = false;
    await ensureSessionPage(_context);
};

export const closeBrowser = async () => {
    if (_sessionPage) await _sessionPage.close().catch(() => {});
    if (_browser) await _browser.close().catch(() => {});
    _browser = null;
    _context = null;
    _initPromise = null;
    _sessionPage = null;
    _sessionReady = false;
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

export const waitForCloudflare = async (page, selector, timeout = 12000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const title = await page.title().catch(() => '');
            const url = page.url();
            const isChallenge =
                /just a moment|attention required|cloudflare|verify|human|checking your browser/i.test(title) ||
                /cdn-cgi|challenge-platform/i.test(url);
            if (!isChallenge) {
                try {
                    await page.waitForSelector(selector, { timeout: 1500, state: 'attached' });
                    return true;
                } catch {
                    const ok = await page.evaluate(() => document.body?.innerHTML.length > 100).catch(() => false);
                    if (ok) return true;
                }
            }
            await page.waitForTimeout(500);
        } catch {
            await page.waitForTimeout(500);
        }
    }
    const ok = await page.evaluate(() => document.body?.innerHTML.length > 100).catch(() => false);
    if (ok) return true;
    throw new Error(`CF timeout after ${timeout}ms`);
};
