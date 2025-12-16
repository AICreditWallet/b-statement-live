const API_BASE = window.API_BASE;

const input = document.getElementById("pdfInput");
const fileName = document.getElementById("fileName");
const btn = document.getElementById("analyzeBtn");
const statusEl = document.getElementById("status");

// New results UI
const resultsSection = document.getElementById("resultsSection");
const riskPill = document.getElementById("riskPill");
const outcomeTitle = document.getElementById("outcomeTitle");
const bankText = document.getElementById("bankText");
const confPct = document.getElementById("confPct");
const donut = document.getElementById("donut");
const confBar = document.getElementById("confBar");
const reasonsEl = document.getElementById("reasons");

function setStatus(msg, kind="") {
  statusEl.textContent = msg;
  statusEl.className = "status " + kind;
}

function showResults() {
  resultsSection.classList.remove("hidden");
  resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function hideResults() {
  resultsSection.classList.add("hidden");
}

function setRiskPill(verdict) {
  // Map your backend verdicts -> nicer label
  // expected: likely_genuine | suspicious | likely_fake (or anything else)
  riskPill.className = "riskPill";

  if (verdict === "likely_genuine") {
    riskPill.textContent = "GREEN (low risk)";
    riskPill.classList.add("green");
    outcomeTitle.textContent = "likely genuine";
  } else if (verdict === "suspicious") {
    riskPill.textContent = "AMBER (review)";
    riskPill.classList.add("amber");
    outcomeTitle.textContent = "needs review";
  } else {
    riskPill.textContent = "RED (high risk)";
    riskPill.classList.add("red");
    outcomeTitle.textContent = "likely fake";
  }
}

function setConfidence(conf) {
  const pct = Math.max(0, Math.min(100, Math.round((conf || 0) * 100)));
  confPct.textContent = `${pct}%`;
  donut.style.setProperty("--pct", pct);
  confBar.style.width = `${pct}%`;
}

input.addEventListener("change", () => {
  const f = input.files?.[0];
  fileName.textContent = f ? f.name : "No file selected";
  btn.disabled = !f;
  hideResults();
  setStatus("");
});

btn.addEventListener("click", async () => {
  const f = input.files?.[0];
  if (!f) return;

  btn.disabled = true;
  setStatus("Analyzing…", "info");

  const form = new FormData();
  form.append("file", f);

  try {
    const res = await fetch(`${API_BASE}/analyze`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.detail || "Request failed");

    // Fill UI
    setRiskPill(data.verdict);
    bankText.textContent = data.bank || "unknown";
    setConfidence(data.confidence);

    // Flags
    reasonsEl.innerHTML = "";
    (data.reasons || []).forEach(r => {
      const li = document.createElement("li");
      li.textContent = r;
      reasonsEl.appendChild(li);
    });

    setStatus("", "");
    showResults();
  } catch (e) {
    hideResults();
    setStatus(`Error: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
});
function renderAI(ai) {
  const statusEl = document.getElementById("aiStatus");
  const noteEl = document.getElementById("aiNote");

  if (!ai || !ai.level) {
    statusEl.textContent = "Unknown";
    statusEl.className = "aiStatus neutral";
    noteEl.textContent = "No AI analysis available.";
    return;
  }

  if (ai.level === "none") {
    statusEl.textContent = "NO";
    statusEl.className = "aiStatus good";
    noteEl.textContent = "No AI or automated document generation detected.";
  } 
  else if (ai.level === "possible") {
    statusEl.textContent = "POSSIBLE";
    statusEl.className = "aiStatus warn";
    noteEl.textContent = ai.summary?.[0] || "Some automated indicators detected.";
  } 
  else if (ai.level === "strong") {
    statusEl.textContent = "YES";
    statusEl.className = "aiStatus bad";
    noteEl.textContent = ai.summary?.[0] || "Strong AI-generated document indicators detected.";
  }
}
