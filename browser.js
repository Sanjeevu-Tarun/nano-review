import { chromium } from 'playwright';

let _browser = null;
let _context = null;
let _cfReady = false;
let _cfCookieStr = '';

export const isCFReady = () => _cfReady;
export const getCFCookies = () => _cfCookieStr;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const warmupCF = async () => {
    if (_cfReady) return;
    console.log('[warmup] starting browser...');

    if (!_browser) {
        _browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
        });
    }

    _context = await _browser.newContext({
        userAgent: UA,
        locale: 'en-US',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    await _context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
    });

    const page = await _context.newPage();
    await page.route('**/*', route => {
        const t = route.request().resourceType();
        ['font', 'media', 'image', 'stylesheet'].includes(t) ? route.abort() : route.continue();
    });

    console.log('[warmup] navigating to nanoreview...');
    const t0 = Date.now();
    await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait until CF challenge is gone
    for (let i = 0; i < 30; i++) {
        const title = await page.title().catch(() => '');
        if (!/just a moment|cloudflare|checking/i.test(title)) break;
        await page.waitForTimeout(1000);
    }

    // Extract cookies for direct Node fetch
    const cookies = await _context.cookies('https://nanoreview.net');
    _cfCookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    _cfReady = true;

    await page.close();
    console.log(`[warmup] done in ${Date.now() - t0}ms, ${cookies.length} cookies`);
};

export const getContext = () => _context;

// Direct Node HTTPS fetch using stored CF cookies — no browser needed
import { request } from 'https';
export const cfFetch = (url) => new Promise((resolve, reject) => {
    const opts = {
        headers: {
            'User-Agent': UA,
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://nanoreview.net/en/',
            'Cookie': _cfCookieStr,
        }
    };
    request(url, opts, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
            try { resolve({ ok: res.statusCode === 200, json: JSON.parse(body) }); }
            catch { resolve({ ok: false, json: null, raw: body.slice(0, 200) }); }
        });
    }).on('error', reject).end();
});
