import { currentUser, logout, deleteAccount, clearMyData } from "./auth.js";

console.log("Dashboard JS loaded");

/**
 * Backend base URL resolution:
 * - Local dev (localhost/127.0.0.1) -> http://127.0.0.1:8000
 * - Production (Vercel) -> your Railway backend URL
 */
function resolveBackendApiBase() {
  const host = window.location.hostname;

  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".local");

  if (isLocal) return "http://127.0.0.1:8000";

  // ✅ Your deployed backend (Railway)
  return "https://b-statement-live-production.up.railway.app";
}

const API_BASE = resolveBackendApiBase().replace(/\/$/, "");
const BACKEND_ANALYSE_URL = `${API_BASE}/analyse`;
const BACKEND_ANALYZE_URL = `${API_BASE}/analyze`; // alias support

const REQUEST_TIMEOUT_MS = 90000; // 90 seconds
const MAX_FILES = 10;

const $ = (id) => document.getElementById(id);

const userLine = $("userLine");
const filesInput = $("filesInput");
const analyseAllBtn = $("analyseAllBtn");
const countText = $("countText");
const statusEl = $("status");

const invoicesTbody = document.querySelector("#invoicesTable tbody");
const leaderTbody = document.querySelector("#leaderTable tbody");
const focusText = $("focusText");

// ✅ KPI elements (must exist in dashboard.html)
const kpiMonthlySpend = $("kpiMonthlySpend");
const kpiMonthlyDelta = $("kpiMonthlyDelta");
const kpiLeak = $("kpiLeak");
const kpiLeakSub = $("kpiLeakSub");
const kpiVat = $("kpiVat");

// Modal
const modalOverlay = $("modalOverlay");
const settingsBtn = $("settingsBtn");
const closeModalBtn = $("closeModalBtn");
const settingsName = $("settingsName");
const settingsEmail = $("settingsEmail");
const clearDataBtn = $("clearDataBtn");
const deleteAccountBtn = $("deleteAccountBtn");
const logoutBtn = $("logoutBtn");
const logoutBtn2 = $("logoutBtn2");

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg || "";
}

function currencySymbol(codeOrSymbol) {
  if (!codeOrSymbol) return "£";
  const v = String(codeOrSymbol).trim();
  if (v === "GBP") return "£";
  if (v === "USD") return "$";
  if (v === "EUR") return "€";
  if (v === "£" || v === "$" || v === "€") return v;
  return "£";
}

function money(n, currency = "£") {
  const num = Number(n);
  const sym = currencySymbol(currency);
  if (!Number.isFinite(num)) return `${sym}0.00`;
  return `${sym}${num.toFixed(2)}`;
}

function titleCase(s) {
  return (s || "").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
}

function inferSupplierFromFilename(filename) {
  const base = (filename || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!base) return "Unknown Supplier";
  return titleCase(base.split(" ").slice(0, 3).join(" "));
}

function supplierKey(name) {
  return (name || "").toLowerCase().trim();
}

function changeText(now, prev, currency = "£") {
  if (prev == null) return "First time";
  const diff = now - prev;
  if (Math.abs(diff) < 0.01) return "No change";
  return diff > 0
    ? `+${money(diff, currency)}`
    : `-${money(Math.abs(diff), currency)}`;
}

function changePct(now, prev) {
  const n = Number(now);
  const p = Number(prev);
  if (!Number.isFinite(n) || !Number.isFinite(p) || p <= 0) return null;
  return ((n - p) / p) * 100;
}

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

// ----- per-user storage keys -----
function invoicesKey(userId) {
  return `spw_invoices_${userId}`;
}
function historyKey(userId) {
  return `spw_history_${userId}`;
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// ----- backend helpers -----
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Try /analyse first, then /analyze if needed.
 */
async function postToBackend(formData) {
  let res = await fetchWithTimeout(BACKEND_ANALYSE_URL, {
    method: "POST",
    body: formData
  });

  if (!res.ok && (res.status === 404 || res.status === 405)) {
    res = await fetchWithTimeout(BACKEND_ANALYZE_URL, {
      method: "POST",
      body: formData
    });
  }

  return res;
}

function pickTotalFromBackendJSON(data) {
  if (!data || typeof data !== "object") return null;

  const candidates = [
    data.total,
    data.invoice_total,
    data.amount,
    data.total_amount,
    data.total_gbp
  ];

  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function pickCurrencyFromBackendJSON(data) {
  if (!data || typeof data !== "object") return "£";
  return data.currency || data.currency_code || "£";
}

function pickVendorFromBackendJSON(data) {
  if (!data || typeof data !== "object") return null;
  return data.vendor || data.merchant || data.supplier || null;
}

function demoTotalFromFile(file) {
  return Math.max(1, Math.round(Number(file?.size || 0) / 100));
}

// ----- KPI logic -----
function safeSetText(el, text) {
  if (el) el.textContent = text;
}

function parseDateSafe(x) {
  if (!x) return null;
  const d = new Date(x);
  if (isNaN(d)) return null;
  return d;
}

function sumInvoicesForMonth(invoices, year, month) {
  return invoices
    .filter((inv) => {
      const d = parseDateSafe(inv.date);
      return d && d.getFullYear() === year && d.getMonth() === month;
    })
    .reduce((sum, inv) => sum + (Number(inv.total) || 0), 0);
}

function updateKpis(invoices) {
  // If KPI nodes aren’t on the page, silently do nothing
  if (!kpiMonthlySpend || !kpiMonthlyDelta || !kpiLeakValue || !kpiLeakTitle || !kpiVatTotal) return;

  const now = new Date();
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth();
  const lastMonthDate = new Date(thisYear, thisMonth - 1, 1);
  const lastMonth = lastMonthDate.getMonth();
  const lastMonthYear = lastMonthDate.getFullYear();

  // Use GBP for KPI display (you can upgrade later to multi-currency)
  const thisMonthSpend = sumInvoicesForMonth(invoices, thisYear, thisMonth);
  const lastMonthSpend = sumInvoicesForMonth(invoices, lastMonthYear, lastMonth);

  safeSetText(kpiMonthlySpend, money(thisMonthSpend, "GBP"));

  if (lastMonthSpend > 0) {
    const pct = ((thisMonthSpend - lastMonthSpend) / lastMonthSpend) * 100;
    const arrow = pct >= 0 ? "↑" : "↓";
    safeSetText(kpiMonthlyDelta, `${arrow} ${Math.abs(pct).toFixed(1)}% vs last month`);
  } else {
    safeSetText(kpiMonthlyDelta, "vs last month —");
  }

  // Leak alert: biggest % increase from invoice-to-invoice per supplier
  let best = null;
  for (const inv of invoices) {
    const pct = Number(inv.changePct);
    if (Number.isFinite(pct) && pct > 0) {
      if (!best || pct > best.pct) {
        best = { pct, supplier: inv.supplier || "Supplier" };
      }
    }
  }

  if (!best) {
    safeSetText(kpiLeakValue, "—");
    safeSetText(kpiLeakTitle, "No alerts yet");
  } else {
    safeSetText(kpiLeakValue, `↑ ${best.pct.toFixed(1)}%`);
    safeSetText(kpiLeakTitle, `${best.supplier} price hike`);
  }

  // VAT estimate (20% of this month’s spend)
  const vat = thisMonthSpend * 0.20;
  safeSetText(kpiVatTotal, money(vat, "GBP"));
}

// ----- render -----
function renderInvoices(invoices) {
  if (!invoicesTbody) return;
  invoicesTbody.innerHTML = "";

  if (!invoices.length) {
    invoicesTbody.innerHTML = `<tr><td colspan="5" style="color:rgba(0,0,0,.6)">No uploads yet</td></tr>`;
    return;
  }

  for (const inv of invoices) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${inv.date || "—"}</td>
      <td>${inv.supplier || "—"}</td>
      <td title="${inv.filename || ""}">${inv.filename || "—"}</td>
      <td>${money(inv.total, inv.currency || "£")}</td>
      <td>${inv.changeText || "—"}</td>
    `;
    invoicesTbody.appendChild(tr);
  }
}

function renderLeaderboard(history) {
  if (!leaderTbody) return;
  leaderTbody.innerHTML = "";

  const suppliers = Object.values(history.suppliers || {}).sort(
    (a, b) => (b.totalSpend || 0) - (a.totalSpend || 0)
  );

  if (!suppliers.length) {
    leaderTbody.innerHTML = `<tr><td colspan="4" style="color:rgba(0,0,0,.6)">No history yet</td></tr>`;
    return;
  }

  for (const s of suppliers) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.displayName || "—"}</td>
      <td>${money(s.totalSpend, s.currency || "£")}</td>
      <td>${money(s.lastInvoiceTotal, s.currency || "£")}</td>
      <td>${s.lastChangeText || "—"}</td>
    `;
    leaderTbody.appendChild(tr);
  }

  const top = suppliers[0];
  if (focusText) {
    focusText.textContent = top
      ? `Biggest supplier: ${top.displayName}. Watch the next invoice for increases.`
      : "—";
  }
}
// ----- KPI calculations + render -----
function sum(arr) {
  return arr.reduce((a, b) => a + (Number(b) || 0), 0);
}

function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function getInvoiceMonth(inv) {
  // inv.date is YYYY-MM-DD
  const d = (inv?.date || "").slice(0, 7);
  return d && d.length === 7 ? d : monthKey(new Date());
}

function computeMonthlySpend(invoices, whichMonth) {
  const monthInvoices = invoices.filter((inv) => getInvoiceMonth(inv) === whichMonth);
  const totals = monthInvoices.map((inv) => Number(inv.total) || 0);
  return sum(totals);
}

function computeVatEstimate(invoices, whichMonth) {
  // Simple VAT estimate: assumes totals include VAT, and uses 20% VAT rate.
  // VAT portion of a VAT-inclusive total: total * (rate / (1 + rate))
  const rate = 0.2;
  const total = computeMonthlySpend(invoices, whichMonth);
  return total * (rate / (1 + rate));
}

function computeTopLeak(invoices, whichMonth) {
  // Biggest positive change vs previous invoice for same supplier within this month.
  // Uses stored changeText if it’s a +£ value, otherwise recomputes from history in invoices list.

  const monthInvoices = invoices.filter((inv) => getInvoiceMonth(inv) === whichMonth);

  // Group by supplier (newest first already if invoices is newest-first)
  const bySupplier = {};
  for (const inv of monthInvoices.slice().reverse()) {
    // reverse -> oldest to newest for easier comparison
    const s = supplierKey(inv.supplier || "unknown");
    bySupplier[s] ||= [];
    bySupplier[s].push(inv);
  }

  let best = null; // {supplier, diff, nowTotal, prevTotal}
  for (const sKey in bySupplier) {
    const list = bySupplier[sKey];
    for (let i = 1; i < list.length; i++) {
      const prev = Number(list[i - 1].total) || 0;
      const now = Number(list[i].total) || 0;
      const diff = now - prev;
      if (diff > 0.01) {
        if (!best || diff > best.diff) {
          best = {
            supplier: list[i].supplier || "Unknown supplier",
            diff,
            nowTotal: now,
            prevTotal: prev,
            currency: list[i].currency || "£",
          };
        }
      }
    }
  }

  return best; // can be null
}

function renderKpis(invoices) {
  if (!kpiMonthlySpend || !kpiMonthlyDelta || !kpiLeak || !kpiLeakSub || !kpiVat) return;

  const thisMonth = monthKey(new Date());
  const lastMonthDate = new Date();
  lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
  const lastMonth = monthKey(lastMonthDate);

  const curSpend = computeMonthlySpend(invoices, thisMonth);
  const prevSpend = computeMonthlySpend(invoices, lastMonth);

  // currency: pick latest invoice currency, fallback £
  const currency = invoices?.[0]?.currency || "£";

  kpiMonthlySpend.textContent = money(curSpend, currency);

  if (prevSpend > 0) {
    const pct = ((curSpend - prevSpend) / prevSpend) * 100;
    const arrow = pct >= 0 ? "↑" : "↓";
    kpiMonthlyDelta.textContent = `${arrow} ${Math.abs(pct).toFixed(1)}% vs last month`;
  } else {
    kpiMonthlyDelta.textContent = `vs last month —`;
  }

  const leak = computeTopLeak(invoices, thisMonth);
  if (!leak) {
    kpiLeak.textContent = "—";
    kpiLeakSub.textContent = "No alerts yet";
  } else {
    kpiLeak.textContent = `+${money(leak.diff, leak.currency)}`;
    const pct = leak.prevTotal > 0 ? ((leak.diff / leak.prevTotal) * 100) : null;
    kpiLeakSub.textContent = pct
      ? `${leak.supplier}: ${pct.toFixed(1)}% increase`
      : `${leak.supplier}: price increase`;
  }

  const vat = computeVatEstimate(invoices, thisMonth);
  kpiVat.textContent = money(vat, currency);
}

// ----- main -----
const user = currentUser();
if (!user) {
  window.location.href = "./login.html";
}

userLine.textContent = `${user.name} • ${user.email}`;
settingsName.textContent = user.name;
settingsEmail.textContent = user.email;

let selectedFiles = [];

function updateSelectionUI() {
  const count = selectedFiles.length;
  if (countText) countText.textContent = `${count} / ${MAX_FILES} selected`;
  if (analyseAllBtn) analyseAllBtn.disabled = count === 0;
}

filesInput.addEventListener("change", () => {
  const files = Array.from(filesInput.files || []);

  if (files.length > MAX_FILES) {
    setStatus(`Too many files. Max is ${MAX_FILES}.`);
    filesInput.value = "";
    selectedFiles = [];
    updateSelectionUI();
    return;
  }

  selectedFiles = files;
  setStatus(files.length ? `Selected ${files.length} file(s).` : "");
  updateSelectionUI();
});

analyseAllBtn.addEventListener("click", async () => {
  if (!selectedFiles.length) return;

  setStatus("Analysing uploads…");

  const invKey = invoicesKey(user.userId);
  const histKey = historyKey(user.userId);

  const invoices = loadJSON(invKey, []);
  const history = loadJSON(histKey, { suppliers: {} });
  history.suppliers ||= {};

  for (let i = 0; i < selectedFiles.length; i++) {
    const f = selectedFiles[i];
    setStatus(`Analysing ${i + 1}/${selectedFiles.length}: ${f.name}`);

    let supplierName = inferSupplierFromFilename(f.name);
    let sKey = supplierKey(supplierName);

    let usedBackend = false;
    let total = null;
    let currency = "£";

    try {
      const formData = new FormData();
      formData.append("file", f);

      const res = await postToBackend(formData);

      if (res.ok) {
        const data = await res.json();

        const backendVendor = pickVendorFromBackendJSON(data);
        if (backendVendor) {
          supplierName = backendVendor;
          sKey = supplierKey(supplierName);
        }

        currency = pickCurrencyFromBackendJSON(data) || "£";
        total = pickTotalFromBackendJSON(data);
        usedBackend = true;

        if (total == null) total = demoTotalFromFile(f);
      } else {
        total = demoTotalFromFile(f);
      }
    } catch {
      total = demoTotalFromFile(f);
    }

    const prev = history.suppliers[sKey];
    const prevTotal = prev?.lastInvoiceTotal ?? null;

    const chText = changeText(total, prevTotal, currency);
    const pct = changePct(total, prevTotal); // ✅ used for leak KPI

    history.suppliers[sKey] = {
      displayName: supplierName,
      totalSpend: (prev?.totalSpend || 0) + total,
      lastInvoiceTotal: total,
      lastChangeText: chText,
      currency
    };

    invoices.unshift({
      id: crypto.randomUUID?.() || String(Date.now() + Math.random()),
      date: isoDate(),
      supplier: supplierName,
      filename: f.name,
      total,
      currency,
      changeText: chText,
      changePct: pct, // ✅ store it
      source: usedBackend ? "backend" : "demo"
    });
  }

  saveJSON(invKey, invoices);
  saveJSON(histKey, history);

  filesInput.value = "";
  selectedFiles = [];
  updateSelectionUI();

  renderInvoices(invoices);
  renderLeaderboard(history);
  updateKpis(invoices); // ✅ update KPI cards

  setStatus("Done.");
});

// Load existing data on page load
(function init() {
  const invKey = invoicesKey(user.userId);
  const histKey = historyKey(user.userId);

  const invoices = loadJSON(invKey, []);
  const history = loadJSON(histKey, { suppliers: {} });

  renderInvoices(invoices);
  renderLeaderboard(history);
  updateKpis(invoices); // ✅ fill KPI on load

  updateSelectionUI();

  console.log("Using API_BASE:", API_BASE);
})();

// ----- settings modal wiring -----
function openModal() {
  modalOverlay.style.display = "flex";
}
function closeModal() {
  modalOverlay.style.display = "none";
}

settingsBtn.addEventListener("click", openModal);
closeModalBtn.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

logoutBtn.addEventListener("click", () => {
  logout();
  window.location.href = "./login.html";
});
logoutBtn2.addEventListener("click", () => {
  logout();
  window.location.href = "./login.html";
});

clearDataBtn.addEventListener("click", () => {
  if (!confirm("Clear all invoices + history for this account on this device?")) return;
  clearMyData(user.userId);
  window.location.reload();
});

deleteAccountBtn.addEventListener("click", async () => {
  if (!confirm("Delete account? This removes your account and local data on this device.")) return;
  await deleteAccount();
  window.location.href = "./register.html";
});
