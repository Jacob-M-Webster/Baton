"""Call a WSGI app in-process and decode the JSON response."""
import io
import json


def call(app, method, path, body=None, headers=None):
    payload = json.dumps(body).encode() if body is not None else b""
    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "CONTENT_LENGTH": str(len(payload)),
        "wsgi.input": io.BytesIO(payload),
        "REMOTE_ADDR": "127.0.0.1",
    }
    environ.update(headers or {})
    captured = {}

    def start_response(status, response_headers, exc_info=None):
        captured["status"] = status
        captured["headers"] = dict(response_headers)

    raw = b"".join(app(environ, start_response))
    return int(captured["status"].split()[0]), captured["headers"], json.loads(raw or b"null")
