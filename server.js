import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';
import { warmupBrowser, destroyBrowser } from './browser.js';
import { prefetchBuildId } from './nextjs.js';

const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

await fastify.register(cors, { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });

setupRoutes(fastify);

const port = parseInt(process.env.PORT || '3000', 10);
await fastify.listen({ port, host: '0.0.0.0' });
console.log(`\n🚀 NanoReview API v5 (Playwright) on port ${port}\n`);

// Warm up browser + buildId in background
(async () => {
    try {
        await warmupBrowser();
        await prefetchBuildId();
        console.log('[startup] Browser warm + buildId ready ✅');
    } catch (err) {
        console.warn('[startup] Warm-up error:', err.message);
    }
})();

process.on('SIGTERM', async () => { await destroyBrowser(); process.exit(0); });
