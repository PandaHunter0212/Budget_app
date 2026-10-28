'use strict';

/* ================= Reports page =================
 * data.report = {
 *   filters: { from, to, kind },                 // page-level filters (transactions only)
 *   rows: [{ id, cols (1-5), visuals: [{ id, start, span, title, type, source, groupBy,
 *            agg, field, sort, limit, filters: [{ field, op, value }] }] }]
 * }
 * A visual occupies columns start .. start+span-1 of its row.
 */
const MAX_COLS = 5;
const PALETTE = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#8b5cf6', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#64748b'];

const SOURCES = {
  transactions: {
    label: 'Transactions',
    dims: ['Type', 'Kind', 'Account', 'Account type', 'Budget category', 'Month', 'Year', 'Date'],
    nums: ['Amount'],
    records() {
      return data.transactions.map((t) => {
        const acc = data.accounts.find((a) => a.id === t.accountId);
        return {
          Type: t.type || '(none)',
          Kind: t.kind === 'income' ? 'Income' : 'Expense',
          Account: acc ? acc.name : '(deleted account)',
          'Account type': acc ? acc.type || '(none)' : '(none)',
          'Budget category': t.category ? categoryLabel(t.category) : '(none)',
          Month: String(t.date || '').slice(0, 7),
          Year: String(t.date || '').slice(0, 4),
          Date: t.date || '',
          Amount: Number(t.amount) || 0,
          _date: t.date || '',
          _kind: t.kind,
        };
      });
    },
  },
  accounts: {
    label: 'Accounts',
    dims: ['Name', 'Type', 'Institution', 'Purpose'],
    nums: ['Balance', 'Starting balance', 'Credit limit'],
    records() {
      return data.accounts.map((a) => ({
        Name: a.name || '', Type: a.type || '(none)', Institution: a.institution || '(none)', Purpose: a.purpose || '(none)',
        Balance: accountBalance(a.id), 'Starting balance': Number(a.startingBalance) || 0,
        'Credit limit': a.type === 'Credit Card' ? Number(a.creditLimit) || 0 : 0,
      }));
    },
  },
  investments: {
    label: 'Investments',
    dims: ['Name', 'Start', 'End'],
    nums: ['Monthly'],
    records() {
      return data.investments.map((i) => ({
        Name: i.name || '', Start: i.start || '', End: i.end || '(ongoing)', Monthly: Number(i.monthly) || 0,
      }));
    },
  },
};

const VISUAL_TYPES = [
  ['column', 'Column chart'], ['bar', 'Bar chart'], ['line', 'Line chart'], ['area', 'Area chart'],
  ['pie', 'Pie chart'], ['donut', 'Donut chart'], ['card', 'Card (single number)'], ['table', 'Table'],
];
const AGGS = [['sum', 'Sum'], ['avg', 'Average'], ['count', 'Count'], ['min', 'Minimum'], ['max', 'Maximum']];
const OPS = [['eq', 'is'], ['ne', 'is not'], ['contains', 'contains'], ['gte', '≥'], ['lte', '≤']];

let reportEditMode = false; // layout is read-only until Edit is pressed
let reportEditing = null; // { rowId, visual, isNew } while the editor dialog is open

/* ---------- Data pipeline ---------- */
function reportFilterMatch(rec, f) {
  if (!f.field || f.value === '' || f.value == null) return true;
  const v = rec[f.field];
  const a = String(v ?? '').toLowerCase();
  const b = String(f.value).toLowerCase();
  switch (f.op) {
    case 'eq': return a === b;
    case 'ne': return a !== b;
    case 'contains': return a.includes(b);
    case 'gte': return typeof v === 'number' ? v >= Number(f.value) : String(v) >= String(f.value);
    case 'lte': return typeof v === 'number' ? v <= Number(f.value) : String(v) <= String(f.value);
    default: return true;
  }
}

function reportRecords(v) {
  const src = SOURCES[v.source] || SOURCES.transactions;
  const g = data.report.filters;
  let recs = src.records();
  if (v.source === 'transactions') {
    recs = recs.filter((r) => (!g.from || r._date >= g.from) && (!g.to || r._date <= g.to) && (!g.kind || r._kind === g.kind));
  }
  return recs.filter((r) => (v.filters || []).every((f) => reportFilterMatch(r, f)));
}

function aggregate(recs, agg, field) {
  if (agg === 'count') return recs.length;
  const nums = recs.map((r) => Number(r[field]) || 0);
  if (!nums.length) return 0;
  switch (agg) {
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
    default: return nums.reduce((a, b) => a + b, 0);
  }
}

/** Returns [{ label, value }] grouped and sorted according to the visual config. */
function reportSeries(v, recs) {
  const field = v.field || (SOURCES[v.source]?.nums[0]);
  const groups = new Map();
  recs.forEach((r) => {
    const k = String(r[v.groupBy] ?? '(none)');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  let out = [...groups].map(([label, rs]) => ({ label, value: aggregate(rs, v.agg, field) }));
  const timeLike = ['Month', 'Year', 'Date', 'Start', 'End'].includes(v.groupBy);
  const sort = timeLike && (v.type === 'line' || v.type === 'area' || v.sort === 'label') ? 'label' : v.sort;
  if (sort === 'label') out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  else if (sort === 'asc') out.sort((a, b) => a.value - b.value);
  else out.sort((a, b) => b.value - a.value);
  const limit = Number(v.limit) || 0;
  if (limit > 0) out = out.slice(0, limit);
  return out;
}

const reportFmtValue = (v, n) => (v.agg === 'count' ? String(Math.round(n)) : fmt(n));
const shortNum = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n * 100) / 100);
};

/* ---------- SVG / HTML visuals ---------- */
function drawVisual(v) {
  const recs = reportRecords(v);
  if (v.type === 'card') {
    const val = aggregate(recs, v.agg, v.field || SOURCES[v.source].nums[0]);
    return `<div class="rv-card-value">${esc(reportFmtValue(v, val))}</div>`;
  }
  if (v.type === 'table' && v.groupBy === '(records)') return drawRecordTable(v, recs);
  const series = reportSeries(v, recs);
  if (!series.length) return '<p class="hint rv-empty">No data for this visual.</p>';
  switch (v.type) {
    case 'table': return drawTable(v, series);
    case 'pie': case 'donut': return drawPie(v, series);
    case 'bar': return drawBars(v, series, true);
    case 'line': case 'area': return drawLine(v, series);
    default: return drawBars(v, series, false);
  }
}

function drawTable(v, series) {
  const total = series.reduce((a, s) => a + s.value, 0);
  const rows = series.map((s) => `<tr><td>${esc(s.label)}</td><td class="num">${esc(reportFmtValue(v, s.value))}</td></tr>`).join('');
  const foot = v.agg === 'sum' || v.agg === 'count'
    ? `<tfoot><tr><th>Total</th><th class="num">${esc(reportFmtValue(v, total))}</th></tr></tfoot>` : '';
  return `<div class="rv-table-wrap"><table><thead><tr><th>${esc(v.groupBy)}</th><th class="num">${esc(measureLabel(v))}</th></tr></thead><tbody>${rows}</tbody>${foot}</table></div>`;
}

function drawRecordTable(v, recs) {
  const src = SOURCES[v.source];
  const cols = [...src.dims, ...src.nums];
  const rows = recs.slice(0, 200).map((r) => `<tr>${cols.map((c) => (
    typeof r[c] === 'number' ? `<td class="num">${esc(fmt(r[c]))}</td>` : `<td>${esc(r[c])}</td>`)).join('')}</tr>`).join('');
  if (!recs.length) return '<p class="hint rv-empty">No data for this visual.</p>';
  return `<div class="rv-table-wrap"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>${recs.length > 200 ? '<p class="hint">Showing first 200 records.</p>' : ''}`;
}

function drawPie(v, series) {
  const items = series.filter((s) => s.value > 0);
  const total = items.reduce((a, s) => a + s.value, 0);
  if (!total) return '<p class="hint rv-empty">Nothing to show (values must be positive).</p>';
  const r = 80, c = 100, inner = v.type === 'donut' ? 48 : 0;
  let ang = -Math.PI / 2;
  const pt = (rad, a) => `${(c + rad * Math.cos(a)).toFixed(2)} ${(c + rad * Math.sin(a)).toFixed(2)}`;
  const paths = items.map((s, i) => {
    const frac = s.value / total;
    const color = PALETTE[i % PALETTE.length];
    if (frac > 0.9999) {
      return `<circle cx="${c}" cy="${c}" r="${(r + inner) / 2}" fill="none" stroke="${color}" stroke-width="${r - inner || r * 2}"/>`;
    }
    const a2 = ang + frac * 2 * Math.PI;
    const large = frac > 0.5 ? 1 : 0;
    const d = inner
      ? `M ${pt(r, ang)} A ${r} ${r} 0 ${large} 1 ${pt(r, a2)} L ${pt(inner, a2)} A ${inner} ${inner} 0 ${large} 0 ${pt(inner, ang)} Z`
      : `M ${c} ${c} L ${pt(r, ang)} A ${r} ${r} 0 ${large} 1 ${pt(r, a2)} Z`;
    ang = a2;
    return `<path d="${d}" fill="${color}"><title>${esc(s.label)}: ${esc(reportFmtValue(v, s.value))}</title></path>`;
  }).join('');
  const legend = items.map((s, i) => `<li><span class="rv-dot" style="background:${PALETTE[i % PALETTE.length]}"></span>${esc(s.label)} <b>${esc(reportFmtValue(v, s.value))}</b> <span class="hint">(${(s.value / total * 100).toFixed(1)}%)</span></li>`).join('');
  return `<div class="rv-pie"><svg viewBox="0 0 200 200" class="rv-pie-svg">${paths}</svg><ul class="rv-legend">${legend}</ul></div>`;
}

function drawBars(v, series, horizontal) {
  const max = Math.max(...series.map((s) => s.value), 0) || 1;
  const min = Math.min(...series.map((s) => s.value), 0);
  const range = max - min || 1;
  if (horizontal) {
    const rowH = 26, left = 110, w = 400, h = series.length * rowH + 8;
    const zero = left + (-min / range) * (w - left - 50);
    const bars = series.map((s, i) => {
      const len = (Math.abs(s.value) / range) * (w - left - 50);
      const x = s.value >= 0 ? zero : zero - len;
      const y = 4 + i * rowH;
      const label = s.label.length > 16 ? `${s.label.slice(0, 15)}…` : s.label;
      return `<text x="${left - 6}" y="${y + 15}" text-anchor="end" class="rv-axis">${esc(label)}</text>
        <rect x="${x.toFixed(1)}" y="${y + 3}" width="${Math.max(len, 1).toFixed(1)}" height="${rowH - 8}" rx="3" fill="${PALETTE[0]}"><title>${esc(s.label)}: ${esc(reportFmtValue(v, s.value))}</title></rect>
        <text x="${(s.value >= 0 ? x + len + 4 : x - 4).toFixed(1)}" y="${y + 15}" text-anchor="${s.value >= 0 ? 'start' : 'end'}" class="rv-axis">${esc(shortNum(s.value))}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${w} ${h}" class="rv-svg" preserveAspectRatio="xMidYMin meet">${bars}</svg>`;
  }
  const W = 480, H = 240, L = 44, B = 46, T = 14, R = 8;
  const plotW = W - L - R, plotH = H - T - B;
  const y = (val) => T + plotH - ((val - min) / range) * plotH;
  const step = plotW / series.length;
  const bw = Math.min(step * 0.7, 46);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const val = min + range * f;
    return `<line x1="${L}" x2="${W - R}" y1="${y(val).toFixed(1)}" y2="${y(val).toFixed(1)}" class="rv-grid"/><text x="${L - 4}" y="${(y(val) + 3).toFixed(1)}" text-anchor="end" class="rv-axis">${esc(shortNum(val))}</text>`;
  }).join('');
  const bars = series.map((s, i) => {
    const x = L + step * i + (step - bw) / 2;
    const y0 = y(Math.max(s.value, 0)), y1 = y(Math.min(s.value, 0));
    const label = s.label.length > 10 ? `${s.label.slice(0, 9)}…` : s.label;
    return `<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(y1 - y0, 1).toFixed(1)}" rx="3" fill="${PALETTE[0]}"><title>${esc(s.label)}: ${esc(reportFmtValue(v, s.value))}</title></rect>
      <text transform="translate(${(x + bw / 2).toFixed(1)} ${H - B + 12}) rotate(${series.length > 6 ? 35 : 0})" text-anchor="${series.length > 6 ? 'start' : 'middle'}" class="rv-axis">${esc(label)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="rv-svg">${grid}${bars}</svg>`;
}

function drawLine(v, series) {
  const W = 480, H = 240, L = 44, B = 46, T = 14, R = 14;
  const plotW = W - L - R, plotH = H - T - B;
  const max = Math.max(...series.map((s) => s.value), 0);
  const min = Math.min(...series.map((s) => s.value), 0);
  const range = max - min || 1;
  const y = (val) => T + plotH - ((val - min) / range) * plotH;
  const x = (i) => L + (series.length === 1 ? plotW / 2 : (plotW * i) / (series.length - 1));
  const pts = series.map((s, i) => `${x(i).toFixed(1)},${y(s.value).toFixed(1)}`);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const val = min + range * f;
    return `<line x1="${L}" x2="${W - R}" y1="${y(val).toFixed(1)}" y2="${y(val).toFixed(1)}" class="rv-grid"/><text x="${L - 4}" y="${(y(val) + 3).toFixed(1)}" text-anchor="end" class="rv-axis">${esc(shortNum(val))}</text>`;
  }).join('');
  const area = v.type === 'area'
    ? `<polygon points="${x(0).toFixed(1)},${y(0).toFixed(1)} ${pts.join(' ')} ${x(series.length - 1).toFixed(1)},${y(0).toFixed(1)}" fill="${PALETTE[0]}" opacity="0.2"/>` : '';
  const every = Math.ceil(series.length / 8);
  const dots = series.map((s, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(s.value).toFixed(1)}" r="3.5" fill="${PALETTE[0]}"><title>${esc(s.label)}: ${esc(reportFmtValue(v, s.value))}</title></circle>${i % every === 0
    ? `<text x="${x(i).toFixed(1)}" y="${H - B + 14}" text-anchor="middle" class="rv-axis">${esc(s.label.length > 10 ? `${s.label.slice(0, 9)}…` : s.label)}</text>` : ''}`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="rv-svg">${grid}${area}<polyline points="${pts.join(' ')}" fill="none" stroke="${PALETTE[0]}" stroke-width="2.5"/>${dots}</svg>`;
}

function measureLabel(v) {
  const a = AGGS.find((x) => x[0] === v.agg)?.[1] || 'Sum';
  return v.agg === 'count' ? 'Count' : `${a} of ${v.field || SOURCES[v.source].nums[0]}`;
}

/* ---------- Page rendering ---------- */
function newVisual(start) {
  return {
    id: uid(), start, span: 1, title: 'New visual', type: 'column', source: 'transactions',
    groupBy: 'Type', agg: 'sum', field: 'Amount', sort: 'desc', limit: 0, filters: [],
  };
}

function visualHtml(row, v) {
  const colspan = `grid-column: ${v.start + 1} / span ${v.span};`;
  const sub = `${SOURCES[v.source]?.label || ''}${v.type === 'card' ? '' : ` · by ${v.groupBy}`} · ${measureLabel(v)}${v.filters?.length ? ` · ${v.filters.length} filter(s)` : ''}`;
  return `<div class="card rv-visual" style="${colspan}">
    <div class="rv-head">
      <div><h3>${esc(v.title)}</h3><span class="hint">${esc(sub)}</span></div>
      ${reportEditMode ? `<div class="rv-actions">
        <button class="btn small" data-rv="edit-visual" data-row="${row.id}" data-id="${v.id}" title="Edit">✎</button>
        <button class="btn small danger" data-rv="del-visual" data-row="${row.id}" data-id="${v.id}" title="Remove">✕</button>
      </div>` : ''}
    </div>
    <div class="rv-body">${drawVisual(v)}</div>
  </div>`;
}

function rowHtml(row, idx, total) {
  const covered = new Array(row.cols).fill(false);
  row.visuals.forEach((v) => { for (let c = v.start; c < v.start + v.span && c < row.cols; c++) covered[c] = true; });
  const empties = !reportEditMode ? '' : covered.map((on, c) => (on ? '' : `<button class="rv-empty-slot" style="grid-column:${c + 1}" data-rv="add-visual" data-row="${row.id}" data-col="${c}">＋ Add visual</button>`)).join('');
  const opts = Array.from({ length: MAX_COLS }, (_, i) => `<option value="${i + 1}"${row.cols === i + 1 ? ' selected' : ''}>${i + 1}</option>`).join('');
  const bar = !reportEditMode ? '' : `
    <div class="rv-row-bar">
      <strong>Row ${idx + 1}</strong>
      <label>Columns <select data-rv="set-cols" data-row="${row.id}">${opts}</select></label>
      <button class="btn small" data-rv="row-up" data-row="${row.id}"${idx === 0 ? ' disabled' : ''}>↑</button>
      <button class="btn small" data-rv="row-down" data-row="${row.id}"${idx === total - 1 ? ' disabled' : ''}>↓</button>
      <button class="btn small danger" data-rv="del-row" data-row="${row.id}">Delete row</button>
    </div>`;
  return `<div class="rv-row">${bar}
    <div class="rv-grid-row" style="grid-template-columns: repeat(${row.cols}, minmax(0, 1fr));">
      ${row.visuals.map((v) => visualHtml(row, v)).join('')}${empties}
    </div>
  </div>`;
}

function renderReports() {
  const el = $('#page-reports');
  if (!el) return;
  const f = data.report.filters;
  const rows = data.report.rows;
  el.innerHTML = `<div class="rv-title"><h2>Reports</h2>
    <div class="btn-row">
      ${reportEditMode
        ? '<button class="btn primary" data-rv="save-mode">💾 Save</button>'
        : '<button class="btn" data-rv="edit-mode">✎ Edit</button>'}
      <button class="btn" data-rv="export">⬇ Export</button>
      <label class="btn">⬆ Import<input type="file" accept="application/json,.json" data-rv="import-file" hidden></label>
    </div></div>
    <div class="card rv-filters">
      <h3>Page filters <span class="hint">(apply to every Transactions visual)</span></h3>
      <div class="rv-filter-grid">
        <label>From <input type="date" data-rv="g-from" value="${esc(f.from)}"></label>
        <label>To <input type="date" data-rv="g-to" value="${esc(f.to)}"></label>
        <label>Kind <select data-rv="g-kind">
          <option value="">All</option>
          <option value="income"${f.kind === 'income' ? ' selected' : ''}>Income</option>
          <option value="expense"${f.kind === 'expense' ? ' selected' : ''}>Expense</option>
        </select></label>
        <button class="btn small" data-rv="g-clear">Clear filters</button>
      </div>
    </div>
    ${rows.map((r, i) => rowHtml(r, i, rows.length)).join('')}
    ${rows.length ? '' : '<p class="hint">Your report is empty. Press Edit, then add a row to start building it.</p>'}
    ${reportEditMode ? '<div class="btn-row"><button class="btn primary" data-rv="add-row">＋ Add row</button></div>' : ''}`;
}

/* ---------- Layout actions ---------- */
const findRow = (id) => data.report.rows.find((r) => r.id === id);

function setCols(row, n) {
  row.cols = n;
  // Drop visuals that start outside, shrink those that overflow
  row.visuals = row.visuals.filter((v) => v.start < n);
  row.visuals.forEach((v) => { v.span = Math.min(v.span, n - v.start); });
}

/** Max span a visual can have starting at its column without hitting another visual. */
function maxSpanFor(row, v) {
  let span = 0;
  for (let c = v.start; c < row.cols; c++) {
    const other = row.visuals.find((o) => o.id !== v.id && c >= o.start && c < o.start + o.span);
    if (other) break;
    span++;
  }
  return Math.max(span, 1);
}

/* ---------- Visual editor ---------- */
function openEditor(rowId, visual, isNew) {
  reportEditing = { rowId, visual: JSON.parse(JSON.stringify(visual)), isNew };
  let dlg = $('#rv-editor');
  if (!dlg) {
    dlg = document.createElement('div');
    dlg.id = 'rv-editor';
    dlg.className = 'rv-modal';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', onEditorClick);
    dlg.addEventListener('input', onEditorInput);
    dlg.addEventListener('change', onEditorInput);
  }
  dlg.classList.remove('hidden');
  renderEditor();
}

const optHtml = (list, sel) => list.map((o) => {
  const [val, label] = Array.isArray(o) ? o : [o, o];
  return `<option value="${esc(val)}"${val === sel ? ' selected' : ''}>${esc(label)}</option>`;
}).join('');

function renderEditor() {
  const dlg = $('#rv-editor');
  const { rowId, visual: v } = reportEditing;
  const row = findRow(rowId);
  const src = SOURCES[v.source];
  const filterFields = [...src.dims, ...src.nums];
  const maxSpan = maxSpanFor(row, v);
  const spans = Array.from({ length: maxSpan }, (_, i) => [i + 1, i + 1 === 1 ? '1 column' : `${i + 1} columns`]);
  const isTable = v.type === 'table';
  const groupOpts = isTable ? [...src.dims, '(records)'] : src.dims;
  const showGroup = v.type !== 'card';
  const measureNeedsField = v.agg !== 'count';
  const filters = v.filters.map((f, i) => `<div class="rv-fil-row">
      <select data-f="${i}" data-k="field">${optHtml(filterFields, f.field)}</select>
      <select data-f="${i}" data-k="op">${optHtml(OPS, f.op)}</select>
      <input data-f="${i}" data-k="value" value="${esc(f.value)}" placeholder="value" ${src.dims.includes(f.field) ? `list="rv-dl-${i}"` : ''}>
      ${src.dims.includes(f.field) ? `<datalist id="rv-dl-${i}">${[...new Set(src.records().map((r) => r[f.field]))].slice(0, 100).map((x) => `<option value="${esc(x)}">`).join('')}</datalist>` : ''}
      <button class="btn small danger" data-rv="del-filter" data-f="${i}">✕</button>
    </div>`).join('');
  dlg.innerHTML = `<div class="card rv-modal-card">
    <h3>${reportEditing.isNew ? 'Add visual' : 'Edit visual'}</h3>
    <div class="rv-form">
      <label>Title <input data-k="title" value="${esc(v.title)}"></label>
      <label>Visual type <select data-k="type">${optHtml(VISUAL_TYPES, v.type)}</select></label>
      <label>Width <select data-k="span">${optHtml(spans, Number(v.span))}</select></label>
      <label>Data source <select data-k="source">${optHtml(Object.entries(SOURCES).map(([k, s]) => [k, s.label]), v.source)}</select></label>
      ${showGroup ? `<label>${isTable ? 'Group by' : 'Category / axis'} <select data-k="groupBy">${optHtml(groupOpts, v.groupBy)}</select></label>` : ''}
      ${!(isTable && v.groupBy === '(records)') ? `<label>Measure <select data-k="agg">${optHtml(AGGS, v.agg)}</select></label>
      ${measureNeedsField ? `<label>Value field <select data-k="field">${optHtml(src.nums, v.field)}</select></label>` : ''}` : ''}
      ${showGroup && !(isTable && v.groupBy === '(records)') ? `<label>Sort <select data-k="sort">${optHtml([['desc', 'Value high → low'], ['asc', 'Value low → high'], ['label', 'Label A → Z']], v.sort)}</select></label>
      <label>Show top N (0 = all) <input type="number" min="0" data-k="limit" value="${Number(v.limit) || 0}"></label>` : ''}
    </div>
    <h4>Filters</h4>
    <div>${filters || '<p class="hint">No filters. Add one to narrow the data.</p>'}</div>
    <button class="btn small" data-rv="add-filter">＋ Add filter</button>
    <hr>
    <div class="rv-preview"><span class="hint">Preview</span>${drawVisual(v)}</div>
    <div class="btn-row"><button class="btn primary" data-rv="save-visual">Save</button><button class="btn" data-rv="cancel-visual">Cancel</button></div>
  </div>`;
}

function onEditorInput(e) {
  const t = e.target;
  if (!reportEditing || !t.dataset) return;
  const v = reportEditing.visual;
  if (t.dataset.f !== undefined) {
    const f = v.filters[Number(t.dataset.f)];
    f[t.dataset.k] = t.value;
    if (t.dataset.k === 'field') f.value = '';
    if (e.type === 'change') renderEditor();
    return;
  }
  const k = t.dataset.k;
  if (!k) return;
  if (k === 'title') { v.title = t.value; return; } // no re-render so typing keeps focus
  if (k === 'limit') { v.limit = Number(t.value) || 0; if (e.type === 'change') renderEditor(); return; }
  if (e.type !== 'change') return;
  v[k] = k === 'span' ? Number(t.value) : t.value;
  if (k === 'source') {
    const s = SOURCES[v.source];
    v.groupBy = s.dims[0]; v.field = s.nums[0]; v.filters = [];
  }
  if (k === 'type' && v.type !== 'table' && v.groupBy === '(records)') v.groupBy = SOURCES[v.source].dims[0];
  renderEditor();
}

async function onEditorClick(e) {
  const btn = e.target.closest('[data-rv]');
  if (!btn || !reportEditing) return;
  const v = reportEditing.visual;
  switch (btn.dataset.rv) {
    case 'add-filter': {
      const s = SOURCES[v.source];
      v.filters.push({ field: s.dims[0], op: 'eq', value: '' });
      renderEditor();
      break;
    }
    case 'del-filter':
      v.filters.splice(Number(btn.dataset.f), 1);
      renderEditor();
      break;
    case 'cancel-visual':
      closeEditor();
      break;
    case 'save-visual': {
      const row = findRow(reportEditing.rowId);
      if (row) {
        const i = row.visuals.findIndex((x) => x.id === v.id);
        if (i >= 0) row.visuals[i] = v; else row.visuals.push(v);
      }
      closeEditor();
      await commit();
      break;
    }
    default:
  }
}

function closeEditor() {
  reportEditing = null;
  $('#rv-editor')?.classList.add('hidden');
}

/* ---------- Page events (bound once, delegated) ---------- */
async function onReportAction(e) {
  const el = e.target.closest('[data-rv]');
  if (!el) return;
  const act = el.dataset.rv;
  const isInput = ['g-from', 'g-to', 'g-kind', 'set-cols', 'import-file'].includes(act);
  if (isInput !== (e.type === 'change')) return;
  const rows = data.report.rows;
  const row = findRow(el.dataset.row);
  const layoutActs = ['add-row', 'del-row', 'row-up', 'row-down', 'set-cols', 'add-visual', 'edit-visual', 'del-visual'];
  if (layoutActs.includes(act) && !reportEditMode) return;
  switch (act) {
    case 'edit-mode': reportEditMode = true; renderReports(); return;
    case 'save-mode': reportEditMode = false; break;
    case 'export': exportReport(); return;
    case 'import-file': await importReport(el); return;
    case 'add-row': rows.push({ id: uid(), cols: 2, visuals: [] }); break;
    case 'del-row':
      if (!confirm('Delete this row and all its visuals?')) return;
      data.report.rows = rows.filter((r) => r.id !== el.dataset.row);
      break;
    case 'row-up': case 'row-down': {
      const i = rows.indexOf(row);
      const j = act === 'row-up' ? i - 1 : i + 1;
      if (j < 0 || j >= rows.length) return;
      [rows[i], rows[j]] = [rows[j], rows[i]];
      break;
    }
    case 'set-cols': {
      const n = Number(el.value);
      const lost = row.visuals.filter((v) => v.start >= n).length;
      if (lost && !confirm(`Reducing columns will remove ${lost} visual(s). Continue?`)) { renderReports(); return; }
      setCols(row, n);
      break;
    }
    case 'add-visual': openEditor(row.id, newVisual(Number(el.dataset.col)), true); return;
    case 'edit-visual': openEditor(row.id, row.visuals.find((v) => v.id === el.dataset.id), false); return;
    case 'del-visual':
      if (!confirm('Remove this visual?')) return;
      row.visuals = row.visuals.filter((v) => v.id !== el.dataset.id);
      break;
    case 'g-from': data.report.filters.from = el.value; break;
    case 'g-to': data.report.filters.to = el.value; break;
    case 'g-kind': data.report.filters.kind = el.value; break;
    case 'g-clear': data.report.filters = { from: '', to: '', kind: '' }; break;
    default: return;
  }
  await commit();
}

document.addEventListener('DOMContentLoaded', () => {
  const page = $('#page-reports');
  page.addEventListener('click', onReportAction);
  page.addEventListener('change', onReportAction);
});

/* ---------- Export / import ---------- */
function exportReport() {
  const blob = new Blob([JSON.stringify({ type: 'finance-report', version: 1, report: data.report }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `report-layout-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function sanitizeReport(raw) {
  const pick = (val, list, dflt) => (list.includes(val) ? val : dflt);
  const f = raw.filters || {};
  const rows = (Array.isArray(raw.rows) ? raw.rows : []).map((r) => {
    const cols = Math.min(MAX_COLS, Math.max(1, Math.floor(Number(r.cols)) || 1));
    const visuals = [];
    (Array.isArray(r.visuals) ? r.visuals : []).forEach((v) => {
      const source = pick(v.source, Object.keys(SOURCES), 'transactions');
      const s = SOURCES[source];
      const start = Math.floor(Number(v.start)) || 0;
      if (start < 0 || start >= cols) return;
      let span = Math.max(1, Math.floor(Number(v.span)) || 1);
      span = Math.min(span, cols - start);
      if (visuals.some((o) => start < o.start + o.span && o.start < start + span)) return; // overlaps
      const type = pick(v.type, VISUAL_TYPES.map((x) => x[0]), 'column');
      visuals.push({
        id: uid(), start, span, title: String(v.title ?? 'Visual'), type, source,
        groupBy: type === 'table' && v.groupBy === '(records)' ? '(records)' : pick(v.groupBy, s.dims, s.dims[0]),
        agg: pick(v.agg, AGGS.map((x) => x[0]), 'sum'),
        field: pick(v.field, s.nums, s.nums[0]),
        sort: pick(v.sort, ['desc', 'asc', 'label'], 'desc'),
        limit: Math.max(0, Number(v.limit) || 0),
        filters: (Array.isArray(v.filters) ? v.filters : [])
          .filter((x) => [...s.dims, ...s.nums].includes(x.field))
          .map((x) => ({ field: x.field, op: pick(x.op, OPS.map((o) => o[0]), 'eq'), value: String(x.value ?? '') })),
      });
    });
    return { id: uid(), cols, visuals };
  });
  return {
    filters: { from: String(f.from || ''), to: String(f.to || ''), kind: ['income', 'expense'].includes(f.kind) ? f.kind : '' },
    rows,
  };
}

async function importReport(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const raw = parsed.report || parsed;
    if (!Array.isArray(raw.rows)) throw new Error('No rows found');
    if (!confirm('Importing replaces your current report layout. Continue?')) return;
    data.report = sanitizeReport(raw);
    reportEditMode = false;
    await commit();
  } catch (err) {
    alert(`Could not import this file: ${err.message}`);
  }
}