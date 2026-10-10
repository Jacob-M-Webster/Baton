"""Run the Baton server: python -m baton"""
import logging

import uvicorn

from .app import create_app
from .app import lan_urls
from .config import load_settings


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = load_settings()
    app = create_app(settings)
    print(f"\n  Baton is running on http://localhost:{settings.port}")
    for url in lan_urls(settings.port):
        print(f"  Teammates on your network can join at {url}")
    print()
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning", ws_ping_interval=20)


if __name__ == "__main__":
    main()
