import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from './routes.js';

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: '*' });
setupRoutes(fastify);
await fastify.listen({ port: parseInt(process.env.PORT||'3000'), host: '0.0.0.0' });
console.log('Server running on port 3000');
