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
const API_BASE = "https://b-statement-live-production.up.railway.app";


function setStatus(msg, kind="") {
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
    const res = await fetch(`${API_BASE}/analyze`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.detail || "Request failed");

    // Render
    result.classList.remove("hidden");
    verdictText.textContent = data.verdict.replaceAll("_", " ");
    setBadge(data.verdict);

    bankText.textContent = data.bank || "unknown";
    confText.textContent = `${Math.round((data.confidence || 0) * 100)}%`;

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
