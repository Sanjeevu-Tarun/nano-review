import { searchDevices, scrapeDevicePage, scrapeComparePage, scrapeRankingPage } from './scraper.js';
import { acquireContext } from './browser.js';

// Only used for routes that actually need a browser (scraping pages)
const withContext = async (fn) => {
    const entry = await acquireContext();
    try {
        return await fn(entry.context);
    } finally {
        entry.release();
    }
};

export const setupRoutes = (fastify) => {

    // ── /api/debug ────────────────────────────────────────────────────────────
    // Tests direct Node fetch — no browser involved
    fastify.get('/api/debug', async (req, reply) => {
        const { q } = req.query;
        if (!q) return reply.status(400).send({ error: 'q required' });
        try {
            const allTypes = ['phone', 'tablet', 'laptop', 'soc', 'cpu', 'gpu'];
            const typeResults = {};
            await Promise.all(allTypes.map(async (type) => {
                try {
                    const url = `https://nanoreview.net/api/search?q=${encodeURIComponent(q)}&limit=3&type=${type}`;
                    const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
                    const text = await r.text();
                    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 200); }
                    typeResults[type] = { status: r.status, count: Array.isArray(parsed) ? parsed.length : 'n/a', data: parsed };
                } catch (e) { typeResults[type] = { error: e.message }; }
            }));
            return reply.send({ query: q, typeResults });
        } catch (err) { return reply.status(500).send({ error: err.message }); }
    });

    // ── /api/search ───────────────────────────────────────────────────────────
    // Step 1: searchDevices = plain Node fetch, NO browser needed
    // Step 2: scrapeDevicePage = needs browser for JS rendering
    fastify.get('/api/search', async (req, reply) => {
        const { q, index } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });

        try {
            const results = await searchDevices(null, q, 5);
            if (!results || results.length === 0)
                return reply.status(404).send({ success: false, error: 'No devices found' });

            let item;
            if (index !== undefined) {
                const idx = Math.min(parseInt(index, 10) || 0, results.length - 1);
                item = results[idx];
            } else {
                item = results.find(r => r.name.toLowerCase() === q.toLowerCase()) || results[0];
            }

            const slug = item.slug || item.url_name || item.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${slug}`;

            const data = await withContext((ctx) => scrapeDevicePage(ctx, deviceUrl));
            data.matchedQuery = q;
            data.searchResults = results.map((r, i) => ({
                index: i, name: r.name, type: r.content_type, slug: r.slug || r.url_name,
            }));

            return reply.send({ success: true, contentType: 'device_details', data });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    // ── /api/compare ──────────────────────────────────────────────────────────
    fastify.get('/api/compare', async (req, reply) => {
        const { q1, q2 } = req.query;
        if (!q1 || !q2) return reply.status(400).send({ success: false, error: 'Parameters "q1" and "q2" are required' });

        try {
            const [results1, results2] = await Promise.all([
                searchDevices(null, q1, 3),
                searchDevices(null, q2, 3),
            ]);

            if (!results1.length || !results2.length)
                return reply.status(404).send({ success: false, error: 'One or both devices not found' });

            const item1 = results1.find(r => r.name.toLowerCase() === q1.toLowerCase()) || results1[0];
            const item2 = results2.find(r => r.name.toLowerCase() === q2.toLowerCase()) || results2[0];

            const slug1 = item1.slug || item1.url_name || item1.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            const slug2 = item2.slug || item2.url_name || item2.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

            const compareUrl = `https://nanoreview.net/en/${item1.content_type}-compare/${slug1}-vs-${slug2}`;
            const data = await withContext((ctx) => scrapeComparePage(ctx, compareUrl));
            return reply.send({ success: true, contentType: 'comparison', data });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    // ── /api/suggestions ──────────────────────────────────────────────────────
    // Pure search — no browser at all
    fastify.get('/api/suggestions', async (req, reply) => {
        const { q } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });

        try {
            const results = await searchDevices(null, q, 10);
            const formattedResults = results.map((r, i) => {
                const slug = r.slug || r.url_name || r.url || r.link || r.alias || r.id
                    || r.name?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                return { index: i, name: r.name, type: r.content_type, slug, url: `https://nanoreview.net/en/${r.content_type}/${slug}`, _raw: r };
            });
            return reply.send({ success: true, contentType: 'suggestions', data: formattedResults });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    // ── /api/rankings ─────────────────────────────────────────────────────────
    fastify.get('/api/rankings', async (req, reply) => {
        const { type } = req.query;
        if (!type) return reply.status(400).send({ success: false, error: 'Query parameter "type" is required' });

        const rankingUrls = {
            'desktop-cpu': 'https://nanoreview.net/en/cpu-list/desktop-chips-rating',
            'laptop-cpu':  'https://nanoreview.net/en/cpu-list/laptop-chips-rating',
            'mobile-soc':  'https://nanoreview.net/en/soc-list/rating',
            'desktop-gpu': 'https://nanoreview.net/en/gpu-list/desktop-graphics-rating',
            'laptop-gpu':  'https://nanoreview.net/en/gpu-list/laptop-graphics-rating',
        };

        const targetUrl = rankingUrls[type];
        if (!targetUrl) return reply.status(400).send({ success: false, error: 'Invalid type' });

        try {
            const data = await withContext((ctx) => scrapeRankingPage(ctx, targetUrl));
            return reply.send({ success: true, contentType: 'rankings', data });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });
};
