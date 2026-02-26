/**
 * api/server.js - Vercel handler
 * NOTE: On Vercel this will still be slow (~15-30s) because each request
 * launches a new Chrome. For fast responses, deploy on Railway/Render instead.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from '../routes.js';

const app = Fastify({ logger: false });
app.register(cors, { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
setupRoutes(app);

let ready = false;
export default async function handler(req, res) {
    if (!ready) { await app.ready(); ready = true; }
    const response = await app.inject({ method: req.method || 'GET', url: req.url || '/', headers: req.headers });
    res.writeHead(response.statusCode, response.headers);
    res.end(response.body);
}
