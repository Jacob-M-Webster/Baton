import { useEffect, useState } from "react";
import { Check, ChevronDown, Cpu } from "lucide-react";
import clsx from "clsx";
import { create } from "zustand";
import { api } from "../lib/api";
import type { ProviderInfo } from "../lib/types";
import { modelLabel } from "../lib/format";
import { MenuItem, MenuLabel, Popover } from "./Menu";

const useProviders = create<{ list: ProviderInfo[]; loaded: boolean }>(() => ({ list: [], loaded: false }));

export function useModelCatalog() {
  const state = useProviders();
  useEffect(() => {
    if (!state.loaded) {
      api
        .models()
        .then((r) => useProviders.setState({ list: r.providers, loaded: true }))
        .catch(() => useProviders.setState({ loaded: true }));
    }
  }, [state.loaded]);
  return state.list;
}

const SETUP: Record<string, string> = {
  anthropic: "Set ANTHROPIC_API_KEY",
  openai: "Set OPENAI_API_KEY",
  gemini: "Set GEMINI_API_KEY",
  local: "Start Ollama or any OpenAI-compatible server",
};

export function ProviderGlyph({ provider, className }: { provider: string; className?: string }) {
  const letter =
    { anthropic: "A", openai: "O", gemini: "G", local: "L", demo: "D", external: "E" }[provider] ?? provider[0]?.toUpperCase();
  return (
    <span
      className={clsx(
        "grid size-[18px] shrink-0 place-items-center rounded-[5px] border border-line bg-sunken font-mono text-[10px] font-semibold text-ink-2",
        className,
      )}
    >
      {letter}
    </span>
  );
}

export function ModelPicker({
  provider,
  model,
  onChange,
  disabled,
  compact,
}: {
  provider: string;
  model: string;
  onChange: (provider: string, model: string) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const providers = useModelCatalog();
  const [custom, setCustom] = useState("");
  return (
    <Popover
      width={300}
      trigger={(open, toggle) => (
        <button
          type="button"
          disabled={disabled}
          onClick={toggle}
          title={disabled ? "Only the driver can switch models" : "Switch model"}
          className={clsx(
            "inline-flex items-center gap-2 rounded-lg border border-line bg-panel text-[13px] font-medium text-ink",
            compact ? "h-8 px-2" : "h-9 px-2.5",
            disabled ? "cursor-default" : "hover:bg-sunken",
            open && "bg-sunken",
          )}
        >
          <ProviderGlyph provider={provider} />
          <span className="max-w-[170px] truncate">{modelLabel(model)}</span>
          {!disabled && <ChevronDown className="size-3.5 text-ink-3" />}
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-[420px] overflow-y-auto">
          {providers.map((p) => (
            <div key={p.id}>
              <MenuLabel>
                <span className="flex items-center justify-between">
                  {p.label}
                  {!p.configured && <span className="font-normal tracking-normal normal-case">{SETUP[p.id] || "Not configured"}</span>}
                </span>
              </MenuLabel>
              {p.models.length === 0 && (
                <div className="px-2.5 pb-1.5 text-xs text-ink-4">{p.note || "No models found"}</div>
              )}
              {p.models.map((m) => (
                <MenuItem
                  key={m}
                  disabled={!p.configured}
                  active={p.id === provider && m === model}
                  onClick={() => {
                    onChange(p.id, m);
                    close();
                  }}
                  hint={p.id === provider && m === model ? <Check className="size-3.5" /> : undefined}
                >
                  <ProviderGlyph provider={p.id} />
                  <span className="truncate">{modelLabel(m)}</span>
                </MenuItem>
              ))}
              {p.id === "local" && p.configured && (
                <form
                  className="flex gap-1.5 px-2.5 py-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (custom.trim()) {
                      onChange("local", custom.trim());
                      close();
                    }
                  }}
                >
                  <input
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    placeholder="Other local model id"
                    className="h-7 min-w-0 flex-1 rounded-md border border-line bg-panel px-2 text-xs outline-none focus:border-ink-3"
                  />
                </form>
              )}
            </div>
          ))}
          <div className="mt-1 flex items-start gap-2 border-t border-line px-2.5 pt-2.5 pb-1.5 text-[11.5px] leading-snug text-ink-3">
            <Cpu className="mt-px size-3.5 shrink-0" />
            Switching mid-session is safe: the next turn rebuilds context from the shared log for the new model.
          </div>
        </div>
      )}
    </Popover>
  );
}
