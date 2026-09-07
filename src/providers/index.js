import { cloudflare } from './cloudflare.js';
import { edgeone } from './edgeone.js';
import { esa } from './esa.js';

export const providers = { edgeone, esa, cloudflare };
export const providerOrder = ['edgeone', 'esa', 'cloudflare'];

export function getProvider(id) {
  const provider = providers[id];
  if (!provider) {
    throw Object.assign(new Error(`未知平台：${id}`), { statusCode: 400 });
  }
  return provider;
}

export function requireReady(config, id) {
  const provider = getProvider(id);
  if (!config.readiness[id]) {
    throw Object.assign(
      new Error(`${provider.label} 未配置，缺少环境变量：${config.missing[id].join('、')}`),
      { statusCode: 428, code: 'PlatformNotConfigured' }
    );
  }
  return provider;
}
