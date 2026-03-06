import * as cheerio from 'cheerio';
import { waitForCloudflare, safeNavigate, acquireContext } from './browser.js';

const searchCache = new Map();
const CACHE_TTL = 300000; // 5 min

// ─── Persistent search page ───────────────────────────────────────────────────
// One page stays permanently parked on nanoreview.net after solving CF once.
// All search API calls run as fetch() inside this page — no re-navigation ever.
// Cost: CF solve once at startup. Per-search cost: ~200ms (just the fetch).

let _searchPage = null;
let _searchPagePromise = null;

const initSearchPage = async () => {
    if (_searchPagePromise) return _searchPagePromise;
    _searchPagePromise = (async () => {
        const entry = await acquireContext();
        const page = await entry.context.newPage();

        // Block heavy resources — search page only needs JS/XHR
        await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
            else route.continue();
        });

        await safeNavigate(page, 'https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 25000 });

        try {
            await waitForCloudflare(page, 'body', 20000);
        } catch {
            const ok = await page.evaluate(() => document.body?.innerHTML.length > 100).catch(() => false);
            if (!ok) { _searchPagePromise = null; throw new Error('CF not solved'); }
        }

        _searchPage = page;

        // Reset on crash/close so next call re-initializes
        page.on('close', () => { _searchPage = null; _searchPagePromise = null; });
        page.on('crash', () => { _searchPage = null; _searchPagePromise = null; });

        return page;
    })();
    return _searchPagePromise;
};

const getSearchPage = async () => {
    if (_searchPage) return _searchPage;
    _searchPagePromise = null;
    return initSearchPage();
};

// Warm up search page at startup
initSearchPage().catch(() => {});

// ─── Type detection ───────────────────────────────────────────────────────────
const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
    const all = ['phone', 'tablet', 'laptop', 'soc', 'cpu', 'gpu'];
    if (/ryzen|intel|core|threadripper|xeon|celeron|pentium|i[3579]-|amd|snapdragon|mediatek|exynos|dimensity|a[0-9]{2}\s*bionic/i.test(q))
        return ['cpu', 'soc', 'laptop', 'phone', 'tablet', 'gpu'];
    if (/nvidia|rtx|gtx|radeon|rx\s*[0-9]|geforce|quadro|vega|arc\s*a[0-9]/i.test(q))
        return ['gpu', 'laptop', 'cpu', 'phone', 'tablet', 'soc'];
    if (/iphone|galaxy|pixel|oneplus|xiaomi|redmi|poco|oppo|vivo|iqoo|realme|nothing\s*phone|asus\s*rog\s*phone|nokia|motorola|moto\s*[ge]|xperia|huawei|honor|infinix|tecno|itel|nubia|meizu|blackshark/i.test(q))
        return ['phone', 'soc', 'tablet', 'laptop', 'cpu', 'gpu'];
    if (/ipad|galaxy\s*tab|surface|tab\s*s[0-9]/i.test(q))
        return ['tablet', 'phone', 'soc', 'laptop', 'cpu', 'gpu'];
    if (/macbook|thinkpad|xps|zenbook|vivobook|laptop|notebook|ultrabook|chromebook/i.test(q))
        return ['laptop', 'cpu', 'gpu', 'tablet', 'phone', 'soc'];
    return all;
};

// ─── Search — runs fetch() inside the persistent parked page ─────────────────
export const searchDevices = async (_context, query, limit = 5) => {
    const cacheKey = `${query.toLowerCase()}-${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.results;

    const types = detectLikelyTypes(query);
    const page = await getSearchPage();

    const allResults = await page.evaluate(async ({ query, limit, types }) => {
        const results = [];
        await Promise.all(types.map(async (type) => {
            try {
                const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
                const controller = new AbortController();
                const t = setTimeout(() => controller.abort(), 6000);
                const r = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
                clearTimeout(t);
                if (!r.ok) return;
                const data = await r.json();
                if (Array.isArray(data)) data.forEach(d => results.push({ ...d, content_type: d.content_type || type }));
            } catch {}
        }));
        return results;
    }, { query, limit, types });

    if (!allResults?.length) return [];

    const scoreMatch = (name, q) => {
        const n = name.toLowerCase(), ql = q.toLowerCase();
        if (n === ql) return 1000;
        if (n.includes(ql)) return 500;
        let s = 0;
        for (const w of ql.split(/\s+/)) if (n.includes(w)) s += 10;
        return s - n.length * 0.1;
    };

    allResults.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));
    searchCache.set(cacheKey, { results: allResults, timestamp: Date.now() });
    if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
    return allResults;
};

// ─── Shared helpers ───────────────────────────────────────────────────────────
const extractImages = ($) => {
    const images = [];
    $('img').each((_, img) => {
        const extractUrls = (str) => str ? str.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean) : [];
        const sources = [
            $(img).attr('data-src'), $(img).attr('src'),
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
                !low.includes('avatar') && !low.includes('svg')) images.push(src);
        }
    });
    return [...new Set(images)];
};

// Smart wait: resolves when DOM stops mutating OR maxMs reached — replaces fixed 1000ms sleep
const waitForDOMSettle = (page, maxMs = 1200) =>
    page.evaluate((max) => new Promise(resolve => {
        if (document.body.innerHTML.length > 500) return resolve();
        let timer;
        const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => { obs.disconnect(); resolve(); }, 120); });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { obs.disconnect(); resolve(); }, max);
    }), maxMs);

const openScrapePage = async (context, url) => {
    const page = await context.newPage();
    await page.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (['font', 'media', 'image'].includes(t)) route.abort();
        else route.continue();
    });
    await safeNavigate(page, url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    try {
        await waitForCloudflare(page, 'body', 20000);
    } catch {
        const ok = await page.evaluate(() => document.body?.innerHTML.length > 100).catch(() => false);
        if (!ok) throw new Error('Page failed to load');
    }
    await waitForDOMSettle(page, 1200); // replaces fixed waitForTimeout(1000)
    return page;
};

// ─── Device page ──────────────────────────────────────────────────────────────
export const scrapeDevicePage = async (context, deviceUrl) => {
    const page = await openScrapePage(context, deviceUrl);
    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        const data = {
            title: $('h1').text().trim(),
            sourceUrl: deviceUrl,
            images: extractImages($),
            scores: {}, pros: [], cons: [], specs: {},
        };
        $('[class*="score"], .progress-bar, .rating-box').each((_, el) => {
            const label = $(el).find('[class*="title"], [class*="name"]').first().text().trim() || $(el).prev('div, p, span').text().trim();
            const value = $(el).find('[class*="value"], [class*="num"]').first().text().trim() || $(el).text().replace(/[^0-9]/g, '').trim();
            if (label && value && label !== value) data.scores[label] = value;
        });
        $('[class*="pros"] li, [class*="plus"] li, .green li').each((_, el) => { const t = $(el).text().trim(); if (t) data.pros.push(t); });
        $('[class*="cons"] li, [class*="minus"] li, .red li').each((_, el) => { const t = $(el).text().trim(); if (t) data.cons.push(t); });
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
    const page = await openScrapePage(context, compareUrl);
    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        const data = {
            title: $('h1').text().trim(), sourceUrl: compareUrl,
            images: extractImages($),
            device1: { name: '', score: '' }, device2: { name: '', score: '' },
            comparisons: {},
        };
        const headers = [];
        $('.compare-header [class*="title"], .vs-header h2, th').each((_, el) => {
            const text = $(el).text().trim();
            if (text && text.toLowerCase() !== 'vs') headers.push(text);
        });
        if (headers.length >= 2) { data.device1.name = headers[0]; data.device2.name = headers[1]; }
        $('.card, .box, section, [class*="specs"]').each((_, card) => {
            const sectionTitle = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Comparison';
            const section = {};
            $(card).find('table tr').each((_, row) => {
                const cells = $(row).find('td, th');
                if (cells.length >= 3) {
                    const feature = cells.eq(0).text().trim().replace(/:$/, '');
                    if (feature) section[feature] = {
                        [data.device1.name || 'Device 1']: cells.eq(1).text().trim(),
                        [data.device2.name || 'Device 2']: cells.eq(2).text().trim(),
                    };
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
    const page = await openScrapePage(context, rankingUrl);
    try {
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
        return data;
    } finally {
        await page.close();
    }
};
