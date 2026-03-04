/**
 * browser.js — Persistent Playwright browser pool
 * Uses system Chromium installed via apt-get in Dockerfile.
 */
import { chromium } from 'playwright-core';

let _browser = null;
let _context = null;
let _cfCookies = '';
let _cfExpiry = 0;
const CF_TTL = 25 * 60 * 1000;

async function launchBrowser() {
    console.log('[browser] Launching Chromium...');

    // Use system chromium — set via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH env or find automatically
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        || process.env.CHROMIUM_PATH
        || '/usr/bin/chromium'
        || '/usr/bin/chromium-browser';

    const browser = await chromium.launch({
        executablePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--single-process',
            '--no-zygote',
        ],
        timeout: 30000,
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: {
            'accept-language': 'en-US,en;q=0.9',
        },
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = { runtime: {} };
        const orig = window.navigator.permissions.query;
        window.navigator.permissions.query = (p) =>
            p.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : orig(p);
    });

    browser.on('disconnected', () => {
        console.warn('[browser] Disconnected — will relaunch on next request');
        _browser = null;
        _context = null;
    });

    console.log('[browser] Chromium ready ✅');
    return { browser, context };
}

export async function getContext() {
    if (_browser && _context) return _context;
    const { browser, context } = await launchBrowser();
    _browser = browser;
    _context = context;
    return _context;
}

export function getCFCookies() {
    if (_cfCookies && Date.now() < _cfExpiry) return _cfCookies;
    return '';
}

function storeCFCookies(cookies) {
    const cf = cookies.filter(c =>
        c.name === 'cf_clearance' || c.name.startsWith('__cf') || c.name === '_cfuvid'
    );
    if (cf.length) {
        _cfCookies = cf.map(c => `${c.name}=${c.value}`).join('; ');
        _cfExpiry = Date.now() + CF_TTL;
        console.log('[browser] CF cookies stored:', cf.map(c => c.name).join(', '));
    }
}

async function waitForCF(page, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const title = await page.title().catch(() => '');
        if (!/just a moment|attention required|checking your browser/i.test(title)) return;
        await page.waitForTimeout(1000);
    }
}

export async function fetchPage(url, { timeout = 25000 } = {}) {
    const ctx = await getContext();
    const page = await ctx.newPage();
    try {
        await page.route('**/*', route => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
            else route.continue();
        });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        await waitForCF(page);
        const cookies = await ctx.cookies();
        storeCFCookies(cookies);
        return await page.content();
    } finally {
        await page.close().catch(() => {});
    }
}

export async function parallelSearchInBrowser(query, limit, types) {
    const ctx = await getContext();
    const page = await ctx.newPage();
    try {
        await page.route('**/*', route => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
            else route.continue();
        });

        await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await waitForCF(page);

        const results = await page.evaluate(async ({ query, limit, types }) => {
            const all = await Promise.all(types.map(async type => {
                try {
                    const res = await fetch(
                        `/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`,
                        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
                    );
                    if (!res.ok) return [];
                    const data = await res.json();
                    return Array.isArray(data)
                        ? data.map(r => ({ ...r, content_type: r.content_type || type }))
                        : [];
                } catch { return []; }
            }));
            return all.flat();
        }, { query, limit, types });

        const cookies = await ctx.cookies();
        storeCFCookies(cookies);
        return results;
    } finally {
        await page.close().catch(() => {});
    }
}

export async function warmupBrowser() {
    console.log('[browser] Warming up...');
    const t = Date.now();
    try {
        await fetchPage('https://nanoreview.net/en/');
        console.log(`[browser] Warm-up done in ${Date.now() - t}ms. CF cookies: ${!!getCFCookies()}`);
    } catch (err) {
        console.warn('[browser] Warm-up failed:', err.message);
    }
}

export async function destroyBrowser() {
    if (_browser) { await _browser.close().catch(() => {}); _browser = null; _context = null; }
}
