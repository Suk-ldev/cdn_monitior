import { formatMetric, formatMetricText, formatPercent } from './format.js';

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

function deltaNode(delta, i18n, inverse = false) {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return null;
  const rising = delta > 0;
  const good = inverse ? !rising : rising;
  const cls = Math.abs(delta) < 0.0005 ? 'delta--flat' : good ? 'delta--up' : 'delta--down';
  const arrow = Math.abs(delta) < 0.0005 ? '·' : rising ? '↑' : '↓';
  return el('span', { class: `delta ${cls}` }, [`${arrow} ${formatPercent(Math.abs(delta), 1)}`]);
}

export function kpiCard({ label, value, unit, delta, hint, i18n, inverse = false }) {
  const parts = value === null || value === undefined
    ? { value: '—', unit: '' }
    : formatMetric(value, unit);

  const foot = [];
  const node = deltaNode(delta, i18n, inverse);
  if (node) {
    foot.push(node, el('span', { text: i18n.t('vsPrevious') }));
  } else if (hint) {
    foot.push(el('span', { text: hint }));
  }

  return el('div', { class: 'card' }, [
    el('div', { class: 'card__label', text: label }),
    el('div', { class: 'card__value' }, [parts.value, parts.unit ? el('small', { text: ` ${parts.unit}` }) : null]),
    foot.length ? el('div', { class: 'card__foot' }, foot) : null
  ]);
}

export function skeletonCards(count = 4) {
  return Array.from({ length: count }, () =>
    el('div', { class: 'card' }, [
      el('div', { class: 'card__label skeleton', text: '········' }),
      el('div', { class: 'card__value skeleton', text: '········' })
    ])
  );
}

export function barList({ items, unit, labelOf, emptyText }) {
  if (!items?.length) return el('div', { class: 'empty', text: emptyText });
  const max = Math.max(...items.map((item) => item.value), 1);

  return el(
    'div',
    { class: 'barlist' },
    items.map((item) =>
      el('div', { class: 'barlist__row', title: String(item.key) }, [
        el('div', { class: 'barlist__fill', style: `width:${Math.max(2, (item.value / max) * 100)}%` }),
        el('span', { class: 'barlist__key', text: labelOf ? labelOf(item.key) : String(item.key) }),
        el('span', { class: 'barlist__val', text: formatMetricText(item.value, unit) })
      ])
    )
  );
}

export function chartCard(title, { id, tall = false, short = false, actions } = {}) {
  const chart = el('div', {
    class: `chart${tall ? ' chart--tall' : ''}${short ? ' chart--short' : ''}`,
    id
  });
  const card = el('div', { class: 'card card--chart' }, [
    el('div', { class: 'card__title' }, [el('span', { text: title }), actions || null]),
    chart
  ]);
  return { card, chart };
}

export function banner(level, title, details = []) {
  return el('div', { class: `banner banner--${level}` }, [
    el('div', {}, [
      el('strong', { text: title }),
      details.length
        ? el('ul', {}, details.map((line) => el('li', { text: line })))
        : null
    ])
  ]);
}

export function emptyState(text) {
  return el('div', { class: 'empty', text });
}
