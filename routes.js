import { searchDevices, scrapeDevicePage, scrapeComparePage, scrapeRankingPage } from './scraper.js';
import { acquireContext } from './browser.js';

const withContext = async (fn) => {
    const entry = await acquireContext();
    try { return await fn(entry.context); }
    finally { entry.release(); }
};

export const setupRoutes = (fastify) => {

    fastify.get('/api/search', async (req, reply) => {
        const { q, index } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });
        try {
            return await withContext(async (context) => {
                const results = await searchDevices(context, q, 5);
                if (!results?.length) return reply.status(404).send({ success: false, error: 'No devices found' });

                let item;
                if (index !== undefined) {
                    item = results[Math.min(parseInt(index, 10) || 0, results.length - 1)];
                } else {
                    item = results.find(r => r.name.toLowerCase() === q.toLowerCase()) || results[0];
                }

                const slug = item.slug || item.url_name || item.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                const deviceUrl = `https://nanoreview.net/en/${item.content_type}/${slug}`;

                const data = await scrapeDevicePage(context, deviceUrl);
                data.matchedQuery = q;
                data.searchResults = results.map((r, i) => ({
                    index: i, name: r.name, type: r.content_type, slug: r.slug || r.url_name,
                }));
                return reply.send({ success: true, contentType: 'device_details', data });
            });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    fastify.get('/api/compare', async (req, reply) => {
        const { q1, q2 } = req.query;
        if (!q1 || !q2) return reply.status(400).send({ success: false, error: 'Parameters "q1" and "q2" are required' });
        try {
            return await withContext(async (context) => {
                const [results1, results2] = await Promise.all([
                    searchDevices(context, q1, 3),
                    searchDevices(context, q2, 3),
                ]);
                if (!results1.length || !results2.length)
                    return reply.status(404).send({ success: false, error: 'One or both devices not found' });

                const item1 = results1.find(r => r.name.toLowerCase() === q1.toLowerCase()) || results1[0];
                const item2 = results2.find(r => r.name.toLowerCase() === q2.toLowerCase()) || results2[0];
                const slug1 = item1.slug || item1.url_name || item1.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                const slug2 = item2.slug || item2.url_name || item2.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                const compareUrl = `https://nanoreview.net/en/${item1.content_type}-compare/${slug1}-vs-${slug2}`;
                const data = await scrapeComparePage(context, compareUrl);
                return reply.send({ success: true, contentType: 'comparison', data });
            });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    fastify.get('/api/suggestions', async (req, reply) => {
        const { q } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });
        try {
            return await withContext(async (context) => {
                const results = await searchDevices(context, q, 10);
                const data = results.map((r, i) => {
                    const slug = r.slug || r.url_name || r.url || r.link || r.alias || r.id
                        || r.name?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                    return { index: i, name: r.name, type: r.content_type, slug, url: `https://nanoreview.net/en/${r.content_type}/${slug}`, _raw: r };
                });
                return reply.send({ success: true, contentType: 'suggestions', data });
            });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

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
            return await withContext((ctx) => scrapeRankingPage(ctx, targetUrl));
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });
};
