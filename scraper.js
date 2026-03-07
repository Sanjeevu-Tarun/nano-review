import * as cheerio from 'cheerio';
import { nodeFetch, isCFReady, getBrowserContext } from './browser.js';
import { cacheGet, cacheSet } from './cache.js';

const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
    const all = ['phone', 'tablet', 'laptop', 'soc', 'cpu', 'gpu'];
    if (/ryzen|intel|core i[3579]|amd|snapdragon|mediatek|exynos|dimensity|a\d+\s*bionic/i.test(q)) return ['cpu', 'soc', 'laptop', 'phone', 'tablet', 'gpu'];
    if (/nvidia|rtx|gtx|radeon|geforce/i.test(q)) return ['gpu', 'laptop', 'cpu'];
    if (/iphone|galaxy|pixel|oneplus|xiaomi|oppo|vivo|realme/i.test(q)) return ['phone', 'soc', 'tablet'];
    if (/ipad|galaxy.tab|surface/i.test(q)) return ['tablet', 'phone'];
    if (/macbook|thinkpad|xps|zenbook|laptop|notebook/i.test(q)) return ['laptop', 'cpu', 'gpu'];
    return all;
};

const scoreMatch = (name, q) => {
    const n = name.toLowerCase(), ql = q.toLowerCase();
    if (n === ql) return 1000;
    if (n.includes(ql)) return 500;
    let score = 0;
    for (const w of ql.split(/\s+/)) if (n.includes(w)) score += 10;
    return score - n.length * 0.1;
};

// FAST: search using Node https directly with CF cookies — no browser page needed
const searchViaNode = async (query, limit, types) => {
    const promises = types.map(async (type) => {
        try {
            const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
            const res = await nodeFetch(url);
            if (res.status !== 200 || !res.data) return [];
            return Array.isArray(res.data) ? res.data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
        } catch { return []; }
    });
    return (await Promise.all(promises)).flat();
};

// FALLBACK: search via browser page (if CF cookies not ready)
const searchViaBrowser = async (context, query, limit, types) => {
    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
            else route.continue();
        });
        await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        return await page.evaluate(async ({ query, limit, types }) => {
            const promises = types.map(async (type) => {
                try {
                    const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
                    const c = new AbortController(); setTimeout(() => c.abort(), 4000);
                    const r = await fetch(url, { signal: c.signal, headers: { Accept: 'application/json' } });
                    if (!r.ok) return [];
                    const d = await r.json();
                    return Array.isArray(d) ? d.map(x => ({ ...x, content_type: x.content_type || type })) : [];
                } catch { return []; }
            });
            return (await Promise.all(promises)).flat();
        }, { query, limit, types });
    } finally {
        await page.close();
    }
};

const extractImages = ($) => {
    const images = [];
    $('img').each((_, img) => {
        const eu = (s) => s ? s.split(',').map(x => x.trim().split(' ')[0]).filter(Boolean) : [];
        [$(img).attr('data-src'), $(img).attr('src'), ...eu($(img).attr('srcset')), ...eu($(img).attr('data-srcset'))].forEach(src => {
            if (!src) return;
            if (src.startsWith('/')) src = `https://nanoreview.net${src}`;
            const l = src.toLowerCase();
            if (src.startsWith('http') && !l.includes('logo') && !l.includes('icon') && !l.includes('svg')) images.push(src);
        });
    });
    return [...new Set(images)];
};

const parseDevicePage = (html, deviceUrl, query, searchResults) => {
    const $ = cheerio.load(html);
    const data = {
        title: $('h1').text().trim(), sourceUrl: deviceUrl,
        images: extractImages($), scores: {}, pros: [], cons: {}, specs: {},
        matchedQuery: query,
        searchResults: searchResults?.map((r, i) => ({ index: i, name: r.name, type: r.content_type, slug: r.slug || r.url_name })),
    };
    $('[class*="score"], .progress-bar, .rating-box').each((_, el) => {
        const label = $(el).find('[class*="title"], [class*="name"]').first().text().trim();
        const value = $(el).find('[class*="value"], [class*="num"]').first().text().trim();
        if (label && value && label !== value) data.scores[label] = value;
    });
    $('[class*="pros"] li, [class*="plus"] li, .green li').each((_, el) => { const t = $(el).text().trim(); if (t) data.pros.push(t); });
    $('[class*="cons"] li, [class*="minus"] li, .red li').each((_, el) => { const t = $(el).text().trim(); if (t) data.cons.push(t); });
    $('.card, .box, section, [class*="specs"]').each((_, card) => {
        const st = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Details';
        const section = {};
        $(card).find('table tr').each((__, row) => {
            const cells = $(row).find('td, th');
            if (cells.length >= 2) {
                const label = cells.first().text().trim().replace(/:$/, '');
                const value = cells.last().text().trim();
                if (label && value && label !== value) section[label] = value;
            }
        });
        if (Object.keys(section).length > 0) data.specs[st] = section;
    });
    return data;
};

export const searchAndScrape = async (context, query, index) => {
    const cacheKey = `search:${query.toLowerCase()}:${index ?? 'top'}`;
    const cached = cacheGet(cacheKey);
    if (cached) { console.log(`[cache hit] ${query}`); return cached; }

    const types = detectLikelyTypes(query);
    const t0 = Date.now();

    // STEP 1: Search — use fast Node fetch if CF ready, else browser fallback
    let searchResults;
    if (isCFReady()) {
        searchResults = await searchViaNode(query, 5, types);
        console.log(`[search] node fetch: ${Date.now() - t0}ms, ${searchResults.length} results`);

        // If node fetch got blocked (CF rotated), fall back to browser
        if (!searchResults.length) {
            console.log('[search] node fetch empty, falling back to browser');
            searchResults = await searchViaBrowser(context, query, 5, types);
        }
    } else {
        searchResults = await searchViaBrowser(context, query, 5, types);
        console.log(`[search] browser fetch: ${Date.now() - t0}ms`);
    }

    if (!searchResults.length) return null;
    searchResults.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));

    let item = searchResults.find(r => r.name.toLowerCase() === query.toLowerCase()) || searchResults[0];
    if (index !== undefined) item = searchResults[Math.min(parseInt(index, 10) || 0, searchResults.length - 1)];

    const slug = item.slug || item.url_name || item.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${slug}`;

    const t1 = Date.now();

    // STEP 2: Scrape device page — browser only (need full rendered HTML)
    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
            else route.continue();
        });
        await page.goto(deviceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        console.log(`[scrape] page load: ${Date.now() - t1}ms`);

        const html = await page.content();
        const data = parseDevicePage(html, deviceUrl, query, searchResults);
        const result = { data, searchResults };

        cacheSet(cacheKey, result);
        cacheSet(`url:${deviceUrl}`, data);
        console.log(`[total] ${Date.now() - t0}ms`);
        return result;
    } finally {
        await page.close();
    }
};

export const scrapeUrl = async (context, deviceUrl, label = '') => {
    const cacheKey = `url:${deviceUrl}`;
    if (cacheGet(cacheKey)) return;
    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
            else route.continue();
        });
        await page.goto(deviceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const data = parseDevicePage(await page.content(), deviceUrl, label, null);
        cacheSet(cacheKey, data);
        if (label) cacheSet(`search:${label.toLowerCase()}:top`, { data, searchResults: [] });
        console.log(`[prewarm] ✓ ${label}`);
    } catch (e) { console.error(`[prewarm] ✗ ${label}: ${e.message}`); }
    finally { await page.close(); }
};

export const searchDevicesDirect = async (context, query, limit = 5) => {
    const cacheKey = `searchonly:${query.toLowerCase()}:${limit}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const types = detectLikelyTypes(query);
    let results = [];

    if (isCFReady()) {
        results = await searchViaNode(query, limit, types);
    }
    if (!results.length) {
        results = await searchViaBrowser(context, query, limit, types);
    }
    results.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));
    cacheSet(cacheKey, results);
    return results;
};

export const scrapeComparePage = async (context, compareUrl) => {
    const cached = cacheGet(`url:${compareUrl}`);
    if (cached) return cached;
    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image'].includes(t)) route.abort();
            else route.continue();
        });
        await page.goto(compareUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const html = await page.content();
        const $ = cheerio.load(html);
        const data = { title: $('h1').text().trim(), sourceUrl: compareUrl, images: extractImages($), device1: { name: '' }, device2: { name: '' }, comparisons: {} };
        const headers = [];
        $('.compare-header [class*="title"], .vs-header h2, th').each((_, el) => { const t = $(el).text().trim(); if (t && t.toLowerCase() !== 'vs') headers.push(t); });
        if (headers.length >= 2) { data.device1.name = headers[0]; data.device2.name = headers[1]; }
        $('.card, .box, section, [class*="specs"]').each((_, card) => {
            const st = $(card).find('.card-header, .card-title, h2, h3').first().text().trim() || 'Comparison';
            const section = {};
            $(card).find('table tr').each((__, row) => {
                const cells = $(row).find('td, th');
                if (cells.length >= 3) {
                    const f = cells.eq(0).text().trim().replace(/:$/, '');
                    if (f) section[f] = { [data.device1.name || 'Device 1']: cells.eq(1).text().trim(), [data.device2.name || 'Device 2']: cells.eq(2).text().trim() };
                }
            });
            if (Object.keys(section).length > 0) data.comparisons[st] = section;
        });
        cacheSet(`url:${compareUrl}`, data);
        return data;
    } finally { await page.close(); }
};

export const scrapeRankingPage = async (context, rankingUrl) => {
    const cached = cacheGet(`url:${rankingUrl}`);
    if (cached) return cached;
    const page = await context.newPage();
    try {
        await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image'].includes(t)) route.abort();
            else route.continue();
        });
        await page.goto(rankingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
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
        cacheSet(`url:${rankingUrl}`, data);
        return data;
    } finally { await page.close(); }
};
