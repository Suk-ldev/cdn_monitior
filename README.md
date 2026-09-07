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

同一套 `src/` 代码有四个入口，选一个即可。

### EdgeOne Pages（推荐）

仓库已经是 EdgeOne Pages 的目录约定，前端无需编译：

1. EdgeOne Pages 控制台 → 新建项目 → 关联本仓库
2. 框架选「Other」，**根目录保持仓库根目录**，构建命令填 `npm install --omit=dev`（或留空，使用平台的依赖安装步骤），**输出目录填 `public`**
3. 在项目的「环境变量」里填上表里的变量
4. 部署

前端由 Pages 静态托管 `public/`，接口由仓库根目录下的 `cloud-functions/api/[[default]].js` 承载，映射到 `/api/*`。`public` 只是静态输出目录，不是项目根目录；否则平台找不到旁边的 `cloud-functions/`。

函数入口必须先声明 `const app = createApp({ serveStatic: false })`，再写 `export default app`。不要改成 `export default createApp(...)`：EdgeOne 构建器按导出标记识别入口，直接导出工厂调用会被跳过，导致 `/api/*` 全部 404。参见 [Node.js 函数入口规则](https://pages.edgeone.ai/document/node-functions)。

部署后先访问 `/api/health` 和 `/api/meta`，两者不需要云厂商密钥，应返回 JSON。若仍是平台的 404，检查本次部署是否包含 `/api/*` 云函数、部署分支是否为 `master`、提交是否为最新版本。缺少密钥会在 `meta` 中列出缺失变量，相关数据接口返回配置错误，不会让这两个接口变成 404。

### Vercel

`vercel.json` 已配好，直接导入仓库、在 Project Settings 里填环境变量即可。

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
