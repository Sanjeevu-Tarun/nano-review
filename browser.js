import { chromium } from 'playwright';
import https from 'https';

let _browser = null;
let _launchPromise = null;
let _cfContext = null;
let _cfReady = false;
let _cfCookies = ''; // raw cookie string extracted from context

const getBrowser = async () => {
    if (_browser?.isConnected()) return _browser;
    if (_launchPromise) return _launchPromise;
    _launchPromise = chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
        timeout: 30000,
    }).then(b => {
        _browser = b;
        _launchPromise = null;
        b.on('disconnected', () => { _browser = null; _launchPromise = null; _cfContext = null; _cfReady = false; _cfCookies = ''; });
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
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = { runtime: {} };
    });
    return context;
};

export const warmupCF = async () => {
    if (_cfReady) return;
    try {
        const browser = await getBrowser();
        _cfContext = await createContext(browser);
        const page = await _cfContext.newPage();
        await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
            else route.continue();
        });
        await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await waitForCloudflare(page, 'body', 20000);

        // Extract CF cookies so Node can call the API directly without browser
        const cookies = await _cfContext.cookies('https://nanoreview.net');
        _cfCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        console.log(`CF warmup done ✓ (${cookies.length} cookies extracted)`);

        await page.close();
        _cfReady = true;
    } catch (e) {
        console.error('CF warmup failed:', e.message);
        _cfContext = null; _cfReady = false; _cfCookies = '';
    }
};

// Fast Node.js HTTP request using CF cookies — no browser needed
export const nodeFetch = (url) => new Promise((resolve, reject) => {
    const options = {
        headers: {
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': 'https://nanoreview.net/en/',
            'Cookie': _cfCookies,
        }
    };
    https.get(url, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
            catch { resolve({ status: res.statusCode, data: null }); }
        });
    }).on('error', reject);
});

export const getCFCookies = () => _cfCookies;
export const isCFReady = () => _cfReady;

export const getBrowserContext = async () => {
    if (_cfReady && _cfContext) return { browser: { close: async () => {} }, context: _cfContext };
    const browser = await getBrowser();
    const context = await createContext(browser);
    return { browser: { close: async () => { await context.close().catch(() => {}); } }, context };
};

export const waitForCloudflare = async (page, selector, timeout = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const title = await page.title().catch(() => '');
        const isChallenge = /just a moment|attention required|cloudflare|verify|human|checking your browser/i.test(title);
        if (!isChallenge) {
            const hasContent = await page.evaluate(() => document.body?.innerHTML?.length > 100).catch(() => false);
            if (hasContent) return true;
        }
        await page.waitForTimeout(500);
    }
    throw new Error(`CF timeout after ${timeout}ms`);
};
