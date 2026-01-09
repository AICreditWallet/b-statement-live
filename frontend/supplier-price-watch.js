console.log("Supplier Price Watch JS loaded");

// ================= CONFIG =================
const BACKEND_URL = "http://127.0.0.1:8000/analyse";
const REQUEST_TIMEOUT_MS = 12000;

// Session storage key (must match auth.js)
const SESSION_KEY = "spw_session_v1";

// ================= DOM (safe lookups) =================
const $ = (id) => document.getElementById(id);

const invoiceFile = $("invoiceFile");
const analyseBtn = $("analyseBtn");
const statusEl = $("status");

const resultsHint = $("resultsHint");
const resultsWrap = $("resultsWrap");
const alertPill = $("alertPill");

const resultsSupplier = $("resultsSupplier");
const resultsMeta = $("resultsMeta");

const kpiTotal = $("kpiTotal");
const kpiChange = $("kpiChange");
const kpiBiggest = $("kpiBiggest");

const leaderTableBody = document.querySelector("#leaderTable tbody");
const focusText = $("focusText");

// ================= AUTH (MVP) =================
function getSessionUser() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
  } catch {
    return null;
  }
}

function requireLoginOrLockUI() {
  const user = getSessionUser();
  if (user) return user;

  // Lock UI
  if (invoiceFile) invoiceFile.disabled = true;
  if (analyseBtn) analyseBtn.disabled = true;

  hideResults();
  hidePill();
  renderLeaderboard({ suppliers: {} });

  setStatus("Please login to analyse invoices.");
  if (focusText) {
    focusText.textContent = "Login required. Use the Login/Create account buttons at the top.";
  }

  return null;
}

// Per-user storage key
function storageKeyForUser(user) {
  return user?.userId ? `spw_history_${user.userId}` : "spw_history_guest";
}

// ================= HELPERS =================
function setStatus(msg) {
  if (!statusEl) return;
  statusEl.textContent = msg || "";
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

function nowIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// ================= STORAGE =================
function loadHistory(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  return { suppliers: {} };
}

function saveHistory(storageKey, h) {
  localStorage.setItem(storageKey, JSON.stringify(h));
}

// ================= UI =================
function setPill(level, text) {
  if (!alertPill) return;
  alertPill.classList.remove("hidden");
  alertPill.className = ""; // wipe
  alertPill.classList.add(level); // optional class (good/warn/bad)
  alertPill.textContent = text || "";
}

function hidePill() {
  if (!alertPill) return;
  alertPill.classList.add("hidden");
  alertPill.textContent = "";
}

function showResults() {
  if (resultsHint) resultsHint.classList.add("hidden");
  if (resultsWrap) resultsWrap.classList.remove("hidden");
}

function hideResults() {
  if (resultsWrap) resultsWrap.classList.add("hidden");
  if (resultsHint) resultsHint.classList.remove("hidden");
}

function renderLeaderboard(history, currency = "£") {
  if (!leaderTableBody) return;

  leaderTableBody.innerHTML = "";
  const suppliers = Object.values(history.suppliers || {}).sort(
    (a, b) => (b.totalSpend || 0) - (a.totalSpend || 0)
  );

  if (!suppliers.length) {
    leaderTableBody.innerHTML =
      `<tr><td colspan="4" style="color:rgba(0,0,0,.6)">No history yet</td></tr>`;
    return;
  }

  for (const s of suppliers) {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = s.displayName || "—";

    const tdTotal = document.createElement("td");
    tdTotal.textContent = money(s.totalSpend, currency);

    const tdLast = document.createElement("td");
    tdLast.textContent = money(s.lastInvoiceTotal, currency);

    const tdChange = document.createElement("td");
    tdChange.textContent = s.lastChangeText || "—";

    tr.appendChild(tdName);
    tr.appendChild(tdTotal);
    tr.appendChild(tdLast);
    tr.appendChild(tdChange);

    leaderTableBody.appendChild(tr);
  }
}

function findBiggestSupplier(history) {
  const suppliers = Object.values(history.suppliers || {});
  if (!suppliers.length) return "—";
  suppliers.sort((a, b) => (b.totalSpend || 0) - (a.totalSpend || 0));
  return suppliers[0]?.displayName || "—";
}

function updateAnalyseEnabled() {
  if (!analyseBtn || !invoiceFile) return;
  analyseBtn.disabled = !invoiceFile.files?.[0];
}

// ================= BACKEND CALL =================
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
  const size = Number(file?.size || 0);
  // Simple deterministic estimate
  return Math.max(1, Math.round(size / 100));
}

// ================= MAIN FLOW =================
async function analyseInvoice(storageKey) {
  const f = invoiceFile?.files?.[0];
  if (!f) return;

  const supplierName = inferSupplierFromFilename(f.name);
  const key = supplierKey(supplierName);

  setStatus(`Selected: ${f.name}`);
  setPill("warn", "Analysing…");

  let usedBackend = false;
  let backendMeta = "";
  let total = null;

  // Try backend first
  if (BACKEND_URL && BACKEND_URL.startsWith("http")) {
    try {
      setStatus("Uploading to backend…");

      const formData = new FormData();
      formData.append("file", f);

      const res = await fetchWithTimeout(BACKEND_URL, {
        method: "POST",
        body: formData
      });

      if (!res.ok) throw new Error(`Backend error ${res.status}`);

      const data = await res.json();
      console.log("Backend response:", data);

      total = pickTotalFromBackendJSON(data);
      backendMeta = data?.filename ? `Backend • ${data.filename}` : "Backend connected";

      if (total == null) {
        total = demoTotalFromFile(f);
        backendMeta = "Backend connected (no total yet) • using demo estimate";
      }

      usedBackend = true;
    } catch (err) {
      console.warn("Backend failed, falling back to demo:", err);
      usedBackend = false;
    }
  }

  // Fallback demo
  if (!usedBackend) {
    total = demoTotalFromFile(f);
    backendMeta = "Demo estimate (backend not connected)";
  }

  // Update history
  const history = loadHistory(storageKey);
  history.suppliers ||= {};

  const prev = history.suppliers[key];
  const prevTotal = prev?.lastInvoiceTotal ?? null;
  const lastChange = changeText(total, prevTotal);

  history.suppliers[key] = {
    displayName: supplierName,
    totalSpend: (prev?.totalSpend || 0) + total,
    lastInvoiceTotal: total,
    lastChangeText: lastChange,
    lastFilename: f.name,
    lastDate: nowIsoDate()
  };

  saveHistory(storageKey, history);

  // Render UI
  showResults();

  if (resultsSupplier) resultsSupplier.textContent = supplierName;
  if (resultsMeta) resultsMeta.textContent = backendMeta;

  if (kpiTotal) kpiTotal.textContent = money(total);
  if (kpiChange) kpiChange.textContent = lastChange;
  if (kpiBiggest) kpiBiggest.textContent = findBiggestSupplier(history);

  if (focusText) {
    focusText.textContent = usedBackend
      ? "Backend received the file. Next step: OCR must return the real invoice total."
      : "Demo mode. To get real totals, deploy your backend and update BACKEND_URL.";
  }

  renderLeaderboard(history);

  setPill(usedBackend ? "good" : "warn", usedBackend ? "Done ✅" : "Done (demo)");
  setStatus("Analysis complete.");
}

// ================= EVENTS =================
if (invoiceFile) {
  invoiceFile.addEventListener("change", () => {
    const f = invoiceFile.files?.[0];
    setStatus(f ? `Selected: ${f.name}` : "");
    updateAnalyseEnabled();
    hidePill();
  });
}

if (analyseBtn) {
  analyseBtn.addEventListener("click", () => {
    const user = getSessionUser();
    if (!user) {
      setStatus("Please login first.");
      setPill("bad", "Login required");
      return;
    }

    const storageKey = storageKeyForUser(user);

    analyseInvoice(storageKey).catch((err) => {
      console.error(err);
      setPill("bad", "Error");
      setStatus(err?.message || "Something went wrong");
    });
  });
}

// ================= INIT =================
(function init() {
  // Require login and lock UI if not logged in
  const user = requireLoginOrLockUI();
  if (!user) return;

  // Logged in: enable upload
  if (invoiceFile) invoiceFile.disabled = false;

  const storageKey = storageKeyForUser(user);

  updateAnalyseEnabled();

  const history = loadHistory(storageKey);
  renderLeaderboard(history);

  hideResults();
  hidePill();

  // Honest backend note
  const onLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (!onLocalhost && BACKEND_URL.includes("127.0.0.1")) {
    console.warn("BACKEND_URL points to localhost but site is not localhost. Backend calls will fail.");
  }
})();
