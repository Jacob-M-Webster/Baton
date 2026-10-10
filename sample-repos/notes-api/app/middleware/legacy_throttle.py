"""Request throttle used by the v1 batch endpoints."""
import threading
import time


class LegacyThrottle:
    """Caps total requests per second across the whole service."""

    def __init__(self, app, max_per_second=50):
        self.app = app
        self.max_per_second = max_per_second
        self._lock = threading.Lock()
        self._window = int(time.time())
        self._count = 0

    def __call__(self, environ, start_response):
        with self._lock:
            now = int(time.time())
            if now != self._window:
                self._window, self._count = now, 0
            self._count += 1
            over = self._count > self.max_per_second
        if over:
            time.sleep(1)  # back-pressure: hold the worker until the next window
        return self.app(environ, start_response)
