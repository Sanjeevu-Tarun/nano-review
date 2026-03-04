import * as cheerio from 'cheerio';
import { waitForCloudflare, safeNavigate } from './browser.js';

const searchCache = new Map();
const deviceCache = new Map();
const SEARCH_TTL = 5 * 60 * 1000;   // 5 min
const DEVICE_TTL = 30 * 60 * 1000;  // 30 min

// ── Type detection ────────────────────────────────────────────────────────

const detectLikelyTypes = (query) => {
    const q = query.toLowerCase();
    if (/ryzen|intel\s*core|threadripper|xeon|celeron|pentium|core\s*i[3579]|amd/i.test(q))
        return ['cpu', 'soc', 'laptop', 'phone', 'tablet', 'gpu'];
    if (/snapdragon|mediatek|dimensity|exynos|a\d{2}\s*bionic|helio|kirin/i.test(q))
        return ['soc', 'phone', 'tablet', 'laptop', 'cpu', 'gpu'];
    if (/nvidia|rtx|gtx|radeon|rx\s*\d|geforce|quadro|vega|arc\s*a\d/i.test(q))
        return ['gpu', 'laptop', 'cpu', 'phone', 'tablet', 'soc'];
    if (/iphone|galaxy|pixel\s*\d|oneplus|xiaomi|oppo|vivo|realme|nothing\s*phone|asus\s*rog|redmi|poco|motorola|nokia|sony/i.test(q))
        return ['phone', 'soc', 'tablet', 'laptop', 'cpu', 'gpu'];
    if (/ipad|galaxy\s*tab|surface|tab\s*s\d/i.test(q))
        return ['tablet', 'phone', 'soc', 'laptop', 'cpu', 'gpu'];
    if (/macbook|thinkpad|xps|zenbook|vivobook|chromebook|ultrabook|ideapad|pavilion|inspiron/i.test(q))
        return ['laptop', 'cpu', 'gpu', 'tablet', 'phone', 'soc'];
    return ['phone', 'tablet', 'laptop', 'soc', 'cpu', 'gpu'];
};

// ── Search ────────────────────────────────────────────────────────────────

export const searchDevices = async (context, query, limit = 10) => {
    const cacheKey = `${query.toLowerCase()}-${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SEARCH_TTL) return cached.results;

    const types = detectLikelyTypes(query);
    const page = await context.newPage();

    try {
        await page.route('**/*', route => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
            else route.continue();
        });

        await safeNavigate(page, 'https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForCloudflare(page, 'body', 12000).catch(() => {});

        // Fire all type searches simultaneously from inside the browser
        const allResults = await page.evaluate(async ({ query, limit, types }) => {
            const results = await Promise.all(types.map(async type => {
                try {
                    const res = await fetch(
                        `/api/search?q=${encodeURIComponent(query)}&limit=${limit}&type=${type}`,
                        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) }
                    );
                    if (!res.ok) return [];
                    const data = await res.json();
                    return Array.isArray(data) ? data.map(r => ({ ...r, content_type: r.content_type || type })) : [];
                } catch { return []; }
            }));
            return results.flat();
        }, { query, limit, types });

        if (!allResults.length) return [];

        // Score and dedupe
        const seen = new Set();
        const scored = allResults
            .filter(r => {
                const k = r.slug || r.url_name || r.name;
                if (!k || seen.has(k)) return false;
                seen.add(k); return true;
            })
            .map(r => ({ ...r, _score: scoreMatch(r.name, r.slug || r.url_name || '', query) }))
            .sort((a, b) => b._score - a._score);

        searchCache.set(cacheKey, { results: scored, timestamp: Date.now() });
        if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
        return scored;
    } finally {
        await page.close().catch(() => {});
    }
};

function scoreMatch(name, slug, query) {
    const n = (name || '').toLowerCase();
    const s = (slug || '').toLowerCase();
    const q = query.toLowerCase().trim();
    const qs = q.replace(/\s+/g, '-');
    if (s === qs || s === q) return 1000;
    if (n === q)              return 950;
    if (s.startsWith(qs))     return 850;
    if (n.startsWith(q))      return 800;
    if (s.includes(qs))       return 700;
    if (n.includes(q))        return 650;
    const words = q.split(/\s+/).filter(w => w.length > 1);
    if (!words.length) return 0;
    return (words.filter(w => n.includes(w) || s.includes(w)).length / words.length) * 400 - n.length * 0.05;
}

// ── Device page — __NEXT_DATA__ extraction ───────────────────────────────

const DEVICE_KEYS = ['device', 'phone', 'laptop', 'cpu', 'gpu', 'soc', 'tablet', 'item', 'data', 'pageData'];

function extractNextData(html, sourceUrl) {
    const m = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([^<]+)<\/script>/);
    if (!m) return null;
    try {
        const props = JSON.parse(m[1])?.props?.pageProps;
        if (!props) return null;
        let d = null;
        for (const key of DEVICE_KEYS) { if (props[key]?.name) { d = props[key]; break; } }
        if (!d) {
            for (const val of Object.values(props)) {
                if (val && typeof val === 'object' && !Array.isArray(val) && val.name && (val.specs || val.params)) { d = val; break; }
            }
        }
        if (!d?.name) return null;
        return normalizeDevice(d, sourceUrl);
    } catch { return null; }
}

function normalizeDevice(d, sourceUrl) {
    const specs = {};
    if (Array.isArray(d.specs)) {
        for (const g of d.specs) {
            if (g.title && Array.isArray(g.items)) {
                const sec = {};
                for (const i of g.items) { if (i.name && i.value != null) sec[i.name] = String(i.value); }
                if (Object.keys(sec).length) specs[g.title] = sec;
            } else if (g.name && g.value != null) {
                (specs['Specs'] = specs['Specs'] || {})[g.name] = String(g.value);
            }
        }
    } else if (d.specs && typeof d.specs === 'object') Object.assign(specs, d.specs);

    if (Array.isArray(d.params)) {
        for (const g of d.params) {
            if (g.name && Array.isArray(g.params)) {
                const sec = {};
                for (const p of g.params) { if (p.name && p.value != null) sec[p.name] = String(p.value); }
                if (Object.keys(sec).length) specs[g.name] = sec;
            }
        }
    } else if (d.params && typeof d.params === 'object') Object.assign(specs, d.params);

    const scores = {};
    if (Array.isArray(d.scores)) { for (const s of d.scores) { if (s.name && s.value != null) scores[s.name] = String(s.value); } }
    else if (d.scores && typeof d.scores === 'object') Object.assign(scores, d.scores);
    for (const k of ['total_score','score','rating','nanoreview_score']) { if (d[k] != null) scores[k] = String(d[k]); }

    const toStr = x => typeof x === 'string' ? x : x?.text || x?.name || '';
    const images = [d.image, d.image_url, ...(d.images||[])].filter(Boolean);

    return {
        title: d.name || d.title || '',
        sourceUrl,
        images: [...new Set(images)],
        scores,
        pros: [...new Set([...(d.pros||[]),...(d.advantages||[])].map(toStr).filter(Boolean))],
        cons: [...new Set([...(d.cons||[]),...(d.disadvantages||[])].map(toStr).filter(Boolean))],
        specs,
        _source: 'next_data',
    };
}

// ── Scrape device page ────────────────────────────────────────────────────

export const scrapeDevicePage = async (context, deviceUrl) => {
    const cached = deviceCache.get(deviceUrl);
    if (cached && Date.now() - cached.timestamp < DEVICE_TTL) return cached.data;

    const page = await context.newPage();
    try {
        await page.route('**/*', route => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image', 'stylesheet'].includes(t)) route.abort();
            else route.continue();
        });

        await safeNavigate(page, deviceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForCloudflare(page, 'body', 10000).catch(() => {});

        const html = await page.content();

        // Try __NEXT_DATA__ first — structured JSON, much faster than cheerio parsing
        const nextData = extractNextData(html, deviceUrl);
        if (nextData) {
            deviceCache.set(deviceUrl, { data: nextData, timestamp: Date.now() });
            if (deviceCache.size > 100) deviceCache.delete(deviceCache.keys().next().value);
            return nextData;
        }

        // Fallback: cheerio HTML parsing
        console.warn(`[scraper] __NEXT_DATA__ not found for ${deviceUrl}, falling back to HTML parse`);
        const $ = cheerio.load(html);
        const data = {
            title: $('h1').text().trim(),
            sourceUrl: deviceUrl,
            images: [],
            scores: {},
            pros: [],
            cons: [],
            specs: {},
            _source: 'html_parse',
        };

        $('img').each((_, img) => {
            const srcs = [$(img).attr('data-src'), $(img).attr('src'),
                ...(($(img).attr('srcset')||'').split(',').map(s => s.trim().split(' ')[0]))
            ].filter(Boolean);
            srcs.forEach(src => {
                if (src.startsWith('/')) src = `https://nanoreview.net${src}`;
                if (src.startsWith('http') && !/logo|icon|avatar|svg/i.test(src)) data.images.push(src);
            });
        });
        data.images = [...new Set(data.images)];

        $('[class*="pros"] li, [class*="plus"] li, .green li').each((_, el) => { const t = $(el).text().trim(); if (t) data.pros.push(t); });
        $('[class*="cons"] li, [class*="minus"] li, .red li').each((_, el) => { const t = $(el).text().trim(); if (t) data.cons.push(t); });

        $('.card, .box, section, [class*="specs"]').each((_, card) => {
            const sTitle = $(card).find('.card-header,.card-title,h2,h3').first().text().trim() || 'Details';
            const section = {};
            $(card).find('table tr').each((__, row) => {
                const cells = $(row).find('td,th');
                if (cells.length >= 2) {
                    const label = cells.first().text().trim().replace(/:$/, '');
                    const value = cells.last().text().trim();
                    if (label && value && label !== value) section[label] = value;
                }
            });
            if (Object.keys(section).length) data.specs[sTitle] = section;
        });

        deviceCache.set(deviceUrl, { data, timestamp: Date.now() });
        if (deviceCache.size > 100) deviceCache.delete(deviceCache.keys().next().value);
        return data;
    } finally {
        await page.close().catch(() => {});
    }
};

// ── Compare page ──────────────────────────────────────────────────────────

export const scrapeComparePage = async (context, compareUrl) => {
    const page = await context.newPage();
    try {
        await page.route('**/*', route => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image'].includes(t)) route.abort();
            else route.continue();
        });
        await safeNavigate(page, compareUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForCloudflare(page, 'body', 10000).catch(() => {});
        const html = await page.content();

        // Try __NEXT_DATA__ first
        const m = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([^<]+)<\/script>/);
        if (m) {
            try {
                const props = JSON.parse(m[1])?.props?.pageProps;
                const comp = props?.comparison || props?.data;
                if (comp) {
                    return {
                        title: comp.title || '',
                        sourceUrl: compareUrl,
                        device1: { name: comp.device1?.name || comp.phones?.[0]?.name || '' },
                        device2: { name: comp.device2?.name || comp.phones?.[1]?.name || '' },
                        comparisons: comp.comparisons || comp.specs || {},
                        _source: 'next_data',
                    };
                }
            } catch {}
        }

        const $ = cheerio.load(html);
        const data = { title: $('h1').text().trim(), sourceUrl: compareUrl, device1: { name: '' }, device2: { name: '' }, comparisons: {} };
        const headers = [];
        $('.compare-header [class*="title"], .vs-header h2, th').each((_, el) => {
            const t = $(el).text().trim();
            if (t && t.toLowerCase() !== 'vs') headers.push(t);
        });
        if (headers.length >= 2) { data.device1.name = headers[0]; data.device2.name = headers[1]; }
        $('.card, .box, section, [class*="specs"]').each((_, card) => {
            const sTitle = $(card).find('h2,h3').first().text().trim() || 'Comparison';
            const section = {};
            $(card).find('table tr').each((__, row) => {
                const cells = $(row).find('td,th');
                if (cells.length >= 3) {
                    const f = cells.eq(0).text().trim().replace(/:$/, '');
                    if (f) section[f] = { [data.device1.name||'Device 1']: cells.eq(1).text().trim(), [data.device2.name||'Device 2']: cells.eq(2).text().trim() };
                }
            });
            if (Object.keys(section).length) data.comparisons[sTitle] = section;
        });
        return data;
    } finally {
        await page.close().catch(() => {});
    }
};

// ── Rankings page ─────────────────────────────────────────────────────────

export const scrapeRankingPage = async (context, rankingUrl) => {
    const page = await context.newPage();
    try {
        await page.route('**/*', route => {
            const t = route.request().resourceType();
            if (['font', 'media', 'image'].includes(t)) route.abort();
            else route.continue();
        });
        await safeNavigate(page, rankingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForCloudflare(page, 'body', 10000).catch(() => {});
        const html = await page.content();
        const $ = cheerio.load(html);
        const data = { title: $('h1').text().trim(), sourceUrl: rankingUrl, rankings: [] };

        // Try __NEXT_DATA__ first
        const m = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([^<]+)<\/script>/);
        if (m) {
            try {
                const props = JSON.parse(m[1])?.props?.pageProps;
                const items = props?.items || props?.devices || props?.list;
                if (Array.isArray(items) && items.length) {
                    data.rankings = items.map((item, i) => ({
                        rank: i + 1,
                        name: item.name || item.title,
                        score: item.score || item.total_score || item.rating,
                        slug: item.slug || item.url_name,
                        url: `https://nanoreview.net/en/${item.content_type||'soc'}/${item.slug||item.url_name}`,
                    }));
                    return data;
                }
            } catch {}
        }

        const headers = [];
        $('table thead th').each((_, th) => headers.push($(th).text().trim()));
        $('table tbody tr').each((_, row) => {
            const item = {};
            $(row).find('td').each((i, td) => {
                item[headers[i] || `col_${i}`] = $(td).text().trim();
                const a = $(td).find('a').attr('href');
                if (a && !item.url) item.url = a.startsWith('http') ? a : `https://nanoreview.net${a}`;
            });
            if (Object.keys(item).length) data.rankings.push(item);
        });
        return data;
    } finally {
        await page.close().catch(() => {});
    }
};
