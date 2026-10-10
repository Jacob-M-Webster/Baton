"""Runtime configuration, read from environment variables (and an optional .env file)."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _csv(name: str, default: str) -> list[str]:
    return [m.strip() for m in os.environ.get(name, default).split(",") if m.strip()]


@dataclass
class ProviderConfig:
    """One model endpoint. `kind` selects the wire protocol, not the vendor."""

    id: str
    label: str
    kind: str  # "anthropic" | "openai" | "scripted"
    models: list[str]
    api_key: str | None = None
    base_url: str | None = None
    summary_model: str | None = None
    context_window: int = 200_000
    max_output_tokens: int = 16_000
    discover_models: bool = False  # ask the endpoint's /models for its list
    note: str = ""


@dataclass
class Settings:
    data_dir: Path
    host: str
    port: int
    demo_speed: float
    sandbox: str
    sandbox_image: str
    driver_idle_seconds: int
    checkpoint_every_turns: int
    keep_recent_turns: int
    slack_webhook: str | None
    providers: list[ProviderConfig] = field(default_factory=list)

    def provider(self, pid: str) -> ProviderConfig | None:
        return next((p for p in self.providers if p.id == pid), None)


def load_settings(**overrides) -> Settings:
    _load_dotenv()
    providers: list[ProviderConfig] = [
        ProviderConfig(
            id="anthropic",
            label="Anthropic",
            kind="anthropic",
            models=_csv("ANTHROPIC_MODELS", "claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5"),
            api_key=os.environ.get("ANTHROPIC_API_KEY"),
            base_url=os.environ.get("ANTHROPIC_BASE_URL"),
            summary_model=os.environ.get("ANTHROPIC_SUMMARY_MODEL", "claude-haiku-5-5"),
            context_window=int(os.environ.get("ANTHROPIC_CONTEXT_WINDOW", "200000")),
        ),
        ProviderConfig(
            id="openai",
            label="OpenAI",
            kind="openai",
            models=_csv("OPENAI_MODELS", "gpt-5,gpt-5-mini"),
            api_key=os.environ.get("OPENAI_API_KEY"),
            base_url=os.environ.get("OPENAI_BASE_URL"),
            summary_model=os.environ.get("OPENAI_SUMMARY_MODEL", "gpt-5-mini"),
            context_window=int(os.environ.get("OPENAI_CONTEXT_WINDOW", "128000")),
        ),
        ProviderConfig(
            id="local",
            label="Local",
            kind="openai",
            models=_csv("LOCAL_MODELS", ""),
            api_key=os.environ.get("LOCAL_API_KEY", "local"),
            base_url=os.environ.get("LOCAL_BASE_URL", "http://localhost:11434/v1"),
            summary_model=os.environ.get("LOCAL_SUMMARY_MODEL") or None,
            context_window=int(os.environ.get("LOCAL_CONTEXT_WINDOW", "32768")),
            max_output_tokens=int(os.environ.get("LOCAL_MAX_OUTPUT_TOKENS", "4096")),
            discover_models=True,
            note="Any OpenAI-compatible server: Ollama, vLLM, LM Studio, llama.cpp",
        ),
    ]
    # Extra OpenAI- or Anthropic-compatible endpoints (OpenRouter, Groq, Bedrock gateways...).
    extra = os.environ.get("BATON_PROVIDERS_FILE", str(ROOT / "providers.json"))
    if Path(extra).exists():
        for p in json.loads(Path(extra).read_text()):
            providers.append(
                ProviderConfig(
                    id=p["id"],
                    label=p.get("label", p["id"]),
                    kind=p.get("kind", "openai"),
                    models=p.get("models", []),
                    api_key=os.environ.get(p.get("api_key_env", ""), p.get("api_key")),
                    base_url=p.get("base_url"),
                    summary_model=p.get("summary_model"),
                    context_window=int(p.get("context_window", 128000)),
                    discover_models=bool(p.get("discover_models", not p.get("models"))),
                )
            )
    providers.append(
        ProviderConfig(
            id="demo",
            label="Offline demo",
            kind="scripted",
            models=["baton-demo"],
            context_window=200_000,
            note="Scripted agent for rehearsals and offline demos; runs real tools against the sample repo",
        )
    )
    s = Settings(
        data_dir=Path(os.environ.get("BATON_DATA_DIR", ROOT / "data")),
        host=os.environ.get("BATON_HOST", "0.0.0.0"),
        port=int(os.environ.get("BATON_PORT", "8000")),
        demo_speed=float(os.environ.get("BATON_DEMO_SPEED", "1.0")),
        sandbox=os.environ.get("BATON_SANDBOX", "local"),
        sandbox_image=os.environ.get("BATON_SANDBOX_IMAGE", "python:3.12-slim"),
        driver_idle_seconds=int(os.environ.get("BATON_DRIVER_IDLE_SECONDS", "120")),
        checkpoint_every_turns=int(os.environ.get("BATON_CHECKPOINT_EVERY", "10")),
        keep_recent_turns=int(os.environ.get("BATON_KEEP_RECENT_TURNS", "6")),
        slack_webhook=os.environ.get("SLACK_WEBHOOK_URL") or None,
        providers=providers,
    )
    for k, v in overrides.items():
        setattr(s, k, v)
    return s
