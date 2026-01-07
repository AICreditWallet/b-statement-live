console.log("Frontend JS loaded");

// ================= CONFIG =================
const BACKEND_URL = "http://127.0.0.1:8000/analyse";
const STORAGE_KEY = "spw_history_v2";

// ================= DOM =================
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

// ================= STORAGE =================
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
  return `${currency}${Number(n || 0).toFixed(2)}`;
}

// ================= SUPPLIER =================
function titleCase(s) {
  return (s || "").toLowerCase().replace(/\b\w/g, m => m.toUpperCase());
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

// ================= UI =================
function setPill(level, text) {
  alertPill.classList.remove("hidden");
  alertPill.className = `pill ${level}`;
  alertPill.textContent = text;
}

function renderLeaderboard(history, currency = "£") {
  leaderTableBody.innerHTML = "";

  const suppliers = Object.values(history.suppliers || {}).sort(
    (a, b) => (b.totalSpend || 0) - (a.totalSpend || 0)
  );

  if (!suppliers.length) {
    leaderTableBody.innerHTML =
      `<tr><td colspan="4" class="muted">No history yet</td></tr>`;
    return;
  }

  suppliers.forEach(s => {
    leaderTableBody.innerHTML += `
      <tr>
        <td>${s.displayName}</td>
        <td>${money(s.totalSpend, currency)}</td>
        <td>${money(s.lastInvoiceTotal, currency)}</td>
        <td>${s.lastChangeText}</td>
      </tr>`;
  });
}

function findBiggestSupplier(history) {
  const suppliers = Object.values(history.suppliers || []);
  if (!suppliers.length) return "—";
  suppliers.sort((a, b) => b.totalSpend - a.totalSpend);
  return suppliers[0].displayName;
}

// ================= EVENTS =================
function updateAnalyseEnabled() {
  analyseBtn.disabled = !invoiceFile.files?.[0];
}

invoiceFile.addEventListener("change", () => {
  const f = invoiceFile.files?.[0];
  setStatus(f ? `Selected: ${f.name}` : "");
  updateAnalyseEnabled();
});

// 🔥 REAL BACKEND CALL
analyseBtn.addEventListener("click", async () => {
  const f = invoiceFile.files?.[0];
  if (!f) return;

  try {
    setStatus("Uploading invoice to backend...");
    setPill("warn", "Analysing…");

    const formData = new FormData();
    formData.append("file", f);

    const res = await fetch(BACKEND_URL, {
      method: "POST",
      body: formData
    });

    if (!res.ok) {
      throw new Error(`Backend error ${res.status}`);
    }

    const data = await res.json();
    console.log("Backend response:", data);

    // TEMP: derive a real number from backend response
    const total = Math.max(1, Math.round((data.size_bytes || 0) / 100));

    const supplierName = inferSupplierFromFilename(f.name);
    const key = supplierKey(supplierName);
    const history = loadHistory();
    history.suppliers ||= {};

    const prev = history.suppliers[key];
    const prevTotal = prev?.lastInvoiceTotal ?? null;
    const lastChange = changeText(total, prevTotal);

    history.suppliers[key] = {
      displayName: supplierName,
      totalSpend: (prev?.totalSpend || 0) + total,
      lastInvoiceTotal: total,
      lastChangeText: lastChange
    };

    saveHistory(history);

    resultsHint.classList.add("hidden");
    resultsWrap.classList.remove("hidden");

    resultsSupplier.textContent = supplierName;
    resultsMeta.textContent = `Processed by backend • ${data.filename}`;

    kpiTotal.textContent = money(total);
    kpiChange.textContent = lastChange;
    kpiBiggest.textContent = findBiggestSupplier(history);

    setPill("good", "Backend connected ✅");
    focusText.textContent =
      "Invoice successfully sent to backend. Next step: extract real totals from PDF.";

    renderLeaderboard(history);
    setStatus("Analysis complete.");
  } catch (err) {
    console.error(err);
    setPill("bad", "Backend error");
    setStatus(err.message);
  }
});

clearAllBtn.addEventListener("click", () => {
  if (!confirm("Clear all saved history?")) return;
  localStorage.removeItem(STORAGE_KEY);
  resultsWrap.classList.add("hidden");
  resultsHint.classList.remove("hidden");
  alertPill.classList.add("hidden");
  leaderTableBody.innerHTML = "";
  setStatus("History cleared.");
});

// ================= INIT =================
(function init() {
  updateAnalyseEnabled();
  renderLeaderboard(loadHistory());
})();