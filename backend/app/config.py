"""
Application configuration
"""
import json as _json
import os
from pathlib import Path

# Base directory
BASE_DIR = Path(__file__).resolve().parent.parent

# Upload directory for temporary file storage
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# Export directory for generated files
EXPORT_DIR = BASE_DIR / "exports"
EXPORT_DIR.mkdir(exist_ok=True)

# Maximum file size (50MB)
MAX_FILE_SIZE = 50 * 1024 * 1024

# Allowed file extensions
ALLOWED_EXTENSIONS = {'.csv', '.xlsx', '.xls'}

# CSV encodings to try
CSV_ENCODINGS = ['utf-8', 'latin-1', 'cp1252', 'iso-8859-1']

# Local AI audit settings
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma4:e2b")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

# ── Statutory contribution rates (override via environment variables) ──────────
# Storing rates here means tax-rule changes only require a config update,
# not a code change.  Rates are Ghana 2024 defaults.
SSF_EMPLOYEE_RATE    = float(os.getenv("SSF_EMPLOYEE_RATE",    "0.055"))  # 5.5%
SSF_EMPLOYER_RATE    = float(os.getenv("SSF_EMPLOYER_RATE",    "0.130"))  # 13.0%
SSNIT_TIER1_RATE     = float(os.getenv("SSNIT_TIER1_RATE",     "0.135"))  # 13.5% employer
SSNIT_TIER2_MOP_RATE = float(os.getenv("SSNIT_TIER2_MOP_RATE", "0.050"))  # 5.0% employer (MOP)
PF_EMPLOYEE_RATE     = float(os.getenv("PF_EMPLOYEE_RATE",     "0.050"))  # 5.0%
PF_EMPLOYER_RATE     = float(os.getenv("PF_EMPLOYER_RATE",     "0.075"))  # 7.5%
ICU_PMSU_RATE        = float(os.getenv("ICU_PMSU_RATE",        "0.030"))  # 3.0%

# ── Monthly PAYE bands (GRA 2024) ──────────────────────────────────────────────
# Stored as plain dicts so they are JSON-serialisable and can be injected into
# AI prompts or swapped out via PAYE_BANDS_JSON env var when GRA revises the bands.
# "to": null means the band extends to infinity.
_PAYE_BANDS_DEFAULT = [
    {"from": 0.0,    "to": 490.0,  "rate": 0.000, "label": "0% on first GHS 490"},
    {"from": 490.0,  "to": 730.0,  "rate": 0.050, "label": "5% on next GHS 240"},
    {"from": 730.0,  "to": 1160.0, "rate": 0.100, "label": "10% on next GHS 430"},
    {"from": 1160.0, "to": 1660.0, "rate": 0.175, "label": "17.5% on next GHS 500"},
    {"from": 1660.0, "to": 5000.0, "rate": 0.250, "label": "25% on next GHS 3,340"},
    {"from": 5000.0, "to": None,   "rate": 0.300, "label": "30% on income above GHS 5,000"},
]

_paye_env = os.getenv("PAYE_BANDS_JSON")
PAYE_BANDS_MONTHLY: list = _json.loads(_paye_env) if _paye_env else _PAYE_BANDS_DEFAULT
