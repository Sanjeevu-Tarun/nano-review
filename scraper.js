import * as cheerio from 'cheerio';
import { getContext, isCFReady } from './browser.js';
import { cacheGet, cacheSet } from './cache.js';

const TYPES = (q) => {
    if (/iphone|galaxy\s*s\d|pixel \d|oneplus|xiaomi|oppo|vivo|realme/i.test(q)) return ['phone'];
    if (/ipad|galaxy\s*tab|surface\s*pro/i.test(q)) return ['tablet'];
    if (/snapdragon|dimensity|exynos|helio|a\d+\s*(pro|bionic|chip)?$/i.test(q)) return ['soc'];
    if (/ryzen|core\s*i[3579]|core\s*ultra|xeon|celeron|pentium/i.test(q)) return ['cpu'];
    if (/rtx|gtx|radeon|geforce|rx\s*\d/i.test(q)) return ['gpu'];
    if (/macbook|thinkpad|xps|zenbook|laptop|notebook/i.test(q)) return ['laptop'];
    return ['phone', 'soc', 'cpu', 'gpu', 'laptop', 'tablet'];
};

const scoreMatch = (name, q) => {
    const n = name.toLowerCase(), ql = q.toLowerCase();
    if (n === ql) return 1000;
    if (n.includes(ql)) return 500;
    let s = 0;
    for (const w of ql.split(/\s+/)) if (n.includes(w)) s += 10;
    return s - n.length * 0.1;
};

const search = async (page, query, types) => {
    return page.evaluate(async ({ query, types }) => {
        const results = await Promise.all(types.map(async type => {
            try {
                const r = await fetch(
                    `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=5&type=${type}`,
                    { headers: { Accept: 'application/json' } }
                );
                if (!r.ok) return [];
                const d = await r.json();
                return Array.isArray(d) ? d.map(x => ({ ...x, content_type: x.content_type || type })) : [];
            } catch { return []; }
        }));
        return results.flat();
    }, { query, types });
};

const parseHtml = (html, url, query, searchResults) => {
    const $ = cheerio.load(html);
    const data = {
        title: $('h1').text().trim(),
        sourceUrl: url,
        scores: {}, pros: [], cons: [], specs: {},
        matchedQuery: query,
        searchResults: searchResults?.map((r, i) => ({
            index: i, name: r.name, type: r.content_type, slug: r.slug || r.url_name
        })),
    };
    $('[class*="score"], .progress-bar').each((_, el) => {
        const label = $(el).find('[class*="title"],[class*="name"]').first().text().trim();
        const value = $(el).find('[class*="value"],[class*="num"]').first().text().trim();
        if (label && value && label !== value) data.scores[label] = value;
    });
    $('[class*="pros"] li, .green li').each((_, el) => { const t = $(el).text().trim(); if (t) data.pros.push(t); });
    $('[class*="cons"] li, .red li').each((_, el) => { const t = $(el).text().trim(); if (t) data.cons.push(t); });
    $('.card, section, [class*="specs"]').each((_, card) => {
        const st = $(card).find('h2,h3,.card-title').first().text().trim() || 'Details';
        const section = {};
        $(card).find('table tr').each((__, row) => {
            const cells = $(row).find('td,th');
            if (cells.length >= 2) {
                const k = cells.first().text().trim().replace(/:$/, '');
                const v = cells.last().text().trim();
                if (k && v && k !== v) section[k] = v;
            }
        });
        if (Object.keys(section).length) data.specs[st] = section;
    });
    return data;
};

export const searchAndScrape = async (query, indexParam) => {
    const cacheKey = `device:${query.toLowerCase()}:${indexParam ?? 'top'}`;
    const hit = cacheGet(cacheKey);
    if (hit) { console.log(`[cache HIT] ${query}`); return hit; }

    const context = getContext();
    if (!context) throw new Error('Browser not ready yet, try again in a moment');

    const types = TYPES(query);
    const t0 = Date.now();
    const page = await context.newPage();

    try {
        await page.route('**/*', route => {
            ['font','media','image','stylesheet'].includes(route.request().resourceType()) ? route.abort() : route.continue();
        });

        // Navigation 1: homepage (needed for CF cookies + fetch origin)
        await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        console.log(`[nav1] homepage: ${Date.now()-t0}ms`);

        // Fire all type searches in parallel from the page
        let results = await search(page, query, types);
        console.log(`[search] ${Date.now()-t0}ms, ${results.length} results`);

        // If nothing found with specific types, try all types
        if (!results.length && types.length < 5) {
            results = await search(page, query, ['phone','soc','cpu','gpu','laptop','tablet']);
            console.log(`[search retry] ${Date.now()-t0}ms, ${results.length} results`);
        }

        if (!results.length) return null;

        results.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));

        const idx = indexParam !== undefined ? Math.min(parseInt(indexParam)||0, results.length-1) : 0;
        const item = results[idx];
        const slug = item.slug || item.url_name || item.name.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
        const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${slug}`;

        // Navigation 2: device page — reuse SAME page object
        await page.goto(deviceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        console.log(`[nav2] device page: ${Date.now()-t0}ms total`);

        const data = parseHtml(await page.content(), deviceUrl, query, results);
        const result = { data, searchResults: results };
        cacheSet(cacheKey, result);
        return result;

    } finally {
        await page.close();
    }
};

export const prewarmDevice = async (url, label) => {
    if (cacheGet(`device:${label.toLowerCase()}:top`)) return;
    const context = getContext();
    if (!context) return;
    const page = await context.newPage();
    try {
        await page.route('**/*', route => {
            ['font','media','image','stylesheet'].includes(route.request().resourceType()) ? route.abort() : route.continue();
        });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const data = parseHtml(await page.content(), url, label, null);
        cacheSet(`device:${label.toLowerCase()}:top`, { data, searchResults: [] });
        console.log(`[prewarm ✓] ${label}`);
    } catch (e) {
        console.error(`[prewarm ✗] ${label}: ${e.message}`);
    } finally {
        await page.close();
    }
};

export const searchSuggestions = async (query) => {
    const cacheKey = `suggest:${query.toLowerCase()}`;
    const hit = cacheGet(cacheKey);
    if (hit) return hit;

    const context = getContext();
    if (!context) return [];
    const types = TYPES(query);
    const page = await context.newPage();
    try {
        await page.route('**/*', route => {
            ['font','media','image','stylesheet'].includes(route.request().resourceType()) ? route.abort() : route.continue();
        });
        await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        const results = await search(page, query, types.length > 3 ? types : [...types, 'phone','soc','cpu']);
        results.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));
        cacheSet(cacheKey, results);
        return results;
    } finally {
        await page.close();
    }
};

export const scrapeComparePage = async (url) => {
    const hit = cacheGet(`url:${url}`);
    if (hit) return hit;
    const context = getContext();
    const page = await context.newPage();
    try {
        await page.route('**/*', route => ['font','media','image'].includes(route.request().resourceType()) ? route.abort() : route.continue());
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const $ = cheerio.load(await page.content());
        const data = { title: $('h1').text().trim(), sourceUrl: url, device1: { name: '' }, device2: { name: '' }, comparisons: {} };
        const headers = [];
        $('th').each((_, el) => { const t = $(el).text().trim(); if (t && t.toLowerCase() !== 'vs') headers.push(t); });
        if (headers.length >= 2) { data.device1.name = headers[0]; data.device2.name = headers[1]; }
        $('table tr').each((_, row) => {
            const cells = $(row).find('td,th');
            if (cells.length >= 3) {
                const f = cells.eq(0).text().trim();
                if (f) {
                    if (!data.comparisons.specs) data.comparisons.specs = {};
                    data.comparisons.specs[f] = { [data.device1.name||'D1']: cells.eq(1).text().trim(), [data.device2.name||'D2']: cells.eq(2).text().trim() };
                }
            }
        });
        cacheSet(`url:${url}`, data);
        return data;
    } finally { await page.close(); }
};

export const scrapeRankingPage = async (url) => {
    const hit = cacheGet(`url:${url}`);
    if (hit) return hit;
    const context = getContext();
    const page = await context.newPage();
    try {
        await page.route('**/*', route => ['font','media','image'].includes(route.request().resourceType()) ? route.abort() : route.continue());
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const $ = cheerio.load(await page.content());
        const data = { title: $('h1').text().trim(), sourceUrl: url, rankings: [] };
        const headers = [];
        $('table thead th').each((_, th) => headers.push($(th).text().trim()));
        $('table tbody tr').each((_, row) => {
            const item = {};
            $(row).find('td').each((i, td) => {
                item[headers[i]?.toLowerCase().replace(/\s+/g,'_')||`col_${i}`] = $(td).text().trim();
                const a = $(td).find('a').attr('href');
                if (a && !item.url) item.url = a.startsWith('http') ? a : `https://nanoreview.net${a}`;
            });
            if (Object.keys(item).length) data.rankings.push(item);
        });
        cacheSet(`url:${url}`, data);
        return data;
    } finally { await page.close(); }
};
