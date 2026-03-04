/**
 * nextjs.js — Next.js JSON data extraction
 *
 * nanoreview.net embeds full device data in <script id="__NEXT_DATA__">.
 * We extract it from raw HTML — no DOM parsing needed.
 *
 * Two strategies:
 * 1. /_next/data/{buildId}/en/{type}/{slug}.json  — pure JSON, fastest
 * 2. Full page HTML + __NEXT_DATA__ regex           — fallback
 */
import { fetchPage } from './browser.js';
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
        if (val && typeof val === 'object' && !Array.isArray(val) && val.name && (val.specs || val.params || val.scores)) {
            return val;
        }
    }
    return null;
}

function parseNextData(html, sourceUrl) {
    if (!html) return null;
    const m = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([^<]+)<\/script>/);
    if (!m) return null;
    try {
        const next = JSON.parse(m[1]);
        const d = extractDevice(next?.props?.pageProps);
        if (!d?.name) return null;
        return normalizeDeviceData(d, sourceUrl);
    } catch { return null; }
}

function normalizeDeviceData(d, sourceUrl) {
    const specs = {};

    if (Array.isArray(d.specs)) {
        for (const group of d.specs) {
            if (group.title && Array.isArray(group.items)) {
                const section = {};
                for (const item of group.items) {
                    if (item.name && item.value != null) section[item.name] = String(item.value);
                }
                if (Object.keys(section).length) specs[group.title] = section;
            } else if (group.name && group.value != null) {
                (specs['Specs'] = specs['Specs'] || {})[group.name] = String(group.value);
            }
        }
    } else if (d.specs && typeof d.specs === 'object') {
        Object.assign(specs, d.specs);
    }

    if (Array.isArray(d.params)) {
        for (const group of d.params) {
            if (group.name && Array.isArray(group.params)) {
                const section = {};
                for (const p of group.params) {
                    if (p.name && p.value != null) section[p.name] = String(p.value);
                }
                if (Object.keys(section).length) specs[group.name] = section;
            }
        }
    } else if (d.params && typeof d.params === 'object') {
        Object.assign(specs, d.params);
    }

    const scores = {};
    if (Array.isArray(d.scores)) {
        for (const s of d.scores) { if (s.name && s.value != null) scores[s.name] = String(s.value); }
    } else if (d.scores && typeof d.scores === 'object') {
        Object.assign(scores, d.scores);
    }
    for (const k of ['total_score', 'score', 'rating', 'nanoreview_score']) {
        if (d[k] != null) scores[k] = String(d[k]);
    }

    const toStr = x => typeof x === 'string' ? x : x?.text || x?.name || '';
    const pros = [...(d.pros || []), ...(d.advantages || [])].map(toStr).filter(Boolean);
    const cons = [...(d.cons || []), ...(d.disadvantages || [])].map(toStr).filter(Boolean);

    const images = [d.image, d.image_url, ...(d.images || [])].filter(Boolean);

    return {
        title: d.name || d.title || '',
        sourceUrl,
        images: [...new Set(images)],
        scores,
        pros: [...new Set(pros)],
        cons: [...new Set(cons)],
        specs,
        _source: 'next_data',
    };
}

export async function fetchDeviceData(contentType, slug, sourceUrl) {
    const cacheKey = `device:${contentType}:${slug}`;
    const cached = cache.get('device', cacheKey);
    if (cached) { console.log(`[nextjs] cache hit: ${slug}`); return cached; }

    // Strategy 1: /_next/data/ JSON (no HTML parsing, fastest)
    const buildId = await getBuildId();
    if (buildId) {
        const jsonUrl = `https://nanoreview.net/_next/data/${buildId}/en/${contentType}/${slug}.json`;
        try {
            const html = await fetchPage(jsonUrl);
            // The page might return JSON directly or embed it
            let json;
            try { json = JSON.parse(html.replace(/<[^>]+>/g, '').trim()); } catch {}
            if (!json) {
                const m = html.match(/\{.*"pageProps".*\}/s);
                if (m) json = JSON.parse(m[0]);
            }
            const d = extractDevice(json?.pageProps);
            if (d?.name) {
                const result = normalizeDeviceData(d, sourceUrl);
                cache.set('device', cacheKey, result, TTL.device);
                console.log(`[nextjs] /_next/data hit: ${slug}`);
                return result;
            }
        } catch (err) {
            if (err.message?.includes('404') || err.message?.includes('HTTP 404')) invalidateBuildId();
            else console.warn(`[nextjs] JSON API failed for ${slug}:`, err.message);
        }
    }

    // Strategy 2: Full page HTML
    try {
        const html = await fetchPage(sourceUrl);
        const result = parseNextData(html, sourceUrl);
        if (result?.title) {
            cache.set('device', cacheKey, result, TTL.device);
            console.log(`[nextjs] __NEXT_DATA__ extracted: ${slug}`);
            return result;
        }
        console.warn(`[nextjs] No device data in HTML for ${slug}`);
    } catch (err) {
        console.warn(`[nextjs] HTML fetch failed for ${slug}:`, err.message);
    }

    return null;
}

export async function prefetchBuildId() {
    await getBuildId().catch(() => {});
}
