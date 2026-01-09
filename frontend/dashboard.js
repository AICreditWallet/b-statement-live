import { currentUser, logout, deleteAccount, clearMyData } from "./auth.js";

console.log("Dashboard JS loaded");

const BACKEND_URL = "http://127.0.0.1:8000/analyse";
const REQUEST_TIMEOUT_MS = 12000;
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

function money(n, currency = "£") {
  const num = Number(n);
  if (!Number.isFinite(num)) return `${currency}0.00`;
  return `${currency}${num.toFixed(2)}`;
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
  return diff > 0 ? `+${money(diff, currency)}` : `-${money(Math.abs(diff), currency)}`;
}

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

// ----- per-user storage keys -----
function invoicesKey(userId) {
  return `spw_invoices_${userId}`;
}
function historyKey(userId) {
  return `spw_history_${userId}`; // matches your supplier-price-watch.js convention
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
      <td>${money(inv.total)}</td>
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
      <td>${money(s.totalSpend)}</td>
      <td>${money(s.lastInvoiceTotal)}</td>
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
  // Not logged in => kick out
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

  // process sequentially (simpler, predictable)
  for (let i = 0; i < selectedFiles.length; i++) {
    const f = selectedFiles[i];
    setStatus(`Analysing ${i + 1}/${selectedFiles.length}: ${f.name}`);

    const supplierName = inferSupplierFromFilename(f.name);
    const sKey = supplierKey(supplierName);

    let usedBackend = false;
    let total = null;

    // Try backend
    try {
      const formData = new FormData();
      formData.append("file", f);

      const res = await fetchWithTimeout(BACKEND_URL, {
        method: "POST",
        body: formData
      });

      if (res.ok) {
        const data = await res.json();
        total = pickTotalFromBackendJSON(data);
        usedBackend = true;

        if (total == null) {
          total = demoTotalFromFile(f);
          usedBackend = true; // backend connected but no total
        }
      } else {
        total = demoTotalFromFile(f);
      }
    } catch {
      total = demoTotalFromFile(f);
    }

    const prev = history.suppliers[sKey];
    const prevTotal = prev?.lastInvoiceTotal ?? null;
    const chText = changeText(total, prevTotal);

    // Update supplier history
    history.suppliers[sKey] = {
      displayName: supplierName,
      totalSpend: (prev?.totalSpend || 0) + total,
      lastInvoiceTotal: total,
      lastChangeText: chText
    };

    // Add invoice record
    invoices.unshift({
      id: crypto.randomUUID?.() || String(Date.now() + Math.random()),
      date: isoDate(),
      supplier: supplierName,
      filename: f.name,
      total,
      changeText: chText,
      source: usedBackend ? "backend" : "demo"
    });
  }

  saveJSON(invKey, invoices);
  saveJSON(histKey, history);

  // reset file input
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

  // Honest warning
  const onLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (!onLocalhost && BACKEND_URL.includes("127.0.0.1")) {
    console.warn("BACKEND_URL points to localhost but site is not localhost. Backend calls will fail -> demo mode.");
  }
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
