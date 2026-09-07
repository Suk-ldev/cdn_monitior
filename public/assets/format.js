const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const BPS_UNITS = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
const COUNT_UNITS = ['', 'K', 'M', 'B'];

function scale(value, units, step) {
  let index = 0;
  let n = Math.abs(Number(value) || 0);
  while (n >= step && index < units.length - 1) {
    n /= step;
    index += 1;
  }
  const digits = n >= 100 || index === 0 ? 0 : n >= 10 ? 1 : 2;
  const sign = value < 0 ? '-' : '';
  return { text: sign + n.toFixed(digits), unit: units[index], factor: step ** index, index };
}

export function formatBytes(value) {
  const { text, unit } = scale(value, BYTE_UNITS, 1024);
  return { value: text, unit };
}

export function formatBps(value) {
  const { text, unit } = scale(value, BPS_UNITS, 1000);
  return { value: text, unit };
}

export function formatCount(value) {
  const { text, unit } = scale(value, COUNT_UNITS, 1000);
  return { value: text, unit };
}

export function formatMs(value) {
  const n = Number(value) || 0;
  return n >= 1000
    ? { value: (n / 1000).toFixed(2), unit: 's' }
    : { value: n.toFixed(n >= 100 ? 0 : 1), unit: 'ms' };
}

export function formatMetric(value, unit) {
  switch (unit) {
    case 'bytes':
      return formatBytes(value);
    case 'bps':
      return formatBps(value);
    case 'ms':
      return formatMs(value);
    case 'ratio':
      return { value: (Number(value) * 100).toFixed(2), unit: '%' };
    default:
      return formatCount(value);
  }
}

export function formatMetricText(value, unit) {
  const parts = formatMetric(value, unit);
  return parts.unit ? `${parts.value} ${parts.unit}` : parts.value;
}

/** Pick one divisor for a whole axis so the chart's ticks stay comparable. */
export function axisScale(maxValue, unit) {
  if (unit === 'bytes') {
    const { factor, index } = scale(maxValue, BYTE_UNITS, 1024);
    return { factor, suffix: BYTE_UNITS[index] };
  }
  if (unit === 'bps') {
    const { factor, index } = scale(maxValue, BPS_UNITS, 1000);
    return { factor, suffix: BPS_UNITS[index] };
  }
  if (unit === 'ms') return { factor: 1, suffix: 'ms' };
  const { factor, index } = scale(maxValue, COUNT_UNITS, 1000);
  return { factor, suffix: COUNT_UNITS[index] };
}

export function formatPercent(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatTimeLabel(tsMs, interval) {
  const date = new Date(tsMs);
  const pad = (n) => String(n).padStart(2, '0');
  if (interval === 'day') return `${date.getMonth() + 1}/${date.getDate()}`;
  if (interval === 'hour') return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:00`;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ECharts' bundled world map uses a handful of names that differ from the CLDR
// display names, so those get an explicit alias.
const MAP_NAME_ALIASES = {
  US: 'United States',
  GB: 'United Kingdom',
  RU: 'Russia',
  KR: 'Korea',
  KP: 'Dem. Rep. Korea',
  VN: 'Vietnam',
  LA: 'Lao PDR',
  SY: 'Syria',
  IR: 'Iran',
  TZ: 'Tanzania',
  VE: 'Venezuela',
  BO: 'Bolivia',
  MD: 'Moldova',
  CZ: 'Czech Rep.',
  DO: 'Dominican Rep.',
  CF: 'Central African Rep.',
  CD: 'Dem. Rep. Congo',
  SS: 'S. Sudan',
  BA: 'Bosnia and Herz.',
  MK: 'Macedonia',
  EH: 'W. Sahara',
  SO: 'Somalia',
  BN: 'Brunei',
  AE: 'United Arab Emirates'
};

const displayNameCache = new Map();

function displayNames(locale) {
  if (!displayNameCache.has(locale)) {
    try {
      displayNameCache.set(locale, new Intl.DisplayNames([locale], { type: 'region' }));
    } catch {
      displayNameCache.set(locale, null);
    }
  }
  return displayNameCache.get(locale);
}

/** ISO 3166-1 alpha-2 → human name, falling back to the raw key. */
export function countryName(code, locale = 'zh-CN') {
  const raw = String(code || '').trim();
  if (!/^[A-Za-z]{2}$/.test(raw)) return raw || '—';
  const names = displayNames(locale);
  try {
    return names?.of(raw.toUpperCase()) || raw;
  } catch {
    return raw;
  }
}

/** Name that matches ECharts' bundled world map geometry. */
export function mapRegionName(code) {
  const raw = String(code || '').trim().toUpperCase();
  if (MAP_NAME_ALIASES[raw]) return MAP_NAME_ALIASES[raw];
  return countryName(raw, 'en');
}
