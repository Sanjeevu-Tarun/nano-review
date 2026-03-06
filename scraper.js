import * as cheerio from 'cheerio';
import { waitForCloudflare, safeNavigate } from './browser.js';

const searchCache = new Map();
const CACHE_TTL = 300000;

// Track which contexts have been warmed up (CF cookies obtained)
const warmedContexts = new WeakSet();

const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
    const allTypes = ['phone', 'tablet', 'laptop', 'soc', 'cpu', 'gpu'];
    if (/ryzen|intel|core|threadripper|xeon|celeron|pentium|i[3579]-|amd|snapdragon|mediatek|exynos|dimensity|a[0-9]{2}\s*bionic/i.test(q))
        return ['cpu', 'soc', 'laptop', 'phone', 'tablet', 'gpu'];
    if (/nvidia|rtx|gtx|radeon|rx\s*[0-9]|geforce|quadro|vega|arc\s*a[0-9]/i.test(q))
        return ['gpu', 'laptop', 'cpu', 'phone', 'tablet', 'soc'];
    if (/iphone|galaxy|pixel|oneplus|xiaomi|oppo|vivo|realme|nothing\s*phone|asus\s*rog\s*phone/i.test(q))
        return ['phone', 'soc', 'tablet', 'laptop', 'cpu', 'gpu'];
    if (/ipad|galaxy\s*tab|surface|tab\s*s[0-9]/i.test(q))
        return ['tablet', 'phone', 'soc', 'laptop', 'cpu', 'gpu'];
    if (/macbook|thinkpad|xps|zenbook|vivobook|laptop|notebook|ultrabook|chromebook/i.test(q))
        return ['laptop', 'cpu', 'gpu', 'tablet', 'phone', 'soc'];
    return allTypes;
};

// ─── Resource blocker helper ──────────────────────────────────────────────────
const blockHeavyResources = (page, blockStylesheets = false) =>
    page.route('**/*', (route) => {
        const t = route.request().resourceType();
        const blocked = blockStylesheets
            ? ['font', 'media', 'image', 'stylesheet']
            : ['font', 'media', 'image'];
        if (blocked.includes(t)) route.abort();
        else route.continue();
    });

// ─── Smart content-ready wait ─────────────────────────────────────────────────
const waitForContentReady = async (page, maxMs = 1500) => {
    await page.evaluate((max) => new Promise((resolve) => {
        let timer;
        const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => { observer.disconnect(); resolve(); }, 150);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve(); }, max);
        if (document.body.innerHTML.length > 500) { observer.disconnect(); resolve(); }
    }), maxMs);
};

// ─── Ensure CF cookies on context (once per context) ─────────────────────────
const ensureCookies = async (context) => {
    if (warmedContexts.has(context)) return;
    warmedContexts.add(context);

    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
            else route.continue();
        });
        await safeNavigate(page, 'https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await waitForCloudflare(page, 'body', 12000).catch(() => {});
    } finally {
        await page.close();
    }
};

// ─── Search ───────────────────────────────────────────────────────────────────
export const searchDevices = async (context, query, limit = 5) => {
    const cacheKey = `${query.toLowerCase()}-${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.results;

    const types = detectLikelyTypes(query);

    // Ensure CF cookies are set on this context before making API calls
    await ensureCookies(context);

    const page = await context.newPage();
    try {
        // Only block fonts/media/images — NOT stylesheets (CF challenge may need them)
        await blockHeavyResources(page, false);

        // Navigate to the domain so fetch() runs in the correct origin with cookies
        await safeNavigate(page, 'https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 25000 });

        // Wait until not on a CF challenge page
        await waitForCloudflare(page, 'body', 12000).catch(() => {});

        // Fire all type searches in parallel from within the browser (carries CF cookies)
        const allResults = await page.evaluate(async ({ query, limit, types }) => {
            const results = [];
            const fetchPromises = types.map(async (type) => {
                try {
                    const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 5000);
                    const response = await fetch(url, {
                        signal: controller.signal,
                        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    });
                    clearTimeout(timeoutId);
                    if (!response.ok) return;
                    const data = await response.json();
                    if (Array.isArray(data)) {
                        data.forEach(r => results.push({ ...r, content_type: r.content_type || type }));
                    }
                } catch (e) {
                    // swallow per-type errors
                }
            });
            await Promise.all(fetchPromises);
            return results;
        }, { query, limit, types });

        if (!allResults || allResults.length === 0) return [];

        const scoreMatch = (name, q) => {
            const n = name.toLowerCase();
            const queryLower = q.toLowerCase();
            if (n === queryLower) return 1000;
            if (n.includes(queryLower)) return 500;
            let score = 0;
            for (const w of queryLower.split(/\s+/)) {
                if (n.includes(w)) score += 10;
            }
            return score - n.length * 0.1;
        };

        allResults.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));

        searchCache.set(cacheKey, { results: allResults, timestamp: Date.now() });
        if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);

        return allResults;
    } finally {
        await page.close();
    }
};

// ─── Shared image extractor ───────────────────────────────────────────────────
const extractImages = ($) => {
    const images = [];
    $('img').each((_, img) => {
        const extractUrls = (str) =>
            str ? str.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean) : [];

        const sources = [
            $(img).attr('data-src'),
            $(img).attr('src'),
            ...extractUrls($(img).attr('srcset')),
            ...extractUrls($(img).attr('data-srcset')),
        ];

        $(img).closest('picture').find('source').each((_, src) => {
            sources.push(...extractUrls($(src).attr('srcset')));
            sources.push(...extractUrls($(src).attr('data-srcset')));
        });

        $(img).closest('a').each((_, a) => {
            const href = $(a).attr('href');
            if (href?.match(/\.(jpeg|jpg|gif|png|webp)$/i)) sources.push(href);
        });

        for (let src of sources) {
            if (!src) continue;
            if (src.startsWith('/')) src = `https://nanoreview.net${src}`;
            const low = src.toLowerCase();
            if (src.startsWith('http') && !low.includes('logo') && !low.includes('icon') &&
                !low.includes('avatar') && !low.includes('svg')) {
                images.push(src);
            }
        }
    });
    return [...new Set(images)];
};

// ─── Device page ─────────────────────────────────────────────────────────────
export const scrapeDevicePage = async (context, deviceUrl) => {
    const page = await context.newPage();
    try {
        await blockHeavyResources(page);
        await safeNavigate(page, deviceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForContentReady(page, 1500);

        const html = await page.content();
        const $ = cheerio.load(html);

        const data = {
            title: $('h1').text().trim(),
            sourceUrl: deviceUrl,
            images: extractImages($),
            scores: {},
            pros: [],
            cons: [],
            specs: {},
        };

        $('[class*="score"], .progress-bar, .rating-box').each((_, el) => {
            const label = $(el).find('[class*="title"], [class*="name"]').first().text().trim()
                || $(el).prev('div, p, span').text().trim();
            const value = $(el).find('[class*="value"], [class*="num"]').first().text().trim()
                || $(el).text().replace(/[^0-9]/g, '').trim();
            if (label && value && label !== value) data.scores[label] = value;
        });

        $('[class*="pros"] li, [class*="plus"] li, .green li').each((_, el) => {
            const text = $(el).text().trim();
            if (text) data.pros.push(text);
        });

        $('[class*="cons"] li, [class*="minus"] li, .red li').each((_, el) => {
            const text = $(el).text().trim();
            if (text) data.cons.push(text);
        });

        $('.card, .box, section, [class*="specs"]').each((_, card) => {
            const sectionTitle = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Details';
            const section = {};
            $(card).find('table tr').each((_, row) => {
                const cells = $(row).find('td, th');
                if (cells.length >= 2) {
                    const label = cells.first().text().trim().replace(/:$/, '');
                    const value = cells.last().text().trim();
                    if (label && value && label !== value) section[label] = value;
                }
            });
            if (Object.keys(section).length > 0) data.specs[sectionTitle] = section;
        });

        return data;
    } finally {
        await page.close();
    }
};

// ─── Compare page ─────────────────────────────────────────────────────────────
export const scrapeComparePage = async (context, compareUrl) => {
    const page = await context.newPage();
    try {
        await blockHeavyResources(page);
        await safeNavigate(page, compareUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForContentReady(page, 1500);

        const html = await page.content();
        const $ = cheerio.load(html);

        const data = {
            title: $('h1').text().trim(),
            sourceUrl: compareUrl,
            images: extractImages($),
            device1: { name: '', score: '' },
            device2: { name: '', score: '' },
            comparisons: {},
        };

        const headers = [];
        $('.compare-header [class*="title"], .vs-header h2, th').each((_, el) => {
            const text = $(el).text().trim();
            if (text && text.toLowerCase() !== 'vs') headers.push(text);
        });

        if (headers.length >= 2) {
            data.device1.name = headers[0];
            data.device2.name = headers[1];
        }

        $('.card, .box, section, [class*="specs"]').each((_, card) => {
            const sectionTitle = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Comparison';
            const section = {};
            $(card).find('table tr').each((_, row) => {
                const cells = $(row).find('td, th');
                if (cells.length >= 3) {
                    const feature = cells.eq(0).text().trim().replace(/:$/, '');
                    const val1 = cells.eq(1).text().trim();
                    const val2 = cells.eq(2).text().trim();
                    if (feature) {
                        section[feature] = {
                            [data.device1.name || 'Device 1']: val1,
                            [data.device2.name || 'Device 2']: val2,
                        };
                    }
                }
            });
            if (Object.keys(section).length > 0) data.comparisons[sectionTitle] = section;
        });

        return data;
    } finally {
        await page.close();
    }
};

// ─── Ranking page ─────────────────────────────────────────────────────────────
export const scrapeRankingPage = async (context, rankingUrl) => {
    const page = await context.newPage();
    try {
        await blockHeavyResources(page);
        await safeNavigate(page, rankingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForContentReady(page, 1500);

        const html = await page.content();
        const $ = cheerio.load(html);

        const data = {
            title: $('h1').text().trim(),
            sourceUrl: rankingUrl,
            rankings: [],
        };

        const headers = [];
        $('table thead th').each((_, th) => headers.push($(th).text().trim()));

        $('table tbody tr').each((_, row) => {
            const item = {};
            $(row).find('td').each((i, td) => {
                const val = $(td).text().trim();
                const key = headers[i] ? headers[i].toLowerCase().replace(/\s+/g, '_') : `col_${i}`;
                item[key] = val;
                const a = $(td).find('a').attr('href');
                if (a && !item.url) item.url = a.startsWith('http') ? a : `https://nanoreview.net${a}`;
            });
            if (Object.keys(item).length > 0) data.rankings.push(item);
        });

        return data;
    } finally {
        await page.close();
    }
};
