"""xAI Grok. The API speaks OpenAI Chat Completions, so this only adds model discovery."""
from __future__ import annotations

from .openai_provider import OpenAIProvider

XAI_BASE_URL = "https://api.x.ai/v1"
NOT_FOR_CHAT = ("image", "imagine", "video", "vision", "embed", "tts", "voice")


class XAIProvider(OpenAIProvider):
    def __init__(self, id: str, api_key: str | None, base_url: str | None = None,
                 models: list[str] | None = None, http_client=None):
        super().__init__(id, api_key, base_url or XAI_BASE_URL, models, http_client=http_client)
        self._discovered: list[str] | None = None

    async def list_models(self) -> list[str]:
        """The key's Grok chat models; the configured list until a key is set or if listing fails."""
        if not self.configured:
            return self._models
        if self._discovered is None:
            try:
                page = await self.client.with_options(timeout=5.0, max_retries=0).models.list()
                found = [m.id for m in page.data if m.id.startswith("grok") and not any(x in m.id for x in NOT_FOR_CHAT)]
                # Configured models first (they're the team's picks), then everything else, newest versions first.
                rest = sorted((n for n in found if n not in self._models), reverse=True)
                self._discovered = [m for m in self._models if m in found] + rest if found else []
            except Exception:
                self._discovered = []
        return self._discovered or self._models
