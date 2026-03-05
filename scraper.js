import * as cheerio from 'cheerio';

// ─── Caches ───────────────────────────────────────────────────────────────────
const searchCache = new Map();
const deviceCache = new Map();
const SEARCH_TTL  = 5  * 60 * 1000;
const DEVICE_TTL  = 10 * 60 * 1000;

function evict(cache, maxSize = 200) {
    while (cache.size > maxSize) cache.delete(cache.keys().next().value);
}

// ─── Shared fetch headers — mimics a real Chrome browser ─────────────────────
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'Cache-Control': 'max-age=0',
    'Connection': 'keep-alive',
};

const JSON_HEADERS = {
    ...HEADERS,
    'Accept': 'application/json',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'Referer': 'https://nanoreview.net/',
};

// Persistent cookie jar — stores CF clearance cookies across requests
const cookieJar = new Map(); // domain → cookie string

function storeCookies(domain, setCookieHeaders) {
    if (!setCookieHeaders) return;
    const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    const existing = cookieJar.get(domain) ? Object.fromEntries(
        cookieJar.get(domain).split('; ').map(c => c.split('='))
    ) : {};
    for (const cookie of cookies) {
        const [pair] = cookie.split(';');
        const [name, ...val] = pair.split('=');
        if (name?.trim()) existing[name.trim()] = val.join('=').trim();
    }
    cookieJar.set(domain, Object.entries(existing).map(([k, v]) => `${k}=${v}`).join('; '));
}

function getCookies(domain) {
    return cookieJar.get(domain) || '';
}

async function fetchWithCookies(url, options = {}) {
    const domain = new URL(url).hostname;
    const cookies = getCookies(domain);
    const headers = {
        ...(options.headers || HEADERS),
        ...(cookies ? { 'Cookie': cookies } : {}),
    };
    const res = await fetch(url, {
        ...options,
        headers,
        signal: AbortSignal.timeout(options.timeout || 8000),
        redirect: 'follow',
    });
    // Store any new cookies (CF clearance etc.)
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) storeCookies(domain, setCookie);
    return res;
}

// ─── Type detection ───────────────────────────────────────────────────────────
const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
    if (/ryzen|intel|core i[3579]|threadripper|xeon|snapdragon|mediatek|exynos|dimensity|a\d{2}\s*bionic/i.test(q))
        return ['cpu', 'soc', 'laptop', 'phone', 'tablet', 'gpu'];
    if (/nvidia|rtx|gtx|radeon|rx\s*\d|geforce|quadro|arc\s*a\d/i.test(q))
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

// ─── Search — plain fetch, parallel, no browser ───────────────────────────────
export const searchDevices = async (_context, query, limit = 5) => {
    const cacheKey = `${query.toLowerCase()}-${limit}`;
    const hit = searchCache.get(cacheKey);
    if (hit && Date.now() - hit.timestamp < SEARCH_TTL) return hit.results;

    const types = detectLikelyTypes(query);

    // Only fetch the top 2 most-likely types to cut latency
    const topTypes = types.slice(0, 2);
    const results = (await Promise.all(topTypes.map(async (type) => {
        try {
            const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
            const res = await fetchWithCookies(url, { headers: JSON_HEADERS });
            const ct = res.headers.get('content-type') || '';
            console.log(`[search] ${type} → HTTP ${res.status} | ct: ${ct.substring(0,40)}`);
            if (!res.ok) {
                const body = await res.text();
                console.log(`[search] ${type} error body (100):`, body.substring(0, 100));
                return [];
            }
            if (!ct.includes('application/json')) {
                const body = await res.text();
                console.log(`[search] ${type} non-json body (200):`, body.substring(0, 200));
                return [];
            }
            const data = await res.json();
            console.log(`[search] ${type} → ${Array.isArray(data) ? data.length : 0} results`);
            return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
        } catch (e) {
            console.log(`[search] ${type} exception:`, e.message);
            return [];
        }
    }))).flat();

    // If top types found nothing, try remaining types
    if (!results.length) {
        const remaining = types.slice(2);
        const extra = (await Promise.all(remaining.map(async (type) => {
            try {
                const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`;
                const res = await fetchWithCookies(url, { headers: JSON_HEADERS });
                const ct = res.headers.get('content-type') || '';
                if (!res.ok || !ct.includes('application/json')) return [];
                const data = await res.json();
                return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
            } catch { return []; }
        }))).flat();
        results.push(...extra);
    }

    if (!results.length) return [];
    results.sort((a, b) => scoreMatch(b.name, query) - scoreMatch(a.name, query));
    searchCache.set(cacheKey, { results, timestamp: Date.now() });
    evict(searchCache);
    return results;
};

// ─── Extract __NUXT__ / __NEXT_DATA__ / inline JSON from HTML ────────────────
// NanoReview is Nuxt.js — all SSR data is embedded in the HTML as:
//   window.__NUXT__={...}  or  <script id="__NUXT_DATA__" type="application/json">
// This gives us the full structured device data without running any JS.
function extractEmbeddedData(html) {
    // Method 1: window.__NUXT__ = {...} inline script
    let match = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*(?:<\/script>|;[\s\r\n]*<)/);
    if (match) {
        try { return { source: 'nuxt', data: JSON.parse(match[1]) }; } catch {}
    }

    // Method 2: <script id="__NUXT_DATA__" type="application/json">
    match = html.match(/<script[^>]+id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (match) {
        try { return { source: 'nuxt_data', data: JSON.parse(match[1]) }; } catch {}
    }

    // Method 3: Next.js style
    match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (match) {
        try { return { source: 'next', data: JSON.parse(match[1]) }; } catch {}
    }

    // Method 4: Nuxt useNuxtApp payload
    match = html.match(/window\.__NUXT_PAYLOAD__\s*=\s*({[\s\S]*?})\s*<\/script>/);
    if (match) {
        try { return { source: 'nuxt_payload', data: JSON.parse(match[1]) }; } catch {}
    }

    // Method 5: Nuxt 3 style - <script type="application/json" data-island-uid>
    const scripts = [...html.matchAll(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const s of scripts) {
        try {
            const parsed = JSON.parse(s[1]);
            // Look for device-shaped data
            if (parsed?.data && (parsed.data.specs || parsed.data.name)) {
                return { source: 'json_script', data: parsed };
            }
        } catch {}
    }

    return null;
}

// ─── Recursively search nested object for device data ────────────────────────
function findDeviceData(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 8) return null;
    // Direct hit: has name + specs
    if (obj.name && typeof obj.name === 'string' && obj.name.length > 2) {
        if (obj.specs || obj.characteristics || obj.scores) return obj;
    }
    // Search children
    for (const val of Object.values(obj)) {
        if (val && typeof val === 'object') {
            const found = findDeviceData(val, depth + 1);
            if (found) return found;
        }
    }
    return null;
}

// ─── Build device response from raw API/embedded data ────────────────────────
function buildFromApiData(body, sourceUrl) {
    const data = {
        title: body.name || body.title || '',
        sourceUrl,
        images: [],
        scores: {},
        pros: [],
        cons: [],
        specs: {},
    };

    // Scores
    if (body.scores && typeof body.scores === 'object') {
        for (const [k, v] of Object.entries(body.scores)) {
            if (k && v !== undefined) data.scores[k] = String(v);
        }
    }
    if (body.rating !== undefined) data.scores['Overall'] = String(body.rating);
    if (body.score  !== undefined) data.scores['Score']   = String(body.score);

    // Pros / cons
    const toText = x => typeof x === 'string' ? x : (x?.text || x?.title || x?.name || '');
    if (Array.isArray(body.pros))           data.pros.push(...body.pros.map(toText).filter(Boolean));
    if (Array.isArray(body.cons))           data.cons.push(...body.cons.map(toText).filter(Boolean));
    if (Array.isArray(body.advantages))     data.pros.push(...body.advantages.map(toText).filter(Boolean));
    if (Array.isArray(body.disadvantages))  data.cons.push(...body.disadvantages.map(toText).filter(Boolean));

    // Specs
    const specsSource = body.specs || body.characteristics || body.parameters || body.details;
    if (specsSource) {
        if (Array.isArray(specsSource)) {
            for (const item of specsSource) {
                if (item.title && Array.isArray(item.specs || item.items || item.parameters)) {
                    const section = {};
                    for (const s of (item.specs || item.items || item.parameters)) {
                        if (s.name && s.value !== undefined) section[s.name] = String(s.value);
                    }
                    if (Object.keys(section).length) data.specs[item.title] = section;
                } else if (item.name && item.value !== undefined) {
                    (data.specs['General'] = data.specs['General'] || {})[item.name] = String(item.value);
                }
            }
        } else if (typeof specsSource === 'object') {
            for (const [section, vals] of Object.entries(specsSource)) {
                if (vals && typeof vals === 'object' && !Array.isArray(vals)) {
                    const s = {};
                    for (const [k, v] of Object.entries(vals)) {
                        if (k && v !== undefined) s[k] = String(v);
                    }
                    if (Object.keys(s).length) data.specs[section] = s;
                } else if (typeof vals !== 'object') {
                    (data.specs['General'] = data.specs['General'] || {})[section] = String(vals ?? '');
                }
            }
        }
    }

    // Images
    for (const field of ['image', 'images', 'photo', 'photos', 'thumbnail']) {
        const v = body[field];
        if (typeof v === 'string' && v.startsWith('http')) data.images.push(v);
        if (Array.isArray(v)) data.images.push(...v.filter(u => typeof u === 'string' && u.startsWith('http')));
    }
    data.images = [...new Set(data.images)];
    data.pros   = [...new Set(data.pros)];
    data.cons   = [...new Set(data.cons)];
    return data;
}

// ─── HTML parser fallback ─────────────────────────────────────────────────────
function parseHtmlFallback(html, sourceUrl) {
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

    $('[class*="pros"] li,[class*="plus"] li,.green li').each((_, el) => {
        const t = $(el).text().trim(); if (t) data.pros.push(t);
    });
    $('[class*="cons"] li,[class*="minus"] li,.red li').each((_, el) => {
        const t = $(el).text().trim(); if (t) data.cons.push(t);
    });

    $('.card,.box,section,[class*="specs"]').each((_, card) => {
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

// ─── Core: fetch page HTML and extract data ───────────────────────────────────
async function fetchDeviceData(pageUrl) {
    const res = await fetchWithCookies(pageUrl, { headers: HEADERS, timeout: 8000 });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${pageUrl}`);
    }

    const html = await res.text();

    // Check for CF block
    const isCF = html.includes('cf-browser-verification') ||
                 html.includes('challenge-form') ||
                 (html.includes('cloudflare') && html.includes('ray id')) ||
                 html.includes('_cf_chl_opt');

    if (isCF) throw new Error('CF_BLOCKED');

    // Try to extract embedded SSR JSON first (fastest, most structured)
    const embedded = extractEmbeddedData(html);
    if (embedded) {
        const deviceData = findDeviceData(embedded.data);
        if (deviceData) return buildFromApiData(deviceData, pageUrl);
    }

    // Fall back to HTML parsing
    const parsed = parseHtmlFallback(html, pageUrl);
    if (parsed.title && parsed.title !== 'nanoreview.net') return parsed;

    throw new Error('NO_DATA');
}

// ─── Device page ──────────────────────────────────────────────────────────────
export const scrapeDevicePage = async (_context, deviceUrl) => {
    const hit = deviceCache.get(deviceUrl);
    if (hit && Date.now() - hit.timestamp < DEVICE_TTL) return hit.data;

    try {
        const data = await fetchDeviceData(deviceUrl);
        deviceCache.set(deviceUrl, { data, timestamp: Date.now() });
        evict(deviceCache);
        return data;
    } catch (err) {
        if (err.message === 'CF_BLOCKED') {
            // CF blocked plain fetch — we need to signal to use browser fallback
            throw new Error('NEEDS_BROWSER');
        }
        throw err;
    }
};

// ─── Compare page ─────────────────────────────────────────────────────────────
export const scrapeComparePage = async (_context, compareUrl) => {
    const hit = deviceCache.get(compareUrl);
    if (hit && Date.now() - hit.timestamp < DEVICE_TTL) return hit.data;

    const res = await fetchWithCookies(compareUrl, { headers: HEADERS, timeout: 8000 });
    const html = await res.text();
    const $ = cheerio.load(html);

    // Try embedded data first
    const embedded = extractEmbeddedData(html);
    let data;
    if (embedded) {
        const raw = embedded.data;
        data = {
            title: '',
            sourceUrl: compareUrl,
            images: [],
            device1: { name: '', score: '' },
            device2: { name: '', score: '' },
            comparisons: {},
        };
        if (Array.isArray(raw?.devices) && raw.devices.length >= 2) {
            data.device1.name  = raw.devices[0]?.name  || '';
            data.device2.name  = raw.devices[1]?.name  || '';
            data.device1.score = String(raw.devices[0]?.score ?? '');
            data.device2.score = String(raw.devices[1]?.score ?? '');
            data.title = `${data.device1.name} vs ${data.device2.name}`;
        }
        if (raw?.comparison) data.comparisons = raw.comparison;
    }

    // HTML fallback for compare
    if (!data?.title) {
        data = {
            title: $('h1').first().text().trim(),
            sourceUrl: compareUrl,
            images: [],
            device1: { name: '', score: '' },
            device2: { name: '', score: '' },
            comparisons: {},
        };
        const headers = [];
        $('.compare-header [class*="title"],.vs-header h2,th').each((_, el) => {
            const t = $(el).text().trim();
            if (t && t.toLowerCase() !== 'vs') headers.push(t);
        });
        if (headers.length >= 2) { data.device1.name = headers[0]; data.device2.name = headers[1]; }
        $('.card,.box,section,[class*="specs"]').each((_, card) => {
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
    }

    deviceCache.set(compareUrl, { data, timestamp: Date.now() });
    evict(deviceCache);
    return data;
};

// ─── Rankings page ────────────────────────────────────────────────────────────
export const scrapeRankingPage = async (_context, rankingUrl) => {
    const hit = deviceCache.get(rankingUrl);
    if (hit && Date.now() - hit.timestamp < DEVICE_TTL) return hit.data;

    const res = await fetchWithCookies(rankingUrl, { headers: HEADERS, timeout: 8000 });
    const html = await res.text();
    const $ = cheerio.load(html);

    // Try embedded data
    const embedded = extractEmbeddedData(html);
    if (embedded) {
        const raw = embedded.data;
        const list = raw?.rankings || raw?.list || raw?.items || raw?.data;
        if (Array.isArray(list) && list.length > 0) {
            const data = {
                title: $('h1').first().text().trim(),
                sourceUrl: rankingUrl,
                rankings: list.map((r, i) => ({
                    rank: r.rank || r.position || (i + 1),
                    name: r.name || r.title || '',
                    score: r.score || r.rating || '',
                    url: r.url ? (r.url.startsWith('http') ? r.url : `https://nanoreview.net${r.url}`) : '',
                })),
            };
            deviceCache.set(rankingUrl, { data, timestamp: Date.now() });
            evict(deviceCache);
            return data;
        }
    }

    // HTML table fallback
    const data = { title: $('h1').first().text().trim(), sourceUrl: rankingUrl, rankings: [] };
    const tableHeaders = [];
    $('table thead th').each((_, th) => tableHeaders.push($(th).text().trim()));
    $('table tbody tr').each((_, row) => {
        const item = {};
        $(row).find('td').each((i, td) => {
            const key = tableHeaders[i] ? tableHeaders[i].toLowerCase().replace(/\s+/g, '_') : `col_${i}`;
            item[key] = $(td).text().trim();
            const a = $(td).find('a').attr('href');
            if (a && !item.url) item.url = a.startsWith('http') ? a : `https://nanoreview.net${a}`;
        });
        if (Object.keys(item).length) data.rankings.push(item);
    });

    deviceCache.set(rankingUrl, { data, timestamp: Date.now() });
    evict(deviceCache);
    return data;
};
