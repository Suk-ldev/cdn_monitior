import express from 'express';
import { INTERVALS, RANGES, previousRange, resolveRange } from '../lib/time.js';
import { SERIES_METRICS, TOP_DIMENSIONS, seriesTotal } from '../providers/metrics.js';
import { getProvider, providerOrder, providers, requireReady } from '../providers/index.js';

const KPI_METRICS = [
  'traffic.total',
  'traffic.in',
  'traffic.out',
  'bandwidth.total',
  'bandwidth.in',
  'bandwidth.out',
  'requests.total',
  'origin.traffic.out',
  'origin.requests',
  'security.blocked',
  'perf.responseTime',
  'perf.firstByteTime'
];

const DEFAULT_TOP_DIMENSIONS = ['country', 'statusCode', 'host', 'url', 'referer', 'contentType'];

function parseList(value, fallback = []) {
  if (!value) return fallback;
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function readRange(query) {
  return resolveRange({
    start: query.start,
    end: query.end,
    range: query.range || 'today',
    offsetMinutes: Number.parseInt(query.offset ?? '0', 10) || 0,
    interval: query.interval || 'auto'
  });
}

function pickPlatform(config, query) {
  const id = String(query.platform || config.defaultPlatform || '').toLowerCase();
  return requireReady(config, id);
}

function buildKpis(series, previous) {
  const kpis = {};
  for (const metric of Object.keys(series)) {
    if (!SERIES_METRICS[metric]) continue;
    const value = seriesTotal(series[metric]);
    const prev = previous?.[metric] ? seriesTotal(previous[metric]) : null;
    kpis[metric] = {
      value,
      previous: prev,
      delta: prev !== null && prev !== 0 ? (value - prev) / prev : null
    };
  }
  return kpis;
}

function ratio(hit, total) {
  const hitValue = hit ? seriesTotal(hit) : 0;
  const totalValue = total ? seriesTotal(total) : 0;
  if (!totalValue) return null;
  return Math.min(1, hitValue / totalValue);
}

export function createApiRouter(ctx) {
  const router = express.Router();
  const { config } = ctx;

  router.get('/meta', (req, res) => {
    res.json({
      siteName: config.siteName,
      defaultPlatform: config.defaultPlatform,
      ranges: Object.keys(RANGES),
      intervals: Object.entries(INTERVALS).map(([id, spec]) => ({ id, ...spec })),
      topDimensions: TOP_DIMENSIONS,
      platforms: providerOrder.map((id) => {
        const provider = providers[id];
        return {
          id,
          label: provider.label,
          vendor: provider.vendor,
          docs: provider.docs,
          ready: config.readiness[id],
          missing: config.missing[id],
          capabilities: provider.capabilities
        };
      })
    });
  });

  router.get('/sites', async (req, res, next) => {
    try {
      const provider = pickPlatform(config, req.query);
      res.json({ platform: provider.id, sites: await provider.listSites(ctx) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/overview', async (req, res, next) => {
    try {
      const provider = pickPlatform(config, req.query);
      const range = readRange(req.query);
      const siteId = req.query.siteId || '';
      const compare = req.query.compare === '1' || req.query.compare === 'true';

      const requested = parseList(req.query.metrics, provider.capabilities.series);
      const metrics = requested.filter((metric) => provider.capabilities.series.includes(metric));

      const cacheKey = `overview:${provider.id}:${siteId}:${range.start}:${range.end}:${range.interval}:${metrics.join()}`;
      const current = await ctx.cache.wrap(cacheKey, () =>
        provider.fetchSeries(ctx, { metrics, range, siteId }));

      let previous = null;
      if (compare) {
        const prev = previousRange(range);
        const prevRange = { ...range, ...prev };
        const kpiMetrics = metrics.filter((metric) => KPI_METRICS.includes(metric));
        const prevKey = `overview:${provider.id}:${siteId}:${prev.start}:${prev.end}:${range.interval}:${kpiMetrics.join()}`;
        previous = await ctx.cache
          .wrap(prevKey, () => provider.fetchSeries(ctx, { metrics: kpiMetrics, range: prevRange, siteId }))
          .catch(() => null);
      }

      const series = current.series;
      res.json({
        platform: provider.id,
        siteId,
        range: {
          start: range.start,
          end: range.end,
          interval: range.interval,
          intervalSeconds: range.intervalSeconds,
          intervalAdjusted: range.intervalAdjusted,
          requestedInterval: range.requestedInterval,
          previous: compare ? previousRange(range) : null
        },
        sampling: current.sampling ?? null,
        series,
        kpis: buildKpis(series, previous?.series),
        cache: {
          trafficHitRatio: ratio(series['cache.traffic.hit'], series['cache.traffic.total']),
          requestHitRatio: ratio(series['cache.requests.hit'], series['cache.requests.total'])
        },
        notes: current.notes || []
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/top', async (req, res, next) => {
    try {
      const provider = pickPlatform(config, req.query);
      const range = readRange(req.query);
      const siteId = req.query.siteId || '';
      const metric = req.query.metric === 'requests' ? 'requests' : 'traffic';
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '10', 10) || 10, 1), 50);

      const dimensions = parseList(req.query.dimensions, DEFAULT_TOP_DIMENSIONS)
        .filter((dim) => provider.capabilities.top.includes(dim));

      if (!dimensions.length) {
        return res.json({ platform: provider.id, metric, top: {}, notes: [] });
      }

      const cacheKey = `top:${provider.id}:${siteId}:${range.start}:${range.end}:${metric}:${limit}:${dimensions.join()}`;
      const result = await ctx.cache.wrap(cacheKey, () =>
        provider.fetchTop(ctx, { dimensions, metric, range, siteId, limit }));

      res.json({ platform: provider.id, metric, limit, top: result.top, notes: result.notes || [] });
    } catch (error) {
      next(error);
    }
  });

  router.get('/pages', async (req, res, next) => {
    try {
      const provider = pickPlatform(config, req.query);
      if (!provider.capabilities.pagesStats || !provider.fetchPagesStats) {
        return res.json({ platform: provider.id, supported: false });
      }
      const range = readRange(req.query);
      const cacheKey = `pages:${provider.id}:${range.start}:${range.end}:${range.interval}`;
      const stats = await ctx.cache.wrap(cacheKey, () => provider.fetchPagesStats(ctx, { range }));
      res.json({ platform: provider.id, supported: true, ...stats });
    } catch (error) {
      next(error);
    }
  });

  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      time: new Date().toISOString(),
      platforms: Object.fromEntries(
        providerOrder.map((id) => [id, { ready: config.readiness[id], missing: config.missing[id] }])
      ),
      cacheEntries: ctx.cache.size
    });
  });

  // Backwards compatibility with the pre-refactor endpoints.
  router.get('/config', (req, res) => {
    res.json({ siteName: config.siteName, defaultPlatform: config.defaultPlatform });
  });

  router.get('/zones', async (req, res, next) => {
    try {
      const provider = getProvider(String(req.query.platform || config.defaultPlatform));
      requireReady(config, provider.id);
      const sites = await provider.listSites(ctx);
      res.json({ Zones: sites.map((site) => ({ ZoneId: site.id, ZoneName: site.name })) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
