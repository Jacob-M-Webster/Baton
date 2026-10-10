"""Model adapters. Each speaks the contract in base.py; pick one per session."""
from __future__ import annotations

from ..config import ProviderConfig, Settings
from .anthropic_provider import AnthropicProvider
from .openai_provider import OpenAIProvider
from .scripted import ScriptedProvider


def build_provider(p: ProviderConfig, settings: Settings):
    if p.kind == "anthropic":
        return AnthropicProvider(p.id, p.api_key, p.base_url, p.models)
    if p.kind == "openai":
        return OpenAIProvider(p.id, p.api_key, p.base_url, p.models, discover=p.discover_models)
    if p.kind == "scripted":
        return ScriptedProvider(p.id, speed=settings.demo_speed)
    raise ValueError(f"unknown provider kind: {p.kind}")
