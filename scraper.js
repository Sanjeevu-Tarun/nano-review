import * as cheerio from 'cheerio';
import { waitForCloudflare, safeNavigate } from './browser.js';

// ─── Caches ───────────────────────────────────────────────────────────────────
const searchCache = new Map();  // query → { results, timestamp }
const pageCache   = new Map();  // url   → { data, timestamp }
const SEARCH_TTL  = 5  * 60 * 1000;  // 5 min
const PAGE_TTL    = 10 * 60 * 1000;  // 10 min

function evict(cache, maxSize = 100) {
    if (cache.size > maxSize) cache.delete(cache.keys().next().value);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
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
    return ['phone', 'tablet', 'laptop', 'soc', 'cpu', 'gpu'];
};

const scoreMatch = (name, q) => {
    const n = name.toLowerCase();
    const ql = q.toLowerCase();
    if (n === ql) return 1000;
    if (n.includes(ql)) return 500;
    let score = 0;
    for (const w of ql.split(/\s+/)) if (n.includes(w)) score += 10;
    return score - n.length * 0.1;
};

function extractImages($) {
    const images = new Set();
    $('img').each((_, img) => {
        const attrs = ['data-src', 'src', 'srcset', 'data-srcset'];
        for (const attr of attrs) {
            const val = $(img).attr(attr);
            if (!val) continue;
            for (const part of val.split(',')) {
                const src = part.trim().split(' ')[0];
                if (src) pushSrc(src, images);
            }
        }
        $(img).closest('picture').find('source').each((_, s) => {
            for (const attr of ['srcset', 'data-srcset']) {
                const val = $(s).attr(attr);
                if (!val) continue;
                for (const part of val.split(',')) pushSrc(part.trim().split(' ')[0], images);
            }
        });
    });
    return [...images];
}

function pushSrc(src, set) {
    if (!src) return;
    if (src.startsWith('/')) src = `https://nanoreview.net${src}`;
    const lc = src.toLowerCase();
    if (src.startsWith('http') && !lc.includes('logo') && !lc.includes('icon') && !lc.includes('avatar') && !lc.includes('.svg'))
        set.add(src);
}

// ─── Search — uses direct HTTP fetch, NO browser navigation needed ────────────
// The NanoReview search API is a plain JSON endpoint; opening the homepage first
// was the single biggest slowdown in the original code.
export const searchDevices = async (context, query, limit = 5) => {
    const cacheKey = `${query.toLowerCase()}-${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SEARCH_TTL) return cached.results;

    const types = detectLikelyTypes(query);

    // Fire all type-searches in parallel directly from Node (no browser page needed)
    const fetchType = async (type) => {
        try {
            const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
            const res = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                signal: AbortSignal.timeout(4000),
            });
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
        } catch {
            return [];
        }
    };

    const allResults = (await Promise.all(types.map(fetchType))).flat();
    if (allResults.length === 0) return [];

    allResults.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));

    searchCache.set(cacheKey, { results: allResults, timestamp: Date.now() });
    evict(searchCache);

    return allResults;
};

// ─── Shared page scraper core ─────────────────────────────────────────────────
async function scrapePage(context, url, parseHtml) {
    const cached = pageCache.get(url);
    if (cached && Date.now() - cached.timestamp < PAGE_TTL) return cached.data;

    const page = await context.newPage();
    try {
        // Block heaviest resource types
        await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
            else route.continue();
        });

        await safeNavigate(page, url, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Replace fixed 1000ms wait with a smart content-ready check
        await Promise.race([
            page.waitForSelector('h1', { timeout: 5000 }).catch(() => {}),
            page.waitForTimeout(3000),
        ]);

        const html = await page.content();
        const data = parseHtml(html, url);

        pageCache.set(url, { data, timestamp: Date.now() });
        evict(pageCache);

        return data;
    } finally {
        await page.close();
    }
}

// ─── Device page ──────────────────────────────────────────────────────────────
export const scrapeDevicePage = (context, deviceUrl) =>
    scrapePage(context, deviceUrl, (html, url) => {
        const $ = cheerio.load(html);
        const data = {
            title: $('h1').text().trim(),
            sourceUrl: url,
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
            const t = $(el).text().trim(); if (t) data.pros.push(t);
        });
        $('[class*="cons"] li, [class*="minus"] li, .red li').each((_, el) => {
            const t = $(el).text().trim(); if (t) data.cons.push(t);
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
    });

// ─── Compare page ─────────────────────────────────────────────────────────────
export const scrapeComparePage = (context, compareUrl) =>
    scrapePage(context, compareUrl, (html, url) => {
        const $ = cheerio.load(html);
        const data = {
            title: $('h1').text().trim(),
            sourceUrl: url,
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
        if (headers.length >= 2) { data.device1.name = headers[0]; data.device2.name = headers[1]; }

        $('.card, .box, section, [class*="specs"]').each((_, card) => {
            const sectionTitle = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Comparison';
            const section = {};
            $(card).find('table tr').each((__, row) => {
                const cells = $(row).find('td, th');
                if (cells.length >= 3) {
                    const feature = cells.eq(0).text().trim().replace(/:$/, '');
                    if (feature) {
                        section[feature] = {
                            [data.device1.name || 'Device 1']: cells.eq(1).text().trim(),
                            [data.device2.name || 'Device 2']: cells.eq(2).text().trim(),
                        };
                    }
                }
            });
            if (Object.keys(section).length > 0) data.comparisons[sectionTitle] = section;
        });

        return data;
    });

// ─── Ranking page ─────────────────────────────────────────────────────────────
export const scrapeRankingPage = (context, rankingUrl) =>
    scrapePage(context, rankingUrl, (html, url) => {
        const $ = cheerio.load(html);
        const data = { title: $('h1').text().trim(), sourceUrl: url, rankings: [] };

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

        return data;
    });
