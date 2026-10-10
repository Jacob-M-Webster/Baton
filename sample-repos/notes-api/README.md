# Notes API

A small WSGI service for team notes. No dependencies beyond the Python standard library.

```
python -m app.server        # serve on :8080
python -m unittest -v       # run the test suite
```

Middleware lives in `app/middleware/` and is composed in `app/server.py:build_app`.
