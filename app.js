'use strict';

const DATA_FILE_NAME = 'finance-data.json';

const DEFAULT_DATA = () => ({
  meta: { updatedAt: 0 }, // bumped on every save, used to pick the newest copy
  settings: { passwordHash: '', theme: 'light', planExcluded: [], budgetSplit: { need: 50, want: 30, investment: 20 } },
  accounts: [],     // { id, name, type, institution, startingBalance, creditLimit, purpose }
  transactions: [], // { id, kind: 'income'|'expense', amount, accountId, type, date, ts, recurringId? }
  recurring: [],    // { id, kind, amount, accountId, type, lastApplied }
  investments: [],  // { id, name, monthly, start, end }
  planned: [],      // { id, name, amount, category, include }
  plannedIncome: [], // { id, name, amount, include }
  report: { filters: { from: '', to: '', kind: '' }, rows: [] } // see reports.js
});

let data = DEFAULT_DATA();
let fileHandle = null;       // remembered file link, if previously granted
let loadedFromFetch = false; // data came from finance-data.json next to the app
let editingAccountId = null;
let editingInvestmentId = null;
let editingPlanId = null;
let editingPlanIncomeId = null;
let editingRecurringId = null;

const supportsFileApi = 'showOpenFilePicker' in window;

/* ================= Helpers ================= */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (n) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function normalize(parsed) {
  const d = DEFAULT_DATA();
  const rawPlanned = Array.isArray(parsed.planned) ? parsed.planned : [];
  // Items quick-added earlier are now automatic; keep only their exclusions
  const excluded = new Set(Array.isArray(parsed.settings?.planExcluded) ? parsed.settings.planExcluded : []);
  rawPlanned.filter((p) => p.recurringId && p.include === false).forEach((p) => excluded.add(p.recurringId));
  return {
    meta: { ...d.meta, ...(parsed.meta || {}) },
    settings: {
      ...d.settings,
      ...(parsed.settings || {}),
      planExcluded: [...excluded],
      budgetSplit: { ...d.settings.budgetSplit, ...(parsed.settings?.budgetSplit || {}) },
    },
    accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
    transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
    recurring: Array.isArray(parsed.recurring) ? parsed.recurring : [],
    investments: Array.isArray(parsed.investments) ? parsed.investments : [],
    planned: rawPlanned.filter((p) => !p.recurringId),
    plannedIncome: Array.isArray(parsed.plannedIncome) ? parsed.plannedIncome : [],
    report: {
      filters: { ...d.report.filters, ...(parsed.report?.filters || {}) },
      rows: Array.isArray(parsed.report?.rows) ? parsed.report.rows : [],
    },
  };
}

function setStatus(msg, kind) {
  const el = $('#data-status');
  el.textContent = msg;
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('bad', kind === 'bad');
}

function updateConnectionStatus() {
  if (fileHandle) setStatus('Connected to ' + fileHandle.name.replace(/\.json$/i, ''), 'ok');
  else setStatus('Connected to Browser Storage.', 'bad');
}

/* ============ IndexedDB (remembers the file handle) ============ */
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('finance-manager', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ================= File persistence ================= */
async function loadFromFile() {
  const file = await fileHandle.getFile();
  const text = await file.text();
  if (text.trim()) {
    try {
      data = normalize(JSON.parse(text));
    } catch {
      alert('The selected file is not valid JSON. Please choose the correct data file.');
      fileHandle = null;
      return;
    }
  } else {
    data = DEFAULT_DATA();
    await save();
  }
  startApp();
}

/** One-time link to finance-data.json; afterwards saves go straight to the file. */
async function linkDataFile(fresh = false) {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'JSON data', accept: { 'application/json': ['.json'] } }],
    });
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) !== 'granted'
        && (await handle.requestPermission(opts)) !== 'granted') return;
    // The file's own data (including its own password) wins; an empty file starts from the current data
    let fileData = null;
    try {
      const text = await (await handle.getFile()).text();
      if (text.trim()) fileData = normalize(JSON.parse(text));
    } catch {
      return alert('The selected file is not valid JSON. Please choose the correct data file.');
    }
    fileHandle = handle;
    await idbSet('dataFileHandle', handle); // remembered silently for future sessions
    if (fileData) data = fileData;
    else {
      if (fresh) data = DEFAULT_DATA();
      data.settings.passwordHash = ''; // a browser-storage password must never carry into a file
    }

    await commit();
    startApp();
    updateConnectionStatus();
  } catch (err) {
    if (err.name !== 'AbortError') alert(`Could not link the file: ${err.message}`);
  }
}

async function save() {
  data.meta.updatedAt = Date.now();
  if (fileHandle) {
    try {
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(data, null, 2));
      await writable.close();
      updateConnectionStatus();
    } catch (err) {
      console.error(err);
      setStatus('⚠ Could not save to file', 'bad');
      alert('Could not save to the data file. Try reconnecting it from Settings.');
    }
  } else {
    localStorage.setItem('finance-data', JSON.stringify(data));
    updateConnectionStatus();
  }
}

/** Apply a data change, re-render, and persist. */
async function commit() {
  renderAll();
  await save();
}

/* ================= Domain logic ================= */
function accountBalance(accountId) {
  const acc = data.accounts.find((a) => a.id === accountId);
  if (!acc) return 0;
  return data.transactions
    .filter((t) => t.accountId === accountId)
    .reduce((bal, t) => bal + (t.kind === 'income' ? t.amount : -t.amount),
      (Number(acc.startingBalance) || 0) + (acc.type === 'Credit Card' ? Number(acc.creditLimit) || 0 : 0));
}

function accountName(id) {
  return data.accounts.find((a) => a.id === id)?.name || '(deleted account)';
}

function requireAccount() {
  if (data.accounts.length === 0) {
    alert('Please add an account on the Accounts page first.');
    return false;
  }
  return true;
}

function addTransaction(kind, amount, accountId, type, date, recurringId, category) {
  data.transactions.push({
    id: uid(), kind, amount, accountId, type, date,
    ts: Date.now(), ...(recurringId ? { recurringId } : {}), ...(category ? { category } : {}),
  });
}

const BUDGET_BUCKETS = [
  { key: 'need', label: 'Needs' },
  { key: 'want', label: 'Wants' },
  { key: 'investment', label: 'Investing' },
];
const splitPct = (key) => Number(data.settings.budgetSplit[key]) || 0;
const categoryLabel = (c) => ({ need: 'Need', want: 'Want', investment: 'Investment' }[c] || '—');

function renderBudget(monthExpenses, monthIncome) {
  $('#budget-title').textContent = `${splitPct('need')} / ${splitPct('want')} / ${splitPct('investment')} Budget (this month)`;
  $('#budget-hint').textContent = `Based on this month's income: ${splitPct('need')}% needs, ${splitPct('want')}% wants, ${splitPct('investment')}% investing. Change the split on the Budget page.`;
  const rows = BUDGET_BUCKETS.map((b) => {
    const target = monthIncome * splitPct(b.key) / 100;
    const spent = monthExpenses.filter((t) => t.category === b.key).reduce((s, t) => s + t.amount, 0);
    // Needs/wants are a ceiling; investing is a goal to reach
    const ok = b.key === 'investment' ? spent >= target : spent <= target;
    const status = b.key === 'investment'
      ? (ok ? '✅ On track' : '⚠ Behind')
      : (ok ? '✅ In the green' : '🔴 Over budget');
    const left = target - spent;
    return `
    <tr>
      <td>${b.label} (${splitPct(b.key)}%)</td>
      <td class="num">${fmt(target)}</td>
      <td class="num">${fmt(spent)}</td>
      <td class="num ${ok ? 'amount-income' : 'amount-expense'}">${fmt(left)}</td>
      <td>${status}</td>
    </tr>`;
  });
  $('#budget-table').innerHTML = rows.join('');
  const unassigned = monthExpenses.filter((t) => !BUDGET_BUCKETS.some((b) => b.key === t.category));
  const unTotal = unassigned.reduce((s, t) => s + t.amount, 0);
  $('#budget-note').textContent = unassigned.length
    ? `${unassigned.length} expense(s) totalling ${fmt(unTotal)} have no category and aren't counted above.`
    : (monthIncome ? '' : 'No income recorded this month yet.');
}

const AUTO_INVESTMENT_REC_ID = 'auto-investments';

/** Account an investment is paid from; falls back to the first account if unset or deleted. */
function investmentAccountId(inv) {
  return data.accounts.some((a) => a.id === inv.accountId) ? inv.accountId : (data.accounts[0]?.id || '');
}

/** Keeps one grouped, read-only recurring expense equal to the sum of active investments. */
function syncInvestmentRecurring() {
  const total = data.investments
    .filter((i) => investmentStatus(i) === 'Active')
    .reduce((sum, i) => sum + i.monthly, 0);
  const idx = data.recurring.findIndex((r) => r.id === AUTO_INVESTMENT_REC_ID);
  if (!(total > 0)) {
    if (idx >= 0) data.recurring.splice(idx, 1);
    return;
  }
  const rec = {
    id: AUTO_INVESTMENT_REC_ID, kind: 'expense', amount: total, type: 'Investments',
    category: 'investment', auto: true,
    lastApplied: idx >= 0 ? data.recurring[idx].lastApplied || null : null,
  };
  if (idx >= 0) data.recurring[idx] = rec; else data.recurring.push(rec);
}

/** Records the grouped investment payment, one transaction per source account. */
function payInvestments() {
  const byAccount = new Map();
  data.investments.filter((i) => investmentStatus(i) === 'Active').forEach((i) => {
    const acc = investmentAccountId(i);
    byAccount.set(acc, (byAccount.get(acc) || 0) + i.monthly);
  });
  byAccount.forEach((amount, acc) => {
    addTransaction('expense', amount, acc, 'Investments', today(), AUTO_INVESTMENT_REC_ID, 'investment');
  });
  const rec = data.recurring.find((r) => r.id === AUTO_INVESTMENT_REC_ID);
  if (rec) rec.lastApplied = today();
}

/* ================= Rendering ================= */
function renderAll() {
  syncInvestmentRecurring();
  renderDashboard();
  renderFlowPage('income');
  renderFlowPage('expense');
  renderAccounts();
  renderAccountSelects();
  renderInvestments();
  renderPlanner();
  renderSettings();
  renderReports();
  updateConnectionStatus();
}

function renderDashboard() {
  const monthKey = today().slice(0, 7);
  const monthTx = data.transactions.filter((t) => t.date.startsWith(monthKey));
  const monthIncome = monthTx.filter((t) => t.kind === 'income').reduce((s, t) => s + t.amount, 0);
  const monthExpense = monthTx.filter((t) => t.kind === 'expense').reduce((s, t) => s + t.amount, 0);
  const total = data.accounts.reduce((s, a) => s + accountBalance(a.id), 0);

  $('#stat-total').textContent = fmt(total);
  $('#stat-income-month').textContent = fmt(monthIncome);
  $('#stat-expense-month').textContent = fmt(monthExpense);
  const net = monthIncome - monthExpense;
  const netEl = $('#stat-net-month');
  netEl.textContent = fmt(net);
  netEl.className = `stat-value ${net >= 0 ? 'income' : 'expense'}`;
  renderBudget(monthTx.filter((t) => t.kind === 'expense'), monthIncome);

  $('#accounts-summary').innerHTML = data.accounts.map((a) => `
    <tr>
      <td>${esc(a.name)}</td>
      <td>${esc(a.type)}</td>
      <td>${esc(a.institution)}</td>
      <td class="num">${fmt(accountBalance(a.id))}</td>
    </tr>`).join('');
  $('#accounts-summary-empty').classList.toggle('hidden', data.accounts.length > 0);

  const recent = [...data.transactions].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 10);
  $('#recent-transactions').innerHTML = recent.map((t) => `
    <tr>
      <td>${esc(t.date)}</td>
      <td><span class="badge ${t.kind}">${t.kind}</span></td>
      <td>${esc(t.type)}</td>
      <td>${esc(accountName(t.accountId))}</td>
      <td class="num amount-${t.kind}">${t.kind === 'income' ? '+' : '−'} ${fmt(t.amount)}</td>
      <td><button class="icon-btn" data-action="delete-tx" data-id="${t.id}" title="Delete">🗑</button></td>
    </tr>`).join('');
  $('#recent-empty').classList.toggle('hidden', recent.length > 0);
}

function renderFlowPage(kind) {
  const plural = kind === 'income' ? 'income' : 'expense';
  const tx = data.transactions
    .filter((t) => t.kind === kind)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));

  $(`#${plural}-list`).innerHTML = tx.map((t) => `
    <tr>
      <td>${esc(t.date)}</td>
      <td>${esc(t.type)}</td>
      ${kind === 'expense' ? `<td>${categoryLabel(t.category)}</td>` : ''}
      <td>${esc(accountName(t.accountId))}</td>
      <td class="num amount-${kind}">${fmt(t.amount)}</td>
      <td><button class="icon-btn" data-action="delete-tx" data-id="${t.id}" title="Delete">🗑</button></td>
    </tr>`).join('');
  $(`#${plural}-empty`).classList.toggle('hidden', tx.length > 0);

  const recs = data.recurring
    .filter((r) => r.kind === kind)
    .sort((a, b) => (b.auto ? 1 : 0) - (a.auto ? 1 : 0)); // auto "Investments" first
  $(`#rec-${plural}-list`).innerHTML = recs.map((r) => `
    <li>
      <div class="rec-info">
        <strong>${fmt(r.amount)} — ${esc(r.type)}</strong>
        <span class="sub">${r.category ? `${categoryLabel(r.category)} · ` : ''}${r.auto ? 'Paid from each investment\'s account' : esc(accountName(r.accountId))} · Last recorded: ${r.lastApplied || 'never'}</span>
      </div>
      <div class="rec-actions">
        <button class="btn primary small" data-action="apply-rec" data-id="${r.id}">
          ${kind === 'income' ? 'Receive' : 'Pay'}
        </button>
        ${r.auto
    ? '<span class="hint" title="Managed automatically from the Investments page">🔒 Auto</span>'
    : `<button class="icon-btn" data-action="edit-rec" data-id="${r.id}" title="Edit">✏️</button>
        <button class="icon-btn" data-action="del-rec" data-id="${r.id}" title="Delete">🗑</button>`}
      </div>
    </li>`).join('');
}

function renderAccounts() {
  $('#accounts-table').innerHTML = data.accounts.map((a) => `
    <tr>
      <td>${esc(a.name)}</td>
      <td>${esc(a.type)}</td>
      <td>${esc(a.institution)}</td>
      <td class="num">${fmt(a.startingBalance)}</td>
      <td class="num">${a.type === 'Credit Card' ? fmt(Number(a.creditLimit) || 0) : '—'}</td>
      <td class="num"><strong>${fmt(accountBalance(a.id))}</strong></td>
      <td>${esc(a.purpose || '—')}</td>
      <td>
        <button class="icon-btn" data-action="edit-acc" data-id="${a.id}" title="Edit">✏️</button>
        <button class="icon-btn" data-action="del-acc" data-id="${a.id}" title="Delete">🗑</button>
      </td>
    </tr>`).join('');
  $('#accounts-empty').classList.toggle('hidden', data.accounts.length > 0);
}

function monthsBetween(start, end) {
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  return Math.max(0, (ey - sy) * 12 + (em - sm) + 1);
}

function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

function termMonths(inv) {
  if (inv.termMonths) return inv.termMonths;
  return inv.end ? monthsBetween(inv.start, inv.end) : 0; // older entries saved with an end date
}

function termLabel(months) {
  if (!months) return '—';
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y && `${y} yr`, m && `${m} mo`].filter(Boolean).join(' ');
}

function investmentStatus(inv) {
  const t = today();
  if (inv.start > t) return 'Upcoming';
  if (inv.end && inv.end < t) return 'Completed';
  return 'Active';
}

function renderInvestments() {
  const list = [...data.investments].sort((a, b) => a.start.localeCompare(b.start));
  const active = list.filter((i) => investmentStatus(i) === 'Active');
  $('#inv-stat-monthly').textContent = fmt(active.reduce((s, i) => s + i.monthly, 0));
  $('#inv-stat-active').textContent = active.length;
  $('#investments-table').innerHTML = list.map((i) => `
    <tr>
      <td>${esc(i.name)}</td>
      <td class="num">${fmt(i.monthly)}</td>
      <td>${esc(accountName(investmentAccountId(i)))}</td>
      <td>${esc(i.start)}</td>
      <td>${termLabel(termMonths(i))}</td>
      <td>${esc(i.end || 'Ongoing')}</td>
      <td>${investmentStatus(i)}</td>
      <td class="num">${termMonths(i) ? fmt(i.monthly * termMonths(i)) : '—'}</td>
      <td>
        <button class="icon-btn" data-action="edit-inv" data-id="${i.id}" title="Edit">✏️</button>
        <button class="icon-btn" data-action="del-inv" data-id="${i.id}" title="Delete">🗑</button>
      </td>
    </tr>`).join('');
  $('#investments-empty').classList.toggle('hidden', list.length > 0);
}

async function handleInvestmentSubmit(e) {
  e.preventDefault();
  const fields = {
    name: $('#inv-name').value.trim(),
    monthly: parseFloat($('#inv-amount').value) || 0,
    start: $('#inv-start').value,
    accountId: $('#inv-account').value,
  };
  if (!fields.name || !fields.start) return;
  if (!requireAccount() || !fields.accountId) return;
  fields.termMonths = (parseInt($('#inv-years').value, 10) || 0) * 12 + (parseInt($('#inv-months').value, 10) || 0);
  if (fields.termMonths <= 0) return alert('Please enter a term of at least 1 month.');
  fields.end = addMonths(fields.start, fields.termMonths);
  if (editingInvestmentId) {
    const inv = data.investments.find((i) => i.id === editingInvestmentId);
    if (inv) Object.assign(inv, fields);
  } else {
    data.investments.push({ id: uid(), ...fields });
  }
  resetInvestmentForm();
  await commit();
}

function startEditInvestment(id) {
  const inv = data.investments.find((i) => i.id === id);
  if (!inv) return;
  editingInvestmentId = id;
  $('#inv-name').value = inv.name;
  $('#inv-amount').value = inv.monthly;
  $('#inv-account').value = investmentAccountId(inv);
  $('#inv-start').value = inv.start;
  const months = termMonths(inv);
  $('#inv-years').value = Math.floor(months / 12);
  $('#inv-months').value = months % 12;
  $('#inv-form-title').textContent = 'Edit Investment';
  $('#inv-submit').textContent = 'Save Changes';
  $('#inv-cancel').classList.remove('hidden');
  $('#inv-name').focus();
}

function resetInvestmentForm() {
  editingInvestmentId = null;
  $('#investment-form').reset();
  $('#inv-start').value = today();
  $('#inv-years').value = 5;
  $('#inv-months').value = 0;
  $('#inv-form-title').textContent = 'Add Investment';
  $('#inv-submit').textContent = 'Add Investment';
  $('#inv-cancel').classList.add('hidden');
}

function renderPlanner() {
  ['need', 'want', 'investment'].forEach((k) => {
    const el = $(`#split-${k}`);
    if (document.activeElement !== el) el.value = splitPct(k);
  });
  const s = data.settings;

  // Recurring income is pulled in automatically; only exclusions are stored
  const excluded = new Set(s.planExcluded);
  const incomePlan = [
    ...data.recurring.filter((r) => r.kind === 'income').map((r) => ({
      id: r.id, name: r.type, amount: r.amount, include: !excluded.has(r.id), fromRecurring: true,
    })),
    ...data.plannedIncome,
  ];
  const income = incomePlan.filter((p) => p.include !== false).reduce((sum, p) => sum + p.amount, 0);
  const recPlan = data.recurring
    .filter((r) => r.kind === 'expense')
    .map((r) => ({
      id: r.id, name: r.type, amount: r.amount, category: r.category || 'need',
      include: !excluded.has(r.id), fromRecurring: true,
    }));
  const allPlan = [...recPlan, ...data.planned];
  const included = allPlan.filter((p) => p.include !== false);

  let anyOver = false;
  $('#plan-summary').innerHTML = BUDGET_BUCKETS.map((b) => {
    const target = income * splitPct(b.key) / 100;
    const planned = included.filter((p) => p.category === b.key).reduce((sum, p) => sum + p.amount, 0);
    const left = target - planned;
    // Needs/wants must not exceed the target; investing should at least reach it
    const ok = b.key === 'investment' ? planned >= target : planned <= target;
    if (!ok) anyOver = true;
    const status = b.key === 'investment'
      ? (ok ? '✅ On track' : '⚠ Below goal')
      : (ok ? '✅ In the green' : '🔴 Over budget');
    return `
    <tr>
      <td>${b.label} (${splitPct(b.key)}%)</td>
      <td class="num">${fmt(target)}</td>
      <td class="num">${fmt(planned)}</td>
      <td class="num ${ok ? 'amount-income' : 'amount-expense'}">${fmt(left)}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');

  const totalPlanned = included.reduce((sum, p) => sum + p.amount, 0);
  const remaining = income - totalPlanned;
  $('#plan-verdict').textContent = !(income > 0)
    ? 'Add planned income below to see your verdict.'
    : `Income ${fmt(income)} − planned ${fmt(totalPlanned)} = ${fmt(remaining)} unallocated. `
      + (remaining < 0 ? '🔴 This plan spends more than you earn.'
        : anyOver ? '⚠ Some categories are off target.' : '✅ You are on track.');

  $('#pinc-list').innerHTML = incomePlan.map((p) => `
    <tr>
      <td><input type="checkbox" data-action="${p.fromRecurring ? 'toggle-rec-plan' : 'toggle-pinc'}" data-id="${p.id}" ${p.include !== false ? 'checked' : ''}></td>
      <td>${esc(p.name)}${p.fromRecurring ? ' <span class="hint">(recurring)</span>' : ''}</td>
      <td class="num">${fmt(p.amount)}</td>
      <td>${p.fromRecurring ? '' : `
        <button class="icon-btn" data-action="edit-pinc" data-id="${p.id}" title="Edit">✏️</button>
        <button class="icon-btn" data-action="del-pinc" data-id="${p.id}" title="Delete">🗑</button>`}
      </td>
    </tr>`).join('');
  $('#pinc-empty').classList.toggle('hidden', incomePlan.length > 0);

  $('#plan-list').innerHTML = allPlan.map((p) => `
    <tr>
      <td><input type="checkbox" data-action="${p.fromRecurring ? 'toggle-rec-plan' : 'toggle-plan'}" data-id="${p.id}" ${p.include !== false ? 'checked' : ''}></td>
      <td>${esc(p.name)}${p.fromRecurring ? ' <span class="hint">(recurring)</span>' : ''}</td>
      <td>${categoryLabel(p.category)}</td>
      <td class="num">${fmt(p.amount)}</td>
      <td>${p.fromRecurring ? '' : `
        <button class="icon-btn" data-action="edit-plan" data-id="${p.id}" title="Edit">✏️</button>
        <button class="icon-btn" data-action="del-plan" data-id="${p.id}" title="Delete">🗑</button>`}
      </td>
    </tr>`).join('');
  $('#plan-empty').classList.toggle('hidden', allPlan.length > 0);
}

async function handlePlanIncomeSubmit(e) {
  e.preventDefault();
  const fields = { name: $('#pinc-name').value.trim(), amount: parseFloat($('#pinc-amount').value) };
  if (!fields.name || !(fields.amount > 0)) return;
  if (editingPlanIncomeId) {
    const p = data.plannedIncome.find((x) => x.id === editingPlanIncomeId);
    if (p) Object.assign(p, fields);
  } else {
    data.plannedIncome.push({ id: uid(), include: true, ...fields });
  }
  resetPlanIncomeForm();
  await commit();
}

function startEditPlanIncome(id) {
  const p = data.plannedIncome.find((x) => x.id === id);
  if (!p) return;
  editingPlanIncomeId = id;
  $('#pinc-name').value = p.name;
  $('#pinc-amount').value = p.amount;
  $('#pinc-form-title').textContent = 'Edit Planned Income';
  $('#pinc-submit').textContent = 'Save Changes';
  $('#pinc-cancel').classList.remove('hidden');
  $('#pinc-name').focus();
}

function resetPlanIncomeForm() {
  editingPlanIncomeId = null;
  $('#pinc-form').reset();
  $('#pinc-form-title').textContent = 'Add Planned Income';
  $('#pinc-submit').textContent = 'Add Planned Income';
  $('#pinc-cancel').classList.add('hidden');
}

async function handlePlanSubmit(e) {
  e.preventDefault();
  const fields = {
    name: $('#plan-name').value.trim(),
    amount: parseFloat($('#plan-amount').value),
    category: $('#plan-category').value,
  };
  if (!fields.name || !(fields.amount > 0)) return;
  if (editingPlanId) {
    const p = data.planned.find((x) => x.id === editingPlanId);
    if (p) Object.assign(p, fields);
  } else {
    data.planned.push({ id: uid(), include: true, ...fields });
  }
  resetPlanForm();
  await commit();
}

function startEditPlan(id) {
  const p = data.planned.find((x) => x.id === id);
  if (!p) return;
  editingPlanId = id;
  $('#plan-name').value = p.name;
  $('#plan-amount').value = p.amount;
  $('#plan-category').value = p.category;
  $('#plan-form-title').textContent = 'Edit Planned Expense';
  $('#plan-submit').textContent = 'Save Changes';
  $('#plan-cancel').classList.remove('hidden');
  $('#plan-name').focus();
}

function resetPlanForm() {
  editingPlanId = null;
  $('#plan-form').reset();
  $('#plan-form-title').textContent = 'Add Planned Expense';
  $('#plan-submit').textContent = 'Add Planned Expense';
  $('#plan-cancel').classList.add('hidden');
}

function renderAccountSelects() {
  const options = data.accounts.map((a) => `<option value="${a.id}">${esc(a.name)} (${esc(a.institution)})</option>`).join('');
  $$('.account-select').forEach((sel) => {
    const current = sel.value;
    sel.innerHTML = data.accounts.length
      ? options
      : '<option value="" disabled selected>No accounts yet</option>';
    if (current && data.accounts.some((a) => a.id === current)) sel.value = current;
  });
}

function renderSettings() {
  $('#set-theme').value = data.settings.theme;
  $('#data-file-info').textContent = fileHandle
    ? `${fileHandle.name} (linked — saves go straight to the file)`
    : loadedFromFetch
      ? 'finance-data.json (loaded at startup — edits save in this browser)'
      : 'Browser storage';
  $('#btn-link-file').classList.toggle('hidden', Boolean(fileHandle) || !supportsFileApi);
  $('#btn-disconnect-file').classList.toggle('hidden', !fileHandle);
  $('#btn-lock').classList.toggle('hidden', !data.settings.passwordHash);
  $('#password-card').classList.toggle('hidden', !fileHandle);
}

/* ================= Theme & lock ================= */
function applyTheme() {
  document.documentElement.dataset.theme = data.settings.theme;
}

function applyLockState() {
  const locked = Boolean(data.settings.passwordHash);
  $('#lock-screen').classList.toggle('hidden', !locked);
  $('#lock-change-file').classList.toggle('hidden', !supportsFileApi);
  $('#lock-error').classList.add('hidden');
  if (locked) $('#lock-password').focus();
}

/* ================= App start ================= */
function startApp() {
  $('#app').classList.remove('hidden');
  applyTheme();
  $$('input[type="date"]').forEach((i) => { if (!i.value) i.value = today(); });
  renderAll();
  applyLockState();
}

/* ================= Events ================= */
function bindEvents() {
  // Navigation
  $$('.tab').forEach((btn) => btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${btn.dataset.page}`));
  }));

  // Lock screen
  $('#lock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hash = await sha256($('#lock-password').value);
    if (hash === data.settings.passwordHash) {
      $('#lock-screen').classList.add('hidden');
      $('#lock-password').value = '';
      $('#lock-error').classList.add('hidden');
    } else {
      $('#lock-error').classList.remove('hidden');
    }
  });
  $('#btn-lock').addEventListener('click', applyLockState);
  $('#lock-change-file').addEventListener('click', () => linkDataFile(true));
  $('#lock-disconnect').addEventListener('click', async () => {
    if (!confirm('Disconnect from this file and work on browser storage instead?')) return;
    fileHandle = null;
    await idbDel('dataFileHandle');
    loadBrowserData();
    startApp();
  });

  // One-time income / expense forms
  $('#income-form').addEventListener('submit', (e) => handleTxSubmit(e, 'income'));
  $('#expense-form').addEventListener('submit', (e) => handleTxSubmit(e, 'expense'));

  // Recurring income / expense setup forms
  $('#rec-income-form').addEventListener('submit', (e) => handleRecSubmit(e, 'income'));
  $('#rec-expense-form').addEventListener('submit', (e) => handleRecSubmit(e, 'expense'));
  $('#rec-income-cancel').addEventListener('click', () => resetRecurringForm('income'));
  $('#rec-expense-cancel').addEventListener('click', () => resetRecurringForm('expense'));

  // Account form (add / edit)
  $('#account-form').addEventListener('submit', handleAccountSubmit);
  $('#acc-type').addEventListener('change', updateCreditLimitField);
  $('#acc-cancel').addEventListener('click', resetAccountForm);

  $('#investment-form').addEventListener('submit', handleInvestmentSubmit);
  $('#inv-cancel').addEventListener('click', resetInvestmentForm);

  $('#split-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const split = {};
    ['need', 'want', 'investment'].forEach((k) => { split[k] = parseFloat($(`#split-${k}`).value); });
    if (Object.values(split).some((v) => !(v >= 0))) return;
    const total = split.need + split.want + split.investment;
    if (Math.abs(total - 100) > 0.001) return alert(`The split must add up to 100% (currently ${total}%).`);
    data.settings.budgetSplit = split;
    await commit();
    updateConnectionStatus();
  });
  $('#split-reset').addEventListener('click', async () => {
    data.settings.budgetSplit = { need: 50, want: 30, investment: 20 };
    await commit();
  });

  $('#plan-form').addEventListener('submit', handlePlanSubmit);
  $('#plan-cancel').addEventListener('click', resetPlanForm);
  $('#pinc-form').addEventListener('submit', handlePlanIncomeSubmit);
  $('#pinc-cancel').addEventListener('click', resetPlanIncomeForm);

  // Settings
  $('#set-theme').addEventListener('change', async (e) => {
    data.settings.theme = e.target.value;
    applyTheme();
    await save();
  });

  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#set-password').value;
    if (!pw) return;
    data.settings.passwordHash = await sha256(pw);
    $('#set-password').value = '';
    await commit();
    alert('Password set. The app will ask for it when opened.');
  });

  $('#btn-clear-password').addEventListener('click', async () => {
    if (!data.settings.passwordHash) return alert('No password is set.');
    if (!confirm('Remove the password lock?')) return;
    data.settings.passwordHash = '';
    await commit();
  });

  $('#btn-link-file').addEventListener('click', () => linkDataFile());
  $('#btn-disconnect-file').addEventListener('click', async () => {
    if (!confirm('Disconnect from the data file? Your data will be kept in this browser from now on.')) return;
    fileHandle = null;
    await idbDel('dataFileHandle');
    data.settings.passwordHash = ''; // passwords only belong to files
    await commit(); // saves the current data to browser storage
  });

  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileHandle ? fileHandle.name : DATA_FILE_NAME;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = normalize(JSON.parse(await file.text()));
      if (!confirm('Importing will replace ALL current data. Continue?')) return;
      data = parsed;
      await commit();
      alert('Data imported successfully.');
    } catch {
      alert('That file is not valid JSON.');
    } finally {
      e.target.value = '';
    }
  });

  $('#btn-clear-all').addEventListener('click', async () => {
    if (!confirm('Delete ALL data (accounts, transactions, settings)? This cannot be undone.')) return;
    if (!confirm('Are you really sure?')) return;
    const theme = data.settings.theme;
    data = DEFAULT_DATA();
    data.settings.theme = theme;
    resetAccountForm();
    applyTheme();
    await commit();
  });

  // Delegated actions (delete/apply/edit buttons in lists)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === 'delete-tx') {
      if (!confirm('Delete this transaction?')) return;
      data.transactions = data.transactions.filter((t) => t.id !== id);
      await commit();
    } else if (action === 'apply-rec') {
      const rec = data.recurring.find((r) => r.id === id);
      if (!rec) return;
      if (rec.auto) {
        if (!requireAccount()) return;
        payInvestments();
        return commit();
      }
      addTransaction(rec.kind, rec.amount, rec.accountId, rec.type, today(), rec.id, rec.category);
      rec.lastApplied = today();
      await commit();
    } else if (action === 'del-rec') {
      const recurring = data.recurring.find((r) => r.id === id);
      if (recurring?.auto) return;
      if (!confirm('Delete this recurring item?')) return;
      data.recurring = data.recurring.filter((r) => r.id !== id);
      if (editingRecurringId === id && recurring) resetRecurringForm(recurring.kind);
      await commit();
    } else if (action === 'edit-rec') {
      startEditRecurring(id);
    } else if (action === 'toggle-rec-plan') {
      const ex = new Set(data.settings.planExcluded);
      if (btn.checked) ex.delete(id); else ex.add(id);
      data.settings.planExcluded = [...ex];
      await commit();
    } else if (action === 'toggle-pinc') {
      const p = data.plannedIncome.find((x) => x.id === id);
      if (!p) return;
      p.include = btn.checked;
      await commit();
    } else if (action === 'edit-pinc') {
      startEditPlanIncome(id);
    } else if (action === 'del-pinc') {
      const p = data.plannedIncome.find((x) => x.id === id);
      if (!p || !confirm(`Delete "${p.name}"?`)) return;
      data.plannedIncome = data.plannedIncome.filter((x) => x.id !== id);
      if (editingPlanIncomeId === id) resetPlanIncomeForm();
      await commit();
    } else if (action === 'toggle-plan') {
      const p = data.planned.find((x) => x.id === id);
      if (!p) return;
      p.include = btn.checked;
      await commit();
    } else if (action === 'edit-plan') {
      startEditPlan(id);
    } else if (action === 'del-plan') {
      const p = data.planned.find((x) => x.id === id);
      if (!p || !confirm(`Delete "${p.name}"?`)) return;
      data.planned = data.planned.filter((x) => x.id !== id);
      if (editingPlanId === id) resetPlanForm();
      await commit();
    } else if (action === 'edit-inv') {
      startEditInvestment(id);
    } else if (action === 'del-inv') {
      const inv = data.investments.find((i) => i.id === id);
      if (!inv || !confirm(`Delete "${inv.name}"?`)) return;
      data.investments = data.investments.filter((i) => i.id !== id);
      if (editingInvestmentId === id) resetInvestmentForm();
      await commit();
    } else if (action === 'edit-acc') {
      startEditAccount(id);
    } else if (action === 'del-acc') {
      const acc = data.accounts.find((a) => a.id === id);
      if (!acc) return;
      const txCount = data.transactions.filter((t) => t.accountId === id).length;
      const msg = txCount
        ? `Delete "${acc.name}" and its ${txCount} transaction(s)?`
        : `Delete "${acc.name}"?`;
      if (!confirm(msg)) return;
      data.accounts = data.accounts.filter((a) => a.id !== id);
      data.transactions = data.transactions.filter((t) => t.accountId !== id);
      const editingRecurring = data.recurring.find((r) => r.id === editingRecurringId);
      data.recurring = data.recurring.filter((r) => r.accountId !== id);
      if (editingRecurring?.accountId === id) resetRecurringForm(editingRecurring.kind);
      await commit();
    }
  });
}

async function handleTxSubmit(e, kind) {
  e.preventDefault();
  if (!requireAccount()) return;
  const amount = parseFloat($(`#${kind}-amount`).value);
  const accountId = $(`#${kind}-account`).value;
  const type = $(`#${kind}-type`).value.trim();
  const date = $(`#${kind}-date`).value || today();
  const category = kind === 'expense' ? $('#expense-category').value : '';
  if (!(amount > 0) || !accountId || !type || (kind === 'expense' && !category)) return;

  addTransaction(kind, amount, accountId, type, date, null, category);
  e.target.reset();
  $(`#${kind}-date`).value = today();
  await commit();
}

async function handleRecSubmit(e, kind) {
  e.preventDefault();
  if (!requireAccount()) return;
  const amount = parseFloat($(`#rec-${kind}-amount`).value);
  const accountId = $(`#rec-${kind}-account`).value;
  const type = $(`#rec-${kind}-type`).value.trim();
  const category = kind === 'expense' ? $('#rec-expense-category').value : '';
  if (!(amount > 0) || !accountId || !type || (kind === 'expense' && !category)) return;

  if (editingRecurringId) {
    const recurring = data.recurring.find((r) => r.id === editingRecurringId);
    if (recurring) Object.assign(recurring, { amount, accountId, type, ...(category ? { category } : {}) });
  } else {
    data.recurring.push({ id: uid(), kind, amount, accountId, type, lastApplied: null, ...(category ? { category } : {}) });
  }
  resetRecurringForm(kind);
  await commit();
}

function startEditRecurring(id) {
  const recurring = data.recurring.find((r) => r.id === id);
  if (!recurring || recurring.auto) return;
  const currentEdit = data.recurring.find((r) => r.id === editingRecurringId);
  if (currentEdit && currentEdit.id !== id) resetRecurringForm(currentEdit.kind);
  editingRecurringId = id;
  const prefix = `rec-${recurring.kind}`;
  $(`#${prefix}-amount`).value = recurring.amount;
  $(`#${prefix}-account`).value = recurring.accountId;
  $(`#${prefix}-type`).value = recurring.type;
  if (recurring.kind === 'expense') $(`#${prefix}-category`).value = recurring.category || '';
  $(`#${prefix}-submit`).textContent = `Save Recurring ${recurring.kind === 'income' ? 'Income' : 'Expense'}`;
  $(`#${prefix}-cancel`).classList.remove('hidden');
  $(`#${prefix}-amount`).focus();
}

function resetRecurringForm(kind) {
  const prefix = `rec-${kind}`;
  $(`#${prefix}-form`).reset();
  $(`#${prefix}-submit`).textContent = `Add Recurring ${kind === 'income' ? 'Income' : 'Expense'}`;
  $(`#${prefix}-cancel`).classList.add('hidden');
  editingRecurringId = null;
}

async function handleAccountSubmit(e) {
  e.preventDefault();
  const fields = {
    name: $('#acc-name').value.trim(),
    type: $('#acc-type').value,
    institution: $('#acc-institution').value,
    startingBalance: parseFloat($('#acc-balance').value) || 0,
    creditLimit: $('#acc-type').value === 'Credit Card' ? parseFloat($('#acc-credit-limit').value) || 0 : 0,
    purpose: $('#acc-purpose').value.trim(),
  };
  if (!fields.name) return;

  if (editingAccountId) {
    const acc = data.accounts.find((a) => a.id === editingAccountId);
    if (acc) Object.assign(acc, fields);
  } else {
    data.accounts.push({ id: uid(), ...fields });
  }
  resetAccountForm();
  await commit();
}

function startEditAccount(id) {
  const acc = data.accounts.find((a) => a.id === id);
  if (!acc) return;
  editingAccountId = id;
  $('#acc-name').value = acc.name;
  $('#acc-type').value = acc.type;
  $('#acc-institution').value = acc.institution;
  $('#acc-balance').value = acc.startingBalance;
  $('#acc-credit-limit').value = acc.creditLimit || 0;
  updateCreditLimitField();
  $('#acc-purpose').value = acc.purpose || '';
  $('#account-form-title').textContent = 'Edit Account';
  $('#acc-submit').textContent = 'Save Changes';
  $('#acc-cancel').classList.remove('hidden');
  $('#acc-name').focus();
}

function resetAccountForm() {
  editingAccountId = null;
  $('#account-form').reset();
  updateCreditLimitField();
  $('#account-form-title').textContent = 'Add Account';
  $('#acc-submit').textContent = 'Add Account';
  $('#acc-cancel').classList.add('hidden');
}

function updateCreditLimitField() {
  $('#acc-credit-limit-field').classList.toggle('hidden', $('#acc-type').value !== 'Credit Card');
}

/* Browser storage never has a password */
function loadBrowserData() {
  data = DEFAULT_DATA();
  const saved = localStorage.getItem('finance-data');
  if (saved) {
    try { data = normalize(JSON.parse(saved)); } catch { /* ignore */ }
  }
  data.settings.passwordHash = '';
  updateConnectionStatus();
}

/* ================= Init ================= */
async function init() {
  bindEvents();

  // 1) Silently restore a remembered file link — no picker when permission persists
  if (supportsFileApi) {
    try {
      const handle = await idbGet('dataFileHandle');
      if (handle && (await handle.queryPermission({ mode: 'readwrite' })) === 'prompt') {
        // Browsers drop write permission between sessions; re-grant on the first click (needs a user gesture)
        document.addEventListener('pointerdown', async function regrant() {
          document.removeEventListener('pointerdown', regrant, true);
          try {
            if ((await handle.requestPermission({ mode: 'readwrite' })) === 'granted') {
              fileHandle = handle;
              await loadFromFile();
              updateConnectionStatus();
            }
          } catch (err) {
            console.warn('Could not re-grant file access:', err);
            fileHandle = null;
          }
        }, true);
      } else if (handle && (await handle.queryPermission({ mode: 'readwrite' })) === 'granted') {
        try {
          fileHandle = handle;
          await loadFromFile();
          return;
        } catch (err) {
          console.warn('Remembered file is gone, falling back:', err);
          fileHandle = null;
          await idbDel('dataFileHandle');
        }
      }
    } catch (err) {
      console.warn('Could not restore saved file handle:', err);
    }
  }

  // 2) Load both copies — finance-data.json next to the app (when fetch works)
  //    and browser storage — then keep whichever was saved most recently.
  let fileData = null;
  try {
    const res = await fetch(DATA_FILE_NAME, { cache: 'no-store' });
    if (res.ok) {
      const text = await res.text();
      if (text.trim()) fileData = normalize(JSON.parse(text));
    }
  } catch { /* opened via file:// or file missing — fall through */ }

  let localData = null;
  const saved = localStorage.getItem('finance-data');
  if (saved) {
    try { localData = normalize(JSON.parse(saved)); } catch { /* ignore */ }
  }

  loadedFromFetch = Boolean(fileData);
  if (fileData && (!localData || (fileData.meta.updatedAt || 0) >= (localData.meta.updatedAt || 0))) {
    data = fileData;
    localStorage.setItem('finance-data', JSON.stringify(data)); // keep browser copy in sync
  } else if (localData) {
    data = localData;
  }
  data.settings.passwordHash = '';
  startApp();
}

document.addEventListener('DOMContentLoaded', init);
