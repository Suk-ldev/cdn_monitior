# CDN 流量分析看板

在一个界面里看 **腾讯云 EdgeOne**、**阿里云 ESA（边缘安全加速）** 和 **Cloudflare** 的流量数据。

三家厂商的指标在后端被归一化成同一套结构，前端不区分平台；某个平台不支持的指标，对应的卡片和板块会直接隐藏，而不是一直显示"加载中"。

## 特性

- 三平台统一指标模型：流量 / 带宽 / 请求数 / 缓存命中 / 回源 / 安全 / 边缘函数 / TOP 分析
- 按平台能力自适应渲染，未配置的平台在切换器里置灰并提示缺哪个环境变量
- 环比（较上一周期）增减、采样率提示、粒度自动降级提示
- 单个上游接口失败只降级成一条提示，不会让整页空白
- 深色 / 浅色 / 跟随系统，中英双语，响应式到手机
- 服务端并发拉取 + TTL 缓存 + 单飞去重，一次刷新只有 3 个前端请求
- 零第三方 SDK：腾讯 TC3 与阿里 ACS3 签名自行实现并与官方 SDK 做了逐字节校验，依赖只剩 `express`
- ECharts 本地内置，不依赖 CDN

## 快速开始

```bash
git clone https://github.com/Suk-ldev/cdn_monitior.git
cd cdn_monitior
npm install
cp .env.example .env   # 填入你要用的平台凭证
npm start              # http://localhost:3000
```

想先看看界面长什么样、手头没有凭证：

```bash
npm run mock   # http://localhost:3210，全部上游接口用假数据
```

## 环境变量

只配置你实际使用的平台即可，其余平台会自动置灰。

| 变量 | 平台 | 说明 |
| --- | --- | --- |
| `EO_SECRET_ID` / `EO_SECRET_KEY` | EdgeOne | [腾讯云访问管理](https://console.cloud.tencent.com/cam/capi) 创建的 API 密钥 |
| `EO_ZONE_IDS` | EdgeOne | 可选，逗号分隔；填了就跳过 `DescribeZones` |
| `EO_REGION` | EdgeOne | 可选，默认 `ap-guangzhou` |
| `ESA_ACCESS_KEY_ID` / `ESA_ACCESS_KEY_SECRET` | 阿里云 ESA | [RAM 访问控制](https://ram.console.aliyun.com/manage/ak)，建议只读子账号 |
| `ESA_SITE_IDS` | 阿里云 ESA | 可选，逗号分隔；填了就跳过 `ListSites` |
| `ESA_REGION` | 阿里云 ESA | 可选，默认 `cn-hangzhou` |
| `CF_TOKENS` | Cloudflare | API Token，需要 `Zone:Read` + `Zone Analytics:Read` |
| `CF_ZONES` | Cloudflare | Zone ID，逗号分隔 |
| `CF_DOMAINS` | Cloudflare | 可选，与 `CF_ZONES` 一一对应的展示名 |
| `SITE_NAME` | 通用 | 页面标题 |
| `DEFAULT_PLATFORM` | 通用 | `edgeone` / `esa` / `cloudflare` |
| `CACHE_TTL` | 通用 | 服务端缓存秒数，默认 60，设 0 关闭 |
| `REQUEST_TIMEOUT` | 通用 | 单个上游请求超时秒数，默认 20 |
| `DEBUG` | 通用 | `true` 时打印上游错误堆栈 |

阿里云权限最小化：给子账号挂 `AliyunESAReadOnlyAccess` 即可，本项目只调用 `ListSites`、`DescribeSiteTimeSeriesData`、`DescribeSiteTopData`、`DescribeSiteWafTimeSeriesData`。

## 部署

这个项目不需要前端构建步骤，`public/` 目录就是最终静态文件。后端 API 由不同平台的函数入口加载同一个 `src/app.js`。

### EdgeOne Pages 部署教程

EdgeOne Pages 推荐按下面的方式创建项目：

1. 打开 EdgeOne Pages 控制台，选择「新建项目」并关联这个仓库。
2. 框架选择「Other」或「其他框架」。
3. 项目根目录保持仓库根目录，不要改成 `public`。
4. 安装命令填写 `npm install --omit=dev`。
5. 构建命令留空；如果控制台必填，可以填一个不会改动文件的命令，例如 `node -e "console.log('no build step')"`。
6. 输出目录填写 `public`。
7. Node.js 版本选择 20 或更高版本；仓库里的 `edgeone.json` 已指定 `20.18.0`。
8. 在「环境变量」里填入你要启用的平台凭证。
9. 保存并部署 `master` 分支。

EdgeOne 的字段可以按这个表核对：

| 控制台字段 | 填写内容 | 说明 |
| --- | --- | --- |
| 框架 | Other / 其他框架 | 项目已经按 EdgeOne 目录约定放好静态文件和函数 |
| 根目录 | 仓库根目录 | 必须能同时看到 `public/`、`cloud-functions/`、`src/` |
| 安装命令 | `npm install --omit=dev` | 只安装运行依赖 |
| 构建命令 | 留空 | 本项目没有打包步骤 |
| 输出目录 | `public` | Pages 静态托管目录 |
| Node.js | 20+ | `edgeone.json` 使用 `20.18.0` |
| 部署分支 | `master` | 当前仓库默认分支 |

`public` 只是静态输出目录。项目根目录如果误填成 `public`，EdgeOne 只能看到前端文件，看不到 `cloud-functions/api/[[default]].js` 和 `src/`，所有 `/api/*` 请求都会变成平台 404。

API 入口在 `cloud-functions/api/[[default]].js`。EdgeOne 会把它映射到 `/api/*`，入口文件里必须保留 `export default app` 这种可被平台识别的导出形式：

```js
import { createApp } from '../../src/app.js';

const app = createApp({ serveStatic: false });

export default app;
```

不要改成 `export default createApp(...)`。EdgeOne 构建器会按源码里的导出标记识别函数入口，直接导出工厂调用可能被跳过，结果就是前端能打开，但 `/api/health`、`/api/meta` 和其它接口全部 404。参见 [EdgeOne Node.js 函数文档](https://pages.edgeone.ai/document/node-functions)。

### EdgeOne 环境变量

只需要配置你实际使用的平台。比如只看腾讯云 EdgeOne，就填：

```text
EO_SECRET_ID=你的 SecretId
EO_SECRET_KEY=你的 SecretKey
EO_ZONE_IDS=可选，多个站点用英文逗号分隔
EO_REGION=ap-guangzhou
SITE_NAME=CDN 流量分析看板
DEFAULT_PLATFORM=edgeone
CACHE_TTL=60
REQUEST_TIMEOUT=20
DEBUG=false
```

如果要同时接入阿里云 ESA 或 Cloudflare，再把 README 上方环境变量表里的对应变量补上。未配置完整的平台会在界面里置灰，不会影响已配置平台使用。

### 部署后验证

部署完成后，先访问这两个地址：

```text
https://你的域名/api/health
https://你的域名/api/meta
```

它们不需要云厂商凭证也应该返回 JSON。正常情况下：

- `/api/health` 返回 `status: "ok"`。
- `/api/meta` 返回站点标题、平台列表、每个平台缺哪些环境变量。
- 如果某个平台缺密钥，页面会提示配置缺失，但 `/api/health` 和 `/api/meta` 不应该是 404。
- 如果 `/api/health` 也是 EdgeOne 平台 404，说明函数没有被部署或路由没有注册。

确认基础接口正常后，再打开首页：

```text
https://你的域名/
```

如果首页能打开但数据为空，优先看 `/api/meta` 里对应平台是否 `ready`，再检查云厂商密钥和站点 ID。

### EdgeOne 404 排查

遇到 404 按这个顺序查：

1. 控制台项目根目录是否是仓库根目录。不要填 `public`。
2. 输出目录是否是 `public`。
3. 安装命令是否是 `npm install --omit=dev`，部署日志里是否安装了 `express`。
4. 本次部署分支是否是 `master`，提交是否包含 `cloud-functions/api/[[default]].js`。
5. 函数入口是否仍然是 `const app = ...` 加 `export default app`。
6. `edgeone.json` 是否包含 `cloudFunctions.nodejs.includeFiles: ["src/**"]`，这样函数能带上 `src/` 代码。
7. 部署日志里是否出现云函数构建或 `/api/*` 路由。如果没有，说明 EdgeOne 没识别函数入口。
8. 浏览器请求的是 `/api/health`，不是 `/health`。本地两种路径都能跑，线上建议统一用 `/api/*`。

### Vercel

`vercel.json` 已配好，导入仓库后在 Project Settings 里填环境变量即可。Vercel 入口是 `api/index.js`。

### Docker

```bash
cp .env.example .env
docker compose up -d      # http://localhost:3000
```

### 裸 Node

```bash
npm install --omit=dev
node server.js            # PORT 可覆盖，默认 3000
```

## 接口

所有接口都挂在 `/api` 下（EdgeOne Pages 会去掉这层前缀，应用同时挂载了两种路径，两边都能跑）。

| 接口 | 说明 |
| --- | --- |
| `GET /api/meta` | 站点名、各平台是否就绪、平台能力、可选时间范围与粒度 |
| `GET /api/sites?platform=` | 站点/Zone 列表 |
| `GET /api/overview?platform=&range=&interval=&siteId=&compare=1` | KPI + 时序数据 + 缓存命中率 |
| `GET /api/top?platform=&metric=traffic\|requests&dimensions=&limit=` | TOP 分析 |
| `GET /api/pages?platform=edgeone` | EdgeOne Pages 用量（仅 EdgeOne） |
| `GET /api/health` | 健康检查与配置自检 |

时间参数二选一：`range`（`1h` / `6h` / `today` / `yesterday` / `3d` / `7d` / `14d` / `31d`，配合 `offset` 传浏览器时区偏移分钟数），或直接给 `start` / `end` 的 ISO 时间。

`interval` 可填 `auto` / `min` / `5min` / `hour` / `day`；超出该跨度上限时会自动升粒度，并在响应里用 `range.intervalAdjusted` 标记。

### 统一指标

响应里的 `series` 用的是与厂商无关的指标名：

```
traffic.total|in|out        bandwidth.total|in|out       requests.total
cache.traffic.hit           cache.requests.hit
origin.traffic.out|in       origin.bandwidth.out|in      origin.requests
security.blocked            perf.responseTime            perf.firstByteTime
functions.requests          functions.cpuTime
```

每条序列形如：

```json
{
  "metric": "traffic.total",
  "unit": "bytes",
  "agg": "sum",
  "points": [[1767225600000, 2439157866]],
  "summary": { "sum": 0, "max": 0, "avg": 0, "last": 0 }
}
```

### 各平台覆盖情况

| 指标 | EdgeOne | ESA | Cloudflare |
| --- | :---: | :---: | :---: |
| 流量 / 请求数 | ✅ | ✅ | ✅ |
| 带宽 | ✅ 原生 | ⚠️ 由流量推算 | ⚠️ 由流量推算 |
| 缓存命中 | ✅ | ✅ | ✅ |
| 回源 | ✅ | ❌ | ❌ |
| 安全命中 | ✅ CC/ACL | ✅ WAF | ⚠️ threats |
| 平均耗时 / 首字节 | ✅ | ❌ | ❌ |
| 边缘函数 | ✅ | ❌ | ❌ |
| TOP 维度数 | 12 | 14 | 4 |
| Pages 用量 | ✅ | ❌ | ❌ |

ESA 没有独立的带宽字段，带宽由 `流量 × 8 ÷ 粒度秒数` 推算，界面上标为峰值；ESA 也不提供回源流量入口，官方建议用缓存状态 `miss` 间接判断。

## 上游接口

| 平台 | 使用的接口 |
| --- | --- |
| EdgeOne | `DescribeZones`、`DescribeTimingL7AnalysisData`、`DescribeTimingL7CacheData`、`DescribeTimingL7OriginPullData`、`DescribeTopL7AnalysisData`、`DescribeWebProtectionData`、`DescribeTimingFunctionAnalysisData`、`DescribePagesResources` |
| 阿里云 ESA | `ListSites`、`DescribeSiteTimeSeriesData`、`DescribeSiteTopData`、`DescribeSiteWafTimeSeriesData` |
| Cloudflare | GraphQL `httpRequests1hGroups` / `httpRequests1dGroups`，细粒度时优先 `httpRequestsAdaptiveGroups` 并在失败时回落 |

## 目录结构

```
src/
  app.js                 Express 应用装配（路由同时挂在 / 和 /api）
  config.js              环境变量解析与平台就绪状态
  routes/api.js          HTTP 层
  providers/
    metrics.js           统一指标词表与序列工具
    edgeone.js           腾讯云 EdgeOne
    esa.js               阿里云 ESA
    cloudflare.js        Cloudflare GraphQL
  lib/
    sign/tencent.js      TC3-HMAC-SHA256
    sign/aliyun.js       ACS3-HMAC-SHA256
    http.js              超时 / 重试 / 有界并发
    cache.js             TTL 缓存 + 单飞
    time.js              时间范围与粒度
public/
  index.html
  assets/                app.js / api.js / charts.js / ui.js / format.js / i18n.js / app.css
  vendor/                echarts.min.js + world.js
cloud-functions/api/[[default]].js  EdgeOne Pages 入口
api/index.js                        Vercel 入口
server.js                           裸 Node 入口
test/                               node:test 用例
scripts/mock-server.mjs             假数据服务，无凭证也能看界面
```

## 测试

```bash
npm test
```

包含签名算法与官方 SDK 的比对向量、三个 provider 的解析用例，以及"上游报错时降级成提示"的回归用例。

## 许可证

MIT

## 致谢

- [Geekertao/cloudflare-monitor](https://github.com/Geekertao/cloudflare-monitor)
- [afoim/eo_monitor](https://github.com/afoim/eo_monitor)
