import { searchDevices, scrapeDevicePage, scrapeComparePage, scrapeRankingPage } from './scraper.js';

const RANKING_URLS = {
    'desktop-cpu': 'https://nanoreview.net/en/cpu-list/desktop-chips-rating',
    'laptop-cpu':  'https://nanoreview.net/en/cpu-list/laptop-chips-rating',
    'mobile-soc':  'https://nanoreview.net/en/soc-list/rating',
    'desktop-gpu': 'https://nanoreview.net/en/gpu-list/desktop-graphics-rating',
    'laptop-gpu':  'https://nanoreview.net/en/gpu-list/laptop-graphics-rating',
};

function toDeviceUrl(item) {
    const slug = item.slug || item.url_name || item.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    return `https://nanoreview.net/en/${item.content_type}/${slug}`;
}

export function setupRoutes(fastify) {

    fastify.get('/api/debug', async (req, reply) => {
        const { q = 'iphone 15' } = req.query;
        const results = {};
        try {
            // Search
            const searchRes = await fetch(`https://nanoreview.net/api/search?q=${encodeURIComponent(q)}&limit=2&type=phone`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
                signal: AbortSignal.timeout(8000),
            });
            const searchBody = await searchRes.text();
            let parsedResults = [];
            try { parsedResults = JSON.parse(searchBody); } catch {}
            const first = parsedResults[0];
            const slug = first?.slug || first?.url_name || first?.name?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            results.search = { status: searchRes.status, firstResult: first, generatedSlug: slug };

            // Device page — show raw HTML chunks so we can see the data structure
            if (slug) {
                const pageRes = await fetch(`https://nanoreview.net/en/phone/${slug}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html' },
                    signal: AbortSignal.timeout(8000),
                });
                const html = await pageRes.text();

                // Find data-* attributes and class names used
                const dataAttrs = [...new Set((html.match(/data-[\w-]+="[^"]{1,50}"/g) || []).slice(0, 20))];
                const classNames = [...new Set((html.match(/class="([^"]+)"/g) || []).slice(0, 30))];

                // Find any JSON-like structures in script tags
                const inlineJsons = [];
                const scriptMatches = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
                for (const m of scriptMatches) {
                    const content = m[1].trim();
                    if (content.startsWith('{') || content.startsWith('[')) {
                        inlineJsons.push(content.substring(0, 200));
                    }
                }

                // Show 500 chars from middle of HTML where specs likely are
                const mid = Math.floor(html.length / 2);
                results.devicePage = {
                    status: pageRes.status,
                    length: html.length,
                    isCF: html.includes('Just a moment') || html.includes('cf-browser-verification'),
                    dataAttrs,
                    sampleClassNames: classNames.slice(0, 15),
                    inlineJsons: inlineJsons.slice(0, 3),
                    htmlStart: html.substring(0, 400),
                    htmlMid: html.substring(mid, mid + 600),
                    htmlEnd: html.substring(html.length - 400),
                };
            }
        } catch (e) { results.error = e.message; }
        return reply.send({ success: true, debug: results });
    });

    fastify.get('/api/search', async (req, reply) => {
        const { q, index } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });
        try {
            const results = await searchDevices(null, q, 5);
            if (!results.length) return reply.status(404).send({ success: false, error: 'No devices found. The upstream nanoreview.net search API may be temporarily unavailable or blocking the request.' });
            let item;
            if (index !== undefined) {
                const idx = Math.min(parseInt(index, 10) || 0, results.length - 1);
                item = results[idx];
            } else {
                item = results.find(r => r.name.toLowerCase() === q.toLowerCase()) || results[0];
            }
            const data = await scrapeDevicePage(null, toDeviceUrl(item));
            data.matchedQuery = q;
            data.searchResults = results.map((r, i) => ({
                index: i, name: r.name, type: r.content_type, slug: r.slug || r.url_name,
            }));
            return reply.send({ success: true, contentType: 'device_details', data });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    fastify.get('/api/compare', async (req, reply) => {
        const { q1, q2 } = req.query;
        if (!q1 || !q2) return reply.status(400).send({ success: false, error: 'Parameters "q1" and "q2" are required' });
        try {
            const [results1, results2] = await Promise.all([
                searchDevices(null, q1, 3),
                searchDevices(null, q2, 3),
            ]);
            if (!results1.length || !results2.length) return reply.status(404).send({ success: false, error: 'One or both devices not found' });
            const item1 = results1.find(r => r.name.toLowerCase() === q1.toLowerCase()) || results1[0];
            const item2 = results2.find(r => r.name.toLowerCase() === q2.toLowerCase()) || results2[0];
            const slug1 = item1.slug || item1.url_name || item1.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            const slug2 = item2.slug || item2.url_name || item2.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            const compareUrl = `https://nanoreview.net/en/${item1.content_type}-compare/${slug1}-vs-${slug2}`;
            const data = await scrapeComparePage(null, compareUrl);
            return reply.send({ success: true, contentType: 'comparison', data });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    fastify.get('/api/suggestions', async (req, reply) => {
        const { q } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });
        try {
            const results = await searchDevices(null, q, 10);
            const data = results.map((r, i) => {
                const slug = r.slug || r.url_name || r.name?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                return { index: i, name: r.name, type: r.content_type, slug, url: `https://nanoreview.net/en/${r.content_type}/${slug}` };
            });
            return reply.send({ success: true, contentType: 'suggestions', data });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    fastify.get('/api/rankings', async (req, reply) => {
        const { type } = req.query;
        if (!type) return reply.status(400).send({ success: false, error: 'Query parameter "type" is required' });
        const targetUrl = RANKING_URLS[type];
        if (!targetUrl) return reply.status(400).send({ success: false, error: 'Invalid type' });
        try {
            const data = await scrapeRankingPage(null, targetUrl);
            return reply.send({ success: true, contentType: 'rankings', data });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });
}