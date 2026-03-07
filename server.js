import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';
import { warmupCF, isCFReady } from './browser.js';
import { prewarmPopular } from './prewarm.js';
import { cacheStats } from './cache.js';

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: '*' });
setupRoutes(fastify);

fastify.get('/health', async () => ({
    status: 'ok',
    cf_ready: isCFReady(),
    uptime: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    cached: cacheStats().size,
}));

const port = parseInt(process.env.PORT || '3000', 10);
await fastify.listen({ port, host: '0.0.0.0' });
console.log(`Server live on port ${port}`);

// CF warmup first, then prewarm popular devices
warmupCF()
    .then(() => prewarmPopular())
    .catch(e => console.error('[startup error]', e.message));

// Re-solve CF every 5 min
setInterval(() => warmupCF().catch(e => console.error('[rewarm]', e.message)), 5 * 60 * 1000);
