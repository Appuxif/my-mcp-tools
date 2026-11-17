"""HTTP Basic helpers for the administrator-only Agent Network dashboard tests."""
from __future__ import annotations

import base64
from pathlib import Path


def basic_headers(app) -> dict[str, str]:
    password = Path(app.state.admin_token_file).read_text().strip()
    credentials = base64.b64encode(("admin:" + password).encode("utf-8")).decode("ascii")
    return {"Authorization": "Basic " + credentials}
