# ADR 0007: Retire LegacyThrottle

Status: accepted

`app/middleware/legacy_throttle.py` keeps one global counter behind one lock and
sleeps the worker when the limit is hit. A single noisy client slows down every
other client, and blocked workers pile up under load.

Decision: no new code may depend on `LegacyThrottle`. New limits must be
per-client, reject with `429 Too Many Requests` and a `Retry-After` header, and
never block a worker. The v1 batch endpoints migrate off it in Q3.
