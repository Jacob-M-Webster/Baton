"""Access logging."""
import logging
import time

log = logging.getLogger("notes.access")


class RequestLogger:
    def __init__(self, app, logger=log):
        self.app = app
        self.logger = logger

    def __call__(self, environ, start_response):
        started = time.monotonic()
        seen = {}

        def _start_response(status, headers, exc_info=None):
            seen["status"] = status
            return start_response(status, headers, exc_info)

        result = self.app(environ, _start_response)
        self.logger.info(
            "%s %s %s %.1fms",
            environ["REQUEST_METHOD"],
            environ.get("PATH_INFO", "/"),
            seen.get("status", "-"),
            (time.monotonic() - started) * 1000,
        )
        return result
