import crypto from 'node:crypto';
import { httpJson } from '../http.js';

const ALGORITHM = 'ACS3-HMAC-SHA256';

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// RFC 3986 percent-encoding, which differs from encodeURIComponent for !'()*
export function rfc3986(value) {
  return encodeURIComponent(String(value))
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

export function canonicalQuery(query) {
  return Object.keys(query)
    .sort()
    .map((key) => {
      const value = query[key];
      return value === undefined || value === null ? `${key}=` : `${key}=${rfc3986(value)}`;
    })
    .join('&');
}

export function canonicalHeaders(headers) {
  const grouped = {};
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (!lower.startsWith('x-acs-') && lower !== 'host' && lower !== 'content-type') continue;
    (grouped[lower] ||= []).push(String(headers[key] ?? '').trim());
  }
  const keys = Object.keys(grouped).sort();
  const text = keys.map((key) => `${key}:${grouped[key].sort().join(',')}\n`).join('');
  return { text, keys };
}

export function buildAuthorization({ accessKeyId, accessKeySecret, method, pathname, query, headers, payloadHash }) {
  const uri = (pathname || '/').replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
  const { text, keys } = canonicalHeaders(headers);
  const canonicalRequest = [
    method,
    uri,
    canonicalQuery(query),
    text,
    keys.join(';'),
    payloadHash
  ].join('\n');

  const stringToSign = `${ALGORITHM}\n${sha256hex(canonicalRequest)}`;
  const signature = crypto.createHmac('sha256', accessKeySecret).update(stringToSign).digest('hex');
  return `${ALGORITHM} Credential=${accessKeyId},SignedHeaders=${keys.join(';')},Signature=${signature}`;
}

function acsTimestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Call an Alibaba Cloud RPC-style API with the V3 signature. All parameters go in
 * the query string with an empty body, which is what the ESA analytics APIs expect.
 */
export async function aliyunRequest({
  endpoint,
  action,
  version,
  method = 'POST',
  query = {},
  accessKeyId,
  accessKeySecret,
  securityToken,
  timeoutMs = 20000,
  signal
}) {
  const cleanQuery = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') cleanQuery[key] = value;
  }

  const payloadHash = sha256hex('');
  const headers = {
    host: endpoint,
    accept: 'application/json',
    'x-acs-action': action,
    'x-acs-version': version,
    'x-acs-date': acsTimestamp(),
    'x-acs-signature-nonce': crypto.randomBytes(16).toString('hex'),
    'x-acs-content-sha256': payloadHash
  };
  if (securityToken) headers['x-acs-security-token'] = securityToken;

  headers.Authorization = buildAuthorization({
    accessKeyId,
    accessKeySecret,
    method,
    pathname: '/',
    query: cleanQuery,
    headers,
    payloadHash
  });

  const url = `https://${endpoint}/?${canonicalQuery(cleanQuery)}`;
  const body = await httpJson(url, { method, headers, timeoutMs, signal });

  if (body?.Code && body?.Message && !body?.Data && !body?.Sites) {
    throw Object.assign(new Error(body.Message), { code: body.Code, requestId: body.RequestId });
  }
  return body;
}
