// supplier-price-watch.js
// MVP (no OCR): instant results + supplier tracking using LocalStorage.
// - Analyse is enabled when a file is selected
// - Supplier name is inferred from file name
// - A demo "invoice total" is estimated (so UI works immediately)
// - History is saved per supplier and across suppliers
// Next step later: backend OCR/AI extraction from PDF/photos.

const STORAGE_KEY = "spw_history_v2";

const invoiceFile = document.getElementById("invoiceFile");
const analyseBtn = document.getElementById("analyseBtn");
const clearAllBtn = document.getElementById("clearAllBtn");
const statusEl = document.getElementById("status");

const resultsHint = document.getElementById("resultsHint");
const resultsWrap = document.getElementById("resultsWrap");
const alertPill = document.getElementById("alertPill");

const resultsSupplier = document.getElementById("resultsSupplier");
const resultsMeta = document.getElementById("resultsMeta");

const kpiTotal = document.getElementById("kpiTotal");
const kpiChange = document.getElementById("kpiChange");
const kpiBiggest = document.getElementById("kpiBiggest");

const leaderTableBody = document.querySelector("#leaderTable tbody");
const focusText = document.getElementById("focusText");

// ---------------- storage helpers ----------------

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { suppliers: {} };
  } catch {
    return { suppliers: {} };
  }
}

function saveHistory(h) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(h));
}

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

function money(n, currency = "£") {
  const v = Number(n || 0);
  return `${currency}${v.toFixed(2)}`;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------------- supplier inference (from filename) ----------------

function titleCase(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function inferSupplierFromFilename(filename) {
  // e.g. "bidfood_oct_2025.pdf" -> "Bidfood"
  // e.g. "electric-company invoice.jpg" -> "Electric Company"
  const base = (filename || "")
    .replace(/\.[^.]+$/, "")          // remove extension
    .replace(/[_-]+/g, " ")           // underscores/dashes to spaces
    .replace(/\s+/g, " ")             // collapse spaces
    .trim();

  if (!base) return "Unknown Supplier";

  // take first 2-3 words max to avoid messy supplier names
  const parts = base.split(" ").filter(Boolean);
  const short = parts.slice(0, Math.min(parts.length, 3)).join(" ");
  return titleCase(short);
}

function supplierKey(name) {
  return (name || "").trim().toLowerCase();
}

// ---------------- demo total estimation ----------------

function estimateInvoiceTotal(file) {
  // We can't read PDF/photo reliably in the browser without OCR/libs.
  // So we return a stable demo number based on file size + name hash.
  const size = Number(file?.size || 0);

  const name = String(file?.name || "");
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }

  // Create a number between ~50 and ~900, influenced by size/hash
  const base = 50 + (hash % 250);
  const sizeBump = Math.min(600, Math.round(size / 5000)); // bigger file -> slightly bigger total
  const total = base + sizeBump;

  return Number(total.toFixed(2));
}

function changeText(now, prev, currency = "£") {
  if (prev == null) return "First time";
  const diff = now - prev;
  if (Math.abs(diff) < 0.01) return "No change";
  if (diff > 0) return `+${money(diff, currency)}`;
  return `-${money(Math.abs(diff), currency)}`;
}

// ---------------- UI rendering ----------------

function setPill(level, text) {
  alertPill.classList.remove("hidden");
  alertPill.className = `pill ${level}`;
  alertPill.textContent = text;
}

function renderLeaderboard(history, currency = "£") {
  leaderTableBody.innerHTML = "";

  const suppliers = Object.entries(history.suppliers || {})
    .map(([k, v]) => ({ key: k, ...v }))
    .sort((a, b) => (b.totalSpend || 0) - (a.totalSpend || 0));

  if (suppliers.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4" class="muted">No history yet. Upload and analyse an invoice.</td>`;
    leaderTableBody.appendChild(tr);
    return;
  }

  suppliers.forEach(s => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(s.displayName || s.key)}</td>
      <td>${money(s.totalSpend || 0, currency)}</td>
      <td>${s.lastInvoiceTotal == null ? "—" : money(s.lastInvoiceTotal, currency)}</td>
      <td>${escapeHtml(s.lastChangeText || "—")}</td>
    `;
    leaderTableBody.appendChild(tr);
  });
}

function findBiggestSupplier(history) {
  const suppliers = Object.values(history.suppliers || []);
  if (!suppliers.length) return "—";
  suppliers.sort((a, b) => (b.totalSpend || 0) - (a.totalSpend || 0));
  const top = suppliers[0];
  return top?.displayName ? top.displayName : "—";
}

// ---------------- events ----------------

function updateAnalyseEnabled() {
  analyseBtn.disabled = !invoiceFile.files?.[0];
}

invoiceFile.addEventListener("change", () => {
  const f = invoiceFile.files?.[0];
  if (!f) {
    setStatus("");
    updateAnalyseEnabled();
    return;
  }

  setStatus(`Selected: ${f.name}`);
  updateAnalyseEnabled();
});

analyseBtn.addEventListener("click", () => {
  const f = invoiceFile.files?.[0];
  if (!f) return;

  const currency = "£"; // keep simple for now

  const supplierName = inferSupplierFromFilename(f.name);
  const key = supplierKey(supplierName);

  const total = estimateInvoiceTotal(f);

  const history = loadHistory();
  history.suppliers = history.suppliers || {};

  const prev = history.suppliers[key];
  const prevTotal = prev?.lastInvoiceTotal ?? null;

  const lastChange = changeText(total, prevTotal, currency);

  // Update supplier record
  const newTotalSpend = Number((prev?.totalSpend || 0) + total);

  history.suppliers[key] = {
    displayName: supplierName,
    totalSpend: newTotalSpend,
    lastInvoiceTotal: total,
    lastFileName: f.name,
    lastSeenAt: new Date().toLocaleString(),
    lastChangeText: lastChange
  };

  saveHistory(history);

  // Render results area
  resultsHint.classList.add("hidden");
  resultsWrap.classList.remove("hidden");

  resultsSupplier.textContent = supplierName;
  resultsMeta.textContent = `File: ${f.name} • Saved on this device`;

  kpiTotal.textContent = money(total, currency);
  kpiChange.textContent = lastChange;
  kpiBiggest.textContent = findBiggestSupplier(history);

  // Pill + focus text
  if (prevTotal == null) {
    setPill("good", "Saved (first invoice)");
    focusText.textContent = `This is your first saved invoice for ${supplierName}. Next time you upload another invoice for this supplier, we’ll flag any increase.`;
  } else {
    const diff = total - prevTotal;
    if (diff > 0.01) {
      setPill("bad", "Increase detected");
      focusText.textContent = `Alert: ${supplierName} went up by ${money(diff, currency)} compared to last time. You may want to check this supplier first.`;
    } else if (diff < -0.01) {
      setPill("good", "Cost went down");
      focusText.textContent = `Nice: ${supplierName} is down by ${money(Math.abs(diff), currency)} compared to last time.`;
    } else {
      setPill("warn", "No change");
      focusText.textContent = `No change detected for ${supplierName} vs last time.`;
    }
  }

  renderLeaderboard(history, currency);

  setStatus("Saved. Results updated.");
});

clearAllBtn.addEventListener("click", () => {
  if (!confirm("Clear all saved supplier history from this browser?")) return;
  localStorage.removeItem(STORAGE_KEY);

  resultsHint.classList.remove("hidden");
  resultsWrap.classList.add("hidden");
  alertPill.classList.add("hidden");
  leaderTableBody.innerHTML = "";
  focusText.textContent = "";

  setStatus("History cleared.");
  updateAnalyseEnabled();
});

// init
(function init() {
  updateAnalyseEnabled();

  const history = loadHistory();
  renderLeaderboard(history, "£");
})();
