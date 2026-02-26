/**
 * nextjs.js - Next.js /_next/data/ JSON API
 *
 * nanoreview is Next.js. Their device pages expose pure JSON at:
 *   /_next/data/{buildId}/en/{type}/{slug}.json
 *
 * This returns structured device data with no HTML parsing needed.
 * buildId is discovered once from homepage and cached in memory.
 */
import { directFetchHtml } from './http.js';
import { cache, TTL } from './cache.js';

let _buildId = null;
let _buildIdExpiry = 0;

async function fetchBuildId(cookies = '') {
    if (_buildId && Date.now() < _buildIdExpiry) return _buildId;

    const cached = cache.get('meta', 'buildId');
    if (cached) {
        _buildId = cached;
        _buildIdExpiry = Date.now() + 2 * 60 * 60 * 1000;
        return _buildId;
    }

    try {
        const html = await directFetchHtml('https://nanoreview.net/en/', cookies, 6000);
        const m = html.match(/"buildId"\s*:\s*"([^"]+)"/);
        if (m) {
            _buildId = m[1];
            _buildIdExpiry = Date.now() + 2 * 60 * 60 * 1000;
            cache.set('meta', 'buildId', _buildId, 2 * 60 * 60 * 1000);
            console.log('[nextjs] buildId:', _buildId);
            return _buildId;
        }
    } catch (err) {
        console.log('[nextjs] buildId fetch failed:', err.message);
    }
    return null;
}

export async function fetchNextData(contentType, slug, cookies = '') {
    const buildId = await fetchBuildId(cookies);
    if (!buildId) return null;

    const url = `https://nanoreview.net/_next/data/${buildId}/en/${contentType}/${slug}.json`;
    const cacheKey = `next:${contentType}:${slug}`;
    const cached = cache.get('device', cacheKey);
    if (cached) return cached;

    try {
        const text = await directFetchHtml(url, cookies, 5000);
        if (!text || text.trim()[0] !== '{') return null;
        const json = JSON.parse(text);
        const props = json?.pageProps;
        if (!props) return null;
        const d = props?.device || props?.phone || props?.item || props?.data || props?.pageData;
        if (!d?.name) return null;

        const result = {
            title: d.name,
            sourceUrl: `https://nanoreview.net/en/${contentType}/${slug}`,
            images: d.image ? [d.image] : (d.images || []),
            scores: d.scores || d.ratings || {},
            pros: d.pros || d.advantages || [],
            cons: d.cons || d.disadvantages || [],
            specs: d.specs || d.specifications || d.params || {},
            _source: 'next_api',
        };

        cache.set('device', cacheKey, result, TTL.device);
        console.log('[nextjs] hit:', slug);
        return result;
    } catch {
        return null;
    }
}

export async function prefetchBuildId(cookies = '') {
    await fetchBuildId(cookies).catch(() => {});
}
