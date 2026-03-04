/**
 * browser.js — Browser pool with CF session management
 *
 * Strategy:
 * 1. On startup: open ONE page, load nanoreview.net, solve CF challenge, store cookies
 * 2. All subsequent requests: use a persistent page that stays open at nanoreview.net
 *    and makes fetch() calls from inside it — no new navigations
 * 3. If CF challenge appears again: re-solve on the persistent page
 */
import { chromium } from 'playwright-core';

let _browser = null;
let _context = null;
let _activePage = null;      // persistent page kept alive at nanoreview.net
let _pageReady = false;      // true = page is at nanoreview.net and past CF
let _initPromise = null;     // deduplicate concurrent init calls

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium';
const BASE_URL = 'https://nanoreview.net/en/';

// ── Launch ────────────────────────────────────────────────────────────────

async function launch() {
    console.log('[browser] Launching Chromium...');
    const browser = await chromium.launch({
        executablePath: CHROMIUM_PATH,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
            '--no-zygote',
            '--single-process',
        ],
        timeout: 30000,
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = { runtime: {} };
    });

    browser.on('disconnected', () => {
        console.warn('[browser] Disconnected, resetting state');
        _browser = null; _context = null; _activePage = null; _pageReady = false; _initPromise = null;
    });

    console.log('[browser] Chromium ready ✅');
    _browser = browser;
    _context = context;
    return context;
}

// ── CF challenge waiter ───────────────────────────────────────────────────

async function waitForCF(page, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const title = await page.title().catch(() => '');
        const url = page.url();
        if (
            !/just a moment|attention required|checking your browser/i.test(title) &&
            !/cdn-cgi\/challenge/i.test(url)
        ) return true;
        console.log('[browser] Waiting for CF challenge...');
        await page.waitForTimeout(1500);
    }
    return false; // timed out but continue anyway
}

// ── Persistent active page ────────────────────────────────────────────────
// This page stays open at nanoreview.net. All fetch() calls go through it.

async function ensureActivePage() {
    // Already ready
    if (_activePage && _pageReady) return _activePage;

    // Deduplicate concurrent calls
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        try {
            const ctx = _context || await launch();

            if (!_activePage || _activePage.isClosed()) {
                _activePage = await ctx.newPage();

                // Block heavy resources on this page too
                await _activePage.route('**/*', route => {
                    const t = route.request().resourceType();
                    if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
                    else route.continue();
                });
            }

            console.log('[browser] Navigating to nanoreview.net...');
            await _activePage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await waitForCF(_activePage);

            _pageReady = true;
            console.log('[browser] Active page ready at nanoreview.net ✅');
            return _activePage;
        } finally {
            _initPromise = null;
        }
    })();

    return _initPromise;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * runFetch — execute a fetch() from inside the persistent browser page.
 * Fast: no navigation, inherits CF cookies, reuses existing session.
 */
export async function runFetch(url, { isJson = true } = {}) {
    const page = await ensureActivePage();

    const result = await page.evaluate(async ({ url, isJson }) => {
        try {
            const res = await fetch(url, {
                headers: { accept: isJson ? 'application/json' : 'text/html,*/*' },
                signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) return { error: res.status, status: res.status };
            const text = await res.text();
            return { text, status: res.status };
        } catch (e) { return { error: String(e) }; }
    }, { url, isJson });

    if (result.error) {
        // If CF kicked us out, reset page readiness and retry once
        if (result.status === 403 || result.status === 503) {
            console.warn('[browser] CF blocked fetch, re-warming page...');
            _pageReady = false;
            const page2 = await ensureActivePage();
            const retry = await page2.evaluate(async ({ url, isJson }) => {
                try {
                    const res = await fetch(url, {
                        headers: { accept: isJson ? 'application/json' : 'text/html,*/*' },
                        signal: AbortSignal.timeout(10000),
                    });
                    if (!res.ok) return { error: res.status };
                    return { text: await res.text(), status: res.status };
                } catch (e) { return { error: String(e) }; }
            }, { url, isJson });
            if (retry.error) throw new Error(`Fetch failed after retry: ${retry.error}`);
            return retry.text;
        }
        throw new Error(`Fetch error for ${url}: ${result.error}`);
    }

    return result.text;
}

/**
 * parallelSearchInBrowser — fire all type searches simultaneously from inside browser.
 */
export async function parallelSearchInBrowser(query, limit, types) {
    const page = await ensureActivePage();

    const results = await page.evaluate(async ({ query, limit, types }) => {
        const all = await Promise.all(types.map(async type => {
            try {
                const res = await fetch(
                    `/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`,
                    { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(7000) }
                );
                if (!res.ok) return [];
                const data = await res.json();
                return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
            } catch { return []; }
        }));
        return all.flat();
    }, { query, limit, types });

    return results;
}

/**
 * fetchPageHtml — navigate a TEMPORARY page and get HTML.
 * Used only for device pages (not search). Separate from active page.
 */
export async function fetchPageHtml(url) {
    // Ensure we have a context (may trigger launch if first call)
    if (!_context) await ensureActivePage();

    const page = await _context.newPage();
    try {
        await page.route('**/*', route => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
            else route.continue();
        });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await waitForCF(page, 15000);
        return await page.content();
    } finally {
        await page.close().catch(() => {});
    }
}

export async function warmupBrowser() {
    console.log('[browser] Warming up (establishing CF session)...');
    const t = Date.now();
    try {
        await ensureActivePage();
        console.log(`[browser] Warm-up done in ${Date.now() - t}ms ✅`);
    } catch (err) {
        console.warn('[browser] Warm-up failed:', err.message);
    }
}

export async function destroyBrowser() {
    if (_browser) { await _browser.close().catch(() => {}); }
    _browser = null; _context = null; _activePage = null; _pageReady = false;
}
