import * as cheerio from 'cheerio';
import { cfFetch, isCFReady, getContext } from './browser.js';
import { cacheGet, cacheSet } from './cache.js';

const TYPES_MAP = (q) => {
    if (/iphone|galaxy\s*s|pixel|oneplus|xiaomi|oppo|vivo|realme/i.test(q)) return ['phone'];
    if (/ipad|galaxy\s*tab|surface\s*pro/i.test(q)) return ['tablet'];
    if (/snapdragon|dimensity|exynos|a\d+\s*(pro|bionic)/i.test(q)) return ['soc'];
    if (/ryzen|core\s*i[3579]|core\s*ultra|xeon|celeron/i.test(q)) return ['cpu'];
    if (/rtx|gtx|radeon|geforce|rx\s*\d/i.test(q)) return ['gpu'];
    if (/macbook|thinkpad|xps|zenbook|laptop/i.test(q)) return ['laptop'];
    return ['phone', 'soc', 'cpu', 'gpu', 'laptop', 'tablet']; // unknown — try all
};

const best = (results, query) => {
    const q = query.toLowerCase();
    return results.sort((a, b) => {
        const sa = a.name.toLowerCase(), sb = b.name.toLowerCase();
        const score = n => n === q ? 1000 : n.includes(q) ? 500 : q.split(' ').filter(w => n.includes(w)).length * 10 - n.length * 0.1;
        return score(sb) - score(sa);
    });
};

// Search via direct Node fetch (fast, ~300ms) using stored CF cookies
const searchFast = async (query, types) => {
    const promises = types.map(async type => {
        try {
            const res = await cfFetch(`https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=5&type=${type}`);
            if (!res.ok || !res.json) return [];
            return Array.isArray(res.json) ? res.json.map(r => ({ ...r, content_type: r.content_type || type })) : [];
        } catch { return []; }
    });
    return (await Promise.all(promises)).flat();
};

// Search via browser page (fallback, ~8s)
const searchSlow = async (query, types) => {
    const context = getContext();
    if (!context) throw new Error('Browser context not ready');
    const page = await context.newPage();
    try {
        await page.route('**/*', r => {
            ['font','media','image','stylesheet'].includes(r.request().resourceType()) ? r.abort() : r.continue();
        });
        await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        return await page.evaluate(async ({ query, types }) => {
            const res = await Promise.all(types.map(async type => {
                try {
                    const r = await fetch(`https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=5&type=${type}`, { headers: { Accept: 'application/json' } });
                    const d = await r.json();
                    return Array.isArray(d) ? d.map(x => ({ ...x, content_type: x.content_type || type })) : [];
                } catch { return []; }
            }));
            return res.flat();
        }, { query, types });
    } finally { await page.close(); }
};

const parseHtml = (html, url, query, searchResults) => {
    const $ = cheerio.load(html);
    const data = {
        title: $('h1').text().trim(),
        sourceUrl: url,
        scores: {}, pros: [], cons: [], specs: {},
        matchedQuery: query,
        searchResults: searchResults?.map((r, i) => ({ index: i, name: r.name, type: r.content_type, slug: r.slug || r.url_name })),
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
    if (hit) { console.log(`[cache] HIT ${query}`); return hit; }

    const types = TYPES_MAP(query);
    const t0 = Date.now();

    // Step 1: Search
    let results = [];
    if (isCFReady()) {
        results = await searchFast(query, types);
        console.log(`[search] fast=${Date.now()-t0}ms results=${results.length}`);
        // If fast returned nothing (CF rotated), fall back
        if (!results.length && types.length < 4) {
            results = await searchFast(query, ['phone','soc','cpu','gpu','laptop','tablet']);
        }
    }
    if (!results.length) {
        results = await searchSlow(query, types.length > 3 ? types : ['phone','soc','cpu','gpu','laptop','tablet']);
        console.log(`[search] slow=${Date.now()-t0}ms results=${results.length}`);
    }
    if (!results.length) return null;

    best(results, query);
    const idx = indexParam !== undefined ? Math.min(parseInt(indexParam)||0, results.length-1) : 0;
    const item = results[idx];
    const slug = item.slug || item.url_name || item.name.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
    const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${slug}`;

    const t1 = Date.now();

    // Step 2: Scrape device page (browser, one navigation)
    const context = getContext();
    const page = await context.newPage();
    try {
        await page.route('**/*', r => {
            ['font','media','image','stylesheet'].includes(r.request().resourceType()) ? r.abort() : r.continue();
        });
        await page.goto(deviceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        console.log(`[scrape] page=${Date.now()-t1}ms total=${Date.now()-t0}ms`);
        const data = parseHtml(await page.content(), deviceUrl, query, results);
        const result = { data, searchResults: results };
        cacheSet(cacheKey, result);
        return result;
    } finally {
        await page.close();
    }
};

export const prewarmDevice = async (url, label) => {
    if (cacheGet(`url:${url}`)) return;
    const context = getContext();
    if (!context) return;
    const page = await context.newPage();
    try {
        await page.route('**/*', r => {
            ['font','media','image','stylesheet'].includes(r.request().resourceType()) ? r.abort() : r.continue();
        });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const data = parseHtml(await page.content(), url, label, null);
        cacheSet(`url:${url}`, data);
        cacheSet(`device:${label.toLowerCase()}:top`, { data, searchResults: [] });
        console.log(`[prewarm] ✓ ${label}`);
    } catch (e) { console.error(`[prewarm] ✗ ${label}: ${e.message}`); }
    finally { await page.close(); }
};

export const searchSuggestions = async (query) => {
    const cacheKey = `suggest:${query.toLowerCase()}`;
    const hit = cacheGet(cacheKey);
    if (hit) return hit;
    const types = TYPES_MAP(query);
    let results = isCFReady() ? await searchFast(query, types) : [];
    if (!results.length) results = await searchSlow(query, types);
    best(results, query);
    cacheSet(cacheKey, results);
    return results;
};

export const scrapeComparePage = async (url) => {
    const hit = cacheGet(`url:${url}`);
    if (hit) return hit;
    const context = getContext();
    const page = await context.newPage();
    try {
        await page.route('**/*', r => ['font','media','image'].includes(r.request().resourceType()) ? r.abort() : r.continue());
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
                    data.comparisons.specs[f] = { [data.device1.name||'Device1']: cells.eq(1).text().trim(), [data.device2.name||'Device2']: cells.eq(2).text().trim() };
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
        await page.route('**/*', r => ['font','media','image'].includes(r.request().resourceType()) ? r.abort() : r.continue());
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const $ = cheerio.load(await page.content());
        const data = { title: $('h1').text().trim(), sourceUrl: url, rankings: [] };
        const headers = [];
        $('table thead th').each((_, th) => headers.push($(th).text().trim()));
        $('table tbody tr').each((_, row) => {
            const item = {};
            $(row).find('td').each((i, td) => {
                item[headers[i]?.toLowerCase().replace(/\s+/g,'_') || `col_${i}`] = $(td).text().trim();
                const a = $(td).find('a').attr('href');
                if (a && !item.url) item.url = a.startsWith('http') ? a : `https://nanoreview.net${a}`;
            });
            if (Object.keys(item).length) data.rankings.push(item);
        });
        cacheSet(`url:${url}`, data);
        return data;
    } finally { await page.close(); }
};
