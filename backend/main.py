import re
from enum import Enum
from typing import List, Tuple, Dict, Optional, Any
from io import BytesIO

import pdfplumber
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PyPDF2 import PdfReader

app = FastAPI(title="B Statement Check API")

# In production: keep only your deployed frontend domain.
# For local dev you can temporarily add "http://localhost:3000" etc.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://b-statement-live.vercel.app"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Verdict(str, Enum):
    likely_genuine = "likely_genuine"
    suspicious = "suspicious"
    likely_fake = "likely_fake"


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/analyze")
async def analyze_statement(file: UploadFile = File(...)):
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    file_bytes = await file.read()
    if len(file_bytes) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 10 MB).")

    try:
        verdict, confidence, reasons, detected_bank, sections, ai_info = run_basic_checks(file_bytes)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis error: {e}")

    # Keep old keys so frontend won't break + extra keys for new UI
    return {
        "verdict": verdict,
        "confidence": confidence,
        "reasons": reasons,
        "bank": detected_bank,
        "sections": sections,
        "ai_generated": ai_info,
    }


def run_basic_checks(
    file_bytes: bytes
) -> Tuple[str, float, List[str], str, Dict[str, List[str]], Dict[str, Any]]:
    reasons: List[str] = []
    score = 1.0
    detected_bank = "unknown"

    # Grouped flags for UI (you can render these in separate cards later)
    sections: Dict[str, List[str]] = {
        "integrity": [],
        "branding": [],
        "layout": [],
        "transactions": [],
        "ai": [],
    }

    # --- Read PDF (PyPDF2)
    pdf = PdfReader(BytesIO(file_bytes))
    num_pages = len(pdf.pages)
    if num_pages == 0:
        raise ValueError("Empty PDF")

    # -------------------------
    # STRUCTURAL CHECKS
    # -------------------------
    if num_pages > 12:
        score -= 0.15
        msg = f"Unusual page count: {num_pages} pages."
        reasons.append(msg)
        sections["layout"].append(msg)
    elif num_pages > 8:
        score -= 0.08
        msg = f"High page count: {num_pages} pages."
        reasons.append(msg)
        sections["layout"].append(msg)

    # -------------------------
    # METADATA CHECKS (REWEIGHTED)
    # -------------------------
    meta = pdf.metadata or {}
    producer = (getattr(meta, "producer", "") or meta.get("/Producer", "") or "").strip()
    creator = (getattr(meta, "creator", "") or meta.get("/Creator", "") or "").strip()
    lower_meta = (producer + " " + creator).lower().strip()

    # AI / synthetic signals (metadata-only, weak evidence)
    ai_level, ai_reasons = ai_generation_signals(lower_meta)
    ai_info = {
        "level": ai_level,  # "none" | "possible" | "strong"
        "summary": ai_reasons or ["No strong AI/synthetic indicators found in PDF metadata."],
        "note": "This is metadata-based only (not a guarantee).",
    }
    sections["ai"].extend(ai_info["summary"])
    reasons.extend(ai_info["summary"])

    # Strong edit tools (these are meaningful signals)
    high_risk_editors = [
        "microsoft word", "powerpoint", "excel", "libreoffice", "openoffice",
        "photoshop", "indesign", "canva", "figma", "nitro", "foxit",
        "phantompdf", "pdf-xchange", "pdf editor", "smallpdf", "ilovepdf",
        "sejda", "pdfelement", "wondershare",
    ]

    # Medium tools = possible post-processing
    medium_risk_tools = [
        "pdfcreator", "cutepdf", "primopdf", "pdf printer",
        "google docs", "google drive", "camscanner", "scanner",
    ]

    # Often normal for app exports / system generated PDFs
    banklike_or_os = [
        "pdfkit", "quartz", "ios", "mac os", "coregraphics", "skia", "pdfium",
        "adobe", "chrome", "chromium",
    ]

    strong_edit_signal = False

    if not lower_meta:
        # Missing metadata is common for fintech exports → small penalty only
        score -= 0.03
        msg = "Metadata: minimal or missing (can be normal for app-generated statements)."
        reasons.append(msg)
        sections["integrity"].append(msg)
    else:
        if any(x in lower_meta for x in high_risk_editors):
            score -= 0.55
            strong_edit_signal = True
            msg = f"Metadata: shows possible editing tool ('{producer or creator}')."
            reasons.append(msg)
            sections["integrity"].append(msg)
        elif any(x in lower_meta for x in medium_risk_tools):
            score -= 0.10
            msg = f"Metadata: shows generic PDF tool ('{producer or creator}')."
            reasons.append(msg)
            sections["integrity"].append(msg)
        elif any(x in lower_meta for x in banklike_or_os):
            msg = f"Metadata: looks system-generated ('{producer or creator}')."
            reasons.append(msg)
            sections["integrity"].append(msg)
        else:
            # Unknown metadata should not push genuine PDFs into RED
            score -= 0.03
            msg = f"Metadata: unrecognised producer/creator ('{producer or creator}')."
            reasons.append(msg)
            sections["integrity"].append(msg)

    # Apply AI penalties gently (metadata-only)
    if ai_level == "strong":
        score -= 0.20
        msg = "AI indicator: strong metadata signal of automated generation."
        reasons.append(msg)
        sections["ai"].append(msg)
    elif ai_level == "possible":
        score -= 0.05
        msg = "AI indicator: possible metadata signal (weak evidence)."
        reasons.append(msg)
        sections["ai"].append(msg)

    # -------------------------
    # EXTRACT TEXT (ALL PAGES)
    # -------------------------
    pages_text: List[str] = []
    for page in pdf.pages:
        pages_text.append(page.extract_text() or "")

    first_text = pages_text[0] if pages_text else ""
    first_lower = first_text.lower()

    # -------------------------
    # BANK BRANDING CHECK
    # -------------------------
    bank_tokens = {
        "Lloyds": ["lloyds"],
        "Barclays": ["barclays"],
        "HSBC": ["hsbc"],
        "NatWest": ["natwest"],
        "RBS": ["royal bank of scotland", "rbs"],
        "Halifax": ["halifax"],
        "Santander": ["santander"],
        "Nationwide": ["nationwide"],
        "TSB": ["tsb"],
        "Monzo": ["monzo"],
        "Starling": ["starling"],
        "Revolut": ["revolut"],
        "Metro Bank": ["metro bank"],
        "Virgin Money": ["virgin money"],
    }

    for bank_name, tokens in bank_tokens.items():
        if any(t in first_lower for t in tokens):
            detected_bank = bank_name
            break

    if detected_bank == "unknown":
        score -= 0.06
        msg = "Branding: bank name not matched to current list."
        reasons.append(msg)
        sections["branding"].append(msg)
    else:
        # small positive bump so genuine docs don't become red by default
        score += 0.05
        msg = f"Branding: detected '{detected_bank}' on page 1."
        reasons.append(msg)
        sections["branding"].append(msg)

    # -------------------------
    # SIMPLE CONTENT CHECK (SOFTER)
    # -------------------------
    if "balance" not in first_lower:
        score -= 0.03
        msg = "Content: 'balance' not found on page 1 (not always an issue)."
        reasons.append(msg)
        sections["layout"].append(msg)

    # -------------------------
    # LAYOUT CHECKS (WEAK SIGNAL)
    # -------------------------
    layout_warnings = layout_anomaly_check(pages_text)
    if layout_warnings:
        score -= 0.05
        reasons.extend(layout_warnings)
        sections["layout"].extend(layout_warnings)

    # -------------------------
    # TRANSACTION EXTRACTION + RUNNING BALANCE
    # -------------------------
    txs: List[Dict] = []
    rb_warnings: List[str] = []

    try:
        txs = extract_transactions_pdfplumber(file_bytes)
    except Exception as e:
        msg = f"Transactions: parse error ({e})."
        reasons.append(msg)
        sections["transactions"].append(msg)
        txs = []

    if not txs:
        # Not being able to extract tables is common → tiny penalty
        score -= 0.02
        msg = "Transactions: could not extract structured tables (common for some bank/app PDFs)."
        reasons.append(msg)
        sections["transactions"].append(msg)
    else:
        try:
            rb_warnings = running_balance_check_rows(txs)
        except Exception as e:
            msg = f"Running balance check error: {e}"
            reasons.append(msg)
            sections["transactions"].append(msg)
            rb_warnings = []

        if rb_warnings:
            score -= 0.30
            reasons.extend(rb_warnings)
            sections["transactions"].extend(rb_warnings)

    # -------------------------
    # NORMALISE SCORE
    # -------------------------
    score = max(0.05, min(score, 1.0))

    # -------------------------
    # VERDICT BUCKETS (UPDATED)
    # -------------------------
    if strong_edit_signal or score < 0.55:
        verdict = Verdict.likely_fake
        reasons.append(
            "Overall: high risk signals found — recommend requesting an original statement directly from the bank."
        )
    elif score < 0.82:
        verdict = Verdict.suspicious
        reasons.append("Overall: some elements need review — recommend manual checks.")
    else:
        verdict = Verdict.likely_genuine
        reasons.append("Overall: looks consistent with a bank-generated PDF (not proof of authenticity).")

    return verdict.value, score, reasons, detected_bank, sections, ai_info


def layout_anomaly_check(pages_text: List[str]) -> List[str]:
    warnings: List[str] = []
    if not pages_text:
        return warnings

    num_pages = len(pages_text)

    first = (pages_text[0] or "").lower()
    header_tokens = ["account", "sort code", "statement", "period"]
    header_hits = sum(1 for tok in header_tokens if tok in first)
    if header_hits <= 1:
        warnings.append("Layout: key header fields look missing/unclear on page 1.")

    line_counts = [len((p or "").splitlines()) for p in pages_text]
    if num_pages >= 3:
        internal = line_counts[1:-1]
        avg_lines = sum(internal) / max(1, len(internal))
        for idx in range(1, num_pages - 1):
            count = line_counts[idx]
            if avg_lines > 0 and count < 0.5 * avg_lines:
                warnings.append(f"Layout: page {idx+1} has far fewer text lines than other pages.")

    pages_with_marker = []
    for idx, txt in enumerate(pages_text):
        if re.search(r"page\s+\d+\s+of\s+\d+", (txt or "").lower()):
            pages_with_marker.append(idx)

    if 0 < len(pages_with_marker) < num_pages:
        missing = [str(i + 1) for i in range(num_pages) if i not in pages_with_marker]
        warnings.append("Layout: page numbering marker appears on some pages but missing on: " + ", ".join(missing))

    return warnings


def extract_transactions_pdfplumber(file_bytes: bytes) -> List[dict]:
    transactions: List[dict] = []

    def _to_money(x: Optional[str]) -> Optional[float]:
        if not x:
            return None
        s = str(x).strip()
        if not s:
            return None
        s = s.replace(",", "").replace("£", "").replace(" ", "")
        if s.startswith("(") and s.endswith(")"):
            s = "-" + s[1:-1]
        try:
            return float(s)
        except Exception:
            return None

    with pdfplumber.open(BytesIO(file_bytes)) as pdf:
        for page_idx, page in enumerate(pdf.pages):
            tables = page.extract_tables()
            if not tables:
                continue

            for table in tables:
                if not table or len(table) < 2:
                    continue

                headers = [(h or "").strip().lower() for h in table[0]]

                date_idx = next((i for i, h in enumerate(headers) if "date" in h), None)
                debit_idx = next(
                    (i for i, h in enumerate(headers) if "debit" in h or "paid out" in h or h == "out"), None
                )
                credit_idx = next(
                    (i for i, h in enumerate(headers) if "credit" in h or "paid in" in h or h == "in"), None
                )
                amount_idx = next((i for i, h in enumerate(headers) if "amount" in h), None)
                balance_idx = next((i for i, h in enumerate(headers) if "balance" in h), None)

                if balance_idx is None:
                    continue

                for row_idx, row in enumerate(table[1:], start=2):
                    if not row or balance_idx >= len(row):
                        continue

                    bal = _to_money(row[balance_idx])
                    if bal is None:
                        continue

                    debit = 0.0
                    credit = 0.0

                    if debit_idx is not None and debit_idx < len(row):
                        d = _to_money(row[debit_idx])
                        if d is not None:
                            debit = abs(d)

                    if credit_idx is not None and credit_idx < len(row):
                        c = _to_money(row[credit_idx])
                        if c is not None:
                            credit = abs(c)

                    if amount_idx is not None and amount_idx < len(row):
                        a = _to_money(row[amount_idx])
                        if a is not None:
                            if a < 0:
                                debit = abs(a)
                            else:
                                credit = a

                    transactions.append(
                        {
                            "page": page_idx + 1,
                            "row": row_idx,
                            "debit": float(debit),
                            "credit": float(credit),
                            "balance": float(bal),
                            "date": (row[date_idx] if (date_idx is not None and date_idx < len(row)) else None),
                        }
                    )

    return transactions


def running_balance_check_rows(transactions: List[dict]) -> List[str]:
    warnings: List[str] = []

    if len(transactions) < 3:
        return ["Running balance: not enough extracted rows to validate."]

    def _count_mismatches(rows: List[dict]) -> Tuple[int, List[str]]:
        local_warn: List[str] = []
        m = 0
        for i in range(1, len(rows)):
            prev = rows[i - 1]
            curr = rows[i]
            expected = prev["balance"] + curr["credit"] - curr["debit"]
            if abs(expected - curr["balance"]) > 0.01:
                m += 1
                if m <= 5:
                    local_warn.append(
                        f"Running balance: mismatch on page {curr['page']} row {curr['row']} "
                        f"(expected £{expected:.2f}, saw £{curr['balance']:.2f})."
                    )
        return m, local_warn

    m1, w1 = _count_mismatches(transactions)
    m2, w2 = _count_mismatches(list(reversed(transactions)))

    if m2 < m1:
        mismatches, best_warn = m2, w2
    else:
        mismatches, best_warn = m1, w1

    warnings.extend(best_warn)

    if mismatches >= 5:
        warnings.append("Running balance: many inconsistencies detected (showing first 5).")

    return warnings


def ai_generation_signals(meta_text: str) -> Tuple[str, List[str]]:
    """
    Detects AI / synthetic PDF generation indicators based on metadata only.
    Returns: (level, reasons)
    level: "none" | "possible" | "strong"
    """
    reasons: List[str] = []
    level = "none"

    strong_ai_tools = [
        "reportlab",
        "weasyprint",
        "wkhtmltopdf",
        "langchain",
        "playwright",
        "puppeteer",
        "headlesschrome",
        "chatgpt",
        "openai",
        "gpt",
    ]

    generic_signals = [
        "pdf generator",
        "generator",
    ]

    lower = (meta_text or "").lower().strip()

    if any(x in lower for x in strong_ai_tools):
        level = "strong"
        reasons.append("AI/synthetic indicator: metadata mentions an automated generation tool.")
    elif not lower:
        level = "possible"
        reasons.append("AI/synthetic indicator: metadata missing (common in automated PDFs, but also common in real exports).")
    elif any(x in lower for x in generic_signals):
        level = "possible"
        reasons.append("AI/synthetic indicator: metadata suggests a generic PDF generator (weak evidence).")

    return level, reasons
