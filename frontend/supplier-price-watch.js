// supplier-price-watch.js
// MVP: stores supplier history in the browser (LocalStorage).
// Next step later: OCR/AI extraction from PDF/photos (backend).

const STORAGE_KEY = "spw_history_v1";

const invoiceFile = document.getElementById("invoiceFile");
const analyseBtn = document.getElementById("analyseBtn");
const clearAllBtn = document.getElementById("clearAllBtn");
const statusEl = document.getElementById("status");

const supplierNameEl = document.getElementById("supplierName");
const invoiceDateEl = document.getElementById("invoiceDate");
const currencyEl = document.getElementById("currency");
const notesEl = document.getElementById("notes");

const itemNameEl = document.getElementById("itemName");
const itemPriceEl = document.getElementById("itemPrice");
const itemQtyEl = document.getElementById("itemQty");
const addItemBtn = document.getElementById("addItemBtn");
const clearItemsBtn = document.getElementById("clearItemsBtn");
const itemsTableBody = document.querySelector("#itemsTable tbody");

const resultsEmpty = document.getElementById("resultsEmpty");
const resultsWrap = document.getElementById("results");

const resultsSupplier = document.getElementById("resultsSupplier");
const resultsMeta = document.getElementById("resultsMeta");
const alertPill = document.getElementById("alertPill");

const kpiTotal = document.getElementById("kpiTotal");
const kpiTopItem = document.getElementById("kpiTopItem");
const kpiIncreases = document.getElementById("kpiIncreases");

const summaryTableBody = document.querySelector("#summaryTable tbody");
const focusText = document.getElementById("focusText");
const historyList = document.getElementById("historyList");

let items = [];

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveHistory(history) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

function money(n, currency = "£") {
  const v = Number(n || 0);
  return `${currency}${v.toFixed(2)}`;
}

function normalizeSupplierName(name) {
  return (name || "").trim().toLowerCase();
}

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

function renderItems() {
  itemsTableBody.innerHTML = "";
  items.forEach((it, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(it.name)}</td>
      <td>${escapeHtml(it.currency)}${Number(it.unitPrice).toFixed(2)}</td>
      <td>${Number(it.qty)}</td>
      <td>${escapeHtml(it.currency)}${(it.unitPrice * it.qty).toFixed(2)}</td>
      <td><button data-i="${idx}" class="removeBtn">✕</button></td>
    `;
    itemsTableBody.appendChild(tr);
  });

  // remove handlers
  itemsTableBody.querySelectorAll(".removeBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.getAttribute("data-i"));
      items.splice(i, 1);
      renderItems();
      validate();
    });
  });
}

function validate() {
  const supplierOk = normalizeSupplierName(supplierNameEl.value).length > 0;
  analyseBtn.disabled = !(supplierOk && items.length > 0);
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function calcInvoice(items) {
  const total = items.reduce((sum, it) => sum + (it.unitPrice * it.qty), 0);
  const sorted = [...items].sort((a,b) => (b.unitPrice*b.qty) - (a.unitPrice*a.qty));
  const topItem = sorted[0] ? `${sorted[0].name} (${money(sorted[0].unitPrice*sorted[0].qty, sorted[0].currency)})` : "—";
  return { total, topItem };
}

function compareWithPrevious(prevPricesMap, currentItems) {
  // compare by item name (simple MVP)
  const increases = [];
  const rows = currentItems.map(it => {
    const key = it.name.trim().toLowerCase();
    const prev = prevPricesMap?.[key];
    const prevPrice = (prev && typeof prev.unitPrice === "number") ? prev.unitPrice : null;

    let changeText = "—";
    let changeValue = 0;

    if (prevPrice != null) {
      const diff = it.unitPrice - prevPrice;
      changeValue = diff;
      if (Math.abs(diff) < 0.0001) changeText = "No change";
      else if (diff > 0) changeText = `+${money(diff, it.currency)} per unit`;
      else changeText = `-${money(Math.abs(diff), it.currency)} per unit`;

      if (diff > 0) {
        increases.push({
          name: it.name,
          prevPrice,
          nowPrice: it.unitPrice,
          diff
        });
      }
    }

    return {
      name: it.name,
      now: it.unitPrice,
      prev: prevPrice,
      changeText
    };
  });

  // Sort: biggest increases first
  increases.sort((a,b) => b.diff - a.diff);

  return { increases, rows };
}

function buildPricesMap(items) {
  const map = {};
  items.forEach(it => {
    const key = it.name.trim().toLowerCase();
    if (!key) return;
    map[key] = { unitPrice: Number(it.unitPrice), currency: it.currency };
  });
  return map;
}

function renderResults({ supplier, invoiceDate, currency, notes, items, compare }) {
  resultsEmpty.classList.add("hidden");
  resultsWrap.classList.remove("hidden");

  const { total, topItem } = calcInvoice(items);

  resultsSupplier.textContent = supplier;
  resultsMeta.textContent = [
    invoiceDate ? `Date: ${invoiceDate}` : null,
    notes ? `Note: ${notes}` : null
  ].filter(Boolean).join(" • ");

  kpiTotal.textContent = money(total, currency);
  kpiTopItem.textContent = topItem;
  kpiIncreases.textContent = String(compare.increases.length);

  // pill state
  if (compare.increases.length === 0) {
    alertPill.className = "pill good";
    alertPill.textContent = "No price increases";
  } else if (compare.increases.length <= 2) {
    alertPill.className = "pill warn";
    alertPill.textContent = `${compare.increases.length} increase(s) found`;
  } else {
    alertPill.className = "pill bad";
    alertPill.textContent = `${compare.increases.length} increases found`;
  }

  // table
  summaryTableBody.innerHTML = "";
  compare.rows.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.name)}</td>
      <td>${money(r.now, currency)}</td>
      <td>${r.prev == null ? "—" : money(r.prev, currency)}</td>
      <td>${escapeHtml(r.changeText)}</td>
    `;
    summaryTableBody.appendChild(tr);
  });

  // focus text (plain english)
  if (compare.increases.length === 0) {
    focusText.textContent = "Good news — we didn’t detect any unit price increases for the items on this invoice compared to your last saved invoice for this supplier.";
  } else {
    const top = compare.increases[0];
    focusText.textContent =
      `Focus here: "${top.name}" increased from ${money(top.prevPrice, currency)} to ${money(top.nowPrice, currency)} (+${money(top.diff, currency)} per unit).`;
  }
}

function renderHistory() {
  const history = loadHistory();
  const suppliers = Object.keys(history);

  if (suppliers.length === 0) {
    historyList.innerHTML = `<div class="muted">No saved supplier history yet.</div>`;
    return;
  }

  historyList.innerHTML = "";
  suppliers.sort().forEach(key => {
    const entry = history[key];
    const div = document.createElement("div");
    div.className = "spwCard";
    div.style.marginTop = "10px";
    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start; flex-wrap:wrap;">
        <div>
          <div style="font-weight:900;">${escapeHtml(entry.displayName || key)}</div>
          <div class="muted">Last saved: ${escapeHtml(entry.lastSavedAt || "—")}</div>
          <div class="muted">Items tracked: ${Object.keys(entry.prices || {}).length}</div>
        </div>
        <button class="spwBtn ghost" data-k="${escapeHtml(key)}">Remove</button>
      </div>
    `;
    historyList.appendChild(div);

    div.querySelector("button").addEventListener("click", () => {
      const h = loadHistory();
      delete h[key];
      saveHistory(h);
      renderHistory();
    });
  });
}

addItemBtn.addEventListener("click", () => {
  const name = (itemNameEl.value || "").trim();
  const unitPrice = Number((itemPriceEl.value || "").trim());
  const qty = Number((itemQtyEl.value || "").trim() || "1");
  const currency = (currencyEl.value || "£").trim() || "£";

  if (!name) { setStatus("Please enter an item name."); return; }
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) { setStatus("Please enter a valid unit price."); return; }
  if (!Number.isFinite(qty) || qty <= 0) { setStatus("Please enter a valid quantity."); return; }

  items.push({ name, unitPrice, qty, currency });
  itemNameEl.value = "";
  itemPriceEl.value = "";
  itemQtyEl.value = "";
  setStatus("");
  renderItems();
  validate();
});

clearItemsBtn.addEventListener("click", () => {
  items = [];
  renderItems();
  validate();
  setStatus("");
});

[supplierNameEl, invoiceDateEl, currencyEl, notesEl].forEach(el => {
  el.addEventListener("input", validate);
});

invoiceFile.addEventListener("change", () => {
  // MVP: we accept file but we don't parse it yet
  // Later we will send it to backend OCR.
  validate();
});

analyseBtn.addEventListener("click", () => {
  const supplierDisplay = (supplierNameEl.value || "").trim();
  const supplierKey = normalizeSupplierName(supplierDisplay);
  const invoiceDate = (invoiceDateEl.value || "").trim();
  const currency = (currencyEl.value || "£").trim() || "£";
  const notes = (notesEl.value || "").trim();

  if (!supplierKey) { setStatus("Supplier name is required."); return; }
  if (items.length === 0) { setStatus("Add at least one item."); return; }

  const history = loadHistory();
  const prev = history[supplierKey];
  const prevMap = prev?.prices || {};

  // compare
  const compare = compareWithPrevious(prevMap, items);

  // save new baseline
  history[supplierKey] = {
    displayName: supplierDisplay,
    lastSavedAt: new Date().toLocaleString(),
    prices: buildPricesMap(items)
  };
  saveHistory(history);

  renderResults({
    supplier: supplierDisplay,
    invoiceDate,
    currency,
    notes,
    items,
    compare
  });

  renderHistory();
  setStatus(compare.increases.length ? "Saved. Price increases detected." : "Saved. No increases detected.");
});

clearAllBtn.addEventListener("click", () => {
  if (!confirm("Clear all saved supplier history from this browser?")) return;
  localStorage.removeItem(STORAGE_KEY);
  renderHistory();
  setStatus("History cleared.");
});

// initial
renderItems();
validate();
renderHistory();
