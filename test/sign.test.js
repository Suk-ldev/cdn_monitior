import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAuthorization as aliyunAuth, canonicalQuery } from '../src/lib/sign/aliyun.js';
import { buildAuthorization as tencentAuth } from '../src/lib/sign/tencent.js';

// Golden vectors produced by the official SDKs (@alicloud/openapi-core and
// tencentcloud-sdk-nodejs-common) so we can drop those heavy dependencies
// without losing confidence in the hand-rolled signers.

test('ACS3-HMAC-SHA256 matches the Alibaba Cloud SDK', () => {
  const query = {
    SiteId: '1150376036123',
    StartTime: '2026-01-01T00:00:00Z',
    EndTime: '2026-01-02T00:00:00Z',
    Interval: '3600',
    Fields: JSON.stringify([{ Dimension: ['ALL'], FieldName: 'Traffic' }])
  };
  const headers = {
    host: 'esa.cn-hangzhou.aliyuncs.com',
    accept: 'application/json',
    'x-acs-action': 'DescribeSiteTimeSeriesData',
    'x-acs-version': '2024-09-10',
    'x-acs-date': '2026-01-02T03:04:05Z',
    'x-acs-signature-nonce': 'deadbeefdeadbeefdeadbeefdeadbeef',
    'x-acs-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  };

  assert.equal(
    aliyunAuth({
      accessKeyId: 'AK_TEST_ID',
      accessKeySecret: 'AK_TEST_SECRET',
      method: 'POST',
      pathname: '/',
      query,
      headers,
      payloadHash: headers['x-acs-content-sha256']
    }),
    'ACS3-HMAC-SHA256 Credential=AK_TEST_ID,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=505a293bdf820cfc70ce591b456a134153dd1979d0425ea67505d09f06750e88'
  );
});

test('TC3-HMAC-SHA256 matches the Tencent Cloud SDK', () => {
  const payload = JSON.stringify({
    StartTime: '2026-01-01T00:00:00Z',
    EndTime: '2026-01-02T00:00:00Z',
    MetricNames: ['l7Flow_flux'],
    ZoneIds: ['zone-1']
  });

  assert.equal(
    tencentAuth({
      secretId: 'SID_TEST',
      secretKey: 'SKEY_TEST',
      host: 'teo.tencentcloudapi.com',
      payload,
      timestamp: 1767225845
    }),
    'TC3-HMAC-SHA256 Credential=SID_TEST/2026-01-01/teo/tc3_request, SignedHeaders=content-type;host, Signature=aef2abd76636174285e9aafa14501ea6a80e963d4a741f5a8057e02bbbc77e39'
  );
});

test('query canonicalization uses RFC 3986 escaping and sorted keys', () => {
  // Uppercase keys sort first (byte order), and an undefined value still emits
  // `key=` — both behaviours are what the SDK signs against.
  assert.equal(
    canonicalQuery({ b: "a*b(c)'d!", a: 'x y', Empty: undefined }),
    'Empty=&a=x%20y&b=a%2Ab%28c%29%27d%21'
  );
});
