/**
 * server.js - FOR RAILWAY / RENDER / VPS deployment
 * 
 * Browser launches ONCE at startup, stays alive forever.
 * After warm-up, every request reuses the same browser context.
 * This is what makes it fast — no per-request Chrome launch.
 *
 * Expected performance:
 * - First request after deploy: ~5-8s (browser launch + CF warm-up)  
 * - All subsequent requests: ~1-3s (browser already running, CF cookies cached)
 * - Cached requests: <100ms
 */
import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';
import { warmUp } from './browser.js';

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
setupRoutes(fastify);

const port = parseInt(process.env.PORT || '3000', 10);
await fastify.listen({ port, host: '0.0.0.0' });
console.log(`\n🚀 Server live: http://localhost:${port}`);
console.log('📋 Endpoints: /api/search?q= | /api/compare?q1=&q2= | /api/suggestions?q= | /api/rankings?type=\n');

// Warm up browser in background — pass CF once so all future requests are fast
warmUp().catch(err => console.warn('[startup] Warm-up failed:', err.message));
