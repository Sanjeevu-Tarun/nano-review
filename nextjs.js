/**
 * nextjs.js - Exploit Next.js /_next/data/ JSON API
 *
 * Next.js SSR sites expose their page data as pure JSON at:
 *   /_next/data/{buildId}/{path}.json
 *
 * This gives us structured device data with NO browser and NO HTML parsing.
 * We discover the buildId once from the homepage HTML, then cache it.
 *
 * Example: GET /_next/data/abc123/en/phone/apple-iphone-15.json
 * Returns: { pageProps: { device: { name, specs, scores, ... } } }
 */
import { directFetchHtml } from './http.js';
import { cache, TTL } from './cache.js';

let _buildId = null;
let _buildIdExpiry = 0;

/**
 * Extract Next.js buildId from homepage HTML.
 * The buildId is embedded in a <script id="__NEXT_DATA__"> tag.
 */
async function fetchBuildId(cookies = '') {
    if (_buildId && Date.now() < _buildIdExpiry) return _buildId;

    // Check cache
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
            _buildIdExpiry = Date.now() + 2 * 60 * 60 * 1000; // 2h
            cache.set('meta', 'buildId', _buildId, 2 * 60 * 60 * 1000);
            console.log('[nextjs] buildId:', _buildId);
            return _buildId;
        }
    } catch (err) {
        console.log('[nextjs] buildId fetch failed:', err.message);
    }
    return null;
}

/**
 * Fetch device data via Next.js data API — pure JSON, no HTML, no browser.
 * Returns parsed pageProps or null if unavailable.
 */
export async function fetchNextData(contentType, slug, cookies = '') {
    const buildId = await fetchBuildId(cookies);
    if (!buildId) return null;

    const url = `https://nanoreview.net/_next/data/${buildId}/en/${contentType}/${slug}.json`;
    const cacheKey = `next:${contentType}:${slug}`;
    const cached = cache.get('device', cacheKey);
    if (cached) return cached;

    try {
        const html = await directFetchHtml(url, cookies, 5000);
        if (!html) return null;
        // CF returns HTML on block — check it's actually JSON
        if (html.trim()[0] !== '{') return null;
        const json = JSON.parse(html);
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
        console.log('[nextjs] API hit:', url);
        return result;
    } catch (err) {
        console.log('[nextjs] API miss:', err.message);
        return null;
    }
}

/**
 * Prefetch and cache buildId at startup so it's ready before first request.
 */
export async function prefetchBuildId(cookies = '') {
    try {
        await fetchBuildId(cookies);
    } catch {}
}
