// EdgeOne Pages 函数入口。平台会剥掉 `/api` 前缀后直接调用导出的 Express 实例，
// 这里不需要 listen。src/app.js 同时把路由挂在 `/` 和 `/api`，两种调用方式都能命中。
import { createApp } from '../../src/app.js';

export default createApp({ serveStatic: false });
