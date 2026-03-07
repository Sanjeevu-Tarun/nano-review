import { chromium } from 'playwright';

let _browser = null;
let _launchPromise = null;
// One persistent context with CF already solved
let _cfContext = null;
let _cfReady = false;

const getBrowser = async () => {
    if (_browser?.isConnected()) return _browser;
    if (_launchPromise) return _launchPromise;
    _launchPromise = chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
        ],
        timeout: 30000,
    }).then(b => {
        _browser = b;
        _launchPromise = null;
        b.on('disconnected', () => {
            _browser = null;
            _launchPromise = null;
            _cfContext = null;
            _cfReady = false;
        });
        return b;
    });
    return _launchPromise;
};

const createContext = async (browser) => {
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        },
    });
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = { runtime: {} };
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
        );
    });
    return context;
};

// Warm up CF once at startup — all subsequent requests reuse the solved context
export const warmupCF = async () => {
    if (_cfReady) return;
    try {
        const browser = await getBrowser();
        _cfContext = await createContext(browser);
        const page = await _cfContext.newPage();
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(type)) route.abort();
            else route.continue();
        });
        await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await waitForCloudflare(page, 'body', 20000);
        await page.close();
        _cfReady = true;
        console.log('CF warmup done ✓');
    } catch (e) {
        console.error('CF warmup failed:', e.message);
        _cfContext = null;
        _cfReady = false;
    }
};

export const getBrowserContext = async () => {
    // If CF context is ready, reuse it (no homepage visit needed)
    if (_cfReady && _cfContext) {
        return {
            browser: { close: async () => {} }, // no-op: don't close shared context
            context: _cfContext
        };
    }
    // Fallback: create fresh context and solve CF
    const browser = await getBrowser();
    const context = await createContext(browser);
    return {
        browser: { close: async () => { await context.close().catch(() => {}); } },
        context
    };
};

export const waitForCloudflare = async (page, selector, timeout = 20000) => {
    const start = Date.now();
    let lastError;
    while (Date.now() - start < timeout) {
        try {
            const title = await page.title().catch(() => '');
            const isChallenge = /just a moment|attention required|cloudflare|verify|human|checking your browser/i.test(title);
            if (!isChallenge) {
                try {
                    await page.waitForSelector(selector, { timeout: 2000, state: 'attached' });
                    return true;
                } catch {
                    const hasContent = await page.evaluate(() => document.body && document.body.innerHTML.length > 100);
                    if (hasContent) return true;
                }
            }
            await page.waitForTimeout(500);
        } catch (error) {
            lastError = error;
            await page.waitForTimeout(500);
        }
    }
    throw new Error(`Cloudflare timeout after ${timeout}ms: ${lastError?.message || 'Unknown'}`);
};

export const safeNavigate = async (page, url, options = {}) => {
    const defaultOptions = { waitUntil: 'domcontentloaded', timeout: 25000 };
    try {
        await page.goto(url, { ...defaultOptions, ...options });
        return true;
    } catch (error) {
        const hasContent = await page.evaluate(() => document.body && document.body.innerHTML.length > 100).catch(() => false);
        if (hasContent) return true;
        throw error;
    }
};
