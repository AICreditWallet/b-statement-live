// frontend/dashboard.js
import { currentUser, logout, deleteAccount, clearMyData } from "./auth.js";

console.log("Dashboard JS loaded");

/**
 * Backend base URL resolution:
 * - Local dev (localhost/127.0.0.1) -> http://127.0.0.1:8000
 * - Production (Vercel) -> Railway backend URL
 */
function resolveBackendApiBase() {
  const host = window.location.hostname;

  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".local");

  if (isLocal) return "http://127.0.0.1:8000";

  return "https://b-statement-live-production.up.railway.app";
}

const API_BASE = resolveBackendApiBase().replace(/\/$/, "");
const BACKEND_ANALYSE_URL = `${API_BASE}/analyse`;
const BACKEND_ANALYZE_URL = `${API_BASE}/analyze`;

const REQUEST_TIMEOUT_MS = 90000;
const MAX_FILES = 10;

const $ = (id) => document.getElementById(id);

// ---- DOM ----
const userLine = $("userLine");
const filesInput = $("filesInput");
const analyseAllBtn = $("analyseAllBtn");
const countText = $("countText");
const statusEl = $("status");

const invoicesTbody = document.querySelector("#invoicesTable tbody");
const leaderTbody = document.querySelector("#leaderTable tbody");
const focusText = $("focusText");

// KPI nodes (match dashboard.html)
const kpiMonthlySpend = $("kpiMonthlySpend");
const kpiMonthlyDelta = $("kpiMonthlyDelta");
const kpiLeakValue = $("kpiLeakValue");
const kpiLeakTitle = $("kpiLeakTitle");
const kpiVatTotal = $("kpiVatTotal");

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

// ---- helpers ----
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

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

function changeText(now, prev, currency = "£") {
  if (prev == null) return "First time";
  const diff = now - prev;
  if (Math.abs(diff) < 0.01) return "No change";
  return diff > 0 ? `+${money(diff, currency)}` : `-${money(Math.abs(diff), currency)}`;
}

function changePct(now, prev) {
  const n = Number(now);
  const p = Number(prev);
  if (!Number.isFinite(n) || !Number.isFinite(p) || p <= 0) return null;
  return ((n - p) / p) * 100;
}

function demoTotalFromFile(file) {
  return Math.max(1, Math.round(Number(file?.size || 0) / 100));
}

// ---- per-user storage ----
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

// ---- backend ----
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function postToBackend(formData) {
  let res = await fetchWithTimeout(BACKEND_ANALYSE_URL, { method: "POST", body: formData });

  if (!res.ok && (res.status === 404 || res.status === 405)) {
    res = await fetchWithTimeout(BACKEND_ANALYZE_URL, { method: "POST", body: formData });
  }

  return res;
}

function pickTotalFromBackendJSON(data) {
  if (!data || typeof data !== "object") return null;
  const candidates = [data.total, data.invoice_total, data.amount, data.total_amount, data.total_gbp];
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

// ---- render tables ----
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
    if (focusText) focusText.textContent = "—";
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

// ---- KPI logic ----
function monthKeyFromISO(iso) {
  if (!iso || typeof iso !== "string") return "";
  return iso.slice(0, 7); // YYYY-MM
}

function sumInvoicesForMonth(invoices, yyyyMM) {
  return (invoices || [])
    .filter((inv) => monthKeyFromISO(inv.date) === yyyyMM)
    .reduce((sum, inv) => sum + (Number(inv.total) || 0), 0);
}

// SKU leak: needs inv.items[] with {description, unit_price}.
// Fallback: invoice-total leak based on inv.changePct.
function computeTopLeak(invoices) {
  const lastPrice = {};
  let bestSku = null; // {pct, supplier, item, from, to}

  const ordered = [...(invoices || [])].reverse(); // oldest -> newest
  for (const inv of ordered) {
    const supplier = inv.supplier || "Unknown Supplier";
    const sKey = supplierKey(supplier);

    const items = Array.isArray(inv.items) ? inv.items : [];
    for (const it of items) {
      const name = (it.description || "").trim();
      const unit = Number(it.unit_price);

      if (!name || !Number.isFinite(unit) || unit <= 0) continue;

      const itemKey = `${sKey}::${name.toLowerCase()}`;
      const prev = lastPrice[itemKey];

      if (prev && unit > prev) {
        const pct = ((unit - prev) / prev) * 100;
        if (!bestSku || pct > bestSku.pct) {
          bestSku = { pct, supplier, item: name, from: prev, to: unit };
        }
      }

      lastPrice[itemKey] = unit;
    }
  }

  if (bestSku) return { type: "sku", ...bestSku };

  // fallback: biggest invoice-level changePct
  let bestInv = null;
  for (const inv of invoices || []) {
    const pct = Number(inv.changePct);
    if (Number.isFinite(pct) && pct > 0) {
      if (!bestInv || pct > bestInv.pct) {
        bestInv = { pct, supplier: inv.supplier || "Supplier" };
      }
    }
  }
  return bestInv ? { type: "invoice", ...bestInv } : null;
}

function updateKpis(invoices) {
  // If KPI nodes aren’t present, do nothing safely
  if (!kpiMonthlySpend || !kpiMonthlyDelta || !kpiLeakValue || !kpiLeakTitle || !kpiVatTotal) return;

  const now = new Date();
  const thisYYYYMM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastYYYYMM = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}`;

  const currency = invoices?.[0]?.currency || "GBP";

  const thisSpend = sumInvoicesForMonth(invoices, thisYYYYMM);
  const lastSpend = sumInvoicesForMonth(invoices, lastYYYYMM);

  kpiMonthlySpend.textContent = money(thisSpend, currency);

  if (lastSpend > 0) {
    const pct = ((thisSpend - lastSpend) / lastSpend) * 100;
    const arrow = pct >= 0 ? "↑" : "↓";
    kpiMonthlyDelta.textContent = `${arrow} ${Math.abs(pct).toFixed(1)}% vs last month`;
  } else {
    kpiMonthlyDelta.textContent = "vs last month —";
  }

  const leak = computeTopLeak(invoices);
  if (!leak) {
    kpiLeakValue.textContent = "—";
    kpiLeakTitle.textContent = "No alerts yet";
  } else if (leak.type === "sku") {
    kpiLeakValue.textContent = `↑ ${leak.pct.toFixed(1)}%`;
    kpiLeakTitle.textContent = `${leak.supplier}: ${leak.item} (${money(leak.from, currency)} → ${money(leak.to, currency)})`;
  } else {
    kpiLeakValue.textContent = `↑ ${leak.pct.toFixed(1)}%`;
    kpiLeakTitle.textContent = `${leak.supplier} price hike`;
  }

  // VAT estimate: VAT portion of VAT-inclusive totals @20% is total*(0.2/1.2)
  const vat = thisSpend * (0.2 / 1.2);
  kpiVatTotal.textContent = money(vat, currency);
}

// ---- Charts (Chart.js) ----
let spendChart = null;
let catChart = null;

function monthLabel(yyyyMM) {
  if (!yyyyMM) return "—";
  const [y, m] = yyyyMM.split("-");
  const dt = new Date(Number(y), Number(m) - 1, 1);
  return dt.toLocaleString(undefined, { month: "short", year: "numeric" });
}

function buildMonthlySpendSeries(invoices) {
  const map = new Map();
  for (const inv of invoices || []) {
    const k = monthKeyFromISO(inv.date);
    if (!k) continue;
    map.set(k, (map.get(k) || 0) + (Number(inv.total) || 0));
  }
  const keys = Array.from(map.keys()).sort();
  return {
    labels: keys.map(monthLabel),
    values: keys.map((k) => Number((map.get(k) || 0).toFixed(2))),
  };
}

function guessCategory(inv) {
  const s = `${inv?.supplier || ""} ${inv?.filename || ""}`.toLowerCase();
  if (/(sainsbury|tesco|asda|aldi|lidl|marks|waitrose|co-?op)/.test(s)) return "Food";
  if (/(tkmaxx|amazon|ebay|shop|store|retail)/.test(s)) return "Retail";
  if (/(uber|bolt|taxi|fuel|petrol|shell|bp)/.test(s)) return "Logistics";
  if (/(electric|water|utility|gas|octopus|edf|eon)/.test(s)) return "Utilities";
  return "Other";
}

function buildCategoryTotals(invoices) {
  const map = new Map();
  for (const inv of invoices || []) {
    const cat = guessCategory(inv);
    map.set(cat, (map.get(cat) || 0) + (Number(inv.total) || 0));
  }
  const entries = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  return { labels: entries.map((e) => e[0]), values: entries.map((e) => Number(e[1].toFixed(2))) };
}

function updateCharts(invoices) {
  if (typeof Chart === "undefined") return;

  const spendCanvas = document.getElementById("spendVelocityChart");
  const catCanvas = document.getElementById("categoryChart");
  if (!spendCanvas || !catCanvas) return;

  if (spendChart) { spendChart.destroy(); spendChart = null; }
  if (catChart) { catChart.destroy(); catChart = null; }

  const monthly = buildMonthlySpendSeries(invoices);
  spendChart = new Chart(spendCanvas, {
    type: "bar",
    data: {
      labels: monthly.labels.length ? monthly.labels : ["No data"],
      datasets: [{ label: "Total spend", data: monthly.values.length ? monthly.values : [0] }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } },
    },
  });

  const cats = buildCategoryTotals(invoices);
  catChart = new Chart(catCanvas, {
    type: "doughnut",
    data: {
      labels: cats.labels.length ? cats.labels : ["No data"],
      datasets: [{ data: cats.values.length ? cats.values : [0] }],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom" } },
      cutout: "68%",
    },
  });
}

// ---- settings modal wiring ----
function openModal() {
  if (modalOverlay) modalOverlay.style.display = "flex";
}
function closeModal() {
  if (modalOverlay) modalOverlay.style.display = "none";
}

if (settingsBtn) settingsBtn.addEventListener("click", openModal);
if (closeModalBtn) closeModalBtn.addEventListener("click", closeModal);
if (modalOverlay) {
  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeModal();
  });
}

async function doLogout() {
  try {
    await logout();
  } catch (e) {
    console.warn(e);
  }
  window.location.href = "./index.html";
}

// ---- main boot (IMPORTANT: Supabase currentUser() is async) ----
let user = null;
let selectedFiles = [];

function updateSelectionUI() {
  const count = selectedFiles.length;
  if (countText) countText.textContent = `${count} / ${MAX_FILES} selected`;
  if (analyseAllBtn) analyseAllBtn.disabled = count === 0;
}

(async function boot() {
  const user = await currentUser();
if (!user) {
  window.location.href = "./login.html";
  throw new Error("Not logged in");
}

if (userLine) userLine.textContent = `${user.name} • ${user.email}`;
if (settingsName) settingsName.textContent = user.name;
if (settingsEmail) settingsEmail.textContent = user.email;


  // Attach logout listeners AFTER boot
  logoutBtn?.addEventListener("click", doLogout);
  logoutBtn2?.addEventListener("click", doLogout);

  if (clearDataBtn) {
    clearDataBtn.addEventListener("click", () => {
      if (!confirm("Clear all invoices + history for this account on this device?")) return;
      clearMyData(user.userId);
      window.location.reload();
    });
  }

  if (deleteAccountBtn) {
    deleteAccountBtn.addEventListener("click", async () => {
      if (!confirm("Delete account? This removes your account and local data on this device.")) return;
      await deleteAccount();
      window.location.href = "./register.html";
    });
  }

  if (filesInput) {
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
  }

  if (analyseAllBtn) {
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
        let items = [];

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
            items = Array.isArray(data.items) ? data.items : [];

            usedBackend = true;
            if (total == null) total = demoTotalFromFile(f);
          } else {
            total = demoTotalFromFile(f);
          }
        } catch (err) {
          console.warn("Backend analyse failed, using demo total:", err);
          total = demoTotalFromFile(f);
        }

        const prev = history.suppliers[sKey];
        const prevTotal = prev?.lastInvoiceTotal ?? null;

        const chText = changeText(total, prevTotal, currency);
        const pct = changePct(total, prevTotal);

        history.suppliers[sKey] = {
          displayName: supplierName,
          totalSpend: (prev?.totalSpend || 0) + total,
          lastInvoiceTotal: total,
          lastChangeText: chText,
          currency,
        };

        invoices.unshift({
          id: crypto.randomUUID?.() || String(Date.now() + Math.random()),
          date: isoDate(),
          supplier: supplierName,
          filename: f.name,
          total,
          currency,
          changeText: chText,
          changePct: pct,
          source: usedBackend ? "backend" : "demo",
          items, // store SKU items if backend provided them
        });
      }

      saveJSON(invKey, invoices);
      saveJSON(histKey, history);

      if (filesInput) filesInput.value = "";
      selectedFiles = [];
      updateSelectionUI();

      renderInvoices(invoices);
      renderLeaderboard(history);
      updateKpis(invoices);
      updateCharts(invoices);

      setStatus("Done.");
    });
  }

  // ---- init on load ----
  (function init() {
    const invKey = invoicesKey(user.userId);
    const histKey = historyKey(user.userId);

    const invoices = loadJSON(invKey, []);
    const history = loadJSON(histKey, { suppliers: {} });

    renderInvoices(invoices);
    renderLeaderboard(history);
    updateKpis(invoices);
    updateCharts(invoices);
    updateSelectionUI();

    console.log("Using API_BASE:", API_BASE);
  })();
})();
