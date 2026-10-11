"""API keys and the GitHub token, changeable from the Settings page.

Keys saved from the page live in data/keys.json and win over the environment; clearing one there falls
back to the environment again. Keys are write-only over the API: the page sees whether one is set and
its last four characters, never the key.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from .config import Settings

# (setting name, provider id or None for the GitHub token, label)
KEYS: list[tuple[str, str | None, str]] = [
    ("ANTHROPIC_API_KEY", "anthropic", "Anthropic"),
    ("OPENAI_API_KEY", "openai", "OpenAI"),
    ("GEMINI_API_KEY", "gemini", "Google Gemini"),
    ("GITHUB_TOKEN", None, "GitHub"),
]
MAX_KEY_CHARS = 500


class KeyStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.path = settings.data_dir / "keys.json"
        self.env = {name: self.current(name) for name, _, _ in KEYS}  # what the environment set, before overrides
        self.saved: dict[str, str] = {}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            self.saved = {k: v for k, v in data.items() if k in self.env and isinstance(v, str) and v}
        except (OSError, ValueError, AttributeError):
            pass
        for name, value in self.saved.items():
            self._apply(name, value)

    def current(self, name: str) -> str | None:
        pid = _provider_of(name)
        if pid is None:
            return self.settings.github_token
        p = self.settings.provider(pid)
        return p.api_key if p else None

    def view(self) -> list[dict]:
        out = []
        for name, pid, label in KEYS:
            value = self.current(name)
            out.append({
                "name": name, "label": label, "provider": pid, "set": bool(value),
                "source": "saved" if name in self.saved else ("env" if value else None),
                "hint": f"…{value[-4:]}" if value and len(value) >= 12 else None,
            })
        return out

    def update(self, values: dict[str, str | None]) -> list[str]:
        """Save (a string) or clear (None or "") keys. Returns the provider ids whose key changed."""
        for name, value in values.items():
            if name not in self.env:
                raise ValueError(f"Unknown key: {name}")
            if value and (len(value) > MAX_KEY_CHARS or any(c.isspace() for c in value.strip())):
                raise ValueError(f"That doesn't look like a valid {name}")
        changed = []
        for name, value in values.items():
            value = (value or "").strip()
            if value:
                self.saved[name] = value
            else:
                self.saved.pop(name, None)
            self._apply(name, value or self.env[name])
            pid = _provider_of(name)
            if pid:
                changed.append(pid)
        self._write()
        return changed

    def _apply(self, name: str, value: str | None) -> None:
        pid = _provider_of(name)
        if pid is None:
            self.settings.github_token = value or None
            return
        p = self.settings.provider(pid)
        if p:
            p.api_key = value or None

    def _write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        # Readable by the server's user only (Windows ignores the mode; data/ sits in the user's profile).
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(self.saved, f, indent=2)
        os.replace(tmp, self.path)


def _provider_of(name: str) -> str | None:
    return next(pid for n, pid, _ in KEYS if n == name)
