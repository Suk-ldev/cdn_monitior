import axios from 'axios';
import 'dotenv/config';
import { teo } from "tencentcloud-sdk-nodejs-teo";
import { CommonClient } from "tencentcloud-sdk-nodejs-common";

const CF_API_URL = 'https://api.cloudflare.com/client/v4/graphql';

const DEBUG = process.env.DEBUG === 'true';

function log(...args) {
  if (DEBUG) {
    console.log('[DEBUG]', ...args);
  }
}

function getCloudflareTokens() {
  const tokens = process.env.CF_TOKENS ? process.env.CF_TOKENS.split(',').map(t => t.trim()) : [];
  const zones = process.env.CF_ZONES ? process.env.CF_ZONES.split(',').map(z => z.trim()) : [];
  const domains = process.env.CF_DOMAINS ? process.env.CF_DOMAINS.split(',').map(d => d.trim()) : zones;

  return {
    token: tokens[0],
    zones: zones.map((zoneId, index) => ({
      zone_id: zoneId,
      domain: domains[index] || zoneId
    }))
  };
}

function getEdgeOneKeys() {
  let secretId = process.env.EO_SECRET_ID;
  let secretKey = process.env.EO_SECRET_KEY;

  if (!secretId || !secretKey) {
    return { secretId: null, secretKey: null };
  }

  return { secretId, secretKey };
}

const ORIGIN_PULL_METRICS = [
  'l7Flow_outFlux_hy',
  'l7Flow_outBandwidth_hy',
  'l7Flow_request_hy',
  'l7Flow_inFlux_hy',
  'l7Flow_inBandwidth_hy'
];

const TOP_ANALYSIS_METRICS = [
  'l7Flow_outFlux_country',
  'l7Flow_outFlux_province',
  'l7Flow_outFlux_statusCode',
  'l7Flow_outFlux_domain',
  'l7Flow_outFlux_url',
  'l7Flow_outFlux_resourceType',
  'l7Flow_outFlux_sip',
  'l7Flow_outFlux_referers',
  'l7Flow_outFlux_ua_device',
  'l7Flow_outFlux_ua_browser',
  'l7Flow_outFlux_ua_os',
  'l7Flow_outFlux_ua',
  'l7Flow_request_country',
  'l7Flow_request_province',
  'l7Flow_request_statusCode',
  'l7Flow_request_domain',
  'l7Flow_request_url',
  'l7Flow_request_resourceType',
  'l7Flow_request_sip',
  'l7Flow_request_referers',
  'l7Flow_request_ua_device',
  'l7Flow_request_ua_browser',
  'l7Flow_request_ua_os',
  'l7Flow_request_ua'
];

const SECURITY_METRICS = [
  'ccAcl_interceptNum',
  'ccManage_interceptNum',
  'ccRate_interceptNum'
];

const FUNCTION_METRICS = [
  'function_requestCount',
  'function_cpuCostTime'
];

// Parse query string from URL
function parseQueryString(url) {
  const queryString = url.split('?')[1] || '';
  const params = {};
  
  queryString.split('&').forEach(param => {
    const [key, value] = param.split('=');
    if (key) {
      params[key] = decodeURIComponent(value || '');
    }
  });
  
  return params;
}

// Handle API requests for EdgeOne Pages
async function handleRequest(event) {
  const { request } = event;
  const url = new URL(request.url);
  const path = url.pathname;
  const query = parseQueryString(url.search);
  
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };
  
  // Handle OPTIONS requests
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers
    });
  }
  
  // Handle API routes
  if (path === '/api/config') {
    return new Response(JSON.stringify({
      siteName: process.env.SITE_NAME || 'CDN站点流量分析',
      siteIcon: process.env.SITE_ICON || 'https://cloudflare.com/favicon.ico',
      eoIcon: process.env.EO_ICON || 'https://cloud.tencent.com/favicon.ico'
    }), {
      status: 200,
      headers
    });
  }
  
  if (path === '/api/zones') {
    try {
      const platform = query.platform || 'cloudflare';

      if (platform === 'edgeone') {
        const { secretId, secretKey } = getEdgeOneKeys();
        
        if (!secretId || !secretKey) {
          return new Response(JSON.stringify({ error: "Missing EdgeOne credentials" }), {
            status: 500,
            headers
          });
        }

        const TeoClient = teo.v20220901.Client;
        const clientConfig = {
          credential: {
            secretId: secretId,
            secretKey: secretKey,
          },
          region: "ap-guangzhou",
          profile: {
            httpProfile: {
              endpoint: "teo.tencentcloudapi.com",
            },
          },
        };

        const client = new TeoClient(clientConfig);
        const params = {};
        
        log("Calling DescribeZones...");
        const data = await client.DescribeZones(params);
        return new Response(JSON.stringify(data), {
          status: 200,
          headers
        });
      } else {
        const { zones } = getCloudflareTokens();
        return new Response(JSON.stringify({
          Zones: zones.map(z => ({
            ZoneId: z.zone_id,
            ZoneName: z.domain
          }))
        }), {
          status: 200,
          headers
        });
      }
    } catch (err) {
      console.error("Error calling zones API:", err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers
      });
    }
  }
  
  if (path === '/api/analytics') {
    try {
      const { token, zones } = getCloudflareTokens();

      if (!token || zones.length === 0) {
        return new Response(JSON.stringify({ error: 'Missing CF_TOKENS or CF_ZONES configuration' }), {
          status: 500,
          headers
        });
      }

      const payload = { accounts: [] };

      for (const [accIndex, accZone] of zones.entries()) {
        log(`Processing zone ${accIndex + 1}/${zones.length}: ${accZone.domain}`);
        const accData = { name: `Account ${accIndex + 1}`, zones: [] };

        // Get daily data (for 7-day and 30-day views)
        const daysSince = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // 45 days ago
        const daysUntil = new Date().toISOString().slice(0, 10); // Today

        log(`Querying daily data range: ${daysSince} to ${daysUntil}`);

        const daysQuery = `
          query($zone: String!, $since: Date!, $until: Date!) {
            viewer {
              zones(filter: {zoneTag: $zone}) {
                httpRequests1dGroups(
                  filter: {date_geq: $since, date_leq: $until}
                  limit: 100
                  orderBy: [date_DESC]
                ) {
                  dimensions {
                    date
                  }
                  sum {
                    requests
                    bytes
                    threats
                    cachedRequests
                    cachedBytes
                  }
                }
              }
            }
          }`;

        // Get hourly data (for 1-day and 3-day views, limited to 3 days)
        const hoursSince = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ago
        const hoursUntil = new Date().toISOString(); // Now

        log(`Querying hourly data range: ${hoursSince} to ${hoursUntil}`);

        const hoursQuery = `
          query($zone: String!, $since: Time!, $until: Time!) {
            viewer {
              zones(filter: {zoneTag: $zone}) {
                httpRequests1hGroups(
                  filter: {datetime_geq: $since, datetime_leq: $until}
                  limit: 200
                  orderBy: [datetime_DESC]
                ) {
                  dimensions {
                    datetime
                  }
                  sum {
                    requests
                    bytes
                    threats
                    cachedRequests
                    cachedBytes
                  }
                }
              }
            }
          }`;

        // Get geography data (for today, following API time range limits)
        const today = new Date().toISOString().slice(0, 10); // Today's date
        const geoSince = today; // From today
        const geoUntil = today; // To today

        log(`Querying geography data range: ${geoSince} to ${geoUntil}`);

        const geoQuery = `
          query($zone: String!, $since: Date!, $until: Date!) {
            viewer {
              zones(filter: {zoneTag: $zone}) {
                httpRequests1dGroups(
                  filter: {date_geq: $since, date_leq: $until}
                  limit: 100
                  orderBy: [date_DESC]
                ) {
                  dimensions {
                    date
                  }
                  sum {
                    countryMap {
                      bytes
                      requests
                      threats
                      clientCountryName
                    }
                  }
                }
              }
            }
          }`;

        // Parallel requests for all data types
        const [daysRes, hoursRes, geoRes] = await Promise.allSettled([
          axios.post(
            CF_API_URL,
            { query: daysQuery, variables: { zone: accZone.zone_id, since: daysSince, until: daysUntil } },
            {
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              timeout: 30000
            }
          ),
          axios.post(
            CF_API_URL,
            { query: hoursQuery, variables: { zone: accZone.zone_id, since: hoursSince, until: hoursUntil } },
            {
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              timeout: 30000
            }
          ),
          axios.post(
            CF_API_URL,
            { query: geoQuery, variables: { zone: accZone.zone_id, since: geoSince, until: geoUntil } },
            {
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              timeout: 30000
            }
          )
        ]);

        const zoneData = { domain: accZone.domain, raw: [], rawHours: [], geography: [] };

        // Handle daily data response
        if (daysRes.status === 'rejected' || daysRes.reason) {
          log(`Daily data API error for zone ${accZone.domain}:`, daysRes.reason?.message || daysRes.reason);
          zoneData.error = daysRes.reason?.message || 'Daily data API request failed';
        } else if (daysRes.value?.data?.errors) {
          log(`Daily data API error for zone ${accZone.domain}:`, daysRes.value.data.errors);
          zoneData.error = daysRes.value.data.errors[0]?.message || 'Daily data API request failed';
        } else if (daysRes.value?.data?.data?.viewer?.zones?.[0]?.httpRequests1dGroups) {
          const rawData = daysRes.value.data.data.viewer.zones[0].httpRequests1dGroups;
          log(`Zone ${accZone.domain} daily data retrieved: ${rawData.length} records`);
          zoneData.raw = rawData;

          if (rawData.length > 0) {
            const latestDates = rawData.slice(0, 3).map(d => d.dimensions.date);
            log(`Latest daily data dates: ${latestDates.join(', ')}`);
          }
        }

        // Handle hourly data response
        if (hoursRes.status === 'rejected' || hoursRes.reason) {
          log(`Hourly data API error for zone ${accZone.domain}:`, hoursRes.reason?.message || hoursRes.reason);
          if (!zoneData.error) {
            zoneData.error = hoursRes.reason?.message || 'Hourly data API request failed';
          }
        } else if (hoursRes.value?.data?.errors) {
          log(`Hourly data API error for zone ${accZone.domain}:`, hoursRes.value.data.errors);
          if (!zoneData.error) {
            zoneData.error = hoursRes.value.data.errors[0]?.message || 'Hourly data API request failed';
          }
        } else if (hoursRes.value?.data?.data?.viewer?.zones?.[0]?.httpRequests1hGroups) {
          const rawHoursData = hoursRes.value.data.data.viewer.zones[0].httpRequests1hGroups;
          log(`Zone ${accZone.domain} hourly data retrieved: ${rawHoursData.length} records`);
          zoneData.rawHours = rawHoursData;

          if (rawHoursData.length > 0) {
            const latestHours = rawHoursData.slice(0, 3).map(d => d.dimensions.datetime);
            log(`Latest hourly data times: ${latestHours.join(', ')}`);
          }
        }

        // Handle geography data response
        if (geoRes.status === 'rejected' || geoRes.reason) {
          log(`Geography data API error for zone ${accZone.domain}:`, geoRes.reason?.message || geoRes.reason);
          if (!zoneData.error) {
            zoneData.error = geoRes.reason?.message || 'Geography data API request failed';
          }
        } else if (geoRes.value?.data?.errors) {
          log(`Geography data API error for zone ${accZone.domain}:`, geoRes.value.data.errors);
          if (!zoneData.error) {
            zoneData.error = geoRes.value.data.errors[0]?.message || 'Geography data API request failed';
          }
        } else if (geoRes.value?.data?.data?.viewer?.zones?.[0]?.httpRequests1dGroups) {
          const rawGeoData = geoRes.value.data.data.viewer.zones[0].httpRequests1dGroups;
          log(`Zone ${accZone.domain} geography data retrieved: ${rawGeoData.length} records`);

          // Aggregate geography data (summarize today's data by country)
          const countryStats = {};
          rawGeoData.forEach(record => {
            // Process countryMap array, each record may contain data for multiple countries
            if (record.sum?.countryMap && Array.isArray(record.sum.countryMap)) {
              record.sum.countryMap.forEach(countryData => {
                const country = countryData.clientCountryName;
                if (country && country !== 'Unknown' && country !== '') {
                  if (!countryStats[country]) {
                    countryStats[country] = {
                      dimensions: { clientCountryName: country },
                      sum: { requests: 0, bytes: 0, threats: 0 }
                    };
                  }
                  // Use actual data from countryMap
                  countryStats[country].sum.requests += countryData.requests || 0;
                  countryStats[country].sum.bytes += countryData.bytes || 0;
                  countryStats[country].sum.threats += countryData.threats || 0;
                }
              });
            }
          });

          // Convert to array and sort
          zoneData.geography = Object.values(countryStats)
            .sort((a, b) => b.sum.requests - a.sum.requests)
            .slice(0, 15); // Keep only top 15 countries

          if (zoneData.geography.length > 0) {
            const topCountries = zoneData.geography.slice(0, 5).map(d =>
              `${d.dimensions.clientCountryName}: ${d.sum.requests}`);
            log(`Top 5 countries/regions: ${topCountries.join(', ')}`);
          }
        }

        accData.zones.push(zoneData);
        payload.accounts.push(accData);
      }

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers
      });
    } catch (err) {
      console.error("Error calling analytics API:", err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers
      });
    }
  }
  
  if (path === '/api/traffic') {
    try {
      const platform = query.platform || 'cloudflare';
      const metric = query.metric || "l7Flow_flux";
      const startTime = query.startTime;
      const endTime = query.endTime;
      const interval = query.interval;
      const zoneId = query.zoneId;

      if (platform === 'edgeone') {
        const { secretId, secretKey } = getEdgeOneKeys();
        
        if (!secretId || !secretKey) {
          return new Response(JSON.stringify({ error: "Missing EO_SECRET_ID or EO_SECRET_KEY configuration" }), {
            status: 500,
            headers
          });
        }

        const TeoClient = teo.v20220901.Client;
        const clientConfig = {
          credential: {
            secretId: secretId,
            secretKey: secretKey,
          },
          region: "ap-guangzhou",
          profile: {
            httpProfile: {
              endpoint: "teo.tencentcloudapi.com",
            },
          },
        };

        const client = new TeoClient(clientConfig);
        // For EdgeOne, always include ZoneIds parameter
        const zoneIds = zoneId ? [ zoneId ] : [];

        let params = {};
        let data;

        log(`Requesting EdgeOne metric: ${metric}, StartTime: ${startTime}, EndTime: ${endTime}, Interval: ${interval}`);

        if (TOP_ANALYSIS_METRICS.includes(metric)) {
          params = {
            "StartTime": startTime,
            "EndTime": endTime,
            "MetricName": metric,
            "ZoneIds": zoneIds
          };
          log("Calling DescribeTopL7AnalysisData with params:", JSON.stringify(params, null, 2));
          data = await client.DescribeTopL7AnalysisData(params);
        } else if (SECURITY_METRICS.includes(metric)) {
          params = {
            "StartTime": startTime,
            "EndTime": endTime,
            "MetricNames": [ metric ],
            "ZoneIds": zoneIds
          };

          if (interval && interval !== 'auto') {
            params["Interval"] = interval;
          }
          
          const commonClientConfig = {
            credential: {
              secretId: secretId,
              secretKey: secretKey,
            },
            region: "ap-guangzhou",
            profile: {
              httpProfile: {
                endpoint: "teo.tencentcloudapi.com",
              },
            },
          };

          const commonClient = new CommonClient(
            "teo.tencentcloudapi.com",
            "2022-09-01",
            commonClientConfig
          );

          log("Calling DescribeWebProtectionData with params:", JSON.stringify(params, null, 2));
          data = await commonClient.request("DescribeWebProtectionData", params);
          
        } else if (FUNCTION_METRICS.includes(metric)) {
          let metricNames = [metric];
          if (metric === 'function_cpuCostTime') {
            metricNames = ["function_requestCount", "function_cpuCostTime"];
          }

          params = {
            "StartTime": startTime,
            "EndTime": endTime,
            "MetricNames": metricNames,
            "ZoneIds": zoneIds
          };

          if (interval && interval !== 'auto') {
            params["Interval"] = interval;
          }

          log("Calling DescribeTimingFunctionAnalysisData with params:", JSON.stringify(params, null, 2));
          
          const commonClientConfig = {
            credential: {
              secretId: secretId,
              secretKey: secretKey,
            },
            region: "ap-guangzhou",
            profile: {
              httpProfile: {
                endpoint: "teo.tencentcloudapi.com",
              },
            },
          };

          const commonClient = new CommonClient(
            "teo.tencentcloudapi.com",
            "2022-09-01",
            commonClientConfig
          );

          data = await commonClient.request("DescribeTimingFunctionAnalysisData", params);

        } else {
          params = {
            "StartTime": startTime,
            "EndTime": endTime,
            "MetricNames": [ metric ],
            "ZoneIds": zoneIds
          };

          if (interval && interval !== 'auto') {
            params["Interval"] = interval;
          }
          
          log("Calling Timing API with params:", JSON.stringify(params, null, 2));
          
          if (ORIGIN_PULL_METRICS.includes(metric)) {
            // For origin pull data, use correct parameters
            const originPullParams = {
              StartTime: startTime,
              EndTime: endTime,
              MetricNames: [metric],
              ZoneIds: zoneIds
            };
            if (interval && interval !== 'auto') {
              originPullParams.Interval = interval;
            }
            data = await client.DescribeTimingL7OriginPullData(originPullParams);
          } else {
            data = await client.DescribeTimingL7AnalysisData(params);
          }
        }
        
        return new Response(JSON.stringify(data), {
          status: 200,
          headers
        });
      } else {
        const { token, zones } = getCloudflareTokens();

        if (!token || zones.length === 0) {
          return new Response(JSON.stringify({ error: 'Missing CF_TOKENS or CF_ZONES configuration' }), {
            status: 500,
            headers
          });
        }

        const targetZoneId = zoneId && zoneId !== '*' ? zoneId : zones[0].zone_id;

        const now = new Date();
        const start = new Date(startTime);
        const end = new Date(endTime);
        const diffHours = (end - start) / (1000 * 60 * 60);

        // Define metric mappings for Cloudflare
        const metricMappings = {
          // Standard metrics that map to Cloudflare fields
          'l7Flow_request': { 
            queryField: 'requests', 
            description: '请求数' 
          },
          'l7Flow_flux': { 
            queryField: 'bytes', 
            description: '流量' 
          },
          'l7Flow_inFlux': { 
            queryField: 'bytes', 
            description: '入站流量' 
          },
          'l7Flow_outFlux': { 
            queryField: 'bytes', 
            description: '出站流量' 
          },
          'l7Flow_bandwidth': { 
            queryField: 'bytes', 
            description: '带宽' 
          },
          'l7Flow_inBandwidth': { 
            queryField: 'bytes', 
            description: '入站带宽' 
          },
          'l7Flow_outBandwidth': { 
            queryField: 'bytes', 
            description: '出站带宽' 
          },
          // Origin pull metrics (these don't exist in Cloudflare API, return empty)
          'l7Flow_outFlux_hy': { 
            queryField: 'origin_bytes', // Not supported in Cloudflare, will return empty
            description: '回源流量' 
          },
          'l7Flow_inFlux_hy': { 
            queryField: 'origin_bytes', // Not supported in Cloudflare, will return empty
            description: '回源入站流量' 
          },
          'l7Flow_outBandwidth_hy': { 
            queryField: 'origin_bytes', // Not supported in Cloudflare, will return empty
            description: '回源出站带宽' 
          },
          'l7Flow_inBandwidth_hy': { 
            queryField: 'origin_bytes', // Not supported in Cloudflare, will return empty
            description: '回源入站带宽' 
          },
          'l7Flow_request_hy': { 
            queryField: 'origin_requests', // Not supported in Cloudflare, will return empty
            description: '回源请求数' 
          },
          // Performance metrics (not directly supported in Cloudflare, return 0)
          'l7Flow_avgResponseTime': { 
            queryField: 'avgResponseTime', 
            description: '平均响应时间' 
          },
          'l7Flow_avgFirstByteResponseTime': { 
            queryField: 'avgFirstByteTime', 
            description: '平均首字节时间' 
          }
        };

        // Determine which field to use based on the metric
        const metricInfo = metricMappings[metric] || { queryField: 'requests', description: '请求数' };
        const queryField = metricInfo.queryField;

        // For origin pull metrics and unsupported metrics, return empty data for Cloudflare
        if (queryField.includes('origin_')) {
          log(`Cloudflare does not support origin pull metrics: ${metric}`);
          return new Response(JSON.stringify({ Data: [] }), {
            status: 200,
            headers
          });
        }

        let query, variables;

        if (diffHours <= 24) {
          query = `
            query($zone: String!, $since: Time!, $until: Time!) {
              viewer {
                zones(filter: {zoneTag: $zone}) {
                  httpRequests1hGroups(
                    filter: {datetime_geq: $since, datetime_leq: $until}
                    limit: 200
                    orderBy: [datetime_DESC]
                  ) {
                    dimensions {
                      datetime
                    }
                    sum {
                      requests
                      bytes
                      threats
                      cachedRequests
                      cachedBytes
                    }
                  }
                }
              }
            }`;

          variables = { 
            zone: targetZoneId, 
            since: startTime, 
            until: endTime 
          };
        } else {
          query = `
            query($zone: String!, $since: Date!, $until: Date!) {
              viewer {
                zones(filter: {zoneTag: $zone}) {
                  httpRequests1dGroups(
                    filter: {date_geq: $since, date_leq: $until}
                    limit: 100
                    orderBy: [date_DESC]
                  ) {
                    dimensions {
                      date
                    }
                    sum {
                      requests
                      bytes
                      threats
                      cachedRequests
                      cachedBytes
                    }
                  }
                }
              }
            }`;

          variables = { 
            zone: targetZoneId, 
            since: startTime.slice(0, 10), 
            until: endTime.slice(0, 10) 
          };
        }

        log("Calling Cloudflare GraphQL API with query:", query);
        log("Variables:", variables);

        const response = await axios.post(
          CF_API_URL,
          { query, variables },
          {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 30000
          }
        );

        log("Cloudflare API response:", JSON.stringify(response.data, null, 2));

        if (response.data.data?.viewer?.zones?.[0]) {
          const zoneData = response.data.data.viewer.zones[0];
          const groups = zoneData.httpRequests1hGroups || zoneData.httpRequests1dGroups || [];

          // Process data based on the specific field for the metric
          const detail = groups.map(g => {
            let value = 0;
            
            // Determine the value based on the metric type
            if (queryField === 'requests') {
              value = g.sum.requests || 0;
            } else if (queryField === 'bytes') {
              value = g.sum.bytes || 0;
            } else if (queryField === 'avgResponseTime' || queryField === 'avgFirstByteTime') {
              // For response time metrics, we'll use a placeholder since Cloudflare doesn't provide this in the same way
              // We'll return 0 for now, but in a real implementation you'd need to find the right field
              value = 0;
            } else {
              // Default to requests if unknown field
              value = g.sum.requests || 0;
            }
            
            return {
              Timestamp: Math.floor(new Date(g.dimensions.datetime || g.dimensions.date).getTime() / 1000),
              Value: value
            };
          });

          const sum = detail.reduce((acc, d) => acc + d.Value, 0);
          const max = Math.max(...detail.map(d => d.Value));
          const avg = sum / (detail.length || 1);

          const data = [{
            TypeValue: [{
              MetricName: metric,
              Sum: sum,
              Max: max,
              Avg: avg,
              Detail: detail
            }]
          }];

          return new Response(JSON.stringify({ Data: data }), {
            status: 200,
            headers
          });
        } else {
          return new Response(JSON.stringify({ Data: [] }), {
            status: 200,
            headers
          });
        }
      }
    } catch (err) {
      console.error("Error calling traffic API:", err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers
      });
    }
  }
  
  if (path === '/api/health') {
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers
    });
  }
  
  if (path === '/pages/build-count') {
    try {
      const { secretId, secretKey } = getEdgeOneKeys();
      
      if (!secretId || !secretKey) {
        return new Response(JSON.stringify({ error: "Missing EdgeOne credentials" }), {
          status: 500,
          headers
        });
      }

      const commonClientConfig = {
        credential: {
          secretId: secretId,
          secretKey: secretKey,
        },
        region: "ap-guangzhou",
        profile: {
          httpProfile: {
            endpoint: "teo.tencentcloudapi.com",
          },
        },
      };

      const client = new CommonClient(
        "teo.tencentcloudapi.com",
        "2022-09-01",
        commonClientConfig
      );

      let targetZoneId = query.zoneId;

      if (!targetZoneId) {
        try {
          const TeoClient = teo.v20220901.Client;
          const teoClient = new TeoClient({
            credential: { secretId, secretKey },
            region: "ap-guangzhou",
            profile: { httpProfile: { endpoint: "teo.tencentcloudapi.com" } }
          });
          
          const zonesData = await teoClient.DescribeZones({});
          if (zonesData && zonesData.Zones) {
            const pagesZone = zonesData.Zones.find(z => z.ZoneName === 'default-pages-zone');
            if (pagesZone) {
              targetZoneId = pagesZone.ZoneId;
              log(`Found default-pages-zone: ${targetZoneId}`);
            } else if (zonesData.Zones.length > 0) {
              targetZoneId = zonesData.Zones[0].ZoneId;
              log(`default-pages-zone not found, using first zone: ${targetZoneId}`);
            }
          }
        } catch (zErr) {
          console.error("Error fetching zones for Pages:", zErr);
        }
      }

      if (!targetZoneId) {
        return new Response(JSON.stringify({ error: "Missing ZoneId and could not auto-discover one." }), {
          status: 400,
          headers
        });
      }

      const params = {
        "Interface": "pages:DescribePagesDeploymentUsage",
        "Payload": "{}",
        "ZoneId": targetZoneId
      };
      
      log("Calling DescribePagesResources with params:", JSON.stringify(params));
      const data = await client.request("DescribePagesResources", params);
      
      if (data && data.Result) {
        try {
          data.parsedResult = JSON.parse(data.Result);
        } catch (e) {
          console.error("Error parsing Result JSON:", e);
        }
      }
      
      return new Response(JSON.stringify(data), {
        status: 200,
        headers
      });
    } catch (err) {
      console.error("Error calling DescribePagesResources:", err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers
      });
    }
  }
  
  if (path === '/pages/cloud-function-requests') {
    try {
      const { secretId, secretKey } = getEdgeOneKeys();
      
      if (!secretId || !secretKey) {
        return new Response(JSON.stringify({ error: "Missing EdgeOne credentials" }), {
          status: 500,
          headers
        });
      }

      const commonClientConfig = {
        credential: {
          secretId: secretId,
          secretKey: secretKey,
        },
        region: "ap-guangzhou",
        profile: {
          httpProfile: {
            endpoint: "teo.tencentcloudapi.com",
          },
        },
      };

      const client = new CommonClient(
        "teo.tencentcloudapi.com",
        "2022-09-01",
        commonClientConfig
      );

      let targetZoneId = query.zoneId;
      const { startTime, endTime } = query;

      if (!targetZoneId) {
        try {
          const TeoClient = teo.v20220901.Client;
          const teoClient = new TeoClient({
            credential: { secretId, secretKey },
            region: "ap-guangzhou",
            profile: { httpProfile: { endpoint: "teo.tencentcloudapi.com" } }
          });
          
          const zonesData = await teoClient.DescribeZones({});
          if (zonesData && zonesData.Zones) {
            const pagesZone = zonesData.Zones.find(z => z.ZoneName === 'default-pages-zone');
            if (pagesZone) {
              targetZoneId = pagesZone.ZoneId;
              log(`Found default-pages-zone: ${targetZoneId}`);
            } else if (zonesData.Zones.length > 0) {
              targetZoneId = zonesData.Zones[0].ZoneId;
              log(`default-pages-zone not found, using first zone: ${targetZoneId}`);
            }
          }
        } catch (zErr) {
          console.error("Error fetching zones for Pages:", zErr);
        }
      }

      if (!targetZoneId) {
        return new Response(JSON.stringify({ error: "Missing ZoneId and could not auto-discover one." }), {
          status: 400,
          headers
        });
      }

      const payload = {
        ZoneId: targetZoneId,
        Interval: "hour"
      };
      
      if (startTime) payload.StartTime = startTime;
      if (endTime) payload.EndTime = endTime;

      const params = {
        "ZoneId": targetZoneId,
        "Interface": "pages:DescribePagesFunctionsRequestDataByZone",
        "Payload": JSON.stringify(payload)
      };
      
      log("Calling DescribePagesResources (CloudFunction) with params:", JSON.stringify(params));
      const data = await client.request("DescribePagesResources", params);
      
      if (data && data.Result) {
        try {
          data.parsedResult = JSON.parse(data.Result);
        } catch (e) {
          console.error("Error parsing Result JSON:", e);
        }
      }
      
      return new Response(JSON.stringify(data), {
        status: 200,
        headers
      });
    } catch (err) {
      console.error("Error calling DescribePagesResources for CloudFunction:", err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers
      });
    }
  }
  
  if (path === '/pages/cloud-function-monthly-stats') {
    try {
      const { secretId, secretKey } = getEdgeOneKeys();
      
      if (!secretId || !secretKey) {
        return new Response(JSON.stringify({ error: "Missing EdgeOne credentials" }), {
          status: 500,
          headers
        });
      }

      const commonClientConfig = {
        credential: {
          secretId: secretId,
          secretKey: secretKey,
        },
        region: "ap-guangzhou",
        profile: {
          httpProfile: {
            endpoint: "teo.tencentcloudapi.com",
          },
        },
      };

      const client = new CommonClient(
        "teo.tencentcloudapi.com",
        "2022-09-01",
        commonClientConfig
      );

      let targetZoneId = query.zoneId;

      if (!targetZoneId) {
        try {
          const TeoClient = teo.v20220901.Client;
          const teoClient = new TeoClient({
            credential: { secretId, secretKey },
            region: "ap-guangzhou",
            profile: { httpProfile: { endpoint: "teo.tencentcloudapi.com" } }
          });
          
          const zonesData = await teoClient.DescribeZones({});
          if (zonesData && zonesData.Zones) {
            const pagesZone = zonesData.Zones.find(z => z.ZoneName === 'default-pages-zone');
            if (pagesZone) {
              targetZoneId = pagesZone.ZoneId;
              log(`Found default-pages-zone: ${targetZoneId}`);
            } else if (zonesData.Zones.length > 0) {
              targetZoneId = zonesData.Zones[0].ZoneId;
              log(`default-pages-zone not found, using first zone: ${targetZoneId}`);
            }
          }
        } catch (zErr) {
          console.error("Error fetching zones for Pages:", zErr);
        }
      }

      if (!targetZoneId) {
        return new Response(JSON.stringify({ error: "Missing ZoneId and could not auto-discover one." }), {
          status: 400,
          headers
        });
      }

      const payload = {
        ZoneId: targetZoneId,
      };

      const params = {
        "ZoneId": targetZoneId,
        "Interface": "pages:DescribeHistoryCloudFunctionStats",
        "Payload": JSON.stringify(payload)
      };
      
      log("Calling DescribePagesResources (CloudFunction Monthly) with params:", JSON.stringify(params));
      const data = await client.request("DescribePagesResources", params);
      
      if (data && data.Result) {
        try {
          data.parsedResult = JSON.parse(data.Result);
        } catch (e) {
          console.error("Error parsing Result JSON:", e);
        }
      }
      
      return new Response(JSON.stringify(data), {
        status: 200,
        headers
      });
    } catch (err) {
      console.error("Error calling DescribePagesResources for CloudFunction Monthly:", err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers
      });
    }
  }
  
  // Default response for unknown routes
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers
  });
}

export default handleRequest;