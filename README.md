# CDN 流量分析看板

一个支持 Cloudflare 和 EdgeOne 的 CDN 流量分析看板，采用无服务器架构，可部署在 Vercel 或其他平台。

## 功能特性

- 无服务器架构 - 无需后端服务器
- 支持 Cloudflare 和 EdgeOne 双平台
- 实时 CDN 流量数据展示
- 多语言支持（中文/英文）
- 深色/浅色主题切换
- 响应式设计，基于 Tailwind CSS
- 交互式图表，使用 ECharts
- 缓存统计和地域分析
- 时间范围选择（1小时/今日/昨日/3天/7天/14天/31天）
- 粒度选择（1分钟/5分钟/15分钟/30分钟/1小时/4小时/1天）

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/Suk-ldev/cdn_monitior.git
cd cdn_monitior
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

本项目使用环境变量存储敏感信息，如 API 密钥。请在部署平台的控制台中设置以下环境变量：

#### Cloudflare 配置

- `CF_TOKENS`：Cloudflare API Token，多个 Token 用逗号分隔
- `CF_ZONES`：Zone ID，多个 ID 用逗号分隔
- `CF_DOMAINS`：域名，多个域名用逗号分隔（可选）

#### EdgeOne 配置

- `EO_SECRET_ID`：EdgeOne Secret ID
- `EO_SECRET_KEY`：EdgeOne Secret Key

#### 通用配置

- `SITE_NAME`：站点标题（可选）
- `SITE_ICON`：Cloudflare 图标 URL（可选）
- `EO_ICON`：EdgeOne 图标 URL（可选）
- `DEBUG`：调试模式，设置为 `true` 启用（可选）

### 本地开发

如果你需要在本地开发，可以创建一个 `.env` 文件，参考 `.env.example` 的格式，填入你的 API 凭证。但请注意，不要将 `.env` 文件提交到版本控制系统中。

### 4. 获取 Cloudflare API Token

1. 访问 [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
2. 创建新的 API Token，需要以下权限：
   - Account - Analytics - Read
   - Zone - Zone - Read
   - Zone - Analytics - Read
3. 在 Token 权限中包含你的 Zone ID

### 5. 获取 Cloudflare Zone ID

1. 访问你的 Cloudflare Dashboard
2. 选择你的域名
3. Zone ID 显示在右侧边栏

### 6. 获取 EdgeOne API 密钥

1. 访问 [腾讯云访问管理控制台](https://console.cloud.tencent.com/cam/capi)
2. 创建新的 API 密钥
3. 记录 SecretId 和 SecretKey

### 7. 本地开发

启动开发服务器：

```bash
npm run dev
```

在浏览器中打开 `http://localhost:3000`。

## 部署教程

### 方法一：部署到 Vercel

#### 1. 准备工作

确保你已经：
- 将代码推送到 GitHub 仓库
- 拥有 Vercel 账号

#### 2. 导入项目到 Vercel

1. 访问 [Vercel Dashboard](https://vercel.com/dashboard)
2. 点击 "Add New Project"
3. 从 GitHub 导入你的仓库
4. Vercel 会自动检测项目配置

#### 3. 配置环境变量

在 Vercel 项目设置中添加以下环境变量：

**Cloudflare 配置（可选，仅使用 Cloudflare 时需要）：**
```
CF_TOKENS=your_cloudflare_api_token_here
CF_ZONES=your_zone_id_here
CF_DOMAINS=example.com
```

**EdgeOne 配置（可选，仅使用 EdgeOne 时需要）：**
```
EO_SECRET_ID=your_edgeone_secret_id_here
EO_SECRET_KEY=your_edgeone_secret_key_here
```

**通用配置（可选）：**
```
SITE_NAME=CDN站点流量分析
SITE_ICON=https://cloudflare.com/favicon.ico
EO_ICON=https://cloud.tencent.com/favicon.ico
DEBUG=false
```

#### 4. 部署

点击 "Deploy" 按钮，Vercel 会自动构建和部署项目。

部署完成后，你会获得一个 Vercel 域名（如 `your-project.vercel.app`）。


#### 2. 获取 Vercel Token 和 IDs

1. 安装 Vercel CLI：
   ```bash
   npm i -g vercel
   ```

2. 登录 Vercel：
   ```bash
   vercel login
   ```

3. 获取 Token：
   - 访问 [Vercel Tokens](https://vercel.com/account/tokens)
   - 创建新的 Token

4. 获取 Org ID 和 Project ID：
   ```bash
   vercel link
   cat .vercel/project.json
   ```

### 方法三：部署到其他平台

本项目使用无服务器架构，可以部署到任何支持 Node.js 的平台：

- **Netlify**：配置构建命令为 `npm install`，输出目录为 `/`
- **Railway**：直接导入项目，配置环境变量
- **Render**：创建 Web Service，配置环境变量
- **自托管**：使用 `npm start` 启动服务器

## 项目结构

```
cloudflare-monitor-serverless/
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions 部署配置
├── node-functions/
│   └── api/
│       └── [[default]].js       # 无服务器 API 端点
├── index.html                   # 前端 UI
├── package.json                 # 依赖和脚本
├── vercel.json                 # Vercel 配置
├── .env.example                # 环境变量模板
└── README.md                   # 本文件
```

## API 端点

- `GET /api/config` - 获取站点配置
- `GET /api/analytics?period=1day&platform=cloudflare` - 获取分析数据
  - Platform 选项：`cloudflare`, `edgeone`
  - Period 选项：`1day`, `3days`, `7days`, `30days`
- `GET /api/health` - 健康检查

## 环境变量说明

| 变量名 | 说明 | 必需 | 平台 |
|--------|------|------|------|
| `CF_TOKENS` | Cloudflare API Token | 是（Cloudflare） | Cloudflare |
| `CF_ZONES` | Zone ID，逗号分隔 | 是（Cloudflare） | Cloudflare |
| `CF_DOMAINS` | 域名，逗号分隔 | 否 | Cloudflare |
| `EO_SECRET_ID` | EdgeOne Secret ID | 是（EdgeOne） | EdgeOne |
| `EO_SECRET_KEY` | EdgeOne Secret Key | 是（EdgeOne） | EdgeOne |
| `SITE_NAME` | 站点标题 | 否 | 通用 |
| `SITE_ICON` | Cloudflare 图标 URL | 否 | Cloudflare |
| `EO_ICON` | EdgeOne 图标 URL | 否 | EdgeOne |
| `DEBUG` | 调试模式 | 否 | 通用 |

## 功能详情

### 时间范围

- **1 小时**：过去 1 小时的每分钟数据
- **今日**：今天的每小时数据
- **昨日**：昨天的每小时数据
- **3 天**：过去 3 天的每小时数据
- **7 天**：过去 7 天的每小时数据
- **14 天**：过去 14 天的每 4 小时数据
- **31 天**：过去 31 天的每天数据

### 指标说明

- 总请求数
- 总流量（带宽）
- 总拦截威胁数
- 缓存命中率（请求数和带宽）
- 地域统计（前 5 个国家/地区）
- 平均响应时间
- 平均首字节响应时间

### 图表展示

- 请求趋势图
- 流量趋势图
- 威胁拦截趋势图

### 平台切换

- 支持在 Cloudflare 和 EdgeOne 之间切换
- 默认平台设置为 EdgeOne
- 自动适配不同平台的 API 数据格式
- 统一的 UI 界面展示

## 故障排除

### 数据无法加载

1. 检查 API Token 是否有正确的权限
2. 验证 Zone ID 或 Secret ID/Key 是否正确
3. 检查浏览器控制台是否有错误
4. 确保环境变量已正确设置

### Cloudflare API 错误

1. 验证 Cloudflare API Token 是否有效且未过期
2. 检查 Token 是否有访问指定 Zone 的权限
3. 确保 Token 有 Analytics:Read 权限

### EdgeOne API 错误

1. 验证 EdgeOne Secret ID 和 Secret Key 是否正确
2. 检查密钥是否有足够的权限
3. 确保密钥未过期

### 平台切换问题

1. 检查两个平台的 API 凭证是否都配置正确
2. 查看浏览器控制台的网络请求
3. 确认后端 API 端点正常工作

## 开发指南

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build
```

### 代码结构

- `index.html`：前端页面，包含所有 UI 和交互逻辑
- `node-functions/api/[[default]].js`：后端 API，处理数据请求
- `vercel.json`：Vercel 部署配置

### 添加新功能

1. 在 `index.html` 中添加 UI 元素
2. 在 `node-functions/api/[[default]].js` 中添加 API 端点
3. 更新环境变量配置
4. 测试并提交代码

## 许可证

MIT License

## 致谢

基于 [Cloudflare Monitor](https://github.com/Geekertao/Cloudflare-monitor) 项目开发

## 相关链接

- [CDN 监控仓库](https://github.com/Suk-ldev/cdn_monitior) - 本项目
- [EdgeOne 监控仓库](https://github.com/afoim/eo_monitor/)
- [Cloudflare 监控仓库](https://github.com/Geekertao/cloudflare-monitor) - 同文件夹下的 Cloudflare 监控项目
- [Cloudflare API 文档](https://developers.cloudflare.com/api/)
- [EdgeOne API 文档](https://cloud.tencent.com/document/product/1552)
- [Vercel 文档](https://vercel.com/docs)

## 贡献

欢迎提交 Issue 和 Pull Request！

## 更新日志

### v2.1.0
- 默认平台设置为 EdgeOne
- 时间范围默认值修改为"今日"
- 删除时间范围中的30分钟、6小时和自定义选项
- 粒度选择器删除"自动"选项，默认设为"1分钟"
- 删除站点选择功能，使用默认站点
- 删除请求与性能中的总请求数部分
- 修复 EdgeOne 回源分析数据不返回的问题
- 优化环境变量配置，敏感信息通过环境变量管理

### v2.0.0
- 添加 EdgeOne 平台支持
- 添加平台切换功能
- 优化 UI 界面
- 添加中文本地化

### v1.0.0
- 初始版本
- 支持 Cloudflare 平台
- 基础流量分析功能
