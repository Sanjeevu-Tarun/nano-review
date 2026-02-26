import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';
import { warmUp, getPersistentContext, getCFCookies, browserFetchDirect } from './browser.js';

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
setupRoutes(fastify);

const port = parseInt(process.env.PORT || '3000', 10);
await fastify.listen({ port, host: '0.0.0.0' });
console.log(`\n🚀 Server live: http://localhost:${port}`);

// Warm up browser immediately — don't block server startup
warmUp().catch(err => console.warn('[startup] Warm-up failed:', err.message));

// Refresh CF cookies every 20 minutes to keep direct HTTP working
// This prevents the costly "CF blocked → fall back to browser" scenario
setInterval(async () => {
    const cookies = await getCFCookies();
    if (!cookies) return; // No cookies yet, warmup still in progress
    console.log('[keepalive] Refreshing CF cookies...');
    try {
        // Quick lightweight page fetch to refresh CF session
        await browserFetchDirect('https://nanoreview.net/en/');
        console.log('[keepalive] CF cookies refreshed');
    } catch (err) {
        console.warn('[keepalive] Refresh failed:', err.message);
    }
}, 20 * 60 * 1000).unref();
