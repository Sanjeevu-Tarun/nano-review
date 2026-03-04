import chromium from '@sparticuz/chromium';
import { chromium as playwrightCore } from 'playwright-core';
import { chromium as playwrightLocal } from 'playwright';

export const getBrowserContext = async () => {
    const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true';
    let browser;

    if (isVercel) {
        // Vercel environment - use playwright-core with chromium
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
            headless: chromium.headless !== false ? true : chromium.headless,
            timeout: 30000,
        });
    } else {
        // Local environment
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
        // Increase timeout for slow responses
        timeout: 30000,
    });

    // Add stealth-like behavior without the plugin
    await context.addInitScript(() => {
        // Override the navigator.webdriver property
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
        });

        // Override the navigator.plugins to appear more real
        Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
        });

        // Override chrome property
        window.chrome = {
            runtime: {},
        };

        // Override permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
        );
    });

    return { browser, context };
};

export const waitForCloudflare = async (page, selector, timeout = 20000) => {
    const start = Date.now();
    let lastError;

    while (Date.now() - start < timeout) {
        try {
            // Check if we're past Cloudflare
            const title = await page.title().catch(() => '');
            const url = await page.url().catch(() => '');

            const isChallenge = /just a moment|attention required|cloudflare|verify|human|checking your browser/i.test(title);
            const isChallengeUrl = /cdn-cgi|challenge-platform/i.test(url);

            if (!isChallenge && !isChallengeUrl) {
                // Try to find the selector or just return if page seems loaded
                try {
                    await page.waitForSelector(selector, { timeout: 2000, state: 'attached' });
                    return true;
                } catch {
                    // Check if page at least has content
                    const hasContent = await page.evaluate(() => document.body && document.body.innerHTML.length > 100);
                    if (hasContent) return true;
                }
            }

            await page.waitForTimeout(1000);
        } catch (error) {
            lastError = error;
            await page.waitForTimeout(1000);
        }
    }

    // One final check before failing
    try {
        const hasContent = await page.evaluate(() => document.body && document.body.innerHTML.length > 100);
        if (hasContent) return true;
    } catch {}

    throw new Error(`Cloudflare timeout after ${timeout}ms: ${lastError?.message || 'Unknown error'}`);
};

export const safeNavigate = async (page, url, options = {}) => {
    const defaultOptions = {
        waitUntil: 'domcontentloaded',
        timeout: 25000,
    };

    try {
        await page.goto(url, { ...defaultOptions, ...options });
        return true;
    } catch (error) {
        // If navigation times out but we have content, that's okay
        try {
            const hasContent = await page.evaluate(() => document.body && document.body.innerHTML.length > 100);
            if (hasContent) return true;
        } catch {}
        throw error;
    }
};