import crypto from 'node:crypto';
import { httpJson } from '../http.js';

const ALGORITHM = 'TC3-HMAC-SHA256';

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function utcDate(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

export function buildAuthorization({ secretId, secretKey, host, payload, timestamp }) {
  const service = host.split('.')[0];
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256hex(payload)
  ].join('\n');

  const date = utcDate(timestamp);
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = [ALGORITHM, timestamp, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac(`TC3${secretKey}`, date);
  const kService = hmac(kDate, service);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return `${ALGORITHM} Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/**
 * Call a Tencent Cloud API v3 endpoint. Throws TencentApiError on business errors.
 */
export async function tencentRequest({
  host,
  action,
  version,
  region,
  params = {},
  secretId,
  secretKey,
  language = 'zh-CN',
  timeoutMs = 20000,
  signal
}) {
  const payload = JSON.stringify(params);
  const timestamp = Math.floor(Date.now() / 1000);

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    Host: host,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Language': language,
    Authorization: buildAuthorization({ secretId, secretKey, host, payload, timestamp })
  };
  if (region) headers['X-TC-Region'] = region;

  const body = await httpJson(`https://${host}/`, {
    method: 'POST',
    headers,
    body: payload,
    timeoutMs,
    signal
  });

  const response = body?.Response;
  if (!response) {
    throw Object.assign(new Error('腾讯云返回了无法解析的响应'), { code: 'InvalidResponse' });
  }
  if (response.Error) {
    throw Object.assign(new Error(response.Error.Message || '腾讯云接口调用失败'), {
      code: response.Error.Code,
      requestId: response.RequestId
    });
  }
  return response;
}
