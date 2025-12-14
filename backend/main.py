import re
from enum import Enum
from typing import List, Tuple, Dict, Optional
from io import BytesIO

import pdfplumber
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PyPDF2 import PdfReader

app = FastAPI(title="B Statement Check API")

# In production, lock this down to your frontend domain(s)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://b-statement-live.vercel.app"
    ],
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
        verdict, confidence, reasons, detected_bank = run_basic_checks(file_bytes)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis error: {e}")

    return {
        "verdict": verdict,
        "confidence": confidence,
        "reasons": reasons,
        "bank": detected_bank,
    }


def run_basic_checks(file_bytes: bytes) -> Tuple[str, float, List[str], str]:
    """
    Keep this function CRASH-PROOF:
    - every variable used later MUST be defined early in function scope
    - all blocks MUST be indented inside the function
    """
    reasons: List[str] = []
    score = 1.0
    detected_bank = "unknown"

    # --- Read PDF (PyPDF2)
    pdf = PdfReader(BytesIO(file_bytes))
    num_pages = len(pdf.pages)
    if num_pages == 0:
        raise ValueError("Empty PDF")

    # -------------------------
    # STRUCTURAL CHECKS
    # -------------------------
    if num_pages > 12:
        score -= 0.20
        reasons.append(f"Page count anomaly: {num_pages} pages (unusually high).")
    elif num_pages > 8:
        score -= 0.10
        reasons.append(f"Page count warning: {num_pages} pages (upper end).")

    # -------------------------
    # METADATA CHECKS
    # -------------------------
    meta = pdf.metadata or {}
    producer = (getattr(meta, "producer", "") or meta.get("/Producer", "") or "").strip()
    creator = (getattr(meta, "creator", "") or meta.get("/Creator", "") or "").strip()
    lower_meta = (producer + " " + creator).lower().strip()

    if not lower_meta:
        score -= 0.25
        reasons.append("Metadata anomaly: producer/creator missing (unusual).")
    else:
        high_risk_editors = [
            "microsoft word", "powerpoint", "excel", "libreoffice", "openoffice",
            "photoshop", "indesign", "canva", "figma", "nitro", "foxit",
            "phantompdf", "pdf-xchange", "pdf editor", "smallpdf", "ilovepdf",
            "sejda", "pdfelement", "wondershare",
        ]
        medium_risk_tools = [
            "pdfcreator", "cutepdf", "primopdf", "pdf printer",
            "google docs", "google drive", "camscanner", "scanner",
        ]
        likely_banklike = [
            "quartz pdfcontext", "ios version", "pdfkit", "pdfium",
            "adobe pdf library", "chrome pdf viewer",
            "opentext output transformation", "opentext",
        ]

        if any(x in lower_meta for x in high_risk_editors):
            score -= 0.45
            reasons.append(
                f"Metadata anomaly: producer/creator ('{producer or creator}') matches a known editor."
            )
        elif any(x in lower_meta for x in medium_risk_tools):
            score -= 0.20
            reasons.append(
                f"Metadata warning: producer/creator ('{producer or creator}') is generic (post-processing possible)."
            )
        elif any(x in lower_meta for x in likely_banklike):
            reasons.append(
                f"Metadata check: producer='{producer or 'unknown'}', creator='{creator or 'unknown'}' looks bank/OS-like."
            )
        else:
            score -= 0.08
            reasons.append(
                f"Metadata check: producer='{producer or 'unknown'}', creator='{creator or 'unknown'}' not recognised (small caution)."
            )

    # -------------------------
    # EXTRACT TEXT (ALL PAGES)
    # -------------------------
    pages_text: List[str] = []
    for page in pdf.pages:
        pages_text.append(page.extract_text() or "")

    first_text = pages_text[0] if pages_text else ""
    first_lower = first_text.lower()

    # -------------------------
    # BANK BRANDING CHECK (token list)
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
        score -= 0.05
        reasons.append("Branding check: bank name not matched to current list.")
    else:
        reasons.append(f"Branding check: detected '{detected_bank}' on page 1.")

    # -------------------------
    # SIMPLE CONTENT CHECK
    # -------------------------
    if "balance" not in first_lower:
        score -= 0.08
        reasons.append("Content warning: 'balance' not found on page 1.")

    # -------------------------
    # LAYOUT CHECKS
    # -------------------------
    layout_warnings = layout_anomaly_check(pages_text)
    if layout_warnings:
        score -= 0.10
        reasons.extend(layout_warnings)

    # -------------------------
    # TRANSACTION + RUNNING BALANCE (SAFE)
    # -------------------------
    txs: List[Dict] = []         # always defined
    rb_warnings: List[str] = []  # always defined

    try:
        txs = extract_transactions_pdfplumber(file_bytes)
    except Exception as e:
        reasons.append(f"Transaction parse error: {e}")
        txs = []

    if not txs:
        score -= 0.05
        reasons.append(
            "Transaction parse: could not extract structured transaction tables "
            "(layout may be image-based or non-standard)."
        )
    else:
        try:
            rb_warnings = running_balance_check_rows(txs)
        except Exception as e:
            reasons.append(f"Running balance check error: {e}")
            rb_warnings = []

        if rb_warnings:
            score -= 0.30
            reasons.extend(rb_warnings)

    # -------------------------
    # NORMALISE SCORE
    # -------------------------
    score = max(0.05, min(score, 1.0))

    # -------------------------
    # VERDICT BUCKETS
    # -------------------------
    if score >= 0.95:
        verdict = Verdict.likely_genuine
    elif score >= 0.75:
        verdict = Verdict.suspicious
        reasons.append("Overall risk: medium – recommend manual review of statement.")
    else:
        verdict = Verdict.likely_fake
        reasons.append("Overall risk: high – multiple anomalies detected.")

    return verdict.value, score, reasons, detected_bank


def layout_anomaly_check(pages_text: List[str]) -> List[str]:
    warnings: List[str] = []
    if not pages_text:
        return warnings

    num_pages = len(pages_text)

    first = pages_text[0].lower()
    header_tokens = ["account", "sort code", "statement", "period"]
    header_hits = sum(1 for tok in header_tokens if tok in first)
    if header_hits <= 1:
        warnings.append("Layout check: key header fields look missing/unclear on page 1.")

    line_counts = [len(p.splitlines()) for p in pages_text]
    if num_pages >= 3:
        internal = line_counts[1:-1]
        avg_lines = sum(internal) / max(1, len(internal))
        for idx in range(1, num_pages - 1):
            count = line_counts[idx]
            if avg_lines > 0 and count < 0.5 * avg_lines:
                warnings.append(
                    f"Layout check: page {idx+1} has far fewer lines than typical internal pages."
                )

    pages_with_marker = []
    for idx, txt in enumerate(pages_text):
        if re.search(r"page\s+\d+\s+of\s+\d+", txt.lower()):
            pages_with_marker.append(idx)

    if 0 < len(pages_with_marker) < num_pages:
        missing = [str(i + 1) for i in range(num_pages) if i not in pages_with_marker]
        warnings.append(
            "Layout check: 'Page X of Y' appears on some pages but missing on page(s): "
            + ", ".join(missing)
        )

    return warnings


def extract_transactions_pdfplumber(file_bytes: bytes) -> List[dict]:
    """
    Bank-agnostic transaction extractor (best-effort).
    - Uses pdfplumber table extraction.
    - Tries to map columns by header names across banks.
    Returns rows with: page, row, debit, credit, balance
    """
    transactions: List[dict] = []

    def _to_money(x: Optional[str]) -> Optional[float]:
        if not x:
            return None
        s = str(x).strip()
        if not s:
            return None
        s = s.replace(",", "").replace("£", "").replace(" ", "")
        # handle (123.45) negatives
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
                debit_idx = next((i for i, h in enumerate(headers) if "debit" in h or "paid out" in h or "out" == h), None)
                credit_idx = next((i for i, h in enumerate(headers) if "credit" in h or "paid in" in h or "in" == h), None)
                amount_idx = next((i for i, h in enumerate(headers) if "amount" in h), None)
                balance_idx = next((i for i, h in enumerate(headers) if "balance" in h), None)

                # If no balance column, this table likely isn't transactions
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

                    transactions.append({
                        "page": page_idx + 1,
                        "row": row_idx,
                        "debit": float(debit),
                        "credit": float(credit),
                        "balance": float(bal),
                        # optional fields
                        "date": (row[date_idx] if (date_idx is not None and date_idx < len(row)) else None),
                    })

    return transactions


def running_balance_check_rows(transactions: List[dict]) -> List[str]:
    warnings: List[str] = []

    if len(transactions) < 3:
        return ["Running balance check: not enough transactions to validate."]

    mismatches = 0
    # Keep order as extracted (usually top-to-bottom). Some statements are reverse chronological.
    # We do a tolerant check either direction: try forward; if too many mismatches, try reverse.
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
                        f"Running balance mismatch on page {curr['page']} row {curr['row']} "
                        f"(expected £{expected:.2f}, saw £{curr['balance']:.2f})."
                    )
        return m, local_warn

    m1, w1 = _count_mismatches(transactions)
    m2, w2 = _count_mismatches(list(reversed(transactions)))

    # choose direction with fewer mismatches
    if m2 < m1:
        mismatches, warnings = m2, w2
    else:
        mismatches, warnings = m1, w1

    if mismatches >= 5:
        warnings.append("Running balance mismatch: too many inconsistencies (stopped after 5).")

    return warnings
