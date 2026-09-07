export class HttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch wrapper with timeout, JSON parsing and bounded retry on transient failures.
 */
export async function httpJson(url, { timeoutMs = 20000, retries = 2, signal, ...init } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        const error = new HttpError(
          parsed?.Message || parsed?.message || `HTTP ${response.status}`,
          { status: response.status, body: parsed ?? text.slice(0, 500) }
        );
        if (RETRIABLE_STATUS.has(response.status) && attempt < retries) {
          lastError = error;
          await sleep(200 * 2 ** attempt);
          continue;
        }
        throw error;
      }

      if (parsed === null && text) {
        throw new HttpError('响应不是合法的 JSON', { status: response.status, body: text.slice(0, 500) });
      }
      return parsed;
    } catch (error) {
      const aborted = error.name === 'AbortError';
      lastError = aborted ? new HttpError(`请求超时（${timeoutMs}ms）`) : error;
      const transient = aborted || error instanceof TypeError;
      if (!transient || attempt === retries) throw lastError;
      await sleep(200 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  throw lastError;
}

/**
 * Run tasks with bounded concurrency, never rejecting: each result is
 * { ok: true, value } or { ok: false, error }. Partial data beats a blank page.
 */
export async function settleAll(tasks, concurrency = 6) {
  const results = new Array(tasks.length);
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { ok: true, value: await tasks[index]() };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}
