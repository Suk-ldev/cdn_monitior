import { aliyunRequest } from '../lib/sign/aliyun.js';
import { settleAll } from '../lib/http.js';
import { combineSeries, emptySeries, makeSeries, trafficToBandwidth } from './metrics.js';

const VERSION = '2024-09-10';

/**
 * ESA exposes four traffic fields. Everything else on the dashboard is derived
 * from them (total traffic, bandwidth) or comes from the WAF analytics APIs.
 */
const FIELD_TRAFFIC_OUT = 'Traffic';
const FIELD_TRAFFIC_IN = 'RequestTraffic';
const FIELD_REQUESTS = 'Requests';

const TOP_DIMENSION = {
  country: 'ClientCountryCode',
  province: 'ClientProvinceCode',
  statusCode: 'EdgeResponseStatusCode',
  host: 'ClientRequestHost',
  url: 'ClientRequestPath',
  contentType: 'EdgeResponseContentType',
  clientIp: 'ClientIP',
  referer: 'ClientRequestReferer',
  device: 'ClientDevice',
  browser: 'ClientBrowser',
  os: 'ClientOS',
  userAgent: 'ClientRequestUserAgent',
  cacheStatus: 'EdgeCacheStatus',
  isp: 'ClientISP'
};

// DescribeSiteTopData only accepts these Limit values.
const ALLOWED_LIMITS = [5, 10, 150];

function call(ctx, action, query, method = 'POST') {
  const { esa } = ctx.config;
  return aliyunRequest({
    endpoint: esa.endpoint,
    action,
    version: VERSION,
    method,
    query,
    accessKeyId: esa.accessKeyId,
    accessKeySecret: esa.accessKeySecret,
    securityToken: esa.securityToken,
    timeoutMs: ctx.config.requestTimeoutMs
  });
}

function fieldsParam(fields) {
  return JSON.stringify(fields.map(({ fieldName, dimension = ['ALL'] }) => ({
    Dimension: dimension,
    FieldName: fieldName
  })));
}

function isCacheHit(value) {
  return /^hit/i.test(String(value || ''));
}

/** Group `Data[]` entries by field name, keeping the dimension value on each. */
function groupByField(response) {
  const grouped = new Map();
  for (const entry of response?.Data || []) {
    const list = grouped.get(entry.FieldName) || [];
    list.push({
      dimensionValue: entry.DimensionValue ?? 'ALL',
      points: (entry.DetailData || []).map((point) => [
        Date.parse(point.TimeStamp),
        Number(point.Value || 0)
      ])
    });
    grouped.set(entry.FieldName, list);
  }
  return grouped;
}

function seriesFor(grouped, fieldName, metric, filter) {
  const entries = grouped.get(fieldName);
  if (!entries?.length) return emptySeries(metric);

  const selected = filter ? entries.filter((entry) => filter(entry.dimensionValue)) : entries;
  if (!selected.length) return emptySeries(metric);

  const merged = new Map();
  for (const entry of selected) {
    for (const [ts, value] of entry.points) {
      if (!Number.isFinite(ts)) continue;
      merged.set(ts, (merged.get(ts) || 0) + value);
    }
  }
  return makeSeries(metric, [...merged.entries()]);
}

function siteIdOf(ctx, siteId) {
  if (siteId && siteId !== '*') return siteId;
  return ctx.config.esa.siteIds[0] || '';
}

export const esa = {
  id: 'esa',
  label: 'ESA',
  vendor: '阿里云',
  docs: 'https://help.aliyun.com/zh/edge-security-acceleration/esa/api-esa-2024-09-10-overview',
  capabilities: {
    series: [
      'traffic.total',
      'traffic.in',
      'traffic.out',
      'bandwidth.total',
      'bandwidth.in',
      'bandwidth.out',
      'requests.total',
      'cache.traffic.hit',
      'cache.requests.hit',
      'security.blocked'
    ],
    top: Object.keys(TOP_DIMENSION),
    topMetrics: ['traffic', 'requests'],
    pagesStats: false,
    sampling: true
  },

  async listSites(ctx) {
    return ctx.cache.wrap('esa:sites', async () => {
      const response = await call(ctx, 'ListSites', { PageNumber: 1, PageSize: 100 }, 'GET');
      return (response.Sites || []).map((site) => ({
        id: String(site.SiteId),
        name: site.SiteName || String(site.SiteId),
        status: site.Status,
        plan: site.PlanName
      }));
    }, 5 * 60 * 1000);
  },

  async fetchSeries(ctx, { metrics, range, siteId }) {
    const SiteId = siteIdOf(ctx, siteId);
    const wanted = new Set(metrics);
    const base = {
      SiteId: SiteId || undefined,
      StartTime: range.start,
      EndTime: range.end,
      Interval: String(range.intervalSeconds)
    };

    const jobs = [];
    const needsTraffic =
      wanted.has('traffic.total') || wanted.has('traffic.out') || wanted.has('bandwidth.total') ||
      wanted.has('bandwidth.out') || wanted.has('traffic.in') || wanted.has('bandwidth.in') ||
      wanted.has('requests.total');

    if (needsTraffic) {
      jobs.push({
        key: 'flow',
        run: () => call(ctx, 'DescribeSiteTimeSeriesData', {
          ...base,
          Fields: fieldsParam([
            { fieldName: FIELD_TRAFFIC_OUT },
            { fieldName: FIELD_TRAFFIC_IN },
            { fieldName: FIELD_REQUESTS }
          ])
        })
      });
    }

    if (wanted.has('cache.traffic.hit') || wanted.has('cache.requests.hit')) {
      jobs.push({
        key: 'cache',
        run: () => call(ctx, 'DescribeSiteTimeSeriesData', {
          ...base,
          Fields: fieldsParam([
            { fieldName: FIELD_TRAFFIC_OUT, dimension: ['EdgeCacheStatus'] },
            { fieldName: FIELD_REQUESTS, dimension: ['EdgeCacheStatus'] }
          ])
        })
      });
    }

    if (wanted.has('security.blocked')) {
      jobs.push({
        key: 'waf',
        run: () => call(ctx, 'DescribeSiteWafTimeSeriesData', {
          ...base,
          Fields: fieldsParam([{ fieldName: FIELD_REQUESTS }])
        })
      });
    }

    const results = await settleAll(jobs.map((job) => job.run));
    const grouped = {};
    const notes = [];
    let sampling = null;

    results.forEach((result, index) => {
      const { key } = jobs[index];
      if (result.ok) {
        grouped[key] = groupByField(result.value);
        const rate = Number(result.value?.SamplingRate);
        if (Number.isFinite(rate) && rate > 0) sampling = Math.min(sampling ?? rate, rate);
      } else {
        notes.push({ level: 'error', scope: key, message: result.error.message });
      }
    });

    const series = {};
    const flow = grouped.flow;

    const trafficOut = flow ? seriesFor(flow, FIELD_TRAFFIC_OUT, 'traffic.out') : emptySeries('traffic.out');
    const trafficIn = flow ? seriesFor(flow, FIELD_TRAFFIC_IN, 'traffic.in') : emptySeries('traffic.in');

    if (wanted.has('traffic.out')) series['traffic.out'] = trafficOut;
    if (wanted.has('traffic.in')) series['traffic.in'] = trafficIn;
    if (wanted.has('traffic.total')) {
      series['traffic.total'] = combineSeries('traffic.total', [trafficOut, trafficIn]);
      series['traffic.total'].derived = true;
    }
    if (wanted.has('requests.total')) {
      series['requests.total'] = flow ? seriesFor(flow, FIELD_REQUESTS, 'requests.total') : emptySeries('requests.total');
    }

    // ESA has no bandwidth field; bandwidth is traffic over the bucket length.
    if (wanted.has('bandwidth.out')) {
      series['bandwidth.out'] = trafficToBandwidth('bandwidth.out', trafficOut, range.intervalSeconds);
    }
    if (wanted.has('bandwidth.in')) {
      series['bandwidth.in'] = trafficToBandwidth('bandwidth.in', trafficIn, range.intervalSeconds);
    }
    if (wanted.has('bandwidth.total')) {
      series['bandwidth.total'] = trafficToBandwidth(
        'bandwidth.total',
        combineSeries('traffic.total', [trafficOut, trafficIn]),
        range.intervalSeconds
      );
    }

    if (grouped.cache) {
      if (wanted.has('cache.traffic.hit')) {
        series['cache.traffic.hit'] = seriesFor(grouped.cache, FIELD_TRAFFIC_OUT, 'cache.traffic.hit', isCacheHit);
        series['cache.traffic.total'] = seriesFor(grouped.cache, FIELD_TRAFFIC_OUT, 'cache.traffic.hit');
      }
      if (wanted.has('cache.requests.hit')) {
        series['cache.requests.hit'] = seriesFor(grouped.cache, FIELD_REQUESTS, 'cache.requests.hit', isCacheHit);
        series['cache.requests.total'] = seriesFor(grouped.cache, FIELD_REQUESTS, 'cache.requests.hit');
      }
    } else {
      if (wanted.has('cache.traffic.hit')) series['cache.traffic.hit'] = emptySeries('cache.traffic.hit');
      if (wanted.has('cache.requests.hit')) series['cache.requests.hit'] = emptySeries('cache.requests.hit');
    }

    if (wanted.has('security.blocked')) {
      series['security.blocked'] = grouped.waf
        ? seriesFor(grouped.waf, FIELD_REQUESTS, 'security.blocked')
        : emptySeries('security.blocked');
    }

    return { series, notes, sampling };
  },

  async fetchTop(ctx, { dimensions, metric = 'traffic', range, siteId, limit = 10 }) {
    const SiteId = siteIdOf(ctx, siteId);
    const fieldName = metric === 'requests' ? FIELD_REQUESTS : FIELD_TRAFFIC_OUT;
    const usable = dimensions.filter((dim) => TOP_DIMENSION[dim]);
    const apiLimit = ALLOWED_LIMITS.find((value) => value >= limit) ?? 150;

    // One call carries every dimension; the response is split by DimensionName.
    const response = await call(ctx, 'DescribeSiteTopData', {
      SiteId: SiteId || undefined,
      StartTime: range.start,
      EndTime: range.end,
      Interval: String(range.intervalSeconds),
      Limit: String(apiLimit),
      Fields: fieldsParam([{ fieldName, dimension: usable.map((dim) => TOP_DIMENSION[dim]) }])
    }).catch((error) => ({ __error: error }));

    if (response?.__error) {
      return {
        top: Object.fromEntries(usable.map((dim) => [dim, []])),
        notes: [{ level: 'error', scope: 'top', message: response.__error.message }]
      };
    }

    const byDimension = new Map();
    for (const entry of response?.Data || []) {
      const list = (entry.DetailData || []).map((item) => ({
        key: item.DimensionValue,
        value: Number(item.Value || 0)
      }));
      byDimension.set(entry.DimensionName, list);
    }

    const top = {};
    for (const dim of usable) {
      const items = byDimension.get(TOP_DIMENSION[dim]) || [];
      top[dim] = items.sort((a, b) => b.value - a.value).slice(0, limit);
    }

    return { top, notes: [] };
  }
};
