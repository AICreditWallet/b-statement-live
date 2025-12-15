// Read backend URL injected by index.html
const API_BASE = window.API_BASE;

if (!API_BASE) {
  console.error("API_BASE is not defined. Check index.html.");
}

const input = document.getElementById("pdfInput");
const fileName = document.getElementById("fileName");
const btn = document.getElementById("analyzeBtn");
const statusEl = document.getElementById("status");
const result = document.getElementById("result");
const verdictText = document.getElementById("verdictText");
const badge = document.getElementById("badge");
const bankText = document.getElementById("bankText");
const confText = document.getElementById("confText");
const reasonsEl = document.getElementById("reasons");

function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = "status " + kind;
}

function setBadge(verdict) {
  badge.className = "badge";
  if (verdict === "likely_genuine") {
    badge.textContent = "GREEN (low risk)";
    badge.classList.add("green");
  } else if (verdict === "suspicious") {
    badge.textContent = "AMBER (medium risk)";
    badge.classList.add("amber");
  } else {
    badge.textContent = "RED (high risk)";
    badge.classList.add("red");
  }
}

input.addEventListener("change", () => {
  const f = input.files?.[0];
  fileName.textContent = f ? f.name : "No file selected";
  btn.disabled = !f;
  result.classList.add("hidden");
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
    const res = await fetch(`${API_BASE}/analyze`, {
      method: "POST",
      body: form
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.detail || "Request failed");

    result.classList.remove("hidden");
    verdictText.textContent = data.verdict.replaceAll("_", " ");
    setBadge(data.verdict);

    bankText.textContent = data.bank || "Unknown";
    const conf = Math.max(0, Math.min(1, (data.confidence || 0)));
confText.textContent = `${Math.round(conf * 100)}%`;

// update ring + bar (new UI)
const ring = document.getElementById("confRing");
const bar = document.getElementById("confBar");
if (ring) ring.style.setProperty("--p", conf);
if (bar) bar.style.width = `${Math.round(conf * 100)}%`;

    reasonsEl.innerHTML = "";
    (data.reasons || []).forEach(r => {
      const li = document.createElement("li");
      li.textContent = r;
      reasonsEl.appendChild(li);
    });

    setStatus("Done.", "ok");
  } catch (e) {
    setStatus(`Error: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
});
