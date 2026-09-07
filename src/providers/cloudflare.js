import { httpJson, settleAll } from '../lib/http.js';
import { emptySeries, makeSeries, trafficToBandwidth } from './metrics.js';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

const LEGACY_QUERY = `
query ($zone: String!, $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      hourly: httpRequests1hGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: 1000
        orderBy: [datetime_ASC]
      ) {
        dimensions { datetime }
        sum {
          requests
          bytes
          cachedRequests
          cachedBytes
          threats
          countryMap { clientCountryName requests bytes }
          responseStatusMap { edgeResponseStatus requests }
          browserMap { uaBrowserFamily pageViews }
          contentTypeMap { edgeResponseContentTypeName requests bytes }
        }
      }
    }
  }
}`;

const LEGACY_DAILY_QUERY = LEGACY_QUERY
  .replace('$since: Time!, $until: Time!', '$since: Date!, $until: Date!')
  .replace('httpRequests1hGroups', 'httpRequests1dGroups')
  .replace('datetime_geq: $since, datetime_leq: $until', 'date_geq: $since, date_leq: $until')
  .replace('orderBy: [datetime_ASC]', 'orderBy: [date_ASC]')
  .replace('dimensions { datetime }', 'dimensions { date }');

const ADAPTIVE_QUERY = `
query ($zone: String!, $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      minutely: httpRequestsAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: 5000
        orderBy: [datetimeMinute_ASC]
      ) {
        dimensions { datetimeMinute cacheStatus }
        count
        sum { edgeResponseBytes }
      }
    }
  }
}`;

const CACHE_HIT_STATUS = new Set(['hit', 'stale', 'updating', 'revalidated']);

async function graphql(ctx, query, variables) {
  const body = await httpJson(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.config.cloudflare.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables }),
    timeoutMs: ctx.config.requestTimeoutMs
  });

  if (body?.errors?.length) {
    throw Object.assign(new Error(body.errors[0].message || 'Cloudflare GraphQL 调用失败'), {
      code: 'GraphQLError'
    });
  }
  return body?.data?.viewer?.zones?.[0] || null;
}

function targetZones(ctx, siteId) {
  const { zones } = ctx.config.cloudflare;
  if (!siteId || siteId === '*') return zones;
  const match = zones.find((zone) => zone.id === siteId);
  return match ? [match] : zones.slice(0, 1);
}

/** Round a timestamp down to the requested bucket size. */
function bucket(tsMs, intervalSeconds) {
  const size = intervalSeconds * 1000;
  return Math.floor(tsMs / size) * size;
}

function accumulate(target, key, tsMs, value) {
  const map = target.get(key) || new Map();
  map.set(tsMs, (map.get(tsMs) || 0) + value);
  target.set(key, map);
}

function addTop(target, dimension, key, value) {
  if (key === undefined || key === null || key === '') return;
  const map = target.get(dimension) || new Map();
  map.set(String(key), (map.get(String(key)) || 0) + value);
  target.set(dimension, map);
}

function finishTop(collected, limit) {
  const top = {};
  for (const [dimension, map] of collected) {
    top[dimension] = [...map.entries()]
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
  }
  return top;
}

export const cloudflare = {
  id: 'cloudflare',
  label: 'Cloudflare',
  vendor: 'Cloudflare',
  docs: 'https://developers.cloudflare.com/analytics/graphql-api/',
  capabilities: {
    series: [
      'traffic.total',
      'traffic.out',
      'bandwidth.total',
      'bandwidth.out',
      'requests.total',
      'cache.traffic.hit',
      'cache.requests.hit',
      'security.blocked'
    ],
    top: ['country', 'statusCode', 'browser', 'contentType'],
    topMetrics: ['traffic', 'requests'],
    pagesStats: false,
    sampling: false
  },

  async listSites(ctx) {
    return ctx.config.cloudflare.zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      status: 'active'
    }));
  },

  async fetchSeries(ctx, { metrics, range, siteId }) {
    const zones = targetZones(ctx, siteId);
    const wanted = new Set(metrics);
    const notes = [];

    const fine = range.interval === 'min' || range.interval === '5min';
    const daily = range.interval === 'day';

    const collected = new Map();
    let usedFallback = false;

    async function loadZone(zone) {
      if (fine) {
        try {
          const data = await graphql(ctx, ADAPTIVE_QUERY, {
            zone: zone.id,
            since: range.start,
            until: range.end
          });
          for (const row of data?.minutely || []) {
            const ts = bucket(Date.parse(`${row.dimensions.datetimeMinute}`), range.intervalSeconds);
            const requests = Number(row.count || 0);
            const bytes = Number(row.sum?.edgeResponseBytes || 0);
            accumulate(collected, 'requests', ts, requests);
            accumulate(collected, 'bytes', ts, bytes);
            if (CACHE_HIT_STATUS.has(String(row.dimensions.cacheStatus || '').toLowerCase())) {
              accumulate(collected, 'cachedRequests', ts, requests);
              accumulate(collected, 'cachedBytes', ts, bytes);
            }
          }
          return;
        } catch (error) {
          usedFallback = true;
          notes.push({ level: 'warn', scope: 'adaptive', message: `细粒度数据不可用，已回落到小时粒度：${error.message}` });
        }
      }

      const query = daily ? LEGACY_DAILY_QUERY : LEGACY_QUERY;
      const variables = daily
        ? { zone: zone.id, since: range.start.slice(0, 10), until: range.end.slice(0, 10) }
        : { zone: zone.id, since: range.start, until: range.end };

      const data = await graphql(ctx, query, variables);
      const rows = data?.hourly || [];
      for (const row of rows) {
        const stamp = row.dimensions.datetime || row.dimensions.date;
        const ts = Date.parse(daily ? `${stamp}T00:00:00Z` : stamp);
        accumulate(collected, 'requests', ts, Number(row.sum?.requests || 0));
        accumulate(collected, 'bytes', ts, Number(row.sum?.bytes || 0));
        accumulate(collected, 'cachedRequests', ts, Number(row.sum?.cachedRequests || 0));
        accumulate(collected, 'cachedBytes', ts, Number(row.sum?.cachedBytes || 0));
        accumulate(collected, 'threats', ts, Number(row.sum?.threats || 0));
      }
    }

    const results = await settleAll(zones.map((zone) => () => loadZone(zone)), 4);
    results.forEach((result, index) => {
      if (!result.ok) {
        notes.push({ level: 'error', scope: zones[index].name, message: result.error.message });
      }
    });

    const bucketSeconds = usedFallback && fine ? 3600 : range.intervalSeconds;
    const toSeries = (metric, key) => {
      const map = collected.get(key);
      return map ? makeSeries(metric, [...map.entries()]) : emptySeries(metric);
    };

    const series = {};
    const bytesSeries = toSeries('traffic.out', 'bytes');

    if (wanted.has('traffic.out')) series['traffic.out'] = bytesSeries;
    if (wanted.has('traffic.total')) series['traffic.total'] = { ...bytesSeries, metric: 'traffic.total' };
    if (wanted.has('requests.total')) series['requests.total'] = toSeries('requests.total', 'requests');
    if (wanted.has('bandwidth.out')) {
      series['bandwidth.out'] = trafficToBandwidth('bandwidth.out', bytesSeries, bucketSeconds);
    }
    if (wanted.has('bandwidth.total')) {
      series['bandwidth.total'] = trafficToBandwidth('bandwidth.total', bytesSeries, bucketSeconds);
    }
    if (wanted.has('cache.traffic.hit')) {
      series['cache.traffic.hit'] = toSeries('cache.traffic.hit', 'cachedBytes');
      series['cache.traffic.total'] = { ...bytesSeries, metric: 'cache.traffic.hit' };
    }
    if (wanted.has('cache.requests.hit')) {
      series['cache.requests.hit'] = toSeries('cache.requests.hit', 'cachedRequests');
      series['cache.requests.total'] = { ...toSeries('requests.total', 'requests'), metric: 'cache.requests.hit' };
    }
    if (wanted.has('security.blocked')) {
      series['security.blocked'] = toSeries('security.blocked', 'threats');
    }

    return { series, notes };
  },

  async fetchTop(ctx, { dimensions, metric = 'traffic', range, siteId, limit = 10 }) {
    const zones = targetZones(ctx, siteId);
    const daily = range.spanMs > 3 * 24 * 3600 * 1000;
    const collected = new Map();
    const notes = [];

    const results = await settleAll(zones.map((zone) => async () => {
      const query = daily ? LEGACY_DAILY_QUERY : LEGACY_QUERY;
      const variables = daily
        ? { zone: zone.id, since: range.start.slice(0, 10), until: range.end.slice(0, 10) }
        : { zone: zone.id, since: range.start, until: range.end };

      const data = await graphql(ctx, query, variables);
      for (const row of data?.hourly || []) {
        const sum = row.sum || {};
        for (const item of sum.countryMap || []) {
          addTop(collected, 'country', item.clientCountryName, Number(metric === 'requests' ? item.requests : item.bytes) || 0);
        }
        for (const item of sum.responseStatusMap || []) {
          addTop(collected, 'statusCode', item.edgeResponseStatus, Number(item.requests) || 0);
        }
        for (const item of sum.browserMap || []) {
          addTop(collected, 'browser', item.uaBrowserFamily, Number(item.pageViews) || 0);
        }
        for (const item of sum.contentTypeMap || []) {
          addTop(
            collected,
            'contentType',
            item.edgeResponseContentTypeName,
            Number(metric === 'requests' ? item.requests : item.bytes) || 0
          );
        }
      }
    }, 4));

    results.forEach((result, index) => {
      if (!result.ok) notes.push({ level: 'error', scope: zones[index].name, message: result.error.message });
    });

    const all = finishTop(collected, limit);
    const top = {};
    for (const dim of dimensions) top[dim] = all[dim] || [];
    return { top, notes };
  }
};
