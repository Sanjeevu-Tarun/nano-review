import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';
import { warmupCF, getBrowserContext } from './browser.js';
import { prewarmPopular } from './prewarm.js';
import { cacheStats } from './cache.js';

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: '*' });

setupRoutes(fastify);

fastify.get('/health', async () => {
    const cache = cacheStats();
    return {
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        cached_entries: cache.size,
    };
});

const port = parseInt(process.env.PORT || '3000', 10);
await fastify.listen({ port, host: '0.0.0.0' });
console.log(`Server live on port ${port}`);

// Startup sequence: CF warmup → then pre-warm popular devices in background
warmupCF()
    .then(() => getBrowserContext())
    .then(({ context }) => prewarmPopular(context))
    .catch(e => console.error('Startup error:', e.message));

// Re-warm CF every 4 minutes
setInterval(() => {
    warmupCF().catch(e => console.error('Re-warmup error:', e.message));
}, 4 * 60 * 1000);
