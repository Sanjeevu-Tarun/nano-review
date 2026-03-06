import * as cheerio from 'cheerio';
import { waitForCloudflare, safeNavigate } from './browser.js';

const searchCache = new Map();
const CACHE_TTL = 300000;

const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
    const allTypes = ['phone', 'tablet', 'laptop', 'soc', 'cpu', 'gpu'];
    if (/ryzen|intel|core|threadripper|xeon|celeron|pentium|i[3579]-|amd|snapdragon|mediatek|exynos|dimensity|a[0-9]{2}\s*bionic/i.test(q)) {
        return ['cpu', 'soc', 'laptop', 'phone', 'tablet', 'gpu'];
    }
    if (/nvidia|rtx|gtx|radeon|rx\s*[0-9]|geforce|quadro|vega|arc\s*a[0-9]/i.test(q)) {
        return ['gpu', 'laptop', 'cpu', 'phone', 'tablet', 'soc'];
    }
    if (/iphone|galaxy|pixel|oneplus|xiaomi|oppo|vivo|realme|nothing\s*phone|asus\s*rog\s*phone/i.test(q)) {
        return ['phone', 'soc', 'tablet', 'laptop', 'cpu', 'gpu'];
    }
    if (/ipad|galaxy\s*tab|surface|tab\s*s[0-9]/i.test(q)) {
        return ['tablet', 'phone', 'soc', 'laptop', 'cpu', 'gpu'];
    }
    if (/macbook|thinkpad|xps|zenbook|vivobook|laptop|notebook|ultrabook|chromebook/i.test(q)) {
        return ['laptop', 'cpu', 'gpu', 'tablet', 'phone', 'soc'];
    }
    return allTypes;
};

export const searchDevices = async (context, query, limit = 5) => {
    const cacheKey = `${query.toLowerCase()}-${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.results;

    const types = detectLikelyTypes(query);
    console.log(`[SEARCH] query="${query}" types=${JSON.stringify(types)}`);

    const page = await context.newPage();

    try {
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(type)) route.abort();
            else route.continue();
        });

        await safeNavigate(page, 'https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });

        try {
            await waitForCloudflare(page, 'body', 10000);
        } catch {
            const hasContent = await page.evaluate(() => document.body && document.body.innerHTML.length > 100).catch(() => false);
            console.log(`[SEARCH] CF check failed, hasContent=${hasContent}`);
            if (!hasContent) throw new Error('Page failed to load');
        }

        const pageTitle = await page.title().catch(() => 'unknown');
        const pageUrl = await page.url().catch(() => 'unknown');
        console.log(`[SEARCH] Page loaded - title="${pageTitle}" url="${pageUrl}"`);

        const allResults = await page.evaluate(async ({ query, limit, types }) => {
            const log = [];
            const fetchPromises = types.map(async (type) => {
                try {
                    const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 2000);
                    const response = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
                    clearTimeout(timeoutId);
                    log.push(`type=${type} status=${response.status}`);
                    if (!response.ok) return [];
                    const data = await response.json();
                    log.push(`type=${type} results=${Array.isArray(data) ? data.length : 'not-array'} sample=${JSON.stringify(data).slice(0,100)}`);
                    return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
                } catch (error) {
                    log.push(`type=${type} ERROR=${error.message}`);
                    return [];
                }
            });
            const resultsArrays = await Promise.all(fetchPromises);
            return { results: resultsArrays.flat(), log };
        }, { query, limit, types });

        console.log(`[SEARCH] API logs:\n  ${allResults.log.join('\n  ')}`);
        console.log(`[SEARCH] Total results: ${allResults.results.length}`);
        if (allResults.results.length > 0) {
            console.log(`[SEARCH] First result: ${JSON.stringify(allResults.results[0])}`);
        }

        if (allResults.results.length === 0) return [];

        const scoreMatch = (name, q) => {
            const n = name.toLowerCase();
            const queryLower = q.toLowerCase();
            if (n === queryLower) return 1000;
            if (n.includes(queryLower)) return 500;
            let score = 0;
            const words = queryLower.split(/\s+/);
            for (const w of words) { if (n.includes(w)) score += 10; }
            return score - (n.length * 0.1);
        };

        allResults.results.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));
        searchCache.set(cacheKey, { results: allResults.results, timestamp: Date.now() });
        if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
        return allResults.results;
    } finally {
        await page.close();
    }
};
