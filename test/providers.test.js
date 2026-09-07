import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

/** Route stubbed responses by Action / URL so one fake fetch serves every provider. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = typeof url === 'string' ? url : url.toString();
    const headers = init.headers || {};
    const action =
      headers['X-TC-Action'] ||
      headers['x-acs-action'] ||
      new URL(href).searchParams.get('Action') ||
      'graphql';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ href, action, body });

    const payload = handler({ href, action, body });
    return new Response(JSON.stringify(payload ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return calls;
}

async function freshApp(env) {
  Object.assign(process.env, env);
  const { createApp } = await import(`../src/app.js?t=${Math.random()}`);
  return createApp({ serveStatic: false });
}

function request(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const response = await fetchReal(`http://127.0.0.1:${server.address().port}${path}`);
        resolve({ status: response.status, body: await response.json() });
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

// The tests replace globalThis.fetch, so the harness keeps its own reference.
const fetchReal = (...args) => ORIGINAL_FETCH(...args);

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(CF_|EO_|ESA_|SITE_NAME|DEFAULT_PLATFORM|CACHE_TTL)/.test(key)) delete process.env[key];
  }
  process.env.CACHE_TTL = '0';
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = { ...ORIGINAL_ENV };
});

test('ESA overview normalizes traffic, derives bandwidth and computes cache hit ratio', async () => {
  const t0 = '2026-01-01T00:00:00Z';
  const t1 = '2026-01-01T01:00:00Z';

  stubFetch(({ action, href }) => {
    if (action === 'DescribeSiteTimeSeriesData') {
      const fields = JSON.parse(new URL(href).searchParams.get('Fields'));
      const byCacheStatus = fields[0].Dimension.includes('EdgeCacheStatus');

      if (byCacheStatus) {
        return {
          SamplingRate: 100,
          Data: [
            { FieldName: 'Traffic', DimensionName: 'EdgeCacheStatus', DimensionValue: 'hit', DetailData: [{ TimeStamp: t0, Value: 800 }] },
            { FieldName: 'Traffic', DimensionName: 'EdgeCacheStatus', DimensionValue: 'miss', DetailData: [{ TimeStamp: t0, Value: 200 }] },
            { FieldName: 'Requests', DimensionName: 'EdgeCacheStatus', DimensionValue: 'hit', DetailData: [{ TimeStamp: t0, Value: 90 }] },
            { FieldName: 'Requests', DimensionName: 'EdgeCacheStatus', DimensionValue: 'miss', DetailData: [{ TimeStamp: t0, Value: 10 }] }
          ]
        };
      }
      return {
        SamplingRate: 100,
        Data: [
          { FieldName: 'Traffic', DimensionName: 'ALL', DimensionValue: 'ALL', DetailData: [{ TimeStamp: t0, Value: 1000 }, { TimeStamp: t1, Value: 2000 }] },
          { FieldName: 'RequestTraffic', DimensionName: 'ALL', DimensionValue: 'ALL', DetailData: [{ TimeStamp: t0, Value: 100 }, { TimeStamp: t1, Value: 200 }] },
          { FieldName: 'Requests', DimensionName: 'ALL', DimensionValue: 'ALL', DetailData: [{ TimeStamp: t0, Value: 50 }, { TimeStamp: t1, Value: 70 }] }
        ]
      };
    }
    if (action === 'DescribeSiteWafTimeSeriesData') {
      return { Data: [{ FieldName: 'Requests', DimensionName: 'ALL', DimensionValue: 'ALL', DetailData: [{ TimeStamp: t0, Value: 7 }] }] };
    }
    return {};
  });

  const app = await freshApp({ ESA_ACCESS_KEY_ID: 'ak', ESA_ACCESS_KEY_SECRET: 'sk', ESA_SITE_IDS: '123' });
  const { status, body } = await request(
    app,
    '/api/overview?platform=esa&start=2026-01-01T00:00:00Z&end=2026-01-01T02:00:00Z&interval=hour'
  );

  assert.equal(status, 200);
  assert.equal(body.series['traffic.out'].summary.sum, 3000);
  assert.equal(body.series['traffic.in'].summary.sum, 300);
  assert.equal(body.series['traffic.total'].summary.sum, 3300);
  assert.equal(body.series['requests.total'].summary.sum, 120);

  // 2000 bytes in a 3600s bucket → 2000 * 8 / 3600 bps, and max wins for bandwidth.
  assert.equal(Math.round(body.series['bandwidth.out'].summary.max), Math.round((2000 * 8) / 3600));

  assert.equal(body.cache.trafficHitRatio, 0.8);
  assert.equal(body.cache.requestHitRatio, 0.9);
  assert.equal(body.series['security.blocked'].summary.sum, 7);
  assert.deepEqual(body.notes, []);
});

test('ESA top data splits one response by dimension', async () => {
  stubFetch(({ action }) => {
    if (action !== 'DescribeSiteTopData') return {};
    return {
      Data: [
        {
          FieldName: 'Traffic',
          DimensionName: 'ClientCountryCode',
          DetailData: [
            { DimensionValue: 'CN', Value: '900' },
            { DimensionValue: 'US', Value: '300' }
          ]
        },
        {
          FieldName: 'Traffic',
          DimensionName: 'EdgeResponseStatusCode',
          DetailData: [{ DimensionValue: '200', Value: '1200' }]
        }
      ]
    };
  });

  const app = await freshApp({ ESA_ACCESS_KEY_ID: 'ak', ESA_ACCESS_KEY_SECRET: 'sk' });
  const { body } = await request(
    app,
    '/api/top?platform=esa&start=2026-01-01T00:00:00Z&end=2026-01-01T02:00:00Z&dimensions=country,statusCode'
  );

  assert.deepEqual(body.top.country, [
    { key: 'CN', value: 900 },
    { key: 'US', value: 300 }
  ]);
  assert.deepEqual(body.top.statusCode, [{ key: '200', value: 1200 }]);
});

test('EdgeOne sums metrics across zones and merges the three interception counters', async () => {
  const stamp = Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000);

  stubFetch(({ action, body }) => {
    if (action === 'DescribeZones') {
      return { Response: { Zones: [{ ZoneId: 'z1', ZoneName: 'a.com' }, { ZoneId: 'z2', ZoneName: 'b.com' }] } };
    }
    if (action === 'DescribeTimingL7AnalysisData') {
      const record = (zone, value) => ({
        TypeKey: zone,
        TypeValue: body.MetricNames.map((name) => ({
          MetricName: name,
          Sum: value,
          Max: value,
          Avg: value,
          Detail: [{ Timestamp: stamp, Value: value }]
        }))
      });
      return { Response: { Data: [record('z1', 100), record('z2', 50)] } };
    }
    if (action === 'DescribeWebProtectionData') {
      return {
        Response: {
          Data: [
            {
              TypeKey: 'z1',
              TypeValue: body.MetricNames.map((name) => ({
                MetricName: name,
                Detail: [{ Timestamp: stamp, Value: 3 }]
              }))
            }
          ]
        }
      };
    }
    return { Response: { Data: [] } };
  });

  const app = await freshApp({ EO_SECRET_ID: 'id', EO_SECRET_KEY: 'key' });
  const { body } = await request(
    app,
    '/api/overview?platform=edgeone&start=2026-01-01T00:00:00Z&end=2026-01-01T02:00:00Z&interval=hour&metrics=traffic.total,security.blocked'
  );

  assert.equal(body.series['traffic.total'].summary.sum, 150);
  // Three counters × 3 hits each.
  assert.equal(body.series['security.blocked'].summary.sum, 9);
});

test('a failing upstream section degrades to a note instead of failing the request', async () => {
  stubFetch(({ action }) => {
    if (action === 'DescribeZones') return { Response: { Zones: [{ ZoneId: 'z1', ZoneName: 'a.com' }] } };
    if (action === 'DescribeTimingL7AnalysisData') {
      return { Response: { Error: { Code: 'AuthFailure', Message: '密钥无效' } } };
    }
    return { Response: { Data: [] } };
  });

  const app = await freshApp({ EO_SECRET_ID: 'id', EO_SECRET_KEY: 'key' });
  const { status, body } = await request(
    app,
    '/api/overview?platform=edgeone&start=2026-01-01T00:00:00Z&end=2026-01-01T02:00:00Z&metrics=traffic.total'
  );

  assert.equal(status, 200);
  assert.equal(body.series['traffic.total'].empty, true);
  assert.equal(body.notes[0].message, '密钥无效');
});

test('Cloudflare maps the legacy GraphQL payload onto the shared schema', async () => {
  stubFetch(() => ({
    data: {
      viewer: {
        zones: [
          {
            hourly: [
              {
                dimensions: { datetime: '2026-01-01T00:00:00Z' },
                sum: {
                  requests: 100,
                  bytes: 5000,
                  cachedRequests: 60,
                  cachedBytes: 4000,
                  threats: 4,
                  countryMap: [{ clientCountryName: 'CN', requests: 70, bytes: 3500 }],
                  responseStatusMap: [{ edgeResponseStatus: 200, requests: 95 }],
                  browserMap: [],
                  contentTypeMap: []
                }
              }
            ]
          }
        ]
      }
    }
  }));

  const app = await freshApp({ CF_TOKENS: 'token', CF_ZONES: 'zone1', CF_DOMAINS: 'example.com' });
  const { body } = await request(
    app,
    '/api/overview?platform=cloudflare&start=2026-01-01T00:00:00Z&end=2026-01-01T02:00:00Z&interval=hour'
  );

  assert.equal(body.series['requests.total'].summary.sum, 100);
  assert.equal(body.series['traffic.out'].summary.sum, 5000);
  assert.equal(body.cache.requestHitRatio, 0.6);
  assert.equal(body.cache.trafficHitRatio, 0.8);
  assert.equal(body.series['security.blocked'].summary.sum, 4);
});
