import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { loadConfig } from './config.js';
import { createCache } from './lib/cache.js';
import { createApiRouter } from './routes/api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, '../public');

export function createApp({ serveStatic = true } = {}) {
  const config = loadConfig();
  const cache = createCache({ ttlMs: config.cacheTtlMs });
  const ctx = { config, cache };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  });

  const router = createApiRouter(ctx);
  // EdgeOne Pages strips the `cloud-functions/api` prefix before invoking the
  // function, while Node/Vercel/Docker keep the full `/api/...` path.
  app.use('/api', router);
  app.use('/', router);

  if (serveStatic && fs.existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '5m' }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NotFound', message: `未知路径 ${req.path}` } });
  });

  app.use((error, req, res, next) => {
    void next;
    const status = error.statusCode || (error.code === 'PlatformNotConfigured' ? 428 : 502);
    if (config.debug) console.error('[cdn-monitor]', error);
    res.status(status).json({
      error: {
        code: error.code || 'UpstreamError',
        message: error.message || '服务异常',
        requestId: error.requestId
      }
    });
  });

  app.locals.ctx = ctx;
  return app;
}

export default createApp();
