import { searchAndScrape, searchSuggestions, scrapeComparePage, scrapeRankingPage } from './scraper.js';

export const setupRoutes = (fastify) => {
    fastify.get('/api/search', async (req, reply) => {
        const { q, index } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: '"q" required' });
        try {
            const result = await searchAndScrape(q, index);
            if (!result) return reply.status(404).send({ success: false, error: 'No devices found' });
            return reply.send({ success: true, contentType: 'device_details', data: result.data });
        } catch (e) {
            return reply.status(500).send({ success: false, error: e.message });
        }
    });

    fastify.get('/api/compare', async (req, reply) => {
        const { q1, q2 } = req.query;
        if (!q1 || !q2) return reply.status(400).send({ success: false, error: '"q1" and "q2" required' });
        try {
            const [r1, r2] = await Promise.all([searchAndScrape(q1), searchAndScrape(q2)]);
            if (!r1 || !r2) return reply.status(404).send({ success: false, error: 'Device not found' });
            const s1 = r1.searchResults[0], s2 = r2.searchResults[0];
            const compareUrl = `https://nanoreview.net/en/${s1.content_type}-compare/${s1.slug||s1.url_name}-vs-${s2.slug||s2.url_name}`;
            const data = await scrapeComparePage(compareUrl);
            return reply.send({ success: true, contentType: 'comparison', data });
        } catch (e) {
            return reply.status(500).send({ success: false, error: e.message });
        }
    });

    fastify.get('/api/suggestions', async (req, reply) => {
        const { q } = req.query;
        if (!q) return reply.status(400).send({ success: false, error: '"q" required' });
        try {
            const results = await searchSuggestions(q);
            return reply.send({ success: true, data: results.map((r, i) => ({
                index: i, name: r.name, type: r.content_type,
                slug: r.slug || r.url_name,
                url: `https://nanoreview.net/en/${r.content_type}/${r.slug||r.url_name}`
            }))});
        } catch (e) {
            return reply.status(500).send({ success: false, error: e.message });
        }
    });

    fastify.get('/api/rankings', async (req, reply) => {
        const { type } = req.query;
        const urls = {
            'desktop-cpu': 'https://nanoreview.net/en/cpu-list/desktop-chips-rating',
            'laptop-cpu': 'https://nanoreview.net/en/cpu-list/laptop-chips-rating',
            'mobile-soc': 'https://nanoreview.net/en/soc-list/rating',
            'desktop-gpu': 'https://nanoreview.net/en/gpu-list/desktop-graphics-rating',
            'laptop-gpu': 'https://nanoreview.net/en/gpu-list/laptop-graphics-rating',
        };
        if (!urls[type]) return reply.status(400).send({ success: false, error: 'Invalid type' });
        try {
            return reply.send({ success: true, data: await scrapeRankingPage(urls[type]) });
        } catch (e) {
            return reply.status(500).send({ success: false, error: e.message });
        }
    });
};
