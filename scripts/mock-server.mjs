// Dev helper: runs the real app with every upstream API stubbed, so the UI can be
// exercised (and screenshotted) without any cloud credentials.
//   npm run mock   (or: node scripts/mock-server.mjs [port])
process.env.EO_SECRET_ID ||= 'mock-id';
process.env.EO_SECRET_KEY ||= 'mock-key';
process.env.ESA_ACCESS_KEY_ID ||= 'mock-ak';
process.env.ESA_ACCESS_KEY_SECRET ||= 'mock-sk';
process.env.CF_TOKENS ||= 'mock-token';
process.env.CF_ZONES ||= 'zone-1';
process.env.CF_DOMAINS ||= 'example.com';
process.env.SITE_NAME ||= 'CDN 流量分析看板';
process.env.CACHE_TTL ||= '0';

const HOUR = 3600 * 1000;

function wave(count, base, amplitude, seed = 1) {
  return Array.from({ length: count }, (_, i) => {
    const noise = Math.sin((i + seed) * 1.7) * 0.35 + Math.sin((i + seed) * 0.4) * 0.65;
    return Math.max(0, Math.round(base + amplitude * noise));
  });
}

function slots(startIso, endIso, intervalSeconds) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  const step = intervalSeconds * 1000;
  const out = [];
  for (let t = Math.floor(start / step) * step; t <= end; t += step) out.push(t);
  return out.slice(0, 400);
}

globalThis.fetch = async (url, init = {}) => {
  const href = typeof url === 'string' ? url : url.toString();
  const headers = init.headers || {};
  const body = init.body && headers['Content-Type']?.includes('json') ? JSON.parse(init.body) : null;
  const params = href.includes('?') ? new URL(href).searchParams : new URLSearchParams();
  const action = headers['X-TC-Action'] || headers['x-acs-action'] || 'graphql';

  const json = (payload) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

  /* ---- Tencent EdgeOne ---- */
  if (headers['X-TC-Action']) {
    if (action === 'DescribeZones') {
      return json({
        Response: {
          Zones: [
            { ZoneId: 'zone-a', ZoneName: 'imsuk.cn', Status: 'active' },
            { ZoneId: 'zone-b', ZoneName: 'demo.example.com', Status: 'active' }
          ]
        }
      });
    }
    if (action === 'DescribeTopL7AnalysisData') {
      const table = {
        country: [['CN', 62], ['US', 14], ['JP', 8], ['SG', 6], ['DE', 4], ['GB', 3], ['KR', 2], ['AU', 1]],
        province: [['广东', 30], ['浙江', 22], ['江苏', 18], ['北京', 14], ['上海', 9]],
        statusCode: [['200', 88], ['304', 6], ['404', 3], ['500', 2], ['403', 1]],
        domain: [['www.imsuk.cn', 55], ['api.imsuk.cn', 28], ['cdn.imsuk.cn', 17]],
        url: [['/', 40], ['/posts/hello-world', 22], ['/assets/app.js', 18], ['/api/list', 12], ['/favicon.ico', 8]],
        resourceType: [['html', 32], ['js', 26], ['png', 20], ['css', 12], ['json', 10]],
        sip: [['203.0.113.7', 24], ['198.51.100.9', 19], ['192.0.2.44', 15]],
        referers: [['https://www.google.com', 33], ['https://t.co', 21], ['direct', 46]],
        ua_device: [['Desktop', 58], ['Mobile', 38], ['Tablet', 4]],
        ua_browser: [['Chrome', 61], ['Safari', 22], ['Firefox', 10], ['Edge', 7]],
        ua_os: [['Windows', 41], ['macOS', 26], ['iOS', 19], ['Android', 14]],
        ua: [['Mozilla/5.0 Chrome/125', 55], ['Mozilla/5.0 Safari/17', 25], ['curl/8.4', 20]]
      };
      const suffix = String(body.MetricName).replace(/^l7Flow_(outFlux|request)_/, '');
      const rows = table[suffix] || [];
      const scale = body.MetricName.includes('outFlux') ? 9_400_000 : 1_820;
      return json({
        Response: {
          Data: [{ TypeKey: 'zone-a', DetailData: rows.map(([Key, share]) => ({ Key, Value: share * scale })) }]
        }
      });
    }

    const times = slots(body.StartTime, body.EndTime, { min: 60, '5min': 300, hour: 3600, day: 86400 }[body.Interval] || 3600);
    const shape = {
      l7Flow_flux: [2.1e9, 9e8],
      l7Flow_outFlux: [1.9e9, 8e8],
      l7Flow_inFlux: [2.1e8, 9e7],
      l7Flow_bandwidth: [4.6e9, 1.8e9],
      l7Flow_outBandwidth: [4.2e9, 1.6e9],
      l7Flow_inBandwidth: [4.4e8, 1.7e8],
      l7Flow_request: [42000, 17000],
      l7Flow_avgResponseTime: [78, 22],
      l7Flow_avgFirstByteResponseTime: [41, 12],
      l7Flow_outFlux_hy: [3.4e8, 1.4e8],
      l7Flow_inFlux_hy: [3.9e8, 1.5e8],
      l7Flow_outBandwidth_hy: [7.6e8, 3e8],
      l7Flow_inBandwidth_hy: [8.1e8, 3.2e8],
      l7Flow_request_hy: [5200, 2100],
      l7Cache_outFlux: [1.6e9, 6e8],
      l7Cache_request: [36000, 14000],
      ccAcl_interceptNum: [140, 90],
      ccManage_interceptNum: [60, 40],
      ccRate_interceptNum: [30, 25],
      function_requestCount: [8600, 3400],
      function_cpuCostTime: [23000, 9000]
    };

    const hitFilter = (body.Filters || []).some((f) => f.Value?.includes('hit'));
    const TypeValue = (body.MetricNames || []).map((name, index) => {
      const [base, amplitude] = shape[name] || [1000, 400];
      const factor = hitFilter && name.startsWith('l7Cache') ? 0.82 : 1;
      const values = wave(times.length, base * factor, amplitude * factor, index + 2);
      return {
        MetricName: name,
        Sum: values.reduce((a, b) => a + b, 0),
        Max: Math.max(...values),
        Avg: values.reduce((a, b) => a + b, 0) / values.length,
        Detail: times.map((t, i) => ({ Timestamp: Math.floor(t / 1000), Value: values[i] }))
      };
    });

    return json({ Response: { Data: [{ TypeKey: 'zone-a', TypeValue }] } });
  }

  /* ---- Alibaba Cloud ESA ---- */
  if (headers['x-acs-action']) {
    if (action === 'ListSites') {
      return json({ Sites: [{ SiteId: 1150376036, SiteName: 'imsuk.cn', Status: 'active', PlanName: 'basic' }] });
    }
    const fields = JSON.parse(params.get('Fields') || '[]');
    const interval = Number(params.get('Interval') || 3600);
    const times = slots(params.get('StartTime'), params.get('EndTime'), interval);

    if (action === 'DescribeSiteTopData') {
      const table = {
        ClientCountryCode: [['CN', 58], ['US', 16], ['HK', 9], ['JP', 7], ['SG', 5], ['DE', 5]],
        ClientProvinceCode: [['广东', 28], ['江苏', 21], ['浙江', 19], ['四川', 17], ['北京', 15]],
        EdgeResponseStatusCode: [['200', 90], ['304', 5], ['404', 3], ['502', 2]],
        ClientRequestHost: [['imsuk.cn', 64], ['static.imsuk.cn', 36]],
        ClientRequestPath: [['/', 44], ['/blog', 26], ['/assets/main.css', 18], ['/rss.xml', 12]],
        EdgeResponseContentType: [['text/html', 34], ['application/javascript', 28], ['image/webp', 24], ['text/css', 14]],
        ClientIP: [['203.0.113.7', 40], ['198.51.100.9', 35], ['192.0.2.44', 25]],
        ClientRequestReferer: [['https://www.google.com', 48], ['https://news.ycombinator.com', 30], ['-', 22]],
        ClientDevice: [['Desktop', 55], ['Mobile', 41], ['Tablet', 4]],
        ClientBrowser: [['Chrome', 58], ['Safari', 26], ['Firefox', 16]],
        ClientOS: [['Windows', 38], ['macOS', 29], ['iOS', 21], ['Android', 12]],
        ClientRequestUserAgent: [['Mozilla/5.0 Chrome/125', 60], ['Mozilla/5.0 Safari/17', 40]],
        EdgeCacheStatus: [['hit', 78], ['miss', 18], ['dynamic', 4]],
        ClientISP: [['China Telecom', 42], ['China Mobile', 33], ['China Unicom', 25]]
      };
      const scale = fields[0]?.FieldName === 'Requests' ? 1640 : 8_200_000;
      return json({
        SamplingRate: 100,
        Data: (fields[0]?.Dimension || []).map((dimension) => ({
          FieldName: fields[0].FieldName,
          DimensionName: dimension,
          DetailData: (table[dimension] || []).map(([DimensionValue, share]) => ({
            DimensionValue,
            Value: share * scale
          }))
        }))
      });
    }

    const shape = { Traffic: [1.7e9, 7e8], RequestTraffic: [1.8e8, 8e7], Requests: [38000, 15000] };
    const Data = [];
    for (const [index, field] of fields.entries()) {
      const [base, amplitude] = shape[field.FieldName] || [900, 300];
      const dims = field.Dimension.includes('EdgeCacheStatus')
        ? [['hit', 0.79], ['miss', 0.17], ['dynamic', 0.04]]
        : [['ALL', 1]];
      for (const [dimensionValue, weight] of dims) {
        const values = wave(times.length, base * weight, amplitude * weight, index + 3);
        Data.push({
          FieldName: field.FieldName,
          DimensionName: field.Dimension[0],
          DimensionValue: dimensionValue,
          DetailData: times.map((t, i) => ({ TimeStamp: new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'), Value: values[i] }))
        });
      }
    }

    if (action === 'DescribeSiteWafTimeSeriesData') {
      const values = wave(times.length, 220, 160, 9);
      return json({
        SamplingRate: 100,
        Data: [
          {
            FieldName: 'Requests',
            DimensionName: 'ALL',
            DimensionValue: 'ALL',
            DetailData: times.map((t, i) => ({ TimeStamp: new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'), Value: values[i] }))
          }
        ]
      });
    }

    return json({ SamplingRate: 100, Data });
  }

  /* ---- Cloudflare GraphQL ---- */
  const gql = JSON.parse(init.body || '{}');
  const start = Date.parse(gql.variables.since.length === 10 ? `${gql.variables.since}T00:00:00Z` : gql.variables.since);
  const end = Date.parse(gql.variables.until.length === 10 ? `${gql.variables.until}T23:59:59Z` : gql.variables.until);
  const buckets = Math.max(1, Math.min(200, Math.round((end - start) / HOUR)));
  const requests = wave(buckets, 26000, 11000, 4);
  const bytes = wave(buckets, 1.1e9, 5e8, 6);

  return json({
    data: {
      viewer: {
        zones: [
          {
            hourly: Array.from({ length: buckets }, (_, i) => ({
              dimensions: { datetime: new Date(start + i * HOUR).toISOString() },
              sum: {
                requests: requests[i],
                bytes: bytes[i],
                cachedRequests: Math.round(requests[i] * 0.71),
                cachedBytes: Math.round(bytes[i] * 0.83),
                threats: Math.round(requests[i] * 0.004),
                countryMap: [
                  { clientCountryName: 'CN', requests: Math.round(requests[i] * 0.5), bytes: Math.round(bytes[i] * 0.5) },
                  { clientCountryName: 'US', requests: Math.round(requests[i] * 0.2), bytes: Math.round(bytes[i] * 0.2) },
                  { clientCountryName: 'JP', requests: Math.round(requests[i] * 0.1), bytes: Math.round(bytes[i] * 0.1) }
                ],
                responseStatusMap: [
                  { edgeResponseStatus: 200, requests: Math.round(requests[i] * 0.93) },
                  { edgeResponseStatus: 404, requests: Math.round(requests[i] * 0.05) }
                ],
                browserMap: [
                  { uaBrowserFamily: 'Chrome', pageViews: Math.round(requests[i] * 0.6) },
                  { uaBrowserFamily: 'Safari', pageViews: Math.round(requests[i] * 0.25) }
                ],
                contentTypeMap: [
                  { edgeResponseContentTypeName: 'html', requests: Math.round(requests[i] * 0.4), bytes: Math.round(bytes[i] * 0.3) },
                  { edgeResponseContentTypeName: 'jpeg', requests: Math.round(requests[i] * 0.3), bytes: Math.round(bytes[i] * 0.5) }
                ]
              }
            }))
          }
        ]
      }
    }
  });
};

const { createApp } = await import('../src/app.js');
const port = Number(process.argv[2] || 3210);
createApp({ serveStatic: true }).listen(port, () => {
  console.log(`mock dashboard: http://localhost:${port}`);
});
