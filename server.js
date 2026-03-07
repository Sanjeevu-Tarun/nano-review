import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';
import { warmupCF } from './browser.js';

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: '*' });

setupRoutes(fastify);

fastify.get('/health', async () => ({ status: 'ok' }));

const port = parseInt(process.env.PORT || '3000', 10);
await fastify.listen({ port, host: '0.0.0.0' });
console.log(`Server live on port ${port}`);

// Warm up CF in background — don't block server startup
warmupCF().catch(e => console.error('Warmup error:', e.message));
