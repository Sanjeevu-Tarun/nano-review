/**
 * worker.js - Background cache warming and refresh
 */
import { cache, TTL } from './cache.js';
import { directSearch, directFetchHtml } from './http.js';
import { scrapeDeviceHtml, scrapeRankingHtml } from './scraper.js';

const POPULAR_QUERIES = [
    { q: 'iPhone 16', type: 'phone' },
    { q: 'iPhone 15', type: 'phone' },
    { q: 'Samsung Galaxy S24', type: 'phone' },
    { q: 'Pixel 9', type: 'phone' },
    { q: 'Snapdragon 8 Gen 3', type: 'soc' },
    { q: 'Apple M3', type: 'soc' },
    { q: 'RTX 4090', type: 'gpu' },
    { q: 'RTX 4070', type: 'gpu' },
    { q: 'Ryzen 9 7950X', type: 'cpu' },
    { q: 'Core i9-14900K', type: 'cpu' },
];

const RANKING_URLS = {
    'desktop-cpu': 'https://nanoreview.net/en/cpu-list/desktop-chips-rating',
    'laptop-cpu': 'https://nanoreview.net/en/cpu-list/laptop-chips-rating',
    'mobile-soc': 'https://nanoreview.net/en/soc-list/rating',
    'desktop-gpu': 'https://nanoreview.net/en/gpu-list/desktop-graphics-rating',
    'laptop-gpu': 'https://nanoreview.net/en/gpu-list/laptop-graphics-rating',
};

async function warmSearchCache(query) {
    const cacheKey = `${query.toLowerCase()}-5`;
    if (cache.get('search', cacheKey)) return;
    try {
        const results = await directSearch(query, 5);
        if (results.length > 0) {
            cache.set('search', cacheKey, results, TTL.search);
            console.log(`[worker] Warmed search: "${query}" (${results.length} results)`);
        }
    } catch (err) {
        console.log(`[worker] Failed to warm search "${query}": ${err.message}`);
    }
}

async function warmDeviceCache(query) {
    const searchKey = `${query.toLowerCase()}-5`;
    let results = cache.get('search', searchKey);
    if (!results) {
        try {
            results = await directSearch(query, 5);
            if (results.length > 0) cache.set('search', searchKey, results, TTL.search);
        } catch { return; }
    }
    if (!results || results.length === 0) return;

    const item = results[0];
    const slug = item.slug || item.url_name || item.name?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${slug}`;
    if (cache.get('device', deviceUrl)) return;

    try {
        const html = await directFetchHtml(deviceUrl);
        const data = scrapeDeviceHtml(html, deviceUrl);
        cache.set('device', deviceUrl, data, TTL.device);
        console.log(`[worker] Warmed device: "${query}" -> ${deviceUrl}`);
    } catch (err) {
        console.log(`[worker] Skipped device warm for "${query}": ${err.message}`);
    }
}

async function warmRankingCache() {
    for (const [type, url] of Object.entries(RANKING_URLS)) {
        if (cache.get('ranking', url)) continue;
        try {
            const html = await directFetchHtml(url, 10000);
            const data = scrapeRankingHtml(html, url);
            if (data.rankings.length > 0) {
                cache.set('ranking', url, data, TTL.ranking);
                console.log(`[worker] Warmed ranking: ${type} (${data.rankings.length} entries)`);
            }
        } catch (err) {
            console.log(`[worker] Failed to warm ranking ${type}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }
}

export async function startWarmup() {
    console.log('[worker] Starting cache warmup...');
    for (const { q } of POPULAR_QUERIES) {
        await warmSearchCache(q);
        await new Promise(r => setTimeout(r, 200));
    }
    await warmRankingCache();
    for (const { q } of POPULAR_QUERIES) {
        await warmDeviceCache(q);
        await new Promise(r => setTimeout(r, 300));
    }
    console.log('[worker] Cache warmup complete');
}

export function startPeriodicRefresh() {
    const timer = setInterval(async () => {
        console.log('[worker] Starting periodic cache refresh...');
        await warmRankingCache();
        for (const { q } of POPULAR_QUERIES.slice(0, 5)) {
            await warmSearchCache(q);
        }
    }, 12 * 60 * 60 * 1000);
    timer.unref();
    return timer;
}
