/**
 * nextjs.js — Next.js data extraction layer
 *
 * nanoreview.net is a Next.js SSR app. Every device page embeds the FULL
 * device data as JSON in a <script id="__NEXT_DATA__"> tag — so we never
 * need to parse HTML with cheerio for device details.
 *
 * THREE strategies, tried in order:
 *
 * 1. /_next/data/{buildId}/en/{type}/{slug}.json  — pure JSON API, fastest
 * 2. Full page HTML + extract __NEXT_DATA__        — robust fallback
 * 3. Direct HTML page fetch with broad key search  — last resort
 */
import { fetchHtml, fetchJson, getCFCookies } from './tls.js';
import { cache, TTL } from './cache.js';

let _buildId = null;
let _buildIdExpiry = 0;

// ── buildId discovery ─────────────────────────────────────────────────────

async function getBuildId() {
    if (_buildId && Date.now() < _buildIdExpiry) return _buildId;

    const cached = cache.get('meta', 'buildId');
    if (cached) {
        _buildId = cached;
        _buildIdExpiry = Date.now() + 2 * 60 * 60 * 1000;
        return _buildId;
    }

    try {
        const html = await fetchHtml('https://nanoreview.net/en/', {
            cookies: getCFCookies(),
            timeout: 10,
        });
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

// ── __NEXT_DATA__ parser ──────────────────────────────────────────────────

const DEVICE_KEYS = ['device', 'phone', 'laptop', 'cpu', 'gpu', 'soc', 'tablet', 'item', 'data', 'pageData'];

function extractDevice(props) {
    if (!props) return null;
    for (const key of DEVICE_KEYS) {
        if (props[key]?.name) return props[key];
    }
    // Deep search — sometimes nested under a wrapper
    for (const key of Object.keys(props)) {
        const val = props[key];
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
        const props = next?.props?.pageProps;
        if (!props) return null;

        const d = extractDevice(props);
        if (!d?.name) return null;

        return normalizeDeviceData(d, sourceUrl);
    } catch {
        return null;
    }
}

function normalizeDeviceData(d, sourceUrl) {
    const specs = {};

    if (d.specs && typeof d.specs === 'object') {
        if (Array.isArray(d.specs)) {
            for (const group of d.specs) {
                if (group.title && Array.isArray(group.items)) {
                    const section = {};
                    for (const item of group.items) {
                        if (item.name && item.value != null) {
                            section[item.name] = String(item.value);
                        }
                    }
                    if (Object.keys(section).length) specs[group.title] = section;
                } else if (group.name && group.value != null) {
                    specs['Specs'] = specs['Specs'] || {};
                    specs['Specs'][group.name] = String(group.value);
                }
            }
        } else {
            Object.assign(specs, d.specs);
        }
    }

    if (d.params && typeof d.params === 'object') {
        if (Array.isArray(d.params)) {
            for (const group of d.params) {
                if (group.name && Array.isArray(group.params)) {
                    const section = {};
                    for (const p of group.params) {
                        if (p.name && p.value != null) {
                            section[p.name] = String(p.value);
                        }
                    }
                    if (Object.keys(section).length) specs[group.name] = section;
                }
            }
        } else {
            Object.assign(specs, d.params);
        }
    }

    const scores = {};
    if (d.scores && typeof d.scores === 'object') {
        if (Array.isArray(d.scores)) {
            for (const s of d.scores) {
                if (s.name && s.value != null) scores[s.name] = String(s.value);
            }
        } else {
            Object.assign(scores, d.scores);
        }
    }
    for (const key of ['total_score', 'score', 'rating', 'nanoreview_score']) {
        if (d[key] != null) scores[key] = String(d[key]);
    }

    const pros = Array.isArray(d.pros) ? d.pros.map(p => typeof p === 'string' ? p : p.text || p.name || '') : [];
    const cons = Array.isArray(d.cons) ? d.cons.map(c => typeof c === 'string' ? c : c.text || c.name || '') : [];
    const advantages = Array.isArray(d.advantages) ? d.advantages.map(p => typeof p === 'string' ? p : p.text || p.name || '') : [];
    const disadvantages = Array.isArray(d.disadvantages) ? d.disadvantages.map(c => typeof c === 'string' ? c : c.text || c.name || '') : [];

    const images = [];
    if (d.image) images.push(d.image);
    if (d.image_url) images.push(d.image_url);
    if (Array.isArray(d.images)) images.push(...d.images);

    return {
        title: d.name || d.title || '',
        sourceUrl,
        images: [...new Set(images.filter(Boolean))],
        scores,
        pros: [...new Set([...pros, ...advantages].filter(Boolean))],
        cons: [...new Set([...cons, ...disadvantages].filter(Boolean))],
        specs,
        _source: 'next_data',
    };
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * fetchDeviceData — returns structured device data for type+slug.
 *
 * 1. Memory/disk cache  → <1ms
 * 2. /_next/data/ JSON  → ~100-200ms (fastest)
 * 3. Full page HTML + __NEXT_DATA__ → ~200-500ms
 */
export async function fetchDeviceData(contentType, slug, sourceUrl) {
    const cacheKey = `device:${contentType}:${slug}`;
    const cached = cache.get('device', cacheKey);
    if (cached) {
        console.log(`[nextjs] cache hit: ${slug}`);
        return cached;
    }

    const cookies = getCFCookies();

    // ── Strategy 1: /_next/data/ JSON endpoint
    const buildId = await getBuildId();
    if (buildId) {
        const jsonUrl = `https://nanoreview.net/_next/data/${buildId}/en/${contentType}/${slug}.json`;
        try {
            const json = await fetchJson(jsonUrl, { cookies, timeout: 8 });
            const props = json?.pageProps;
            const d = extractDevice(props);

            if (d?.name) {
                const result = normalizeDeviceData(d, sourceUrl);
                cache.set('device', cacheKey, result, TTL.device);
                console.log(`[nextjs] /_next/data hit: ${slug}`);
                return result;
            }
        } catch (err) {
            if (err.message?.includes('404') || err.message?.includes('HTTP 404')) {
                console.log('[nextjs] buildId stale, invalidating...');
                invalidateBuildId();
            } else {
                console.warn(`[nextjs] JSON API failed for ${slug}:`, err.message);
            }
        }
    }

    // ── Strategy 2: Full page HTML + __NEXT_DATA__
    try {
        const html = await fetchHtml(sourceUrl, { cookies, timeout: 12 });
        const result = parseNextData(html, sourceUrl);
        if (result?.title) {
            cache.set('device', cacheKey, result, TTL.device);
            console.log(`[nextjs] __NEXT_DATA__ extracted: ${slug}`);
            return result;
        }
        console.warn(`[nextjs] No device data in HTML for ${slug} (url: ${sourceUrl})`);
    } catch (err) {
        console.warn(`[nextjs] HTML fetch failed for ${slug}:`, err.message);
    }

    return null;
}

/** Pre-warm the buildId (call on startup) */
export async function prefetchBuildId() {
    await getBuildId().catch(() => {});
}
