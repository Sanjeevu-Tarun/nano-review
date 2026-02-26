/**
 * browser.js - Browser launch + navigation helpers
 * Creates a fresh browser+context per request (same as v1 — proven reliable).
 */
import chromium from '@sparticuz/chromium';
import { chromium as playwrightCore } from 'playwright-core';
import { chromium as playwrightLocal } from 'playwright';

const IS_VERCEL = process.env.VERCEL === '1' || process.env.VERCEL === 'true';

export const getBrowserContext = async () => {
    let browser;

    if (IS_VERCEL) {
        const executablePath = await chromium.executablePath();
        browser = await playwrightCore.launch({
            args: [
                ...chromium.args,
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
            ],
            executablePath: executablePath || undefined,
            headless: true,
            timeout: 30000,
        });
    } else {
        browser = await playwrightLocal.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
            ],
            timeout: 30000,
        });
    }

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
        const orig = window.navigator.permissions.query;
        window.navigator.permissions.query = (p) =>
            p.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : orig(p);
    });

    return { browser, context };
};

export const waitForCloudflare = async (page, selector, timeout = 20000) => {
    const start = Date.now();
    let lastError;

    while (Date.now() - start < timeout) {
        try {
            const title = await page.title().catch(() => '');
            const url = page.url();
            const isChallenge = /just a moment|attention required|cloudflare|verify|human|checking your browser/i.test(title);
            const isChallengeUrl = /cdn-cgi|challenge-platform/i.test(url);

            if (!isChallenge && !isChallengeUrl) {
                try {
                    await page.waitForSelector(selector, { timeout: 2000, state: 'attached' });
                    return true;
                } catch {
                    const hasContent = await page.evaluate(() => document.body && document.body.innerHTML.length > 100).catch(() => false);
                    if (hasContent) return true;
                }
            }
            await page.waitForTimeout(1000);
        } catch (error) {
            lastError = error;
            await page.waitForTimeout(1000);
        }
    }

    try {
        const hasContent = await page.evaluate(() => document.body && document.body.innerHTML.length > 100).catch(() => false);
        if (hasContent) return true;
    } catch {}

    throw new Error(`Cloudflare timeout after ${timeout}ms: ${lastError?.message || 'Unknown'}`);
};

export const safeNavigate = async (page, url, options = {}) => {
    const defaultOptions = { waitUntil: 'domcontentloaded', timeout: 25000 };
    try {
        await page.goto(url, { ...defaultOptions, ...options });
        return true;
    } catch (error) {
        try {
            const hasContent = await page.evaluate(() => document.body && document.body.innerHTML.length > 100).catch(() => false);
            if (hasContent) return true;
        } catch {}
        throw error;
    }
};

export const blockResources = async (page, block = ['font', 'media', 'image', 'stylesheet']) => {
    await page.route('**/*', (route) => {
        if (block.includes(route.request().resourceType())) route.abort();
        else route.continue();
    });
};
