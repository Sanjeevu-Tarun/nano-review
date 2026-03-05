import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from '../routes.js';

// Build the app once, reuse across invocations
const app = Fastify({ logger: false });
await app.register(cors, { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
setupRoutes(app);
await app.ready();

export default async function handler(req, res) {
    app.server.emit('request', req, res);
}
