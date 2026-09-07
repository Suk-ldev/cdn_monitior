/**
 * Vendor-neutral metric vocabulary. Every provider maps its own API onto these
 * ids so the frontend never branches on the platform.
 */
export const SERIES_METRICS = {
  'traffic.total': { unit: 'bytes', agg: 'sum', group: 'traffic' },
  'traffic.in': { unit: 'bytes', agg: 'sum', group: 'traffic' },
  'traffic.out': { unit: 'bytes', agg: 'sum', group: 'traffic' },

  'bandwidth.total': { unit: 'bps', agg: 'max', group: 'bandwidth' },
  'bandwidth.in': { unit: 'bps', agg: 'max', group: 'bandwidth' },
  'bandwidth.out': { unit: 'bps', agg: 'max', group: 'bandwidth' },

  'requests.total': { unit: 'count', agg: 'sum', group: 'requests' },

  'cache.traffic.hit': { unit: 'bytes', agg: 'sum', group: 'cache' },
  'cache.traffic.miss': { unit: 'bytes', agg: 'sum', group: 'cache' },
  'cache.requests.hit': { unit: 'count', agg: 'sum', group: 'cache' },
  'cache.requests.miss': { unit: 'count', agg: 'sum', group: 'cache' },

  'origin.traffic.out': { unit: 'bytes', agg: 'sum', group: 'origin' },
  'origin.traffic.in': { unit: 'bytes', agg: 'sum', group: 'origin' },
  'origin.bandwidth.out': { unit: 'bps', agg: 'max', group: 'origin' },
  'origin.bandwidth.in': { unit: 'bps', agg: 'max', group: 'origin' },
  'origin.requests': { unit: 'count', agg: 'sum', group: 'origin' },

  'security.blocked': { unit: 'count', agg: 'sum', group: 'security' },

  'perf.responseTime': { unit: 'ms', agg: 'avg', group: 'performance' },
  'perf.firstByteTime': { unit: 'ms', agg: 'avg', group: 'performance' },

  'functions.requests': { unit: 'count', agg: 'sum', group: 'functions' },
  'functions.cpuTime': { unit: 'ms', agg: 'sum', group: 'functions' }
};

export const TOP_DIMENSIONS = [
  'country',
  'province',
  'statusCode',
  'host',
  'url',
  'contentType',
  'clientIp',
  'referer',
  'device',
  'browser',
  'os',
  'userAgent',
  'cacheStatus',
  'isp'
];

export function emptySeries(metric) {
  const spec = SERIES_METRICS[metric] || { unit: 'count', agg: 'sum' };
  return {
    metric,
    unit: spec.unit,
    agg: spec.agg,
    points: [],
    summary: { sum: 0, max: 0, avg: 0, last: 0 },
    empty: true
  };
}

/** Build a normalized series from [timestampMs, value] pairs. */
export function makeSeries(metric, points, overrides = {}) {
  const spec = SERIES_METRICS[metric] || { unit: 'count', agg: 'sum' };
  const sorted = points
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
    .sort((a, b) => a[0] - b[0]);

  const values = sorted.map(([, v]) => v);
  const sum = values.reduce((acc, v) => acc + v, 0);
  const max = values.length ? Math.max(...values) : 0;

  return {
    metric,
    unit: spec.unit,
    agg: spec.agg,
    points: sorted,
    summary: {
      sum,
      max,
      avg: values.length ? sum / values.length : 0,
      last: values.length ? values[values.length - 1] : 0
    },
    empty: sorted.length === 0,
    ...overrides
  };
}

/** The single number a KPI card shows, chosen by the metric's aggregation. */
export function seriesTotal(series) {
  if (!series) return 0;
  if (series.agg === 'max') return series.summary.max;
  if (series.agg === 'avg') return series.summary.avg;
  return series.summary.sum;
}

/** Element-wise combination of several series into one (used for derived metrics). */
export function combineSeries(metric, list, reducer = (a, b) => a + b) {
  const buckets = new Map();
  for (const series of list) {
    if (!series) continue;
    for (const [t, v] of series.points) {
      buckets.set(t, buckets.has(t) ? reducer(buckets.get(t), v) : v);
    }
  }
  return makeSeries(metric, [...buckets.entries()]);
}

/** Derive bandwidth (bps) from a traffic (bytes) series at a known granularity. */
export function trafficToBandwidth(metric, trafficSeries, intervalSeconds) {
  if (!trafficSeries || !intervalSeconds) return emptySeries(metric);
  return makeSeries(
    metric,
    trafficSeries.points.map(([t, v]) => [t, (v * 8) / intervalSeconds]),
    { derived: true }
  );
}
