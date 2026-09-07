export const INTERVALS = {
  min: { seconds: 60, label: '1 分钟' },
  '5min': { seconds: 300, label: '5 分钟' },
  hour: { seconds: 3600, label: '1 小时' },
  day: { seconds: 86400, label: '1 天' }
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

export const RANGES = {
  '1h': { hours: 1 },
  '6h': { hours: 6 },
  today: { day: 0 },
  yesterday: { day: -1 },
  '3d': { days: 3 },
  '7d': { days: 7 },
  '14d': { days: 14 },
  '31d': { days: 31 }
};

/** Largest span (ms) each granularity may cover, mirroring the vendors' own limits. */
const MAX_SPAN = {
  min: 3 * HOUR,
  '5min': 12 * HOUR,
  hour: 10 * DAY,
  day: 366 * DAY
};

export function autoInterval(spanMs) {
  if (spanMs <= 3 * HOUR) return 'min';
  if (spanMs <= 12 * HOUR) return '5min';
  if (spanMs <= 10 * DAY) return 'hour';
  return 'day';
}

/** Clamp a requested granularity up to one the span actually allows. */
export function clampInterval(interval, spanMs) {
  const order = ['min', '5min', 'hour', 'day'];
  let index = order.indexOf(interval);
  if (index === -1) return autoInterval(spanMs);
  while (index < order.length - 1 && spanMs > MAX_SPAN[order[index]]) index += 1;
  return order[index];
}

function isoSecond(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Resolve a time window. Explicit start/end win; otherwise a named range is
 * expanded against the caller's UTC offset in minutes (browser-provided).
 */
export function resolveRange({ start, end, range = 'today', offsetMinutes = 0, interval = 'auto' } = {}) {
  let startDate;
  let endDate;

  if (start && end) {
    startDate = new Date(start);
    endDate = new Date(end);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw Object.assign(new Error('start / end 不是合法的时间'), { statusCode: 400 });
    }
  } else {
    const spec = RANGES[range] || RANGES.today;
    const now = Date.now();
    const shift = offsetMinutes * 60 * 1000;

    if (spec.hours) {
      endDate = new Date(now);
      startDate = new Date(now - spec.hours * HOUR);
    } else if (spec.days) {
      endDate = new Date(now);
      startDate = new Date(now - spec.days * DAY);
    } else {
      // Local midnight, expressed as an absolute instant.
      const localNow = new Date(now + shift);
      const localMidnight = Date.UTC(
        localNow.getUTCFullYear(),
        localNow.getUTCMonth(),
        localNow.getUTCDate()
      );
      const dayStart = localMidnight + spec.day * DAY - shift;
      startDate = new Date(dayStart);
      endDate = spec.day === 0 ? new Date(now) : new Date(dayStart + DAY - 1000);
    }
  }

  if (endDate <= startDate) {
    throw Object.assign(new Error('结束时间必须晚于开始时间'), { statusCode: 400 });
  }

  const spanMs = endDate - startDate;
  const requested = interval === 'auto' ? autoInterval(spanMs) : interval;
  const resolved = clampInterval(requested, spanMs);

  return {
    start: isoSecond(startDate),
    end: isoSecond(endDate),
    startMs: startDate.getTime(),
    endMs: endDate.getTime(),
    spanMs,
    interval: resolved,
    intervalSeconds: INTERVALS[resolved].seconds,
    intervalAdjusted: resolved !== requested,
    requestedInterval: requested
  };
}

/** The immediately preceding window of equal length, for period-over-period deltas. */
export function previousRange(resolved) {
  const start = new Date(resolved.startMs - resolved.spanMs);
  const end = new Date(resolved.startMs);
  return { start: isoSecond(start), end: isoSecond(end), startMs: start.getTime(), endMs: end.getTime() };
}
