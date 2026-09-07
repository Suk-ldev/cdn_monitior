import { abortAll, api } from './api.js';
import { barOption, lineOption, mapOption, refreshChartTheme, renderChart } from './charts.js';
import { countryName, formatDateTime } from './format.js';
import { createI18n } from './i18n.js';
import { banner, barList, chartCard, clear, el, emptyState, kpiCard, skeletonCards } from './ui.js';

const STORE_KEY = 'cdn-monitor:prefs';

const state = {
  platform: '',
  siteId: '',
  range: 'today',
  interval: 'auto',
  topMetric: 'traffic',
  topLimit: 10,
  topDimensions: [],
  autoRefresh: 0,
  lang: 'zh',
  theme: 'auto'
};

let meta = null;
let sites = [];
let refreshTimer = null;
let i18n = createI18n('zh');

const dom = {
  progress: document.getElementById('progress'),
  platform: document.getElementById('platform-switch'),
  site: document.getElementById('site-select'),
  range: document.getElementById('range-select'),
  interval: document.getElementById('interval-select'),
  refresh: document.getElementById('refresh-btn'),
  auto: document.getElementById('auto-btn'),
  theme: document.getElementById('theme-btn'),
  lang: document.getElementById('lang-btn'),
  nav: document.getElementById('sidenav'),
  content: document.getElementById('content'),
  notices: document.getElementById('notices'),
  title: document.getElementById('site-title'),
  subtitle: document.getElementById('site-subtitle'),
  updated: document.getElementById('updated-at')
};

/* ------------------------------------------------------------------ prefs */

function loadPrefs() {
  try {
    Object.assign(state, JSON.parse(localStorage.getItem(STORE_KEY) || '{}'));
  } catch {
    /* first visit, private mode, or cleared storage — defaults are fine */
  }
  const params = new URLSearchParams(location.hash.slice(1));
  for (const key of ['platform', 'siteId', 'range', 'interval', 'topMetric']) {
    if (params.get(key)) state[key] = params.get(key);
  }
  i18n = createI18n(state.lang);
}

function savePrefs() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        platform: state.platform,
        siteId: state.siteId,
        range: state.range,
        interval: state.interval,
        topMetric: state.topMetric,
        autoRefresh: state.autoRefresh,
        lang: state.lang,
        theme: state.theme
      })
    );
  } catch {
    /* storage unavailable — preferences just won't persist */
  }

  const params = new URLSearchParams({
    platform: state.platform,
    range: state.range,
    interval: state.interval
  });
  if (state.siteId) params.set('siteId', state.siteId);
  history.replaceState(null, '', `#${params}`);
}

/* ------------------------------------------------------------------ theme */

function applyTheme() {
  const root = document.documentElement;
  const resolved =
    state.theme === 'auto'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : state.theme;
  root.dataset.theme = resolved;
  dom.theme.setAttribute('title', `${i18n.t('theme')}: ${state.theme}`);
  refreshChartTheme();
}

/* --------------------------------------------------------------- progress */

let progressTimer = null;
function startProgress() {
  clearInterval(progressTimer);
  let width = 8;
  dom.progress.style.opacity = '1';
  dom.progress.style.width = '8%';
  progressTimer = setInterval(() => {
    width = Math.min(90, width + (90 - width) * 0.12);
    dom.progress.style.width = `${width}%`;
  }, 160);
}

function stopProgress() {
  clearInterval(progressTimer);
  dom.progress.style.width = '100%';
  setTimeout(() => {
    dom.progress.style.opacity = '0';
    dom.progress.style.width = '0';
  }, 240);
}

/* ------------------------------------------------------------- top bar UI */

function currentPlatform() {
  return meta?.platforms.find((platform) => platform.id === state.platform);
}

function renderPlatformSwitch() {
  clear(dom.platform);
  for (const platform of meta.platforms) {
    dom.platform.append(
      el(
        'button',
        {
          type: 'button',
          'aria-pressed': String(platform.id === state.platform),
          disabled: !platform.ready,
          title: platform.ready
            ? `${platform.vendor} · ${platform.label}`
            : `${i18n.t('notConfigured')} — ${i18n.t('missingEnv')}: ${platform.missing.join(', ')}`,
          onclick: () => selectPlatform(platform.id)
        },
        [el('span', { class: `dot${platform.ready ? '' : ' dot--off'}` }), platform.label]
      )
    );
  }
}

function renderSelect(node, options, value, onChange) {
  clear(node);
  for (const option of options) {
    node.append(el('option', { value: option.value, text: option.label, selected: option.value === value }));
  }
  node.onchange = () => onChange(node.value);
}

function renderControls() {
  renderSelect(
    dom.range,
    meta.ranges.map((id) => ({ value: id, label: i18n.t(`range.${id}`) })),
    state.range,
    (value) => {
      state.range = value;
      savePrefs();
      refresh();
    }
  );

  renderSelect(
    dom.interval,
    [{ value: 'auto', label: 'Auto' }].concat(
      meta.intervals.map((item) => ({ value: item.id, label: i18n.t(`interval.${item.id}`) }))
    ),
    state.interval,
    (value) => {
      state.interval = value;
      savePrefs();
      refresh();
    }
  );

  dom.auto.setAttribute('aria-pressed', String(state.autoRefresh > 0));
  dom.auto.title = state.autoRefresh ? `${i18n.t('autoRefresh')}: ${state.autoRefresh}s` : i18n.t('autoRefresh');
}

function renderSiteSelect() {
  const options = [{ value: '', label: i18n.t('allSites') }].concat(
    sites.map((site) => ({ value: site.id, label: site.name }))
  );
  renderSelect(dom.site, options, state.siteId, (value) => {
    state.siteId = value;
    savePrefs();
    refresh();
  });
  dom.site.disabled = sites.length === 0;
}

/* ---------------------------------------------------------------- sections */

const SECTIONS = [
  {
    id: 'overview',
    needs: () => true
  },
  {
    id: 'traffic',
    needs: (cap) => cap.series.some((m) => m.startsWith('traffic.') || m.startsWith('bandwidth.') || m === 'requests.total')
  },
  { id: 'cache', needs: (cap) => cap.series.includes('cache.requests.hit') || cap.series.includes('cache.traffic.hit') },
  { id: 'origin', needs: (cap) => cap.series.some((m) => m.startsWith('origin.')) },
  { id: 'security', needs: (cap) => cap.series.includes('security.blocked') },
  { id: 'functions', needs: (cap) => cap.series.some((m) => m.startsWith('functions.')) },
  { id: 'top', needs: (cap) => cap.top.length > 0 }
];

function visibleSections() {
  const cap = currentPlatform()?.capabilities;
  if (!cap) return [];
  return SECTIONS.filter((section) => section.needs(cap));
}

function buildShell() {
  clear(dom.content);
  clear(dom.nav);

  for (const section of visibleSections()) {
    dom.nav.append(
      el('a', { href: `#section-${section.id}`, text: i18n.t(`nav.${section.id}`), 'data-section': section.id })
    );

    const body = el('div', { class: 'grid', id: `body-${section.id}` });
    dom.content.append(
      el('section', { id: `section-${section.id}` }, [
        el('div', { class: 'section__head' }, [
          el('h2', { text: i18n.t(`section.${section.id}`) }),
          el('span', { class: 'section__hint', id: `hint-${section.id}` })
        ]),
        body
      ])
    );
    body.append(...skeletonCards(3));
  }

  observeSections();
}

let sectionObserver = null;
function observeSections() {
  sectionObserver?.disconnect();
  if (typeof IntersectionObserver === 'undefined') return;
  sectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const link of dom.nav.querySelectorAll('a')) {
          link.classList.toggle('is-active', link.dataset.section === entry.target.id.replace('section-', ''));
        }
      }
    },
    { rootMargin: '-80px 0px -70% 0px' }
  );
  for (const node of dom.content.querySelectorAll('section')) sectionObserver.observe(node);
}

function body(id) {
  return document.getElementById(`body-${id}`);
}

function seriesFor(data, metric, name) {
  const series = data.series?.[metric];
  if (!series?.points?.length) return null;
  return { name: name || i18n.t(`metric.${metric}`), points: series.points, unit: series.unit };
}

function kpi(data, metric, options = {}) {
  const entry = data.kpis?.[metric];
  const series = data.series?.[metric];
  if (!entry && !series) return null;
  return kpiCard({
    label: i18n.t(`metric.${metric}`),
    value: entry?.value ?? null,
    unit: series?.unit || 'count',
    delta: entry?.delta,
    i18n,
    ...options
  });
}

function chartInto(container, title, series, interval, options = {}) {
  const { card, chart } = chartCard(title, options);
  container.append(card);

  if (!series.length) {
    clear(chart).append(emptyState(i18n.t('noData')));
    chart.style.height = 'auto';
    return;
  }

  // Without ECharts (blocked script, offline) show the totals rather than a blank box.
  if (!renderChart(chart, lineOption({ series, interval, ...options }))) {
    chart.style.height = 'auto';
    clear(chart).append(
      barList({
        items: series.map((item) => ({
          key: item.name,
          value: item.points.reduce((acc, [, v]) => acc + v, 0)
        })),
        unit: series[0].unit,
        emptyText: i18n.t('noData')
      })
    );
  }
}

/* ---------------------------------------------------------------- renders */

function renderOverview(data, top) {
  const node = clear(body('overview'));
  node.className = 'grid grid--kpi';

  const cards = [
    kpi(data, 'traffic.total'),
    kpi(data, 'requests.total'),
    kpi(data, 'bandwidth.total'),
    kpi(data, 'security.blocked', { inverse: true })
  ].filter(Boolean);

  if (data.cache?.requestHitRatio !== null && data.cache?.requestHitRatio !== undefined) {
    cards.push(
      kpiCard({
        label: i18n.t('metric.cache.hitRatio.requests'),
        value: data.cache.requestHitRatio,
        unit: 'ratio',
        i18n
      })
    );
  }

  node.append(...(cards.length ? cards : [emptyState(i18n.t('noData'))]));

  const wide = el('div', { class: 'grid grid--half', style: 'margin-top:12px;grid-column:1/-1' });
  node.append(wide);

  chartInto(
    wide,
    i18n.t('chart.traffic'),
    [seriesFor(data, 'traffic.total'), seriesFor(data, 'requests.total')].filter(Boolean).slice(0, 1),
    data.range.interval
  );

  const countries = top?.top?.country || [];
  const mapUnit = state.topMetric === 'requests' ? 'count' : 'bytes';
  const { card, chart } = chartCard(i18n.t('chart.map'));
  wide.append(card);

  const canMap = countries.length && window.echarts?.getMap?.('world');
  if (canMap && renderChart(chart, mapOption({ items: countries, unit: mapUnit }))) {
    // rendered
  } else if (countries.length) {
    clear(chart).append(
      barList({
        items: countries.slice(0, 8),
        unit: state.topMetric === 'requests' ? 'count' : 'bytes',
        labelOf: (key) => countryName(key, i18n.locale)
      })
    );
    chart.style.height = 'auto';
  } else {
    clear(chart).append(emptyState(i18n.t('noData')));
    chart.style.height = 'auto';
  }
}

function renderTraffic(data) {
  const node = clear(body('traffic'));
  node.className = 'grid grid--kpi';

  node.append(
    ...[
      kpi(data, 'traffic.out'),
      kpi(data, 'traffic.in'),
      kpi(data, 'bandwidth.out'),
      kpi(data, 'bandwidth.in')
    ].filter(Boolean)
  );

  const charts = el('div', { class: 'grid grid--half', style: 'margin-top:12px;grid-column:1/-1' });
  node.append(charts);

  const trafficSeries = [
    seriesFor(data, 'traffic.out'),
    seriesFor(data, 'traffic.in')
  ].filter(Boolean);
  chartInto(charts, i18n.t('chart.traffic'), trafficSeries, data.range.interval, { stack: true });

  const bandwidthSeries = [
    seriesFor(data, 'bandwidth.out'),
    seriesFor(data, 'bandwidth.in')
  ].filter(Boolean);
  chartInto(charts, i18n.t('chart.bandwidth'), bandwidthSeries, data.range.interval);

  const requestSeries = [seriesFor(data, 'requests.total')].filter(Boolean);
  chartInto(charts, i18n.t('chart.requests'), requestSeries, data.range.interval);
}

function renderCache(data) {
  const node = clear(body('cache'));
  node.className = 'grid grid--kpi';

  const cards = [];
  if (data.cache?.requestHitRatio !== null && data.cache?.requestHitRatio !== undefined) {
    cards.push(kpiCard({ label: i18n.t('metric.cache.hitRatio.requests'), value: data.cache.requestHitRatio, unit: 'ratio', i18n }));
  }
  if (data.cache?.trafficHitRatio !== null && data.cache?.trafficHitRatio !== undefined) {
    cards.push(kpiCard({ label: i18n.t('metric.cache.hitRatio.traffic'), value: data.cache.trafficHitRatio, unit: 'ratio', i18n }));
  }
  cards.push(kpi(data, 'cache.requests.hit'), kpi(data, 'cache.traffic.hit'));
  node.append(...cards.filter(Boolean));

  const charts = el('div', { class: 'grid', style: 'margin-top:12px;grid-column:1/-1' });
  node.append(charts);
  chartInto(
    charts,
    i18n.t('chart.cache'),
    [
      seriesFor(data, 'cache.requests.hit', i18n.t('metric.cache.requests.hit')),
      seriesFor(data, 'requests.total')
    ].filter(Boolean),
    data.range.interval,
    { area: false }
  );
}

function renderOrigin(data) {
  const node = clear(body('origin'));
  node.className = 'grid grid--kpi';
  node.append(
    ...[
      kpi(data, 'origin.traffic.out'),
      kpi(data, 'origin.traffic.in'),
      kpi(data, 'origin.bandwidth.out'),
      kpi(data, 'origin.requests')
    ].filter(Boolean)
  );

  const charts = el('div', { class: 'grid grid--half', style: 'margin-top:12px;grid-column:1/-1' });
  node.append(charts);
  chartInto(
    charts,
    i18n.t('chart.origin'),
    [seriesFor(data, 'origin.traffic.out'), seriesFor(data, 'origin.traffic.in')].filter(Boolean),
    data.range.interval
  );
  chartInto(charts, i18n.t('metric.origin.requests'), [seriesFor(data, 'origin.requests')].filter(Boolean), data.range.interval);
}

function renderSecurity(data) {
  const node = clear(body('security'));
  node.className = 'grid grid--kpi';
  node.append(...[kpi(data, 'security.blocked', { inverse: true })].filter(Boolean));

  const charts = el('div', { class: 'grid', style: 'margin-top:12px;grid-column:1/-1' });
  node.append(charts);
  chartInto(charts, i18n.t('chart.security'), [seriesFor(data, 'security.blocked')].filter(Boolean), data.range.interval);
}

function renderFunctions(data, pages) {
  const node = clear(body('functions'));
  node.className = 'grid grid--kpi';

  const cards = [kpi(data, 'functions.requests'), kpi(data, 'functions.cpuTime')].filter(Boolean);
  if (pages?.builds) {
    cards.push(
      kpiCard({
        label: i18n.t('pages.builds'),
        value: pages.builds.used,
        unit: 'count',
        hint: pages.builds.quota ? `${i18n.t('pages.quota')}: ${pages.builds.quota}` : undefined,
        i18n
      })
    );
  }
  node.append(...(cards.length ? cards : [emptyState(i18n.t('noData'))]));

  const charts = el('div', { class: 'grid grid--half', style: 'margin-top:12px;grid-column:1/-1' });
  node.append(charts);
  chartInto(
    charts,
    i18n.t('chart.functions'),
    [seriesFor(data, 'functions.requests'), seriesFor(data, 'functions.cpuTime')].filter(Boolean),
    data.range.interval,
    { area: false }
  );
}

function renderTop(top) {
  const node = clear(body('top'));
  node.className = 'grid grid--third';

  const hint = document.getElementById('hint-top');
  clear(hint).append(
    el('span', { class: 'segmented', style: 'transform:scale(0.92);transform-origin:left' }, [
      el(
        'button',
        {
          type: 'button',
          'aria-pressed': String(state.topMetric === 'traffic'),
          onclick: () => setTopMetric('traffic')
        },
        [i18n.t('top.byTraffic')]
      ),
      el(
        'button',
        {
          type: 'button',
          'aria-pressed': String(state.topMetric === 'requests'),
          onclick: () => setTopMetric('requests')
        },
        [i18n.t('top.byRequests')]
      )
    ])
  );

  const unit = state.topMetric === 'requests' ? 'count' : 'bytes';
  const dimensions = currentPlatform()?.capabilities.top || [];
  let rendered = 0;

  for (const dimension of dimensions) {
    const items = top?.top?.[dimension] || [];
    if (!items.length) continue;
    rendered += 1;

    const useChart = items.length > 4 && dimension !== 'url' && dimension !== 'userAgent';
    const { card, chart } = chartCard(i18n.t(`top.${dimension}`), { short: true });
    node.append(card);

    const labelOf = dimension === 'country' ? (key) => countryName(key, i18n.locale) : undefined;
    const rows = items.slice(0, 10);
    const drawn = useChart && renderChart(chart, barOption({ items: rows, unit, labelOf }));

    if (!drawn) {
      chart.style.height = 'auto';
      clear(chart).append(barList({ items: rows, unit, labelOf, emptyText: i18n.t('noData') }));
    }
  }

  if (!rendered) node.append(emptyState(i18n.t('noData')));
}

/* ---------------------------------------------------------------- notices */

function renderNotices(data, errors) {
  clear(dom.notices);

  for (const error of errors) {
    dom.notices.append(banner('error', error));
  }

  const notes = (data?.notes || []).map((note) => `${note.scope ? `[${note.scope}] ` : ''}${note.message}`);
  if (notes.length) {
    dom.notices.append(banner('warn', i18n.t('unsupported'), notes));
  }

  const extras = [];
  if (data?.range?.intervalAdjusted) {
    extras.push(`${i18n.t('intervalAdjusted')} ${i18n.t(`interval.${data.range.interval}`)}`);
  }
  if (data?.sampling && data.sampling < 100) {
    extras.push(`${i18n.t('samplingNote')}: ${data.sampling}%`);
  }
  if (extras.length) dom.notices.append(banner('warn', extras.join(' · ')));
}

/* ------------------------------------------------------------------ fetch */

let refreshToken = 0;

async function refresh() {
  const platform = currentPlatform();
  if (!platform?.ready) {
    clear(dom.content).append(
      banner('warn', `${platform?.label || state.platform} ${i18n.t('notConfigured')}`, [
        `${i18n.t('missingEnv')}: ${(platform?.missing || []).join(', ')}`
      ])
    );
    clear(dom.nav);
    return;
  }

  const token = ++refreshToken;
  abortAll();
  startProgress();
  dom.refresh.classList.add('is-busy');

  state.topDimensions = platform.capabilities.top;

  const [overviewResult, topResult, pagesResult] = await Promise.allSettled([
    api.overview(state),
    platform.capabilities.top.length ? api.top(state) : Promise.resolve(null),
    platform.capabilities.pagesStats ? api.pages(state) : Promise.resolve(null)
  ]);

  if (token !== refreshToken) return;

  dom.refresh.classList.remove('is-busy');
  stopProgress();

  const errors = [];
  const data = overviewResult.status === 'fulfilled' ? overviewResult.value : null;
  if (overviewResult.status === 'rejected' && overviewResult.reason?.name !== 'AbortError') {
    errors.push(overviewResult.reason.message);
  }
  const top = topResult.status === 'fulfilled' ? topResult.value : null;
  if (topResult.status === 'rejected' && topResult.reason?.name !== 'AbortError') {
    errors.push(topResult.reason.message);
  }
  const pages = pagesResult.status === 'fulfilled' ? pagesResult.value : null;

  renderNotices(data, errors);
  if (!data) {
    for (const section of visibleSections()) clear(body(section.id)).append(emptyState(i18n.t('noData')));
    return;
  }

  const visible = new Set(visibleSections().map((section) => section.id));
  if (visible.has('overview')) renderOverview(data, top);
  if (visible.has('traffic')) renderTraffic(data);
  if (visible.has('cache')) renderCache(data);
  if (visible.has('origin')) renderOrigin(data);
  if (visible.has('security')) renderSecurity(data);
  if (visible.has('functions')) renderFunctions(data, pages);
  if (visible.has('top')) renderTop(top);

  dom.updated.textContent = `${i18n.t('updatedAt')} ${formatDateTime(new Date().toISOString())}`;
  document.getElementById('hint-overview').textContent =
    `${formatDateTime(data.range.start)} → ${formatDateTime(data.range.end)} · ${i18n.t(`interval.${data.range.interval}`)}`;
}

function setTopMetric(metric) {
  state.topMetric = metric;
  savePrefs();
  refresh();
}

async function selectPlatform(id) {
  if (state.platform === id) return;
  state.platform = id;
  state.siteId = '';
  savePrefs();
  renderPlatformSwitch();
  buildShell();
  await loadSites();
  refresh();
}

async function loadSites() {
  const platform = currentPlatform();
  if (!platform?.ready) {
    sites = [];
    renderSiteSelect();
    return;
  }
  try {
    const response = await api.sites(state.platform);
    sites = response.sites || [];
    if (!state.siteId && sites.length === 1) state.siteId = sites[0].id;
  } catch {
    sites = [];
  }
  renderSiteSelect();
}

function setAutoRefresh(seconds) {
  state.autoRefresh = seconds;
  clearInterval(refreshTimer);
  if (seconds > 0) refreshTimer = setInterval(refresh, seconds * 1000);
  dom.auto.setAttribute('aria-pressed', String(seconds > 0));
  dom.auto.title = seconds ? `${i18n.t('autoRefresh')}: ${seconds}s` : i18n.t('autoRefresh');
  savePrefs();
}

/* ------------------------------------------------------------------- init */

async function init() {
  loadPrefs();
  applyTheme();

  dom.refresh.onclick = () => refresh();
  dom.auto.onclick = () => setAutoRefresh(state.autoRefresh > 0 ? 0 : 60);
  dom.theme.onclick = () => {
    state.theme = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto';
    savePrefs();
    applyTheme();
  };
  dom.lang.onclick = () => {
    state.lang = state.lang === 'zh' ? 'en' : 'zh';
    i18n = createI18n(state.lang);
    dom.lang.textContent = state.lang === 'zh' ? 'EN' : '中';
    savePrefs();
    renderPlatformSwitch();
    renderControls();
    renderSiteSelect();
    buildShell();
    refresh();
  };
  dom.lang.textContent = state.lang === 'zh' ? 'EN' : '中';

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'auto') applyTheme();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.autoRefresh > 0) refresh();
  });

  try {
    meta = await api.meta();
  } catch (error) {
    clear(dom.content).append(banner('error', error.message));
    return;
  }

  document.title = meta.siteName;
  dom.title.textContent = meta.siteName;
  dom.subtitle.textContent = i18n.t('subtitle');

  const ready = meta.platforms.filter((platform) => platform.ready);
  if (!meta.platforms.some((platform) => platform.id === state.platform && platform.ready)) {
    state.platform = ready[0]?.id || meta.defaultPlatform;
  }

  renderPlatformSwitch();
  renderControls();
  buildShell();

  if (!ready.length) {
    clear(dom.content).append(
      banner(
        'warn',
        i18n.t('notConfigured'),
        meta.platforms.map((platform) => `${platform.label}: ${platform.missing.join(', ')}`)
      )
    );
    return;
  }

  await loadSites();
  setAutoRefresh(state.autoRefresh);
  await refresh();
}

init();
