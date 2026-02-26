/**
 * api/server.js - Vercel serverless entry point
 * Uses app.inject() like GSM Arena API — faster than fastify.server.emit()
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupRoutes } from '../routes.js';

const app = Fastify({ logger: false });

app.register(cors, { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
setupRoutes(app);

let ready = false;

export default async function handler(req, res) {
    if (!ready) {
        await app.ready();
        ready = true;
    }

    const url = req.url || '/';
    const response = await app.inject({
        method: (req.method || 'GET'),
        url,
        headers: req.headers,
    });

    res.writeHead(response.statusCode, response.headers);
    res.end(response.body);
}
