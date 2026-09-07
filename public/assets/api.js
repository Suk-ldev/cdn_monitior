const BASE = '/api';

let inflight = new Set();

export class ApiError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request(path, params = {}, { signal } = {}) {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  inflight.add(controller);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(body?.error?.message || `HTTP ${response.status}`, {
        code: body?.error?.code,
        status: response.status
      });
    }
    return body;
  } finally {
    inflight.delete(controller);
  }
}

/** Cancel every request still in flight — used when the user changes filters. */
export function abortAll() {
  for (const controller of inflight) controller.abort();
  inflight = new Set();
}

function rangeParams(state) {
  return {
    platform: state.platform,
    siteId: state.siteId,
    range: state.range,
    interval: state.interval,
    offset: -new Date().getTimezoneOffset()
  };
}

export const api = {
  meta: (options) => request('/meta', {}, options),
  sites: (platform, options) => request('/sites', { platform }, options),
  overview: (state, options) => request('/overview', { ...rangeParams(state), compare: '1' }, options),
  top: (state, options) =>
    request('/top', {
      ...rangeParams(state),
      metric: state.topMetric,
      dimensions: state.topDimensions.join(','),
      limit: state.topLimit
    }, options),
  pages: (state, options) => request('/pages', rangeParams(state), options)
};
