// Vercel serverless entry. `vercel.json` rewrites /api/* to this handler and
// keeps the full path, which the app already mounts.
import { createApp } from '../src/app.js';

export default createApp({ serveStatic: false });
