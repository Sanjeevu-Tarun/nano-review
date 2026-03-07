import { searchAndScrape, scrapeComparePage, scrapeRankingPage, searchDevicesDirect } from './scraper.js';
import { getBrowserContext } from './browser.js';

export const setupRoutes = (fastify) => {

    // Main search: search + scrape in ONE page, ONE navigation
    fastify.get('/api/search', async (req, reply) => {
        const { q, index } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });
        try {
            const { context } = await getBrowserContext();
            const result = await searchAndScrape(context, q, index);
            if (!result) return reply.status(404).send({ success: false, error: 'No devices found' });
            return reply.send({ success: true, contentType: 'device_details', data: result.data });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    // Compare: both searches in parallel, then scrape compare page
    fastify.get('/api/compare', async (req, reply) => {
        const { q1, q2 } = req.query;
        if (!q1 || !q2) return reply.status(400).send({ success: false, error: 'Parameters "q1" and "q2" are required' });
        try {
            const { context } = await getBrowserContext();

            // Both searches fire in parallel from separate pages
            const [r1, r2] = await Promise.all([
                searchAndScrape(context, q1),
                searchAndScrape(context, q2),
            ]);

            if (!r1 || !r2) return reply.status(404).send({ success: false, error: 'One or both devices not found' });

            const item1 = r1.searchResults[0];
            const item2 = r2.searchResults[0];
            const slug1 = item1.slug || item1.url_name;
            const slug2 = item2.slug || item2.url_name;
            const compareUrl = `https://nanoreview.net/en/${item1.type}-compare/${slug1}-vs-${slug2}`;

            const data = await scrapeComparePage(context, compareUrl);
            return reply.send({ success: true, contentType: 'comparison', data });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    fastify.get('/api/suggestions', async (req, reply) => {
        const { q } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: 'Query parameter "q" is required' });
        try {
            const { context } = await getBrowserContext();
            const results = await searchDevicesDirect(context, q, 10);
            const formattedResults = results.map((r, i) => {
                const slug = r.slug || r.url_name || r.name?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                return { index: i, name: r.name, type: r.content_type, slug, url: `https://nanoreview.net/en/${r.content_type}/${slug}` };
            });
            return reply.send({ success: true, contentType: 'suggestions', data: formattedResults });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });

    fastify.get('/api/rankings', async (req, reply) => {
        const { type } = req.query;
        if (!type) return reply.status(400).send({ success: false, error: 'Query parameter "type" is required' });
        const rankingUrls = {
            'desktop-cpu': 'https://nanoreview.net/en/cpu-list/desktop-chips-rating',
            'laptop-cpu': 'https://nanoreview.net/en/cpu-list/laptop-chips-rating',
            'mobile-soc': 'https://nanoreview.net/en/soc-list/rating',
            'desktop-gpu': 'https://nanoreview.net/en/gpu-list/desktop-graphics-rating',
            'laptop-gpu': 'https://nanoreview.net/en/gpu-list/laptop-graphics-rating'
        };
        const targetUrl = rankingUrls[type];
        if (!targetUrl) return reply.status(400).send({ success: false, error: 'Invalid type' });
        try {
            const { context } = await getBrowserContext();
            const data = await scrapeRankingPage(context, targetUrl);
            return reply.send({ success: true, contentType: 'rankings', data });
        } catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });
};