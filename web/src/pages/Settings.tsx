import { useEffect, useState } from "react";
import clsx from "clsx";
import { Check, KeyRound, Lock, ShieldAlert } from "lucide-react";
import { api } from "../lib/api";
import type { KeyInfo, KeySettings } from "../lib/types";
import { Button } from "../components/Button";
import { ProviderGlyph, refreshModelCatalog } from "../components/ModelPicker";
import { toast } from "../components/Toasts";

const ADMIN = "baton:admin-code"; // kept for this tab only, so it isn't typed again for every key

function storedAdmin(): string {
  try {
    return sessionStorage.getItem(ADMIN) || "";
  } catch {
    return "";
  }
}

const HELP: Record<string, string> = {
  ANTHROPIC_API_KEY: "Claude models. console.anthropic.com → API keys.",
  OPENAI_API_KEY: "GPT models. platform.openai.com → API keys.",
  GEMINI_API_KEY: "Gemini models. aistudio.google.com → Get API key.",
  GITHUB_TOKEN: "For private repositories. A fine-grained token with read access to contents.",
};

export function SettingsPage() {
  const [data, setData] = useState<KeySettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [admin, setAdmin] = useState(storedAdmin);

  useEffect(() => {
    api.settings().then(setData).catch(() => setFailed(true));
  }, []);

  const save = async (values: Record<string, string | null>) => {
    const r = await api.saveKeys(values, admin);
    try {
      if (admin) sessionStorage.setItem(ADMIN, admin);
    } catch {
      /* private window */
    }
    setData(r);
    refreshModelCatalog();
  };

  const locked = data?.mode === "locked";
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-4 pt-[10vh] pb-20 sm:px-6 md:px-10">
        <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.015em]">API keys</h1>
        <p className="mt-1 text-[13.5px] text-ink-3">Shared by every session on this server. Saved keys show only their last four characters.</p>

        {failed && <p className="mt-10 text-sm text-danger">Couldn't load settings.</p>}
        {!data && !failed && <div className="mt-10 h-64 animate-pulse rounded-xl bg-sunken" />}

        {data && locked && (
          <div className="mt-6 flex gap-3 rounded-lg border border-attn/30 bg-attn-soft px-4 py-3 text-[13px] leading-relaxed text-ink-2">
            <Lock className="mt-0.5 size-4 shrink-0 text-attn" />
            <p>
              Keys are locked on this server. Set them in <code className="font-mono text-[12px]">server.env</code>, or set{" "}
              <code className="font-mono text-[12px]">BATON_ADMIN_CODE</code> to edit them here.
            </p>
          </div>
        )}

        {data?.mode === "code" && (
          <label className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3">
            <ShieldAlert className="size-4 shrink-0 text-ink-3" />
            <span className="text-[13px] text-ink-2">Admin code</span>
            <input
              type="password"
              value={admin}
              onChange={(e) => setAdmin(e.target.value)}
              autoComplete="off"
              placeholder="Needed to change keys"
              className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2.5 text-base outline-none focus:border-ink-3 sm:text-[13px]"
            />
          </label>
        )}

        {data && (
          <div className="mt-6 overflow-hidden rounded-lg border border-line bg-panel">
            {data.keys.map((k, i) => (
              <KeyRow key={k.name} info={k} first={i === 0} disabled={locked || (data.mode === "code" && !admin.trim())} save={save} />
            ))}
          </div>
        )}

        {data && (
          <p className="mt-4 text-xs leading-relaxed text-ink-4">
            Stored in <code className="font-mono">data/keys.json</code>, overriding the environment. Remove a key to fall back to it.
          </p>
        )}
      </div>
    </div>
  );
}

function KeyRow({
  info,
  first,
  disabled,
  save,
}: {
  info: KeyInfo;
  first: boolean;
  disabled: boolean;
  save: (values: Record<string, string | null>) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (v: string | null) => {
    setBusy(true);
    try {
      await save({ [info.name]: v });
      setValue("");
      toast(v ? `${info.label} key saved` : `${info.label} key removed`, "info");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={clsx("px-4 py-4 sm:px-5", !first && "border-t border-line")}
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) run(value.trim());
      }}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {info.provider ? (
          <ProviderGlyph provider={info.provider} className="size-5 text-[10px]" />
        ) : (
          <span className="grid size-5 place-items-center rounded bg-sunken text-ink-3">
            <KeyRound className="size-3" />
          </span>
        )}
        <span className="text-[13.5px] font-medium text-ink">{info.label}</span>
        <code className="font-mono text-[11.5px] text-ink-4">{info.name}</code>
        <span className="ml-auto text-xs">
          {info.set ? (
            <span className="inline-flex items-center gap-1 text-live">
              <Check className="size-3.5" />
              {info.hint ? <span className="font-mono">{info.hint}</span> : "Set"}
              <span className="text-ink-4">· {info.source === "saved" ? "saved here" : "from environment"}</span>
            </span>
          ) : (
            <span className="text-ink-4">Not set</span>
          )}
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-4">{HELP[info.name]}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled || busy}
          autoComplete="off"
          spellCheck={false}
          aria-label={`New ${info.label} key`}
          placeholder={info.set ? "Paste a new key to replace it" : "Paste a key"}
          className="h-8 min-w-[200px] flex-1 rounded-lg border border-line bg-canvas px-2.5 font-mono text-base outline-none placeholder:font-sans focus:border-ink-3 disabled:opacity-50 sm:text-[12.5px]"
        />
        <Button type="submit" variant="primary" disabled={disabled || busy || !value.trim()}>
          Save
        </Button>
        {info.source === "saved" && (
          <Button type="button" variant="ghost" disabled={disabled || busy} onClick={() => run(null)}>
            Remove
          </Button>
        )}
      </div>
    </form>
  );
}
