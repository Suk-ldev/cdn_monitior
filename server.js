import 'dotenv/config';
import { createApp } from './src/app.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const app = createApp({ serveStatic: true });

app.listen(port, () => {
  console.log(`CDN 监控看板已启动: http://localhost:${port}`);
});
