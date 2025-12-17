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

function setStatus(msg, kind = "") {
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

function renderAI(ai) {
  const aiStatusEl = document.getElementById("aiStatus");
  const aiNoteEl = document.getElementById("aiNote");

  // If the card doesn't exist on the page, just safely do nothing.
  if (!aiStatusEl || !aiNoteEl) return;

  // Default
  aiStatusEl.textContent = "NO";
  aiStatusEl.className = "aiStatus good";
  aiNoteEl.textContent = "No strong AI/synthetic indicators found in PDF metadata.";

  if (!ai || !ai.level) {
    aiStatusEl.textContent = "Unknown";
    aiStatusEl.className = "aiStatus neutral";
    aiNoteEl.textContent = "AI document analysis not available.";
    return;
  }

  if (ai.level === "strong") {
    aiStatusEl.textContent = "YES";
    aiStatusEl.className = "aiStatus bad";
    aiNoteEl.textContent =
      ai.summary?.[0] || "Strong AI/synthetic document indicators detected in metadata.";
    return;
  }

  if (ai.level === "possible") {
    aiStatusEl.textContent = "POSSIBLE";
    aiStatusEl.className = "aiStatus warn";
    aiNoteEl.textContent =
      ai.summary?.[0] || "Possible automated/synthetic indicators detected in metadata.";
    return;
  }

  // ai.level === "none" (or anything else) => keep default "NO"
}

input.addEventListener("change", () => {
  const f = input.files?.[0];
  fileName.textContent = f ? f.name : "No file selected";
  btn.disabled = !f;
  hideResults();
  setStatus("");

  // Reset AI card if you want
  renderAI({ level: "none", summary: ["No strong AI/synthetic indicators found in PDF metadata."] });
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
    (data.reasons || []).forEach((r) => {
      const li = document.createElement("li");
      li.textContent = r;
      reasonsEl.appendChild(li);
    });

    // ✅ AI card (THIS is what you were missing)
    // Backend sends: ai_generated (recommended)
    // If your backend sends: ai_info or something else, this fallback still works.
    renderAI(data.ai_generated || data.ai_info || null);

    setStatus("", "");
    showResults();
  } catch (e) {
    hideResults();
    setStatus(`Error: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
});
