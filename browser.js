/**
 * browser.js
 *
 * Render free tier facts:
 * - No persistent disk → CF cookies don't survive restarts
 * - Self-ping is blocked → can't prevent sleep from inside
 * - Sleep after 15min inactivity → cold start on next request
 *
 * Strategy:
 * - Use launchPersistentContext with a TEMP dir (in-process lifetime only)
 * - warmUp() runs immediately on startup in background
 * - Requests that arrive before warmup block on warmUpPromise
 * - Once warm, CF cookies live in memory for the process lifetime
 * - UptimeRobot (external) pings /health every 5min → process never sleeps
 *   → warmup only happens ONCE per deploy, not per request
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { directFetchHtml } from './http.js';

// Use /tmp for browser data — always writable on Render free
const USER_DATA_DIR = process.env.BROWSER_DATA_DIR
    || path.join(os.tmpdir(), 'nanoreview-browser');

let _context = null;
let _launching = null;
let _cfCookies = null;
let _cfCookieExpiry = 0;

export let warmUpPromise = null;
let _warmUpDone = false;

const BLOCKED = new Set(['font', 'media', 'image', 'stylesheet']);

// ── Context ───────────────────────────────────────────────────────────────

async function getContext() {
    if (_context) return _context;
    if (_launching) return _launching;

    _launching = (async () => {
        fs.mkdirSync(USER_DATA_DIR, { recursive: true });
        console.log('[browser] Launching...');
        const t = Date.now();

        _context = await chromium.launchPersistentContext(USER_DATA_DIR, {
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage', '--disable-extensions',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--no-first-run', '--no-zygote', '--disable-gpu',
                '--single-process', '--memory-pressure-off',
                '--disable-ipc-flooding-protection',
            ],
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 720 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
            ignoreHTTPSErrors: true,
        });

        await _context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            window.chrome = { runtime: {} };
        });

        _context.on('close', () => {
            _context = null; _launching = null;
            _cfCookies = null; _cfCookieExpiry = 0;
            _warmUpDone = false;
            warmUp().catch(() => {}); // auto re-warmup
        });

        console.log(`[browser] Launched in ${Date.now() - t}ms`);
        _launching = null;
        return _context;
    })();

    return _launching;
}

async function newPage() {
    const ctx = await getContext();
    const page = await ctx.newPage();
    await page.route('**/*', route =>
        BLOCKED.has(route.request().resourceType()) ? route.abort() : route.continue()
    );
    return page;
}

// ── CF Cookies ────────────────────────────────────────────────────────────

async function extractCFCookies() {
    if (!_context) return null;
    try {
        const cookies = await _context.cookies('https://nanoreview.net');
        const cf = cookies.filter(c =>
            c.name === 'cf_clearance' || c.name.startsWith('__cf') || c.name === '_cfuvid'
        );
        if (!cf.length) return null;
        const str = cf.map(c => `${c.name}=${c.value}`).join('; ');
        const exp = cf.find(c => c.name === 'cf_clearance');
        _cfCookies = str;
        _cfCookieExpiry = exp?.expires
            ? exp.expires * 1000
            : Date.now() + 25 * 60 * 1000;
        console.log('[browser] CF cookies:', cf.map(c => c.name).join(', '));
        return str;
    } catch { return null; }
}

export async function getCFCookies() {
    if (_cfCookies && Date.now() < _cfCookieExpiry) return _cfCookies;
    return null;
}

// ── Warmup ────────────────────────────────────────────────────────────────

export function warmUp() {
    if (warmUpPromise) return warmUpPromise;
    warmUpPromise = _doWarmUp().catch(err => {
        console.error('[warmup] Failed:', err.message);
        warmUpPromise = null; // allow retry
    });
    return warmUpPromise;
}

async function _doWarmUp() {
    console.log('[warmup] Starting...');
    const t = Date.now();
    await getContext(); // launch browser

    const page = await newPage();
    try {
        await page.goto('https://nanoreview.net/en/', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        await waitForCloudflare(page, 15000);
        await extractCFCookies();
    } finally {
        await page.close().catch(() => {});
    }

    _warmUpDone = true;
    console.log(`[warmup] Done in ${Date.now() - t}ms. CF cookies: ${!!_cfCookies}`);
}

async function awaitWarmup() {
    if (_warmUpDone) return;
    if (warmUpPromise) await warmUpPromise.catch(() => {});
}

// ── CF detection ──────────────────────────────────────────────────────────

export async function waitForCloudflare(page, timeout = 12000) {
    try {
        const title = await page.title();
        if (!/just a moment|attention required|cloudflare|checking your browser/i.test(title)) {
            await extractCFCookies();
            return true;
        }
    } catch { return true; }

    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const title = await page.title();
            const url = page.url();
            if (!/just a moment|attention required|cloudflare|checking your browser/i.test(title)
                && !/cdn-cgi|challenge-platform/i.test(url)) {
                await extractCFCookies();
                return true;
            }
            await page.waitForTimeout(300);
        } catch { return true; }
    }
    await extractCFCookies();
    return true;
}

// ── Public fetch APIs ─────────────────────────────────────────────────────

export async function browserFetchDirect(url) {
    await awaitWarmup();
    const page = await newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForCloudflare(page, 8000);
        return await page.content();
    } finally {
        await page.close().catch(() => {});
    }
}

export async function browserSearchDirect(query, limit, types) {
    await awaitWarmup();
    const page = await newPage();
    try {
        const cur = page.url();
        if (!cur.includes('nanoreview.net')) {
            await page.goto('https://nanoreview.net/en/', {
                waitUntil: 'domcontentloaded', timeout: 20000,
            });
            await waitForCloudflare(page, 8000);
        }
        return await page.evaluate(async ({ query, limit, types }) => {
            const all = await Promise.all(types.map(async type => {
                try {
                    const r = await fetch(
                        `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`,
                        { headers: { Accept: 'application/json' } }
                    );
                    if (!r.ok) return [];
                    const d = await r.json();
                    return Array.isArray(d) ? d.map(x => ({ ...x, content_type: x.content_type || type })) : [];
                } catch { return []; }
            }));
            return all.flat();
        }, { query, limit, types });
    } finally {
        await page.close().catch(() => {});
    }
}
