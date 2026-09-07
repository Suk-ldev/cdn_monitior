// EdgeOne Pages Node Functions entry. The platform strips the `/api` prefix and
// invokes the exported Express app directly, so no listener is started here.
// If your EdgeOne project uses the newer `cloud-functions/` convention, copy this
// file to `cloud-functions/api/[[default]].js` — the content is identical.
import { createApp } from '../../src/app.js';

export default createApp({ serveStatic: false });
