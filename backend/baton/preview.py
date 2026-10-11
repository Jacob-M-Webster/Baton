"""Serve a session's workspace as a website, so people can see the frontend the agent is building.

Pages are served from /api/preview/<session>/<key>/<root>/..., where <root> is the folder holding the
site's index.html ("~" for the repository root, "web~dist" for web/dist). The key is an HMAC of the session
id under the access code: the preview frame can't send Baton's cookie (see below), so the key in the path is
what lets its pages, scripts and images through the access gate.

The workspace holds code written by an agent, or cloned from anywhere, so every response carries a CSP
sandbox: the page runs in an opaque origin and can't call Baton's API as the person looking at it.
"""
from __future__ import annotations

import hashlib
import hmac
import mimetypes
import re
from pathlib import Path

from starlette.responses import FileResponse, PlainTextResponse, RedirectResponse, Response

from .sandbox import ToolError, Workspace

PREFIX = "/api/preview/"
PATH = re.compile(r"^/api/preview/([^/]+)/([^/]+)(/|$)")

HEADERS = {
    "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
    # Module scripts and fonts are fetched with CORS, and the sandboxed page's origin is opaque.
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",  # the key is in the URL; don't hand it to CDNs the page loads from
}
TYPES = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
    ".svg": "image/svg+xml", ".wasm": "application/wasm", ".map": "application/json", ".webmanifest": "application/manifest+json",
}
# Root-relative URLs ("/assets/app.js") would leave the preview and hit Baton itself, so HTML and CSS get them
# pointed back inside it. Scripts that build such URLs at run time aren't rewritten (use a relative base).
HTML_ATTR = re.compile(r"""(\s(?:src|href|action|poster)\s*=\s*["'])/(?!/)""", re.I)
CSS_URL = re.compile(r"""(url\(\s*["']?)/(?!/)""", re.I)


def preview_key(session_id: str, access_code: str | None) -> str:
    secret = (access_code or "baton-preview").encode()
    return hmac.new(secret, f"preview:{session_id}".encode(), hashlib.sha256).hexdigest()[:24]


def key_ok(session_id: str, key: str, access_code: str | None) -> bool:
    return hmac.compare_digest(key, preview_key(session_id, access_code))


def root_segment(root: str) -> str:
    root = root.strip("/")
    return root.replace("/", "~") if root and root != "." else "~"


def root_dir(segment: str) -> str:
    return "" if segment == "~" else segment.replace("~", "/")


def rewrite(text: str, prefix: str, html: bool) -> str:
    if html:
        text = HTML_ATTR.sub(lambda m: m.group(1) + prefix + "/", text)
    return CSS_URL.sub(lambda m: m.group(1) + prefix + "/", text)


def serve(ws: Workspace, segment: str, path: str, prefix: str) -> Response:
    """One file of the site rooted at `segment`. Folders serve their index.html; an unknown path without a file
    extension serves the site's index.html, so client-side routes work."""
    root = root_dir(segment)
    try:
        base = ws.resolve(root)
        target = ws.resolve(f"{root}/{path}" if root else path or ".")
    except ToolError:
        return PlainTextResponse("Not found", status_code=404, headers=HEADERS)
    if target.is_dir():
        if path and not path.endswith("/"):
            return RedirectResponse(f"{prefix}/{path}/", status_code=307, headers=HEADERS)
        target = target / "index.html"
    if not target.is_file() and "." not in Path(path).name:
        target = base / "index.html"
    if not target.is_file():
        return PlainTextResponse("Not found in the workspace", status_code=404, headers=HEADERS)

    suffix = target.suffix.lower()
    ctype = TYPES.get(suffix) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    if suffix in (".html", ".htm", ".css"):
        text = rewrite(target.read_text(encoding="utf-8", errors="replace"), prefix, html=suffix != ".css")
        return Response(text, media_type=ctype, headers=HEADERS)
    return FileResponse(target, media_type=ctype, headers=HEADERS)
