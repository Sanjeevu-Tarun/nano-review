import * as cheerio from 'cheerio';

// ─── Caches ───────────────────────────────────────────────────────────────────
const searchCache = new Map();
const deviceCache = new Map();
const SEARCH_TTL  = 5  * 60 * 1000;
const DEVICE_TTL  = 10 * 60 * 1000;

function evict(cache, maxSize = 200) {
    while (cache.size > maxSize) cache.delete(cache.keys().next().value);
}

// ─── Headers ─────────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HTML_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
};

const JSON_HEADERS = {
    'User-Agent': UA,
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://nanoreview.net/',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
};

// ─── Type detection ───────────────────────────────────────────────────────────
function detectTypes(query) {
    const q = query.toLowerCase();
    if (/ryzen|intel|core i[3579]|threadripper|xeon|snapdragon|mediatek|exynos|dimensity|a\d{2}\s*bionic/i.test(q))
        return ['cpu', 'soc', 'laptop', 'phone', 'tablet', 'gpu'];
    if (/nvidia|rtx|gtx|radeon|rx\s*\d|geforce|arc\s*a\d/i.test(q))
        return ['gpu', 'laptop', 'cpu', 'phone', 'tablet', 'soc'];
    if (/iphone|galaxy|pixel|oneplus|xiaomi|oppo|vivo|realme|nothing phone|rog phone/i.test(q))
        return ['phone', 'soc', 'tablet', 'laptop', 'cpu', 'gpu'];
    if (/ipad|galaxy tab|surface|tab s\d/i.test(q))
        return ['tablet', 'phone', 'soc', 'laptop', 'cpu', 'gpu'];
    if (/macbook|thinkpad|xps|zenbook|vivobook|laptop|notebook|chromebook/i.test(q))
        return ['laptop', 'cpu', 'gpu', 'tablet', 'phone', 'soc'];
    return ['phone', 'tablet', 'laptop', 'soc', 'cpu', 'gpu'];
}

function scoreMatch(name, q) {
    const n = name.toLowerCase(), ql = q.toLowerCase();
    if (n === ql) return 1000;
    if (n.includes(ql)) return 500;
    let s = 0;
    for (const w of ql.split(/\s+/)) if (n.includes(w)) s += 10;
    return s - n.length * 0.1;
}

// ─── Search ───────────────────────────────────────────────────────────────────
// NanoReview's search API also supports querying without a type filter.
// We try that first as a fast path, then fall back to per-type queries.
async function fetchSearchType(query, type, limit) {
    const url = type
        ? `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`
        : `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    try {
        const res = await fetch(url, { headers: JSON_HEADERS, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return [];
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('json')) return [];
        const data = await res.json();
        return Array.isArray(data)
            ? data.map(r => ({ ...r, content_type: r.content_type || type || 'phone' }))
            : [];
    } catch {
        return [];
    }
}

export async function searchDevices(_context, query, limit = 5) {
    const key = `${query.toLowerCase()}-${limit}`;
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.ts < SEARCH_TTL) return hit.data;

    // Fast path: query without a type filter — returns mixed results
    const untyped = await fetchSearchType(query, null, limit);
    if (untyped.length > 0) {
        untyped.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));
        searchCache.set(key, { data: untyped, ts: Date.now() });
        evict(searchCache);
        return untyped;
    }

    // Fallback: try all prioritised types (no slice cap)
    const types = detectTypes(query);
    const all = (await Promise.all(
        types.map(type => fetchSearchType(query, type, limit))
    )).flat();

    if (!all.length) return [];

    // Deduplicate by name
    const seen = new Set();
    const deduped = all.filter(r => {
        if (seen.has(r.name)) return false;
        seen.add(r.name);
        return true;
    });

    deduped.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));
    searchCache.set(key, { data: deduped, ts: Date.now() });
    evict(searchCache);
    return deduped;
}

// ─── Slug from search result ──────────────────────────────────────────────────
function toSlug(item) {
    return item.slug || item.url_name ||
        item.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ─── Parse device HTML with cheerio ──────────────────────────────────────────
// NanoReview serves fully server-rendered HTML (80KB+).
// All specs are in <table> rows, scores in specific elements.
function parseDevice(html, url) {
    const $ = cheerio.load(html);

    const data = {
        title: $('h1').first().text().trim(),
        sourceUrl: url,
        images: [],
        scores: {},
        pros: [],
        cons: [],
        specs: {},
    };

    // Images — device photos usually in .device-image, .phone-image, or main img
    $('img[src], img[data-src]').each((_, el) => {
        let src = $(el).attr('data-src') || $(el).attr('src') || '';
        if (src.startsWith('/')) src = 'https://nanoreview.net' + src;
        if (src.startsWith('http') && /\.(jpe?g|png|webp)/i.test(src) &&
            !/logo|icon|avatar|sprite|flag/i.test(src)) {
            data.images.push(src);
        }
    });
    data.images = [...new Set(data.images)].slice(0, 5);

    // Scores — nanoreview uses elements with numeric values and labels
    // Common patterns: .score-value, .rating-value, [class*="score"]
    $('[class*="score-item"], [class*="rating-item"], [class*="test-item"]').each((_, el) => {
        const label = $(el).find('[class*="title"], [class*="name"], [class*="label"]').first().text().trim();
        const value = $(el).find('[class*="value"], [class*="number"], [class*="score"]').first().text().trim();
        if (label && value && /\d/.test(value)) data.scores[label] = value;
    });

    // Also grab overall score / NanoReview score from prominent elements
    $('[class*="overall"], [class*="total-score"], [class*="main-score"]').each((_, el) => {
        const value = $(el).text().trim();
        if (/^\d/.test(value)) data.scores['NanoReview Score'] = value;
    });

    // Pros & cons
    $('[class*="pros"] li, [class*="advantages"] li, [class*="plus"] li').each((_, el) => {
        const t = $(el).text().trim(); if (t) data.pros.push(t);
    });
    $('[class*="cons"] li, [class*="disadvantages"] li, [class*="minus"] li').each((_, el) => {
        const t = $(el).text().trim(); if (t) data.cons.push(t);
    });

    // Specs — look for ALL tables on the page, group by nearest heading
    $('table').each((_, table) => {
        // Find section heading: previous sibling h2/h3 or parent's heading
        let sectionName = $(table).closest('[class*="card"], [class*="section"], [class*="block"]')
            .find('h2, h3, h4, [class*="title"], [class*="header"]').first().text().trim();
        if (!sectionName) {
            sectionName = $(table).prevAll('h2, h3, h4').first().text().trim();
        }
        if (!sectionName) sectionName = 'Specifications';

        const section = {};
        $(table).find('tr').each((_, row) => {
            const cells = $(row).find('td, th');
            if (cells.length >= 2) {
                const label = cells.eq(0).text().trim().replace(/:$/, '');
                const value = cells.eq(cells.length - 1).text().trim();
                if (label && value && label !== value && label.length < 60) {
                    section[label] = value;
                }
            }
        });
        if (Object.keys(section).length > 0) {
            // Merge into existing section if name collides
            data.specs[sectionName] = { ...(data.specs[sectionName] || {}), ...section };
        }
    });

    // Also parse definition lists (dl/dt/dd) which some pages use
    $('dl').each((_, dl) => {
        let sectionName = $(dl).prevAll('h2, h3, h4').first().text().trim() || 'Details';
        const section = {};
        $(dl).find('dt').each((_, dt) => {
            const label = $(dt).text().trim();
            const value = $(dt).next('dd').text().trim();
            if (label && value) section[label] = value;
        });
        if (Object.keys(section).length > 0) {
            data.specs[sectionName] = { ...(data.specs[sectionName] || {}), ...section };
        }
    });

    // Fallback: grab any key-value pairs in [class*="spec"] elements
    if (Object.keys(data.specs).length === 0) {
        const section = {};
        $('[class*="spec-row"], [class*="spec-item"], [class*="param"]').each((_, el) => {
            const label = $(el).find('[class*="name"], [class*="label"], [class*="key"]').first().text().trim();
            const value = $(el).find('[class*="value"], [class*="val"]').first().text().trim();
            if (label && value && label !== value) section[label] = value;
        });
        if (Object.keys(section).length > 0) data.specs['Specifications'] = section;
    }

    return data;
}

// ─── Fetch + parse device page ────────────────────────────────────────────────
export async function scrapeDevicePage(_context, deviceUrl) {
    const hit = deviceCache.get(deviceUrl);
    if (hit && Date.now() - hit.ts < DEVICE_TTL) return hit.data;

    const res = await fetch(deviceUrl, { headers: HTML_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${deviceUrl}`);

    const html = await res.text();
    if (html.includes('cf-browser-verification') || html.includes('Just a moment')) {
        throw new Error('Cloudflare is blocking this request');
    }

    const data = parseDevice(html, deviceUrl);
    deviceCache.set(deviceUrl, { data, ts: Date.now() });
    evict(deviceCache);
    return data;
}

// ─── Compare page ─────────────────────────────────────────────────────────────
export async function scrapeComparePage(_context, compareUrl) {
    const hit = deviceCache.get(compareUrl);
    if (hit && Date.now() - hit.ts < DEVICE_TTL) return hit.data;

    const res = await fetch(compareUrl, { headers: HTML_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    const data = {
        title: $('h1').first().text().trim(),
        sourceUrl: compareUrl,
        images: [],
        device1: { name: '', score: '' },
        device2: { name: '', score: '' },
        comparisons: {},
    };

    // Device names from compare header
    const names = [];
    $('[class*="compare"] h2, [class*="vs"] h2, [class*="device-name"], th[class*="device"]').each((_, el) => {
        const t = $(el).text().trim();
        if (t && !/^vs$/i.test(t)) names.push(t);
    });
    if (names.length >= 2) { data.device1.name = names[0]; data.device2.name = names[1]; }

    $('table').each((_, table) => {
        const sectionName = $(table).prevAll('h2,h3,h4').first().text().trim() || 'Comparison';
        const section = {};
        $(table).find('tr').each((_, row) => {
            const cells = $(row).find('td,th');
            if (cells.length >= 3) {
                const feature = cells.eq(0).text().trim();
                if (feature) section[feature] = {
                    [data.device1.name || 'Device 1']: cells.eq(1).text().trim(),
                    [data.device2.name || 'Device 2']: cells.eq(2).text().trim(),
                };
            }
        });
        if (Object.keys(section).length) data.comparisons[sectionName] = section;
    });

    deviceCache.set(compareUrl, { data, ts: Date.now() });
    evict(deviceCache);
    return data;
}

// ─── Rankings page ────────────────────────────────────────────────────────────
export async function scrapeRankingPage(_context, rankingUrl) {
    const hit = deviceCache.get(rankingUrl);
    if (hit && Date.now() - hit.ts < DEVICE_TTL) return hit.data;

    const res = await fetch(rankingUrl, { headers: HTML_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
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

    deviceCache.set(rankingUrl, { data, ts: Date.now() });
    evict(deviceCache);
    return data;
}