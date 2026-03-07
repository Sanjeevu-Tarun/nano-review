import { chromium } from 'playwright';

let _browser = null;
let _context = null;
let _cfReady = false;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const warmupCF = async () => {
    if (_cfReady) return;
    console.log('[warmup] launching browser...');
    _browser = _browser || await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });
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
        ['font','media','image','stylesheet'].includes(route.request().resourceType()) ? route.abort() : route.continue();
    });

    console.log('[warmup] navigating...');
    await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    for (let i = 0; i < 20; i++) {
        const title = await page.title().catch(() => '');
        if (!/just a moment|cloudflare|checking/i.test(title)) break;
        await page.waitForTimeout(1000);
    }

    await page.close();
    _cfReady = true;
    console.log('[warmup] done ✓');

    _browser.on('disconnected', () => { _browser = null; _context = null; _cfReady = false; });
};

export const getContext = () => _context;
export const isCFReady = () => _cfReady;
