import * as cheerio from 'cheerio';
import { waitForCloudflare, safeNavigate, acquireContext } from './browser.js';

const searchCache = new Map();
const CACHE_TTL = 300000;

// ─── Persistent search page ───────────────────────────────────────────────────
// We keep ONE browser page permanently parked on nanoreview.net after solving CF.
// All search API calls run via page.evaluate() on this page — no re-navigation.
let searchPage = null;
let searchPageReady = false;
let searchPageInitPromise = null;

const initSearchPage = async () => {
    if (searchPageInitPromise) return searchPageInitPromise;

    searchPageInitPromise = (async () => {
        const entry = await acquireContext();
        const page = await entry.context.newPage();

        await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
            else route.continue();
        });

        await safeNavigate(page, 'https://nanoreview.net/en/', { timeout: 30000 });
        await waitForCloudflare(page, 'body', 30000);

        // Verify we actually passed CF
        const title = await page.title();
        if (/just a moment/i.test(title)) {
            searchPage = null;
            searchPageReady = false;
            searchPageInitPromise = null;
            throw new Error('CF challenge not solved');
        }

        searchPage = page;
        searchPageReady = true;
        console.log('[SearchPage] Ready, title:', title);

        // Reset if page crashes or closes
        page.on('close', () => { searchPage = null; searchPageReady = false; searchPageInitPromise = null; });
        page.on('crash', () => { searchPage = null; searchPageReady = false; searchPageInitPromise = null; });
    })();

    return searchPageInitPromise;
};

const getSearchPage = async () => {
    if (searchPageReady && searchPage) return searchPage;
    searchPageInitPromise = null; // force re-init
    await initSearchPage();
    return searchPage;
};

// Run fetch() calls from inside the real Chrome context (bypasses CF IP block)
const searchViaPage = async (query, limit, types) => {
    const page = await getSearchPage();

    return page.evaluate(async ({ query, limit, types }) => {
        const results = [];
        await Promise.all(types.map(async (type) => {
            try {
                const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
                const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
                if (!r.ok) return;
                const data = await r.json();
                if (Array.isArray(data)) data.forEach(d => results.push({ ...d, content_type: d.content_type || type }));
            } catch {}
        }));
        return results;
    }, { query, limit, types });
};

// ─── Type detection ───────────────────────────────────────────────────────────
const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
    const allTypes = ['phone', 'tablet', 'laptop', 'soc', 'cpu', 'gpu'];
    if (/ryzen|intel|core i[0-9]|threadripper|xeon|celeron|pentium|amd\s+a[0-9]|snapdragon|mediatek|exynos|dimensity|a[0-9]{2}\s*bionic/i.test(q))
        return ['cpu', 'soc', 'laptop', 'phone', 'tablet', 'gpu'];
    if (/nvidia|rtx|gtx|radeon|rx\s*[0-9]|geforce|quadro|vega|arc\s*a[0-9]/i.test(q))
        return ['gpu', 'laptop', 'cpu', 'phone', 'tablet', 'soc'];
    if (/iphone|galaxy|pixel|oneplus|xiaomi|redmi|poco|oppo|vivo|iqoo|realme|nothing\s*phone|asus\s*rog\s*phone|nokia|motorola|moto\s*[ge]|xperia|huawei|honor|infinix|tecno|itel|nubia|meizu|blackshark/i.test(q))
        return ['phone', 'soc', 'tablet', 'laptop', 'cpu', 'gpu'];
    if (/ipad|galaxy\s*tab|surface|tab\s*s[0-9]/i.test(q))
        return ['tablet', 'phone', 'soc', 'laptop', 'cpu', 'gpu'];
    if (/macbook|thinkpad|xps|zenbook|vivobook|laptop|notebook|ultrabook|chromebook/i.test(q))
        return ['laptop', 'cpu', 'gpu', 'tablet', 'phone', 'soc'];
    return allTypes;
};

// ─── Search ───────────────────────────────────────────────────────────────────
export const searchDevices = async (_context, query, limit = 5) => {
    const cacheKey = `${query.toLowerCase()}-${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.results;

    const types = detectLikelyTypes(query);
    const allResults = await searchViaPage(query, limit, types);

    if (!allResults || allResults.length === 0) return [];

    const scoreMatch = (name, q) => {
        const n = name.toLowerCase(), ql = q.toLowerCase();
        if (n === ql) return 1000;
        if (n.includes(ql)) return 500;
        let score = 0;
        for (const w of ql.split(/\s+/)) if (n.includes(w)) score += 10;
        return score - n.length * 0.1;
    };

    allResults.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));
    searchCache.set(cacheKey, { results: allResults, timestamp: Date.now() });
    if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
    return allResults;
};

// ─── Shared image extractor ───────────────────────────────────────────────────
const extractImages = ($) => {
    const images = [];
    $('img').each((_, img) => {
        const extractUrls = (str) =>
            str ? str.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean) : [];
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

// ─── Scrape a page (new page per scrape, reuses browser context) ──────────────
const scrapePage = async (context, url) => {
    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image'].includes(t)) route.abort();
            else route.continue();
        });
        await safeNavigate(page, url, { timeout: 30000 });
        await waitForCloudflare(page, 'body', 30000);
        await page.waitForTimeout(800);
        return await page.content();
    } finally {
        await page.close();
    }
};

// ─── Device page ──────────────────────────────────────────────────────────────
export const scrapeDevicePage = async (context, deviceUrl) => {
    const html = await scrapePage(context, deviceUrl);
    const $ = cheerio.load(html);
    const data = { title: $('h1').text().trim(), sourceUrl: deviceUrl, images: extractImages($), scores: {}, pros: [], cons: [], specs: {} };
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
};

// ─── Compare page ─────────────────────────────────────────────────────────────
export const scrapeComparePage = async (context, compareUrl) => {
    const html = await scrapePage(context, compareUrl);
    const $ = cheerio.load(html);
    const data = { title: $('h1').text().trim(), sourceUrl: compareUrl, images: extractImages($), device1: { name: '', score: '' }, device2: { name: '', score: '' }, comparisons: {} };
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
};

// ─── Ranking page ─────────────────────────────────────────────────────────────
export const scrapeRankingPage = async (context, rankingUrl) => {
    const html = await scrapePage(context, rankingUrl);
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
};
