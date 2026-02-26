/**
 * scraper.js - Scraping logic with:
 * 1. Direct HTTP first (no browser) -> fast path
 * 2. Fresh browser+context fallback (same as v1 - proven reliable)
 * 3. Full cache integration
 */
import * as cheerio from 'cheerio';
import { getBrowserContext, waitForCloudflare, safeNavigate, blockResources } from './browser.js';
import { cache, TTL } from './cache.js';
import { directSearch, directFetchHtml } from './http.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
    if (/ryzen|intel|core|threadripper|xeon|celeron|pentium|i[3579]-|amd\s*(ryzen|fx|a\d)|phenom/i.test(q))
        return ['cpu', 'laptop', 'soc', 'gpu'];
    if (/nvidia|rtx|gtx|radeon|rx\s*[0-9]|geforce|quadro|vega|arc\s*a[0-9]|titan/i.test(q))
        return ['gpu', 'laptop', 'cpu'];
    if (/snapdragon|mediatek|exynos|dimensity|a[0-9]{2}\s*bionic|kirin|tensor/i.test(q))
        return ['soc', 'phone', 'tablet'];
    if (/iphone|galaxy\s*s|galaxy\s*note|pixel|oneplus|xiaomi|oppo|vivo|realme|nothing\s*phone|asus\s*rog\s*phone|poco/i.test(q))
        return ['phone', 'soc', 'tablet'];
    if (/ipad|galaxy\s*tab|surface\s*pro|tab\s*s[0-9]|kindle\s*fire/i.test(q))
        return ['tablet', 'phone', 'soc'];
    if (/macbook|thinkpad|xps|zenbook|vivobook|laptop|notebook|ultrabook|chromebook|pavilion|inspiron/i.test(q))
        return ['laptop', 'cpu', 'gpu'];
    return ['phone', 'laptop', 'cpu', 'gpu', 'soc', 'tablet'];
};

const scoreMatch = (name, q) => {
    const n = name.toLowerCase();
    const ql = q.toLowerCase();
    if (n === ql) return 1000;
    if (n.startsWith(ql)) return 800;
    if (n.includes(ql)) return 500;
    const words = ql.split(/\s+/);
    let score = 0;
    for (const w of words) if (n.includes(w)) score += 10;
    return score - (n.length * 0.05);
};

// ── Pure HTML scrapers (no browser required) ───────────────────────────────

const extractImages = ($) => {
    const images = new Set();
    $('img').each((_, img) => {
        const extractUrls = (str) => {
            if (!str) return [];
            return str.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean);
        };
        const sources = [];
        sources.push($(img).attr('data-src'));
        sources.push($(img).attr('src'));
        sources.push(...extractUrls($(img).attr('srcset')));
        sources.push(...extractUrls($(img).attr('data-srcset')));
        $(img).closest('picture').find('source').each((__, source) => {
            sources.push(...extractUrls($(source).attr('srcset')));
            sources.push(...extractUrls($(source).attr('data-srcset')));
        });
        sources.forEach(src => {
            if (!src) return;
            if (src.startsWith('/')) src = `https://nanoreview.net${src}`;
            const l = src.toLowerCase();
            if (src.startsWith('http') && !l.includes('logo') && !l.includes('icon') && !l.includes('avatar') && !l.includes('svg'))
                images.add(src);
        });
    });
    return Array.from(images);
};

export const scrapeDeviceHtml = (html, deviceUrl) => {
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
        const label = $(el).find('[class*="title"], [class*="name"]').first().text().trim() ||
                      $(el).prev('div, p, span').text().trim();
        const value = $(el).find('[class*="value"], [class*="num"]').first().text().trim() ||
                      $(el).text().replace(/[^0-9.]/g, '').trim();
        if (label && value && label !== value) data.scores[label] = value;
    });

    $('[class*="pros"] li, [class*="plus"] li, .green li').each((_, el) => {
        const t = $(el).text().trim();
        if (t) data.pros.push(t);
    });

    $('[class*="cons"] li, [class*="minus"] li, .red li').each((_, el) => {
        const t = $(el).text().trim();
        if (t) data.cons.push(t);
    });

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

    return data;
};

export const scrapeCompareHtml = (html, compareUrl) => {
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
        const t = $(el).text().trim();
        if (t && t.toLowerCase() !== 'vs') headers.push(t);
    });
    if (headers.length >= 2) {
        data.device1.name = headers[0];
        data.device2.name = headers[1];
    }

    $('.card, .box, section, [class*="specs"]').each((_, card) => {
        const sectionTitle = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Comparison';
        const section = {};
        $(card).find('table tr').each((__, row) => {
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
};

export const scrapeRankingHtml = (html, rankingUrl) => {
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
};

// ── Browser-based scrapers (fallback) ─────────────────────────────────────
// Uses fresh browser+context per call — same as v1 which is proven to work.

async function browserSearchDevices(query, limit, types) {
    const { browser, context } = await getBrowserContext();
    try {
        const page = await context.newPage();
        try {
            await blockResources(page, ['font', 'media', 'image', 'stylesheet']);
            await safeNavigate(page, 'https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });
            await waitForCloudflare(page, 'body', 10000).catch(() => {});

            return await page.evaluate(async ({ query, limit, types }) => {
                const fetchPromises = types.map(async (type) => {
                    try {
                        const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
                        const controller = new AbortController();
                        const tid = setTimeout(() => controller.abort(), 2000);
                        const response = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
                        clearTimeout(tid);
                        if (!response.ok) return [];
                        const data = await response.json();
                        return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
                    } catch { return []; }
                });
                return (await Promise.all(fetchPromises)).flat();
            }, { query, limit, types });
        } finally {
            await page.close().catch(() => {});
        }
    } finally {
        await browser.close().catch(() => {});
    }
}

async function browserFetchHtml(url) {
    const { browser, context } = await getBrowserContext();
    try {
        const page = await context.newPage();
        try {
            await blockResources(page, ['font', 'media', 'image']);
            await safeNavigate(page, url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForTimeout(1000);
            return await page.content();
        } finally {
            await page.close().catch(() => {});
        }
    } finally {
        await browser.close().catch(() => {});
    }
}

// ── Public API ─────────────────────────────────────────────────────────────

export const searchDevices = async (query, limit = 5) => {
    const cacheKey = `${query.toLowerCase()}-${limit}`;
    const cached = cache.get('search', cacheKey);
    if (cached) return cached;

    const types = detectLikelyTypes(query);

    // Fast path: direct HTTP (no browser)
    let results;
    try {
        results = await directSearch(query, limit, types);
    } catch {
        results = null;
    }

    // Slow path: browser fallback
    if (!results || results.length === 0) {
        results = await browserSearchDevices(query, limit, types);
    }

    if (!results || results.length === 0) return [];

    results.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));
    cache.set('search', cacheKey, results, TTL.search);
    return results;
};

export const scrapeDevicePage = async (deviceUrl) => {
    const cached = cache.get('device', deviceUrl);
    if (cached) return cached;

    let data;
    try {
        const html = await directFetchHtml(deviceUrl);
        data = scrapeDeviceHtml(html, deviceUrl);
    } catch {
        const html = await browserFetchHtml(deviceUrl);
        data = scrapeDeviceHtml(html, deviceUrl);
    }

    cache.set('device', deviceUrl, data, TTL.device);
    return data;
};

export const scrapeComparePage = async (compareUrl) => {
    const cached = cache.get('compare', compareUrl);
    if (cached) return cached;

    let data;
    try {
        const html = await directFetchHtml(compareUrl);
        data = scrapeCompareHtml(html, compareUrl);
    } catch {
        const html = await browserFetchHtml(compareUrl);
        data = scrapeCompareHtml(html, compareUrl);
    }

    cache.set('compare', compareUrl, data, TTL.compare);
    return data;
};

export const scrapeRankingPage = async (rankingUrl) => {
    const cached = cache.get('ranking', rankingUrl);
    if (cached) return cached;

    let data;
    try {
        const html = await directFetchHtml(rankingUrl, 10000);
        data = scrapeRankingHtml(html, rankingUrl);
    } catch {
        const html = await browserFetchHtml(rankingUrl);
        data = scrapeRankingHtml(html, rankingUrl);
    }

    cache.set('ranking', rankingUrl, data, TTL.ranking);
    return data;
};
