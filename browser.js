/**
 * browser.js — Persistent Playwright browser pool
 *
 * Uses a single shared browser instance with a persistent context.
 * CF cookies captured once and reused across all requests.
 * Browser auto-restarts if it crashes.
 */
import { chromium } from 'playwright-core';
import * as SparkChromium from '@sparticuz/chromium';

let _browser = null;
let _context = null;
let _cfCookies = '';
let _cfExpiry = 0;
const CF_TTL = 25 * 60 * 1000;
let _warming = null;

async function launchBrowser() {
    console.log('[browser] Launching Chromium...');
    const executablePath = await SparkChromium.default.executablePath();
    const browser = await chromium.launch({
        args: [
            ...SparkChromium.default.args,
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--disable-setuid-sandbox',
        ],
        executablePath,
        headless: true,
        timeout: 30000,
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = { runtime: {} };
    });

    browser.on('disconnected', () => {
        console.warn('[browser] Browser disconnected, will relaunch on next request');
        _browser = null;
        _context = null;
    });

    console.log('[browser] Chromium ready ✅');
    return { browser, context };
}

async function getContext() {
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

/**
 * fetchPage — navigate to URL, wait for CF challenge to resolve, return HTML.
 * Reuses the shared context so CF cookies persist across requests.
 */
export async function fetchPage(url, { timeout = 20000, waitForSelector = null } = {}) {
    const ctx = await getContext();
    const page = await ctx.newPage();

    try {
        // Block heavy resources
        await page.route('**/*', route => {
            const type = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(type)) route.abort();
            else route.continue();
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

        // Wait for CF challenge to pass (up to 15s)
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const title = await page.title().catch(() => '');
            const isCF = /just a moment|attention required|checking your browser/i.test(title);
            if (!isCF) break;
            await page.waitForTimeout(1000);
        }

        if (waitForSelector) {
            await page.waitForSelector(waitForSelector, { timeout: 5000 }).catch(() => {});
        }

        // Capture CF cookies for reuse
        const cookies = await ctx.cookies();
        storeCFCookies(cookies);

        return await page.content();
    } finally {
        await page.close().catch(() => {});
    }
}

/**
 * fetchJson — execute a fetch() call from inside the browser context.
 * This is how v1 bypassed CF on /api/search — browser's fetch inherits
 * the CF cookies and TLS fingerprint from the existing session.
 */
export async function fetchJsonInBrowser(url) {
    const ctx = await getContext();
    const page = await ctx.newPage();

    try {
        // Need a base page loaded for fetch to work with CF cookies
        // Use a lightweight page — if context already has CF cookies from warmup, this is instant
        const baseUrl = 'https://nanoreview.net/en/';
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            const title = await page.title().catch(() => '');
            if (!/just a moment|checking your browser/i.test(title)) break;
            await page.waitForTimeout(800);
        }

        const result = await page.evaluate(async (fetchUrl) => {
            try {
                const res = await fetch(fetchUrl, {
                    headers: { 'accept': 'application/json' },
                    signal: AbortSignal.timeout(6000),
                });
                if (!res.ok) return { error: res.status };
                return { data: await res.json() };
            } catch (e) {
                return { error: e.message };
            }
        }, url);

        const cookies = await ctx.cookies();
        storeCFCookies(cookies);

        if (result.error) throw new Error(`Browser fetch failed: ${result.error}`);
        return result.data;
    } finally {
        await page.close().catch(() => {});
    }
}

/**
 * parallelSearchInBrowser — search all types simultaneously from one browser page.
 * Much faster than opening a page per type.
 */
export async function parallelSearchInBrowser(query, limit, types) {
    const ctx = await getContext();
    const page = await ctx.newPage();

    try {
        await page.route('**/*', route => {
            const type = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(type)) route.abort();
            else route.continue();
        });

        await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });

        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const title = await page.title().catch(() => '');
            if (!/just a moment|checking your browser/i.test(title)) break;
            await page.waitForTimeout(800);
        }

        const results = await page.evaluate(async ({ query, limit, types }) => {
            const all = await Promise.all(types.map(async type => {
                try {
                    const res = await fetch(
                        `/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`,
                        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) }
                    );
                    if (!res.ok) return [];
                    const data = await res.json();
                    return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
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
    if (_warming) return _warming;
    _warming = (async () => {
        const t = Date.now();
        console.log('[browser] Warming up (loading nanoreview + capturing CF cookies)...');
        try {
            await fetchPage('https://nanoreview.net/en/');
            console.log(`[browser] Warm-up done in ${Date.now() - t}ms. CF: ${!!getCFCookies()}`);
        } catch (err) {
            console.warn('[browser] Warm-up failed:', err.message);
        }
        _warming = null;
    })();
    return _warming;
}

export async function destroyBrowser() {
    if (_browser) {
        await _browser.close().catch(() => {});
        _browser = null;
        _context = null;
    }
}
