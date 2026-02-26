/**
 * scraper.js
 * KEY INSIGHT from v1: searchDevices and scrapeDevicePage share the SAME context.
 * This means the browser already has Cloudflare cookies from the search step,
 * so the device page loads instantly without a new challenge.
 * All functions take (context) as first argument — routes.js manages the browser lifecycle.
 */
import * as cheerio from 'cheerio';
import { waitForCloudflare, safeNavigate } from './browser.js';
import { cache, TTL } from './cache.js';
import { directSearch } from './http.js';

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

const scoreMatch = (name, q) => {
    const n = name.toLowerCase();
    const queryLower = q.toLowerCase();
    if (n === queryLower) return 1000;
    if (n.includes(queryLower)) return 500;
    let score = 0;
    const words = queryLower.split(/\s+/);
    for (const w of words) if (n.includes(w)) score += 10;
    return score - (n.length * 0.1);
};

/**
 * Search devices. Tries direct HTTP first (fast, no browser).
 * Falls back to browser fetch via the shared context (already past Cloudflare).
 */
export const searchDevices = async (context, query, limit = 5) => {
    const cacheKey = `search:${query.toLowerCase()}-${limit}`;
    const cached = cache.get('search', cacheKey);
    if (cached) return cached;

    const types = detectLikelyTypes(query);

    // Fast path: direct HTTP JSON API
    let allResults;
    try {
        allResults = await directSearch(query, limit, types);
    } catch {
        allResults = null;
    }

    // Browser fallback — context already has CF cookies if we navigated earlier
    if (!allResults || allResults.length === 0) {
        const page = await context.newPage();
        try {
            await page.route('**/*', (route) => {
                if (['font', 'media', 'image', 'stylesheet'].includes(route.request().resourceType())) route.abort();
                else route.continue();
            });
            await safeNavigate(page, 'https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });
            try { await waitForCloudflare(page, 'body', 10000); } catch {
                const ok = await page.evaluate(() => document.body?.innerHTML.length > 100).catch(() => false);
                if (!ok) throw new Error('Page failed to load');
            }
            allResults = await page.evaluate(async ({ query, limit, types }) => {
                const all = await Promise.all(types.map(async (type) => {
                    try {
                        const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
                        const ctrl = new AbortController();
                        const tid = setTimeout(() => ctrl.abort(), 2000);
                        const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
                        clearTimeout(tid);
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

    if (!allResults || allResults.length === 0) return [];
    allResults.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));
    cache.set('search', cacheKey, allResults, TTL.search);
    return allResults;
};

/**
 * Scrape device page. Uses SAME context as searchDevices — already past Cloudflare.
 */
export const scrapeDevicePage = async (context, deviceUrl) => {
    const cached = cache.get('device', deviceUrl);
    if (cached) return cached;

    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            if (['font', 'media', 'image'].includes(route.request().resourceType())) route.abort();
            else route.continue();
        });
        await safeNavigate(page, deviceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1000);

        const html = await page.content();
        const $ = cheerio.load(html);

        const data = {
            title: $('h1').text().trim(),
            sourceUrl: deviceUrl,
            images: [],
            scores: {},
            pros: [],
            cons: [],
            specs: {},
        };

        // Images
        $('img').each((_, img) => {
            const extractUrls = (str) => str ? str.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean) : [];
            const sources = [
                $(img).attr('data-src'), $(img).attr('src'),
                ...extractUrls($(img).attr('srcset')), ...extractUrls($(img).attr('data-srcset')),
            ];
            $(img).closest('picture').find('source').each((__, source) => {
                sources.push(...extractUrls($(source).attr('srcset')));
                sources.push(...extractUrls($(source).attr('data-srcset')));
            });
            $(img).closest('a').each((__, a) => {
                const href = $(a).attr('href');
                if (href?.match(/\.(jpeg|jpg|gif|png|webp)$/i)) sources.push(href);
            });
            sources.forEach(src => {
                if (!src) return;
                if (src.startsWith('/')) src = `https://nanoreview.net${src}`;
                if (src.startsWith('http') && !/(logo|icon|avatar|svg)/i.test(src)) data.images.push(src);
            });
        });
        data.images = [...new Set(data.images)];

        // Scores
        $('[class*="score"], .progress-bar, .rating-box').each((_, el) => {
            const label = $(el).find('[class*="title"], [class*="name"]').first().text().trim() || $(el).prev('div, p, span').text().trim();
            const value = $(el).find('[class*="value"], [class*="num"]').first().text().trim() || $(el).text().replace(/[^0-9]/g, '').trim();
            if (label && value && label !== value) data.scores[label] = value;
        });

        // Pros & Cons
        $('[class*="pros"] li, [class*="plus"] li, .green li').each((_, el) => {
            const t = $(el).text().trim(); if (t) data.pros.push(t);
        });
        $('[class*="cons"] li, [class*="minus"] li, .red li').each((_, el) => {
            const t = $(el).text().trim(); if (t) data.cons.push(t);
        });

        // Specs
        $('.card, .box, section, [class*="specs"]').each((_, card) => {
            const sectionTitle = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Details';
            const section = {};
            $(card).find('table tr').each((__, row) => {
                const cells = $(row).find('td, th');
                if (cells.length >= 2) {
                    const label = cells.first().text().trim().replace(/:$/, '');
                    const value = cells.last().text().trim();
                    if (label && value && label !== value) section[label] = value;
                }
            });
            if (Object.keys(section).length > 0) data.specs[sectionTitle] = section;
        });

        cache.set('device', deviceUrl, data, TTL.device);
        return data;
    } finally {
        await page.close().catch(() => {});
    }
};

/**
 * Scrape compare page. Uses same context — already past Cloudflare.
 */
export const scrapeComparePage = async (context, compareUrl) => {
    const cached = cache.get('compare', compareUrl);
    if (cached) return cached;

    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            if (['font', 'media', 'image'].includes(route.request().resourceType())) route.abort();
            else route.continue();
        });
        await safeNavigate(page, compareUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1000);

        const html = await page.content();
        const $ = cheerio.load(html);

        const data = {
            title: $('h1').text().trim(),
            sourceUrl: compareUrl,
            images: [],
            device1: { name: '', score: '' },
            device2: { name: '', score: '' },
            comparisons: {},
        };

        $('img').each((_, img) => {
            const extractUrls = (str) => str ? str.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean) : [];
            const sources = [$(img).attr('data-src'), $(img).attr('src'), ...extractUrls($(img).attr('srcset'))];
            sources.forEach(src => {
                if (!src) return;
                if (src.startsWith('/')) src = `https://nanoreview.net${src}`;
                if (src.startsWith('http') && !/(logo|icon|avatar|svg)/i.test(src)) data.images.push(src);
            });
        });
        data.images = [...new Set(data.images)];

        const headers = [];
        $('.compare-header [class*="title"], .vs-header h2, th').each((_, el) => {
            const t = $(el).text().trim();
            if (t && t.toLowerCase() !== 'vs') headers.push(t);
        });
        if (headers.length >= 2) { data.device1.name = headers[0]; data.device2.name = headers[1]; }

        $('.card, .box, section, [class*="specs"]').each((_, card) => {
            const sectionTitle = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Comparison';
            const section = {};
            $(card).find('table tr').each((__, row) => {
                const cells = $(row).find('td, th');
                if (cells.length >= 3) {
                    const feature = cells.eq(0).text().trim().replace(/:$/, '');
                    const val1 = cells.eq(1).text().trim();
                    const val2 = cells.eq(2).text().trim();
                    if (feature) section[feature] = { [data.device1.name || 'Device 1']: val1, [data.device2.name || 'Device 2']: val2 };
                }
            });
            if (Object.keys(section).length > 0) data.comparisons[sectionTitle] = section;
        });

        cache.set('compare', compareUrl, data, TTL.compare);
        return data;
    } finally {
        await page.close().catch(() => {});
    }
};

/**
 * Scrape ranking page. Uses same context.
 */
export const scrapeRankingPage = async (context, rankingUrl) => {
    const cached = cache.get('ranking', rankingUrl);
    if (cached) return cached;

    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            if (['font', 'media', 'image'].includes(route.request().resourceType())) route.abort();
            else route.continue();
        });
        await safeNavigate(page, rankingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1000);

        const html = await page.content();
        const $ = cheerio.load(html);

        const data = { title: $('h1').text().trim(), sourceUrl: rankingUrl, rankings: [] };
        const headers = [];
        $('table thead th').each((_, th) => headers.push($(th).text().trim()));
        $('table tbody tr').each((_, row) => {
            const item = {};
            $(row).find('td').each((i, td) => {
                const key = headers[i] ? headers[i].toLowerCase().replace(/\s+/g, '_') : `col_${i}`;
                item[key] = $(td).text().trim();
                const a = $(td).find('a').attr('href');
                if (a && !item.url) item.url = a.startsWith('http') ? a : `https://nanoreview.net${a}`;
            });
            if (Object.keys(item).length > 0) data.rankings.push(item);
        });

        cache.set('ranking', rankingUrl, data, TTL.ranking);
        return data;
    } finally {
        await page.close().catch(() => {});
    }
};
