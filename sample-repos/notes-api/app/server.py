"""Notes API: a tiny WSGI service.

Run locally with `python -m app.server` and open http://localhost:8080/notes
"""
import json
from wsgiref.simple_server import make_server

from app.middleware.logging import RequestLogger
from app.store import NoteStore

store = NoteStore()


def json_response(start_response, status, body, headers=None):
    payload = json.dumps(body).encode()
    start_response(
        status,
        [("Content-Type", "application/json"), ("Content-Length", str(len(payload)))] + (headers or []),
    )
    return [payload]


def notes_app(environ, start_response):
    method = environ["REQUEST_METHOD"]
    path = environ.get("PATH_INFO", "/")
    if path == "/health":
        return json_response(start_response, "200 OK", {"ok": True})
    if path == "/notes" and method == "GET":
        return json_response(start_response, "200 OK", {"notes": store.all()})
    if path == "/notes" and method == "POST":
        length = int(environ.get("CONTENT_LENGTH") or 0)
        data = json.loads(environ["wsgi.input"].read(length) or b"{}")
        if not data.get("text"):
            return json_response(start_response, "400 Bad Request", {"error": "text is required"})
        return json_response(start_response, "201 Created", store.add(data["text"]))
    return json_response(start_response, "404 Not Found", {"error": "not found"})


def build_app():
    """Wrap the core app in middleware. The last wrapper added runs first."""
    app = notes_app
    app = RequestLogger(app)
    return app


app = build_app()

if __name__ == "__main__":
    with make_server("", 8080, app) as httpd:
        print("Serving on http://localhost:8080")
        httpd.serve_forever()
