import { safeNavigate, reWarmCloudflare, getBrowserContext as getBrowserCtx } from './browser.js';

// ─── Caches ───────────────────────────────────────────────────────────────────
const searchCache = new Map();
const deviceCache = new Map();
const SEARCH_TTL  = 5  * 60 * 1000;
const DEVICE_TTL  = 10 * 60 * 1000;

function evict(cache, maxSize = 150) {
    while (cache.size > maxSize) cache.delete(cache.keys().next().value);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
    if (/ryzen|intel|core|threadripper|xeon|celeron|pentium|i[3579]-|amd|snapdragon|mediatek|exynos|dimensity|a\d{2}\s*bionic/i.test(q))
        return ['cpu', 'soc', 'laptop', 'phone', 'tablet', 'gpu'];
    if (/nvidia|rtx|gtx|radeon|rx\s*\d|geforce|quadro|vega|arc\s*a\d/i.test(q))
        return ['gpu', 'laptop', 'cpu', 'phone', 'tablet', 'soc'];
    if (/iphone|galaxy|pixel|oneplus|xiaomi|oppo|vivo|realme|nothing\s*phone|rog\s*phone/i.test(q))
        return ['phone', 'soc', 'tablet', 'laptop', 'cpu', 'gpu'];
    if (/ipad|galaxy\s*tab|surface|tab\s*s\d/i.test(q))
        return ['tablet', 'phone', 'soc', 'laptop', 'cpu', 'gpu'];
    if (/macbook|thinkpad|xps|zenbook|vivobook|laptop|notebook|ultrabook|chromebook/i.test(q))
        return ['laptop', 'cpu', 'gpu', 'tablet', 'phone', 'soc'];
    return ['phone', 'tablet', 'laptop', 'soc', 'cpu', 'gpu'];
};

const scoreMatch = (name, q) => {
    const n = name.toLowerCase(), ql = q.toLowerCase();
    if (n === ql) return 1000;
    if (n.includes(ql)) return 500;
    let s = 0;
    for (const w of ql.split(/\s+/)) if (n.includes(w)) s += 10;
    return s - n.length * 0.1;
};

function isCFBlock(html, title) {
    const t = (title || '').toLowerCase();
    const h = (html  || '').toLowerCase();
    return (
        t.includes('just a moment') ||
        t.includes('attention required') ||
        t === 'nanoreview.net' ||
        h.includes('cf-browser-verification') ||
        h.includes('challenge-form') ||
        (h.includes('cloudflare') && h.includes('ray id'))
    );
}

// ─── Search via session page (cookie-authenticated, parallel) ─────────────────
export const searchDevices = async (context, query, limit = 5) => {
    const cacheKey = `${query.toLowerCase()}-${limit}`;
    const hit = searchCache.get(cacheKey);
    if (hit && Date.now() - hit.timestamp < SEARCH_TTL) return hit.results;

    const types = detectLikelyTypes(query);
    const { sessionPage, sessionReady } = await getBrowserCtx();

    let allResults = [];

    const runSearch = async (page) => page.evaluate(async ({ query, limit, types }) => {
        const results = await Promise.all(types.map(async (type) => {
            try {
                const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`,
                    { headers: { 'Accept': 'application/json' } });
                if (!res.ok) return [];
                const ct = res.headers.get('content-type') || '';
                if (!ct.includes('application/json')) return [];
                const data = await res.json();
                return Array.isArray(data)
                    ? data.map(r => ({ ...r, content_type: r.content_type || type }))
                    : [];
            } catch { return []; }
        }));
        return results.flat();
    }, { query, limit, types });

    // Fast path: reuse open session page (no navigation needed)
    if (sessionReady && sessionPage) {
        try { allResults = await runSearch(sessionPage); } catch { /* fall through */ }
    }

    // Fallback: open a new page and navigate to nanoreview first
    if (!allResults.length) {
        const page = await context.newPage();
        try {
            await page.route('**/*', (route) => {
                const t = route.request().resourceType();
                ['font', 'media', 'image', 'stylesheet'].includes(t) ? route.abort() : route.continue();
            });
            await safeNavigate(page, 'https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });
            for (let i = 0; i < 6; i++) {
                const title = await page.title().catch(() => '');
                if (!/just a moment|attention required/i.test(title)) break;
                await page.waitForTimeout(1500);
            }
            allResults = await runSearch(page);
        } finally { await page.close(); }
    }

    if (!allResults.length) return [];
    allResults.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));
    searchCache.set(cacheKey, { results: allResults, timestamp: Date.now() });
    evict(searchCache);
    return allResults;
};

// ─── Device data via API interception ────────────────────────────────────────
// Instead of scraping rendered HTML (slow), we:
//   1. Navigate to the device page
//   2. Intercept all XHR/fetch JSON responses the SPA makes while loading
//   3. Collect the data directly from the API responses — no HTML parsing
//   4. Abort images/fonts/CSS to make navigation as fast as possible
export const scrapeDevicePage = async (context, deviceUrl) => {
    const hit = deviceCache.get(deviceUrl);
    if (hit && Date.now() - hit.timestamp < DEVICE_TTL) return hit.data;

    const page = await context.newPage();
    const intercepted = [];

    try {
        // Intercept every JSON response the page makes
        await page.route('**/*', async (route) => {
            const req = route.request();
            const type = req.resourceType();

            // Hard-abort anything that can't contain device data
            if (['font', 'media', 'image', 'stylesheet'].includes(type)) {
                return route.abort();
            }

            // For fetch/xhr, intercept and capture JSON
            if (type === 'fetch' || type === 'xhr') {
                try {
                    const response = await route.fetch();
                    const ct = response.headers()['content-type'] || '';
                    if (ct.includes('application/json')) {
                        try {
                            const body = await response.json();
                            intercepted.push({ url: req.url(), data: body });
                        } catch { /* not valid JSON */ }
                    }
                    return route.fulfill({ response });
                } catch {
                    return route.continue();
                }
            }

            return route.continue();
        });

        await safeNavigate(page, deviceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Wait for CF to clear if needed
        for (let i = 0; i < 6; i++) {
            const title = await page.title().catch(() => '');
            const html  = await page.content().catch(() => '');
            if (!isCFBlock(html, title)) break;
            if (i === 3) await reWarmCloudflare();
            await page.waitForTimeout(1500);
        }

        // Wait for the SPA to fire its data requests (network goes quiet)
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

        // Build response from intercepted API data
        const data = buildDeviceData(deviceUrl, intercepted);

        // Fallback: if API interception got nothing useful, parse the HTML
        if (!data.title || Object.keys(data.specs).length === 0) {
            const html = await page.content();
            const title = await page.title().catch(() => '');
            if (!isCFBlock(html, title)) {
                return _parseHtml(html, deviceUrl);
            }
            throw new Error('Cloudflare blocked the device page. Try again in a moment.');
        }

        deviceCache.set(deviceUrl, { data, timestamp: Date.now() });
        evict(deviceCache);
        return data;

    } finally {
        await page.close();
    }
};

// ─── Build structured device data from intercepted API responses ──────────────
function buildDeviceData(sourceUrl, intercepted) {
    const data = {
        title: '',
        sourceUrl,
        images: [],
        scores: {},
        pros: [],
        cons: [],
        specs: {},
    };

    for (const { url, data: body } of intercepted) {
        if (!body || typeof body !== 'object') continue;

        // Device info / main object
        if (body.name && (body.specs || body.characteristics || body.scores)) {
            data.title = data.title || body.name || body.title || '';

            // Scores / ratings
            if (body.scores && typeof body.scores === 'object') {
                for (const [k, v] of Object.entries(body.scores)) {
                    if (k && v !== undefined) data.scores[k] = String(v);
                }
            }
            if (body.rating !== undefined) data.scores['Overall'] = String(body.rating);
            if (body.score  !== undefined) data.scores['Score']   = String(body.score);

            // Pros / cons
            if (Array.isArray(body.pros)) data.pros.push(...body.pros.map(p => typeof p === 'string' ? p : p.text || p.title || '').filter(Boolean));
            if (Array.isArray(body.cons)) data.cons.push(...body.cons.map(c => typeof c === 'string' ? c : c.text || c.title || '').filter(Boolean));
            if (Array.isArray(body.advantages))    data.pros.push(...body.advantages.map(p => typeof p === 'string' ? p : p.text || '').filter(Boolean));
            if (Array.isArray(body.disadvantages)) data.cons.push(...body.disadvantages.map(c => typeof c === 'string' ? c : c.text || '').filter(Boolean));

            // Specs — could be nested object or flat
            const specsSource = body.specs || body.characteristics || body.parameters || body.details;
            if (specsSource && typeof specsSource === 'object') {
                if (Array.isArray(specsSource)) {
                    // Array of { name, value } or { title, specs: [...] }
                    for (const item of specsSource) {
                        if (item.title && Array.isArray(item.specs || item.parameters || item.items)) {
                            const section = {};
                            for (const s of (item.specs || item.parameters || item.items)) {
                                if (s.name && s.value !== undefined) section[s.name] = String(s.value);
                            }
                            if (Object.keys(section).length) data.specs[item.title] = section;
                        } else if (item.name && item.value !== undefined) {
                            (data.specs['General'] = data.specs['General'] || {})[item.name] = String(item.value);
                        }
                    }
                } else {
                    // Nested object: { "Display": { "Resolution": "1080p", ... }, ... }
                    for (const [section, vals] of Object.entries(specsSource)) {
                        if (typeof vals === 'object' && !Array.isArray(vals)) {
                            const s = {};
                            for (const [k, v] of Object.entries(vals)) {
                                if (k && v !== undefined) s[k] = String(v);
                            }
                            if (Object.keys(s).length) data.specs[section] = s;
                        } else if (typeof vals !== 'object') {
                            (data.specs['General'] = data.specs['General'] || {})[section] = String(vals);
                        }
                    }
                }
            }

            // Images
            const imgFields = ['image', 'images', 'photo', 'photos', 'thumbnail', 'img'];
            for (const field of imgFields) {
                const v = body[field];
                if (typeof v === 'string' && v.startsWith('http')) data.images.push(v);
                if (Array.isArray(v)) data.images.push(...v.filter(u => typeof u === 'string' && u.startsWith('http')));
            }
        }

        // Flat array of spec objects: [{ name, value }, ...]
        if (Array.isArray(body) && body.length > 0 && body[0]?.name && body[0]?.value !== undefined) {
            const section = {};
            for (const item of body) {
                if (item.name) section[item.name] = String(item.value ?? '');
            }
            if (Object.keys(section).length) data.specs['Specifications'] = section;
        }
    }

    data.images = [...new Set(data.images)];
    data.pros   = [...new Set(data.pros)];
    data.cons   = [...new Set(data.cons)];
    return data;
}

import * as cheerio from 'cheerio';

function _parseHtml(html, sourceUrl) {
    const $ = cheerio.load(html);
    const data = {
        title: $('h1').first().text().trim(),
        sourceUrl,
        images: [],
        scores: {},
        pros: [],
        cons: [],
        specs: {},
    };

    $('img').each((_, img) => {
        for (const attr of ['data-src', 'src']) {
            let src = $(img).attr(attr);
            if (!src) continue;
            if (src.startsWith('/')) src = `https://nanoreview.net${src}`;
            const lc = src.toLowerCase();
            if (src.startsWith('http') && !lc.includes('logo') && !lc.includes('icon') && !lc.includes('.svg'))
                data.images.push(src);
        }
    });
    data.images = [...new Set(data.images)];

    $('[class*="score"],[class*="rating"]').each((_, el) => {
        const label = $(el).find('[class*="title"],[class*="name"]').first().text().trim();
        const value = $(el).find('[class*="value"],[class*="num"]').first().text().trim();
        if (label && value && label !== value) data.scores[label] = value;
    });

    $('[class*="pros"] li, [class*="plus"] li, .green li').each((_, el) => {
        const t = $(el).text().trim(); if (t) data.pros.push(t);
    });
    $('[class*="cons"] li, [class*="minus"] li, .red li').each((_, el) => {
        const t = $(el).text().trim(); if (t) data.cons.push(t);
    });

    $('.card, .box, section, [class*="specs"]').each((_, card) => {
        const title = $(card).find('.card-header,.card-title,h2,h3').first().text().trim() || 'Details';
        const section = {};
        $(card).find('table tr').each((__, row) => {
            const cells = $(row).find('td,th');
            if (cells.length >= 2) {
                const label = cells.first().text().trim().replace(/:$/, '');
                const value = cells.last().text().trim();
                if (label && value && label !== value) section[label] = value;
            }
        });
        if (Object.keys(section).length) data.specs[title] = section;
    });

    return data;
}

// ─── Compare page ─────────────────────────────────────────────────────────────
export const scrapeComparePage = async (context, compareUrl) => {
    const hit = deviceCache.get(compareUrl);
    if (hit && Date.now() - hit.timestamp < DEVICE_TTL) return hit.data;

    const page = await context.newPage();
    const intercepted = [];

    try {
        await page.route('**/*', async (route) => {
            const req  = route.request();
            const type = req.resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(type)) return route.abort();
            if (type === 'fetch' || type === 'xhr') {
                try {
                    const response = await route.fetch();
                    const ct = response.headers()['content-type'] || '';
                    if (ct.includes('application/json')) {
                        try { intercepted.push({ url: req.url(), data: await response.json() }); } catch {}
                    }
                    return route.fulfill({ response });
                } catch { return route.continue(); }
            }
            return route.continue();
        });

        await safeNavigate(page, compareUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

        const data = buildCompareData(compareUrl, intercepted);

        // HTML fallback
        if (!data.title) {
            const html  = await page.content();
            const title = await page.title().catch(() => '');
            if (!isCFBlock(html, title)) return _parseCompareHtml(html, compareUrl);
        }

        deviceCache.set(compareUrl, { data, timestamp: Date.now() });
        evict(deviceCache);
        return data;
    } finally {
        await page.close();
    }
};

function buildCompareData(sourceUrl, intercepted) {
    const data = {
        title: '',
        sourceUrl,
        images: [],
        device1: { name: '', score: '' },
        device2: { name: '', score: '' },
        comparisons: {},
    };

    for (const { data: body } of intercepted) {
        if (!body || typeof body !== 'object') continue;

        // Compare response typically has devices array
        if (Array.isArray(body.devices) && body.devices.length >= 2) {
            data.device1.name  = body.devices[0]?.name  || '';
            data.device2.name  = body.devices[1]?.name  || '';
            data.device1.score = String(body.devices[0]?.score ?? '');
            data.device2.score = String(body.devices[1]?.score ?? '');
            data.title = `${data.device1.name} vs ${data.device2.name}`;
        }

        if (body.comparison && typeof body.comparison === 'object') {
            for (const [section, vals] of Object.entries(body.comparison)) {
                if (typeof vals === 'object') data.comparisons[section] = vals;
            }
        }
    }

    return data;
}

function _parseCompareHtml(html, sourceUrl) {
    const $ = cheerio.load(html);
    const data = {
        title: $('h1').first().text().trim(),
        sourceUrl,
        images: [],
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
        const title = $(card).find('.card-header,.card-title,h2,h3').first().text().trim() || 'Comparison';
        const section = {};
        $(card).find('table tr').each((__, row) => {
            const cells = $(row).find('td,th');
            if (cells.length >= 3) {
                const feature = cells.eq(0).text().trim().replace(/:$/, '');
                if (feature) section[feature] = {
                    [data.device1.name || 'Device 1']: cells.eq(1).text().trim(),
                    [data.device2.name || 'Device 2']: cells.eq(2).text().trim(),
                };
            }
        });
        if (Object.keys(section).length) data.comparisons[title] = section;
    });
    return data;
}

// ─── Rankings page ────────────────────────────────────────────────────────────
export const scrapeRankingPage = async (context, rankingUrl) => {
    const hit = deviceCache.get(rankingUrl);
    if (hit && Date.now() - hit.timestamp < DEVICE_TTL) return hit.data;

    const page = await context.newPage();
    const intercepted = [];

    try {
        await page.route('**/*', async (route) => {
            const req  = route.request();
            const type = req.resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(type)) return route.abort();
            if (type === 'fetch' || type === 'xhr') {
                try {
                    const response = await route.fetch();
                    const ct = response.headers()['content-type'] || '';
                    if (ct.includes('application/json')) {
                        try { intercepted.push({ url: req.url(), data: await response.json() }); } catch {}
                    }
                    return route.fulfill({ response });
                } catch { return route.continue(); }
            }
            return route.continue();
        });

        await safeNavigate(page, rankingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

        // Try to get ranking data from intercepted API calls
        let rankings = [];
        for (const { data: body } of intercepted) {
            if (Array.isArray(body) && body.length > 0 && (body[0]?.name || body[0]?.rank)) {
                rankings = body;
                break;
            }
            if (body?.data && Array.isArray(body.data)) { rankings = body.data; break; }
            if (body?.items && Array.isArray(body.items)) { rankings = body.items; break; }
            if (body?.list  && Array.isArray(body.list))  { rankings = body.list;  break; }
        }

        if (rankings.length) {
            const data = {
                title: await page.title().catch(() => ''),
                sourceUrl: rankingUrl,
                rankings: rankings.map((r, i) => ({
                    rank: r.rank || r.position || (i + 1),
                    name: r.name || r.title || '',
                    score: r.score || r.rating || '',
                    url: r.url || r.link || '',
                    ...r,
                })),
            };
            deviceCache.set(rankingUrl, { data, timestamp: Date.now() });
            evict(deviceCache);
            return data;
        }

        // HTML fallback for rankings
        const html  = await page.content();
        const title = await page.title().catch(() => '');
        if (!isCFBlock(html, title)) {
            const $ = cheerio.load(html);
            const data = { title: $('h1').first().text().trim(), sourceUrl: rankingUrl, rankings: [] };
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
                if (Object.keys(item).length) data.rankings.push(item);
            });
            deviceCache.set(rankingUrl, { data, timestamp: Date.now() });
            evict(deviceCache);
            return data;
        }
        throw new Error('Cloudflare blocked the rankings page.');
    } finally {
        await page.close();
    }
};
