import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';
import { warmupCF, getBrowserContext } from './browser.js';

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: '*' });

setupRoutes(fastify);

// Health endpoint — also refreshes CF context so it stays warm
fastify.get('/health', async () => {
    const { context } = await getBrowserContext().catch(() => ({ context: null }));
    return {
        status: 'ok',
        cf_ready: context !== null,
        uptime: Math.floor(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
});

const port = parseInt(process.env.PORT || '3000', 10);
await fastify.listen({ port, host: '0.0.0.0' });
console.log(`Server live on port ${port}`);

// Warm up CF immediately on startup
warmupCF().catch(e => console.error('Warmup error:', e.message));

// Re-warm CF every 4 minutes to keep context fresh
setInterval(() => {
    warmupCF().catch(e => console.error('Re-warmup error:', e.message));
}, 4 * 60 * 1000);
