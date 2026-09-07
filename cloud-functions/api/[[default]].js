// EdgeOne 按源码中的导出识别函数入口，必须保留 `export default app`。
// 直接导出 createApp(...) 会被当成辅助模块跳过，不生成 /api/* 路由。
import { createApp } from '../../src/app.js';

const app = createApp({ serveStatic: false });

export default app;
