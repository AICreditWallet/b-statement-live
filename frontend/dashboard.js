import { currentUser, logout, deleteAccount, clearMyData } from "./auth.js";

console.log("Dashboard JS loaded");

/**
 * Backend base URL resolution:
 * - Local dev (localhost/127.0.0.1) -> http://127.0.0.1:8000
 * - Production (Vercel) -> your Railway backend URL
 *
 * NOTE: This is the simplest + most reliable setup for a static frontend.
 * If later you want environment variables, we can re-add them.
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
