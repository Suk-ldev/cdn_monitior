import { axisScale, formatMetricText, formatTimeLabel, mapRegionName } from './format.js';

const PALETTE = ['#2f6fed', '#12a150', '#e0a338', '#a855f7', '#e0393e', '#0ea5b7', '#f97316', '#64748b'];

const instances = new Map();
let resizeObserver = null;

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function theme() {
  return {
    text: cssVar('--text', '#14171a'),
    muted: cssVar('--text-muted', '#6b7280'),
    border: cssVar('--border', '#e3e6ea'),
    elevated: cssVar('--bg-elevated', '#ffffff'),
    subtle: cssVar('--bg-subtle', '#f0f2f5')
  };
}

function ensureObserver() {
  if (resizeObserver || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      instances.get(entry.target)?.resize();
    }
  });
}

export function getChart(el) {
  if (!el || typeof window.echarts === 'undefined') return null;
  let chart = instances.get(el);
  if (!chart || chart.isDisposed?.()) {
    chart = window.echarts.init(el, null, { renderer: 'canvas' });
    instances.set(el, chart);
    ensureObserver();
    resizeObserver?.observe(el);
  }
  return chart;
}

/** Returns false when ECharts is unavailable, so callers can fall back to HTML. */
export function renderChart(el, option) {
  const chart = getChart(el);
  if (!chart) return false;
  chart.setOption(option, { notMerge: true });
  chart.resize();
  return true;
}

/** Re-theme every live chart after a light/dark switch. */
export function refreshChartTheme() {
  for (const chart of instances.values()) {
    if (!chart.isDisposed?.()) chart.setOption(chart.getOption(), { notMerge: false });
  }
}

const baseGrid = { left: 8, right: 16, top: 32, bottom: 8, containLabel: true };

export function lineOption({ series, interval, stack = false, area = true }) {
  const t = theme();
  const usable = series.filter((item) => item.points?.length);
  const max = Math.max(1, ...usable.flatMap((item) => item.points.map(([, v]) => v)));
  const unit = usable[0]?.unit || 'count';
  const { factor, suffix } = axisScale(max, unit);

  return {
    color: PALETTE,
    grid: baseGrid,
    animationDuration: 320,
    tooltip: {
      trigger: 'axis',
      backgroundColor: t.elevated,
      borderColor: t.border,
      textStyle: { color: t.text, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: t.border } },
      formatter(params) {
        if (!params.length) return '';
        const head = new Date(params[0].value[0]).toLocaleString();
        const rows = params
          .map((p) => `${p.marker}${p.seriesName} <b>${formatMetricText(p.value[1], unit)}</b>`)
          .join('<br>');
        return `${head}<br>${rows}`;
      }
    },
    legend: {
      show: series.length > 1,
      top: 0,
      right: 0,
      icon: 'roundRect',
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: t.muted, fontSize: 11 }
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: t.border } },
      axisTick: { show: false },
      axisLabel: {
        color: t.muted,
        fontSize: 11,
        hideOverlap: true,
        formatter: (value) => formatTimeLabel(value, interval)
      },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: t.muted,
        fontSize: 11,
        formatter: (value) => {
          const scaled = value / factor;
          return `${scaled >= 100 || Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}${suffix ? ` ${suffix}` : ''}`;
        }
      },
      splitLine: { lineStyle: { color: t.border, type: 'dashed' } }
    },
    series: series.map((item, index) => ({
      name: item.name,
      type: 'line',
      smooth: 0.25,
      symbol: 'none',
      stack: stack ? 'total' : undefined,
      lineStyle: { width: 1.8 },
      areaStyle: area
        ? {
            opacity: stack ? 0.5 : 0.16,
            color: window.echarts?.graphic
              ? new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
                  { offset: 0, color: PALETTE[index % PALETTE.length] },
                  { offset: 1, color: 'transparent' }
                ])
              : undefined
          }
        : undefined,
      data: item.points
    }))
  };
}

export function barOption({ items, unit, labelOf }) {
  const t = theme();
  const sorted = [...items].reverse();
  const max = Math.max(1, ...sorted.map((item) => item.value));
  const { factor, suffix } = axisScale(max, unit);

  return {
    color: PALETTE,
    grid: { ...baseGrid, top: 12, left: 8, right: 56 },
    tooltip: {
      trigger: 'item',
      backgroundColor: t.elevated,
      borderColor: t.border,
      textStyle: { color: t.text, fontSize: 12 },
      formatter: (p) => `${p.name}<br><b>${formatMetricText(p.value, unit)}</b>`
    },
    xAxis: {
      type: 'value',
      show: false,
      axisLabel: { formatter: (v) => `${(v / factor).toFixed(1)} ${suffix}` }
    },
    yAxis: {
      type: 'category',
      data: sorted.map((item) => (labelOf ? labelOf(item.key) : item.key)),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: t.muted,
        fontSize: 11,
        width: 130,
        overflow: 'truncate'
      }
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 14,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        data: sorted.map((item) => item.value),
        label: {
          show: true,
          position: 'right',
          color: t.muted,
          fontSize: 11,
          formatter: (p) => formatMetricText(p.value, unit)
        }
      }
    ]
  };
}

export function mapOption({ items, unit }) {
  const t = theme();
  const data = items.map((item) => ({ name: mapRegionName(item.key), value: item.value }));
  const max = Math.max(1, ...data.map((item) => item.value));

  return {
    tooltip: {
      trigger: 'item',
      backgroundColor: t.elevated,
      borderColor: t.border,
      textStyle: { color: t.text, fontSize: 12 },
      formatter: (p) =>
        p.value ? `${p.name}<br><b>${formatMetricText(p.value, unit)}</b>` : `${p.name}<br>—`
    },
    visualMap: {
      min: 0,
      max,
      left: 8,
      bottom: 8,
      calculable: false,
      showLabel: false,
      itemWidth: 10,
      itemHeight: 70,
      inRange: { color: [t.subtle, '#8fb2ff', '#2f6fed', '#12306e'] },
      textStyle: { color: t.muted, fontSize: 10 }
    },
    series: [
      {
        type: 'map',
        map: 'world',
        roam: false,
        zoom: 1.2,
        top: 10,
        bottom: 10,
        itemStyle: { areaColor: t.subtle, borderColor: t.border },
        emphasis: { itemStyle: { areaColor: '#5b8dff' }, label: { show: false } },
        data
      }
    ]
  };
}
