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

// Warm up browser in background — don't block server startup
warmUp().catch(err => console.warn('[startup] Warm-up failed:', err.message));
