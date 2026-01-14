import os
import re
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image


# -------------------------
# App + CORS
# -------------------------
app = FastAPI(title="Supplier Price Watch API")

# For dev: allow all. In production lock this down to your Vercel domain.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------
# Constants
# -------------------------
MAX_SYNC_BYTES = 5 * 1024 * 1024  # Textract sync APIs: keep it small & safe

SUPPORTED_EXTS = {".pdf", ".png", ".jpg", ".jpeg", ".heic", ".heif"}

# Content-types we consider valid
SUPPORTED_CONTENT_TYPES = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/heic",
    "image/heif",
    # sometimes browsers send this:
    "application/octet-stream",
}


# -------------------------
# Health
# -------------------------
@app.get("/health")
def health():
    return {"status": "ok"}


# -------------------------
# Main endpoint (keep both spellings)
# -------------------------
@app.post("/analyse")
async def analyse(file: UploadFile = File(...)):
    return await _analyse_impl(file)


@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    # Alias so you don't break older frontend calls
    return await _analyse_impl(file)


async def _analyse_impl(file: UploadFile) -> Dict[str, Any]:
    filename = (file.filename or "").strip()
    if not filename:
        raise HTTPException(status_code=400, detail="Missing filename.")

    ext = _ext_lower(filename)
    content_type = (file.content_type or "").strip().lower()

    # Allow either extension or content-type to decide support
    if ext and ext not in SUPPORTED_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file extension '{ext}'. Supported: PDF, PNG, JPG/JPEG, HEIC/HEIF.",
        )

    if content_type and content_type not in SUPPORTED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported content-type '{content_type}'. Supported: PDF or image files.",
        )

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(raw) > MAX_SYNC_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File too large for realtime extraction (max {MAX_SYNC_BYTES // (1024*1024)} MB).",
        )

    # Decide ext if missing / weird
    if not ext:
        ext = _guess_ext_from_content_type(content_type)

    # Convert images -> JPEG bytes, PDF stays PDF
    try:
        document_bytes, normalized_type = _normalize_for_textract(raw, ext, content_type)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not process file: {e}")

    # Call AWS Textract AnalyzeExpense
    try:
        textract = _textract_client()
        resp = textract.analyze_expense(Document={"Bytes": document_bytes})
    except (BotoCoreError, ClientError) as e:
        raise HTTPException(status_code=502, detail=f"AWS Textract error: {str(e)}")

    # Parse vendor/total/date/items
    vendor, total, currency, date = _parse_summary_fields(resp)
    items = _parse_line_items(resp)

    return {
        "filename": filename,
        "input_type": normalized_type,  # "pdf" or "image/jpeg"
        "vendor": vendor,
        "total": total,
        "currency": currency,
        "date": date,
        "items": items,
        "items_count": len(items),
        "debug": {
            "content_type": content_type,
            "ext": ext,
            "bytes": len(raw),
            "has_expense_documents": bool(resp.get("ExpenseDocuments")),
        },
    }


# -------------------------
# AWS client
# -------------------------
def _textract_client():
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
    if not region:
        raise HTTPException(status_code=500, detail="AWS_REGION is not set in environment.")
    return boto3.client("textract", region_name=region)


# -------------------------
# Normalization
# HEIC/PNG/JPG -> JPEG bytes
# PDF stays PDF
# -------------------------
def _normalize_for_textract(raw: bytes, ext: str, content_type: str) -> Tuple[bytes, str]:
    # Treat PDF as-is
    if ext == ".pdf" or content_type == "application/pdf":
        return raw, "pdf"

    # HEIC/HEIF requires extra decoder
    if ext in {".heic", ".heif"} or content_type in {"image/heic", "image/heif"}:
        try:
            import pillow_heif  # type: ignore
            pillow_heif.register_heif_opener()
        except Exception:
            raise HTTPException(
                status_code=400,
                detail=(
                    "HEIC/HEIF upload received, but HEIC decoding isn't available here. "
                    "Install pillow-heif OR convert the image to JPG/PNG and try again."
                ),
            )

    # Convert any image -> JPEG for Textract
    try:
        img = Image.open(BytesIO(raw))
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Could not open uploaded image. If this is a screenshot, re-save as PNG/JPG. Error: {e}",
        )

    # Ensure RGB (Textract likes JPEG RGB)
    if img.mode not in ("RGB",):
        img = img.convert("RGB")

    out = BytesIO()
    img.save(out, format="JPEG", quality=90, optimize=True)
    return out.getvalue(), "image/jpeg"


def _guess_ext_from_content_type(content_type: str) -> str:
    if content_type == "application/pdf":
        return ".pdf"
    if content_type in {"image/jpeg", "image/jpg"}:
        return ".jpg"
    if content_type == "image/png":
        return ".png"
    if content_type in {"image/heic", "image/heif"}:
        return ".heic"
    # fallback
    return ""


def _ext_lower(name: str) -> str:
    name = name.lower()
    m = re.search(r"(\.[a-z0-9]+)$", name)
    return m.group(1) if m else ""


# -------------------------
# Parsing helpers (AnalyzeExpense response)
# -------------------------
def _parse_summary_fields(resp: Dict[str, Any]) -> Tuple[Optional[str], Optional[float], Optional[str], Optional[str]]:
    """
    Returns: vendor, total, currency, date
    """
    docs = resp.get("ExpenseDocuments") or []
    if not docs:
        return None, None, None, None

    doc0 = docs[0]
    summary_fields = doc0.get("SummaryFields") or []

    vendor = _pick_summary(summary_fields, ["VENDOR_NAME", "SUPPLIER_NAME", "MERCHANT_NAME"])
    total_str = _pick_summary(summary_fields, ["TOTAL", "AMOUNT_DUE", "INVOICE_RECEIPT_TOTAL"])
    date = _pick_summary(summary_fields, ["INVOICE_RECEIPT_DATE", "INVOICE_RECEIPT_RECEIPT_DATE", "DATE"])

    total = _to_float(total_str)
    currency = _guess_currency(total_str)

    return vendor, total, currency, date


def _pick_summary(summary_fields: List[Dict[str, Any]], keys: List[str]) -> Optional[str]:
    for want in keys:
        for f in summary_fields:
            ftype = ((f.get("Type") or {}).get("Text") or "").strip().upper()
            if ftype == want:
                return _field_value_text(f)
    return None


def _field_value_text(field: Dict[str, Any]) -> Optional[str]:
    val = field.get("ValueDetection") or {}
    txt = (val.get("Text") or "").strip()
    return txt or None


def _to_float(val: Optional[str]) -> Optional[float]:
    if not val:
        return None
    s = val.strip().replace(",", "")
    s = re.sub(r"[^0-9\.\-]", "", s)
    if not s:
        return None
    try:
        return float(s)
    except Exception:
        return None


def _guess_currency(val: Optional[str]) -> Optional[str]:
    if not val:
        return None
    if "£" in val:
        return "GBP"
    if "$" in val:
        return "USD"
    if "€" in val:
        return "EUR"
    return None


def _parse_line_items(resp: Dict[str, Any]) -> List[Dict[str, Any]]:
    docs = resp.get("ExpenseDocuments") or []
    if not docs:
        return []

    doc0 = docs[0]
    groups = doc0.get("LineItemGroups") or []
    items_out: List[Dict[str, Any]] = []

    for g in groups:
        line_items = g.get("LineItems") or []
        for li in line_items:
            fields = li.get("LineItemExpenseFields") or []
            description = _pick_line_item(fields, ["ITEM", "DESCRIPTION", "PRODUCT_CODE", "NAME"])
            quantity = _to_float(_pick_line_item(fields, ["QUANTITY"]))
            unit_price = _to_float(_pick_line_item(fields, ["UNIT_PRICE", "PRICE"]))
            amount = _to_float(_pick_line_item(fields, ["AMOUNT", "LINE_TOTAL", "TOTAL_PRICE"]))

            if amount is None and quantity is not None and unit_price is not None:
                amount = round(quantity * unit_price, 2)

            items_out.append(
                {
                    "description": description,
                    "quantity": quantity,
                    "unit_price": unit_price,
                    "amount": amount,
                    "raw_fields": _flatten_fields(fields),
                }
            )

    cleaned = [
        x
        for x in items_out
        if (x.get("description") or x.get("amount") is not None or x.get("unit_price") is not None)
    ]
    return cleaned


def _pick_line_item(fields: List[Dict[str, Any]], keys: List[str]) -> Optional[str]:
    for want in keys:
        for f in fields:
            ftype = ((f.get("Type") or {}).get("Text") or "").strip().upper()
            if ftype == want:
                return _field_value_text(f)
    return None


def _flatten_fields(fields: List[Dict[str, Any]]) -> Dict[str, Optional[str]]:
    out: Dict[str, Optional[str]] = {}
    for f in fields:
        k = ((f.get("Type") or {}).get("Text") or "").strip()
        if not k:
            continue
        out[k] = _field_value_text(f)
    return out
