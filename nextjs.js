/**
 * nextjs.js — Next.js JSON data extraction
 *
 * After the browser warms up and captures CF cookies, device data is
 * fetched fast via /_next/data/ JSON endpoint using a single browser page
 * that fires all fetches via page.evaluate() — no new page per request.
 */
import { fetchPage, getContext } from './browser.js';
import { cache, TTL } from './cache.js';

let _buildId = null;
let _buildIdExpiry = 0;

async function getBuildId() {
    if (_buildId && Date.now() < _buildIdExpiry) return _buildId;
    const cached = cache.get('meta', 'buildId');
    if (cached) {
        _buildId = cached;
        _buildIdExpiry = Date.now() + 2 * 60 * 60 * 1000;
        return _buildId;
    }
    try {
        const html = await fetchPage('https://nanoreview.net/en/');
        const m = html.match(/"buildId"\s*:\s*"([^"]+)"/);
        if (m) {
            _buildId = m[1];
            _buildIdExpiry = Date.now() + 2 * 60 * 60 * 1000;
            cache.set('meta', 'buildId', _buildId, 2 * 60 * 60 * 1000);
            console.log('[nextjs] buildId:', _buildId);
            return _buildId;
        }
    } catch (err) {
        console.warn('[nextjs] buildId fetch failed:', err.message);
    }
    return null;
}

export function invalidateBuildId() {
    _buildId = null;
    _buildIdExpiry = 0;
    cache.del('meta', 'buildId');
}

const DEVICE_KEYS = ['device', 'phone', 'laptop', 'cpu', 'gpu', 'soc', 'tablet', 'item', 'data', 'pageData'];

function extractDevice(props) {
    if (!props) return null;
    for (const key of DEVICE_KEYS) {
        if (props[key]?.name) return props[key];
    }
    for (const val of Object.values(props)) {
        if (val && typeof val === 'object' && !Array.isArray(val) && val.name && (val.specs || val.params || val.scores)) return val;
    }
    return null;
}

function parseNextData(html, sourceUrl) {
    if (!html) return null;
    const m = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([^<]+)<\/script>/);
    if (!m) return null;
    try {
        const d = extractDevice(JSON.parse(m[1])?.props?.pageProps);
        return d?.name ? normalizeDeviceData(d, sourceUrl) : null;
    } catch { return null; }
}

function normalizeDeviceData(d, sourceUrl) {
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
    for (const k of ['total_score', 'score', 'rating', 'nanoreview_score']) { if (d[k] != null) scores[k] = String(d[k]); }

    const toStr = x => typeof x === 'string' ? x : x?.text || x?.name || '';
    return {
        title: d.name || d.title || '',
        sourceUrl,
        images: [...new Set([d.image, d.image_url, ...(d.images || [])].filter(Boolean))],
        scores,
        pros: [...new Set([...(d.pros || []), ...(d.advantages || [])].map(toStr).filter(Boolean))],
        cons: [...new Set([...(d.cons || []), ...(d.disadvantages || [])].map(toStr).filter(Boolean))],
        specs,
        _source: 'next_data',
    };
}

// Fetch JSON via browser's own fetch() — inherits CF session, no new page needed
async function fetchJsonViaBrowser(url) {
    const ctx = await getContext();
    const page = await ctx.newPage();
    try {
        // Navigate to base domain so fetch() shares the CF session
        await page.goto('https://nanoreview.net/en/', { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Wait for CF
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
            const title = await page.title().catch(() => '');
            if (!/just a moment|checking your browser/i.test(title)) break;
            await page.waitForTimeout(800);
        }

        const result = await page.evaluate(async (fetchUrl) => {
            try {
                const res = await fetch(fetchUrl, {
                    headers: { accept: 'application/json' },
                    signal: AbortSignal.timeout(8000),
                });
                if (!res.ok) return { error: res.status };
                return { data: await res.json() };
            } catch (e) { return { error: String(e) }; }
        }, url);

        if (result.error) throw new Error(`Browser fetch error: ${result.error}`);
        return result.data;
    } finally {
        await page.close().catch(() => {});
    }
}

export async function fetchDeviceData(contentType, slug, sourceUrl) {
    const cacheKey = `device:${contentType}:${slug}`;
    const cached = cache.get('device', cacheKey);
    if (cached) { console.log(`[nextjs] cache hit: ${slug}`); return cached; }

    // Strategy 1: /_next/data/ JSON via browser fetch
    const buildId = await getBuildId();
    if (buildId) {
        const jsonUrl = `https://nanoreview.net/_next/data/${buildId}/en/${contentType}/${slug}.json`;
        try {
            const json = await fetchJsonViaBrowser(jsonUrl);
            const d = extractDevice(json?.pageProps);
            if (d?.name) {
                const result = normalizeDeviceData(d, sourceUrl);
                cache.set('device', cacheKey, result, TTL.device);
                console.log(`[nextjs] /_next/data hit: ${slug}`);
                return result;
            }
        } catch (err) {
            if (/404/.test(err.message)) invalidateBuildId();
            else console.warn(`[nextjs] JSON API failed for ${slug}:`, err.message);
        }
    }

    // Strategy 2: Full page HTML + __NEXT_DATA__
    try {
        const html = await fetchPage(sourceUrl);
        const result = parseNextData(html, sourceUrl);
        if (result?.title) {
            cache.set('device', cacheKey, result, TTL.device);
            console.log(`[nextjs] __NEXT_DATA__ extracted: ${slug}`);
            return result;
        }
        console.warn(`[nextjs] No device data found for ${slug}`);
    } catch (err) {
        console.warn(`[nextjs] HTML fetch failed for ${slug}:`, err.message);
    }

    return null;
}

export async function prefetchBuildId() {
    await getBuildId().catch(() => {});
}
