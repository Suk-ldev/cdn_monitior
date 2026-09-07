function str(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return '';
}

function list(...names) {
  const raw = str(...names);
  return raw ? raw.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function int(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

export function loadConfig(env = process.env) {
  const cfTokens = list('CF_TOKENS', 'CF_TOKEN', 'CLOUDFLARE_API_TOKEN');
  const cfZones = list('CF_ZONES', 'CF_ZONE_IDS');
  const cfDomains = list('CF_DOMAINS');

  const eoSecretId = str('EO_SECRET_ID', 'TENCENTCLOUD_SECRET_ID');
  const eoSecretKey = str('EO_SECRET_KEY', 'TENCENTCLOUD_SECRET_KEY');

  const esaKeyId = str('ESA_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_ID');
  const esaKeySecret = str('ESA_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIYUN_ACCESS_KEY_SECRET');

  const config = {
    debug: str('DEBUG').toLowerCase() === 'true',
    siteName: str('SITE_NAME') || 'CDN 流量分析看板',
    cacheTtlMs: int('CACHE_TTL', 60) * 1000,
    requestTimeoutMs: int('REQUEST_TIMEOUT', 20) * 1000,

    cloudflare: {
      token: cfTokens[0] || '',
      zones: cfZones.map((zoneId, index) => ({
        id: zoneId,
        name: cfDomains[index] || zoneId
      }))
    },

    edgeone: {
      secretId: eoSecretId,
      secretKey: eoSecretKey,
      region: str('EO_REGION') || 'ap-guangzhou',
      endpoint: str('EO_ENDPOINT') || 'teo.tencentcloudapi.com',
      zoneIds: list('EO_ZONE_IDS'),
      pagesProjects: list('EO_PAGES_PROJECTS')
    },

    esa: {
      accessKeyId: esaKeyId,
      accessKeySecret: esaKeySecret,
      securityToken: str('ESA_SECURITY_TOKEN', 'ALIBABA_CLOUD_SECURITY_TOKEN'),
      region: str('ESA_REGION') || 'cn-hangzhou',
      endpoint: str('ESA_ENDPOINT') || `esa.${str('ESA_REGION') || 'cn-hangzhou'}.aliyuncs.com`,
      siteIds: list('ESA_SITE_IDS')
    }
  };

  config.readiness = {
    cloudflare: Boolean(config.cloudflare.token && config.cloudflare.zones.length),
    edgeone: Boolean(config.edgeone.secretId && config.edgeone.secretKey),
    esa: Boolean(config.esa.accessKeyId && config.esa.accessKeySecret)
  };

  config.missing = {
    cloudflare: [
      !config.cloudflare.token && 'CF_TOKENS',
      !config.cloudflare.zones.length && 'CF_ZONES'
    ].filter(Boolean),
    edgeone: [
      !config.edgeone.secretId && 'EO_SECRET_ID',
      !config.edgeone.secretKey && 'EO_SECRET_KEY'
    ].filter(Boolean),
    esa: [
      !config.esa.accessKeyId && 'ESA_ACCESS_KEY_ID',
      !config.esa.accessKeySecret && 'ESA_ACCESS_KEY_SECRET'
    ].filter(Boolean)
  };

  const preferred = str('DEFAULT_PLATFORM').toLowerCase();
  const readyOrder = ['edgeone', 'esa', 'cloudflare'].filter((id) => config.readiness[id]);
  config.defaultPlatform =
    (config.readiness[preferred] && preferred) || readyOrder[0] || preferred || 'edgeone';

  void env;
  return config;
}

export function debugLog(config, ...args) {
  if (config?.debug) console.log('[cdn-monitor]', ...args);
}
