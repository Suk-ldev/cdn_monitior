import { tencentRequest } from '../lib/sign/tencent.js';
import { settleAll } from '../lib/http.js';
import { combineSeries, emptySeries, makeSeries } from './metrics.js';

const VERSION = '2022-09-01';

const TIMING_L7 = {
  'traffic.total': 'l7Flow_flux',
  'traffic.in': 'l7Flow_inFlux',
  'traffic.out': 'l7Flow_outFlux',
  'bandwidth.total': 'l7Flow_bandwidth',
  'bandwidth.in': 'l7Flow_inBandwidth',
  'bandwidth.out': 'l7Flow_outBandwidth',
  'requests.total': 'l7Flow_request',
  'perf.responseTime': 'l7Flow_avgResponseTime',
  'perf.firstByteTime': 'l7Flow_avgFirstByteResponseTime'
};

const ORIGIN_PULL = {
  'origin.traffic.out': 'l7Flow_outFlux_hy',
  'origin.traffic.in': 'l7Flow_inFlux_hy',
  'origin.bandwidth.out': 'l7Flow_outBandwidth_hy',
  'origin.bandwidth.in': 'l7Flow_inBandwidth_hy',
  'origin.requests': 'l7Flow_request_hy'
};

const SECURITY_METRICS = ['ccAcl_interceptNum', 'ccManage_interceptNum', 'ccRate_interceptNum'];

const FUNCTION_METRICS = {
  'functions.requests': 'function_requestCount',
  'functions.cpuTime': 'function_cpuCostTime'
};

const TOP_DIMENSION_SUFFIX = {
  country: 'country',
  province: 'province',
  statusCode: 'statusCode',
  host: 'domain',
  url: 'url',
  contentType: 'resourceType',
  clientIp: 'sip',
  referer: 'referers',
  device: 'ua_device',
  browser: 'ua_browser',
  os: 'ua_os',
  userAgent: 'ua'
};

function call(ctx, action, params) {
  const { edgeone } = ctx.config;
  return tencentRequest({
    host: edgeone.endpoint,
    action,
    version: VERSION,
    region: edgeone.region,
    params,
    secretId: edgeone.secretId,
    secretKey: edgeone.secretKey,
    timeoutMs: ctx.config.requestTimeoutMs
  });
}

/** Flatten `Data[].TypeValue[]` across zones into one point list per metric name. */
function collectTiming(response) {
  const byMetric = new Map();
  for (const record of response?.Data || []) {
    for (const entry of record?.TypeValue || []) {
      const bucket = byMetric.get(entry.MetricName) || new Map();
      for (const point of entry.Detail || []) {
        const ts = Number(point.Timestamp) * 1000;
        bucket.set(ts, (bucket.get(ts) || 0) + Number(point.Value || 0));
      }
      byMetric.set(entry.MetricName, bucket);
    }
  }
  return byMetric;
}

function seriesFrom(byMetric, vendorName, metric) {
  const bucket = byMetric.get(vendorName);
  if (!bucket) return emptySeries(metric);
  return makeSeries(metric, [...bucket.entries()]);
}

/** Look for the first numeric field matching any of `keys`, at any depth. */
function pickNumber(source, keys, depth = 0) {
  if (!source || typeof source !== 'object' || depth > 3) return null;
  for (const key of keys) {
    const value = source[key];
    if (Number.isFinite(Number(value)) && value !== null && value !== '') return Number(value);
  }
  for (const value of Object.values(source)) {
    const found = pickNumber(value, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function zoneIds(ctx, siteId) {
  if (siteId && siteId !== '*') return [siteId];
  if (ctx.config.edgeone.zoneIds.length) return ctx.config.edgeone.zoneIds;
  return [];
}

async function resolveZoneIds(ctx, siteId) {
  const explicit = zoneIds(ctx, siteId);
  if (explicit.length) return explicit;
  const sites = await edgeone.listSites(ctx);
  return sites.map((site) => site.id);
}

export const edgeone = {
  id: 'edgeone',
  label: 'EdgeOne',
  vendor: '腾讯云',
  docs: 'https://cloud.tencent.com/document/product/1552',
  capabilities: {
    series: [
      ...Object.keys(TIMING_L7),
      ...Object.keys(ORIGIN_PULL),
      ...Object.keys(FUNCTION_METRICS),
      'cache.traffic.hit',
      'cache.requests.hit',
      'security.blocked'
    ],
    top: Object.keys(TOP_DIMENSION_SUFFIX),
    topMetrics: ['traffic', 'requests'],
    pagesStats: true,
    sampling: false
  },

  async listSites(ctx) {
    return ctx.cache.wrap('edgeone:sites', async () => {
      const response = await call(ctx, 'DescribeZones', { Limit: 200 });
      return (response.Zones || []).map((zone) => ({
        id: zone.ZoneId,
        name: zone.ZoneName || zone.AliasZoneName || zone.ZoneId,
        status: zone.Status,
        area: zone.Area
      }));
    }, 5 * 60 * 1000);
  },

  async fetchSeries(ctx, { metrics, range, siteId }) {
    const ZoneIds = await resolveZoneIds(ctx, siteId);
    if (!ZoneIds.length) {
      return { series: {}, notes: [{ level: 'warn', message: '未找到可用的 EdgeOne 站点' }] };
    }

    const base = { StartTime: range.start, EndTime: range.end, ZoneIds, Interval: range.interval };
    const wanted = new Set(metrics);
    const jobs = [];

    const l7Names = Object.entries(TIMING_L7).filter(([id]) => wanted.has(id)).map(([, name]) => name);
    if (l7Names.length) {
      jobs.push({
        key: 'l7',
        run: () => call(ctx, 'DescribeTimingL7AnalysisData', { ...base, MetricNames: l7Names })
      });
    }

    const originNames = Object.entries(ORIGIN_PULL).filter(([id]) => wanted.has(id)).map(([, name]) => name);
    if (originNames.length) {
      jobs.push({
        key: 'origin',
        run: () => call(ctx, 'DescribeTimingL7OriginPullData', { ...base, MetricNames: originNames })
      });
    }

    if (wanted.has('cache.traffic.hit') || wanted.has('cache.requests.hit')) {
      const cacheNames = ['l7Cache_outFlux', 'l7Cache_request'];
      jobs.push({
        key: 'cacheHit',
        run: () => call(ctx, 'DescribeTimingL7CacheData', {
          ...base,
          MetricNames: cacheNames,
          Filters: [{ Key: 'cacheType', Operator: 'equals', Value: ['hit'] }]
        })
      });
      jobs.push({
        key: 'cacheAll',
        run: () => call(ctx, 'DescribeTimingL7CacheData', { ...base, MetricNames: cacheNames })
      });
    }

    if (wanted.has('security.blocked')) {
      jobs.push({
        key: 'security',
        run: () => call(ctx, 'DescribeWebProtectionData', { ...base, MetricNames: SECURITY_METRICS })
      });
    }

    const functionNames = Object.entries(FUNCTION_METRICS).filter(([id]) => wanted.has(id)).map(([, n]) => n);
    if (functionNames.length) {
      jobs.push({
        key: 'functions',
        run: () => call(ctx, 'DescribeTimingFunctionAnalysisData', {
          ...base,
          MetricNames: [...new Set(['function_requestCount', ...functionNames])]
        })
      });
    }

    const results = await settleAll(jobs.map((job) => job.run));
    const buckets = {};
    const notes = [];

    results.forEach((result, index) => {
      const { key } = jobs[index];
      if (result.ok) {
        buckets[key] = collectTiming(result.value);
      } else {
        notes.push({ level: 'error', scope: key, message: result.error.message });
      }
    });

    const series = {};
    const put = (metric, bucketKey, vendorName) => {
      if (!wanted.has(metric)) return;
      series[metric] = buckets[bucketKey]
        ? seriesFrom(buckets[bucketKey], vendorName, metric)
        : emptySeries(metric);
    };

    for (const [metric, vendorName] of Object.entries(TIMING_L7)) put(metric, 'l7', vendorName);
    for (const [metric, vendorName] of Object.entries(ORIGIN_PULL)) put(metric, 'origin', vendorName);
    for (const [metric, vendorName] of Object.entries(FUNCTION_METRICS)) put(metric, 'functions', vendorName);

    if (wanted.has('cache.traffic.hit')) {
      series['cache.traffic.hit'] = buckets.cacheHit
        ? seriesFrom(buckets.cacheHit, 'l7Cache_outFlux', 'cache.traffic.hit')
        : emptySeries('cache.traffic.hit');
      if (buckets.cacheAll) {
        series['cache.traffic.total'] = seriesFrom(buckets.cacheAll, 'l7Cache_outFlux', 'cache.traffic.hit');
      }
    }
    if (wanted.has('cache.requests.hit')) {
      series['cache.requests.hit'] = buckets.cacheHit
        ? seriesFrom(buckets.cacheHit, 'l7Cache_request', 'cache.requests.hit')
        : emptySeries('cache.requests.hit');
      if (buckets.cacheAll) {
        series['cache.requests.total'] = seriesFrom(buckets.cacheAll, 'l7Cache_request', 'cache.requests.hit');
      }
    }

    if (wanted.has('security.blocked')) {
      series['security.blocked'] = buckets.security
        ? combineSeries('security.blocked', SECURITY_METRICS.map((name) =>
            seriesFrom(buckets.security, name, 'security.blocked')))
        : emptySeries('security.blocked');
    }

    return { series, notes };
  },

  async fetchTop(ctx, { dimensions, metric = 'traffic', range, siteId, limit = 10 }) {
    const ZoneIds = await resolveZoneIds(ctx, siteId);
    if (!ZoneIds.length) return { top: {}, notes: [] };

    const prefix = metric === 'requests' ? 'l7Flow_request' : 'l7Flow_outFlux';
    const usable = dimensions.filter((dim) => TOP_DIMENSION_SUFFIX[dim]);

    const results = await settleAll(usable.map((dim) => () => call(ctx, 'DescribeTopL7AnalysisData', {
      StartTime: range.start,
      EndTime: range.end,
      ZoneIds,
      MetricName: `${prefix}_${TOP_DIMENSION_SUFFIX[dim]}`,
      Limit: limit,
      Interval: range.interval
    })));

    const top = {};
    const notes = [];
    results.forEach((result, index) => {
      const dim = usable[index];
      if (!result.ok) {
        notes.push({ level: 'error', scope: `top.${dim}`, message: result.error.message });
        top[dim] = [];
        return;
      }
      const merged = new Map();
      for (const record of result.value?.Data || []) {
        for (const item of record?.DetailData || []) {
          merged.set(item.Key, (merged.get(item.Key) || 0) + Number(item.Value || 0));
        }
      }
      top[dim] = [...merged.entries()]
        .map(([key, value]) => ({ key, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, limit);
    });

    return { top, notes };
  },

  /**
   * EdgeOne Pages usage. The console exposes it through the generic
   * `DescribePagesResources` proxy action, whose payload comes back as a JSON
   * string, so the raw result is passed through alongside a best-effort parse.
   */
  async fetchPagesStats(ctx, { range }) {
    const sites = await edgeone.listSites(ctx).catch(() => []);
    const pagesZone = sites.find((site) => site.name === 'default-pages-zone') || sites[0];
    if (!pagesZone) {
      return { builds: null, functions: null, notes: [{ level: 'warn', scope: 'pages', message: '未找到 Pages 站点' }] };
    }

    const results = await settleAll([
      () => call(ctx, 'DescribePagesResources', {
        Interface: 'pages:DescribePagesDeploymentUsage',
        Payload: '{}',
        ZoneId: pagesZone.id
      }),
      () => call(ctx, 'DescribeTimingFunctionAnalysisData', {
        StartTime: range.start,
        EndTime: range.end,
        Interval: range.interval,
        ZoneIds: [pagesZone.id],
        MetricNames: ['function_requestCount', 'function_cpuCostTime']
      })
    ]);

    const stats = { zoneId: pagesZone.id, builds: null, functions: null, raw: null, notes: [] };

    if (results[0].ok) {
      let parsed = null;
      try {
        parsed = JSON.parse(results[0].value?.Result ?? 'null');
      } catch {
        parsed = null;
      }
      stats.raw = parsed ?? results[0].value ?? null;
      const used = pickNumber(parsed, ['Used', 'UsedCount', 'DeploymentCount', 'BuildCount', 'Count']);
      const quota = pickNumber(parsed, ['Quota', 'Total', 'TotalCount', 'Limit']);
      if (used !== null || quota !== null) stats.builds = { used: used ?? 0, quota: quota ?? 0 };
    } else {
      stats.notes.push({ level: 'warn', scope: 'pages.usage', message: results[0].error.message });
    }

    if (results[1].ok) {
      const byMetric = collectTiming(results[1].value);
      stats.functions = {
        requests: seriesFrom(byMetric, 'function_requestCount', 'functions.requests'),
        cpuTime: seriesFrom(byMetric, 'function_cpuCostTime', 'functions.cpuTime')
      };
    } else {
      stats.notes.push({ level: 'warn', scope: 'pages.functions', message: results[1].error.message });
    }

    return stats;
  }
};
