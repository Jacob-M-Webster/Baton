import { useEffect, useState } from "react";
import { Link } from "wouter";
import QRCode from "qrcode";
import clsx from "clsx";
import { Check, Copy, GitFork, Link2, Play, Sparkles, Square } from "lucide-react";
import type { Participant, Session } from "../lib/types";
import { api } from "../lib/api";
import { Avatar } from "../components/Avatar";
import { BatonMark } from "../components/Logo";
import { Button, Kbd } from "../components/Button";
import { ModelPicker } from "../components/ModelPicker";
import { MenuItem, MenuLabel, Popover } from "../components/Menu";
import { StatusPill } from "../components/StatusPill";

export function SessionHeader({
  session,
  participants,
  me,
  hasDecision,
  send,
  onCatchUp,
  conn,
}: {
  session: Session;
  participants: Participant[];
  me: string;
  hasDecision: boolean;
  send: (m: Record<string, unknown>) => boolean;
  onCatchUp: () => void;
  conn: string;
}) {
  const isDriver = session.driver_id === me;
  const driver = participants.find((p) => p.user_id === session.driver_id);
  const mine = participants.find((p) => p.user_id === me);
  const others = participants.filter((p) => p.user_id !== session.driver_id && p.role !== "viewer");
  const canTake = !isDriver && mine?.role !== "viewer" && (!driver?.online || mine?.is_owner);

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 sm:gap-3 sm:px-4">
      <div className="flex min-w-[96px] flex-1 items-center gap-2.5">
        <Link href="/" className="hidden text-[13px] text-ink-4 hover:text-ink-2 lg:inline">
          Sessions
        </Link>
        <span className="hidden text-ink-4 lg:inline">/</span>
        <h1 className="min-w-0 truncate text-[13.5px] font-semibold text-ink">{session.title}</h1>
        {session.parent_session_id && (
          <Link
            href={`/s/${session.parent_session_id}`}
            className="hidden shrink-0 items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-3 hover:text-ink sm:inline-flex"
          >
            <GitFork className="size-3" /> fork @{session.fork_seq}
          </Link>
        )}
        <StatusPill status={session.status} decision={hasDecision} />
        {conn !== "open" && (
          <span className="text-xs text-attn">{conn === "reconnecting" ? "Reconnecting…" : "Connecting…"}</span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        <div className="hidden md:block">
        <ModelPicker
          compact
          provider={session.provider}
          model={session.model}
          disabled={!isDriver}
          onChange={(provider, model) => send({ type: "set_model", provider, model })}
        />
        </div>

        <Presence participants={participants} driverId={session.driver_id} />

        <Button variant="ghost" onClick={onCatchUp} title="What happened while you were away">
          <Sparkles className="size-3.5" />
          <span className="hidden xl:inline">Catch up</span>
        </Button>

        <div className="hidden sm:block">
          <ShareButton sessionId={session.id} />
        </div>

        {isDriver ? (
          <Popover
            width={260}
            trigger={(_, toggle) => (
              <Button onClick={toggle} className="border-baton/40" aria-label="Hand off">
                <BatonMark className="size-3.5" />
                <span className="hidden sm:inline">Hand off</span>
              </Button>
            )}
          >
            {(close) => (
              <>
                <MenuLabel>Pass the baton to</MenuLabel>
                {others.length === 0 && <p className="px-2.5 pb-2 text-xs text-ink-4">Share the link. Collaborators who join show up here.</p>}
                {others.map((p) => (
                  <MenuItem
                    key={p.user_id}
                    onClick={() => {
                      send({ type: "grant_driver", to: p.user_id });
                      close();
                    }}
                    hint={p.online ? "online" : "away"}
                  >
                    <Avatar name={p.name} color={p.color} size={20} online={p.online} />
                    <span className="truncate">{p.name}</span>
                  </MenuItem>
                ))}
              </>
            )}
          </Popover>
        ) : canTake ? (
          <Button onClick={() => send({ type: "take_driver" })} title={driver?.online ? "You own this session" : `${driver?.name || "The driver"} is away`}>
            <BatonMark className="size-3.5" />
            <span className="hidden sm:inline">Take the baton</span>
            <span className="sm:hidden">Take</span>
          </Button>
        ) : mine?.role !== "viewer" ? (
          <Button onClick={() => send({ type: "request_driver" })}>
            <BatonMark className="size-3.5" />
            <span className="hidden sm:inline">Ask for the baton</span>
            <span className="sm:hidden">Ask</span>
          </Button>
        ) : null}

        {isDriver && session.status === "running" && (
          <Button variant="danger" onClick={() => send({ type: "interrupt" })} title="Stop the agent (Esc)">
            <Square className="size-3 fill-current" />
            <span className="hidden sm:inline">Interrupt</span>
            <span className="hidden lg:inline">
              <Kbd>Esc</Kbd>
            </span>
          </Button>
        )}
        {isDriver && (session.status === "waiting_input" || session.status === "error") && !hasDecision && (
          <Button onClick={() => send({ type: "resume" })} title="Let the agent continue">
            <Play className="size-3 fill-current" />
            <span className="hidden sm:inline">Resume</span>
          </Button>
        )}
      </div>
    </header>
  );
}

function Presence({ participants, driverId }: { participants: Participant[]; driverId: string | null }) {
  const sorted = [...participants].sort((a, b) => Number(b.online) - Number(a.online) || Number(b.user_id === driverId) - Number(a.user_id === driverId));
  return (
    <Popover
      width={260}
      trigger={(_, toggle) => (
        <button onClick={toggle} className="flex items-center -space-x-1.5 rounded-full px-1 py-1 hover:bg-sunken" aria-label="People in this session">
          {sorted.slice(0, 4).map((p) => (
            <Avatar
              key={p.user_id}
              name={p.name}
              color={p.color}
              size={26}
              driver={p.user_id === driverId}
              className={clsx(!p.online && "opacity-45")}
            />
          ))}
          {sorted.length > 4 && <span className="grid size-[26px] place-items-center rounded-full bg-sunken text-[10px] font-medium ring-2 ring-panel">+{sorted.length - 4}</span>}
        </button>
      )}
    >
      {() => (
        <>
          <MenuLabel>In this session</MenuLabel>
          {sorted.map((p) => (
            <div key={p.user_id} className="flex items-center gap-2.5 px-2.5 py-1.5 text-[13px]">
              <Avatar name={p.name} color={p.color} size={22} online={p.online} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="text-xs text-ink-4">
                {p.user_id === driverId ? (
                  <span className="inline-flex items-center gap-1 font-medium text-baton">
                    <BatonMark className="size-3" /> driving
                  </span>
                ) : (
                  p.role
                )}
              </span>
            </div>
          ))}
        </>
      )}
    </Popover>
  );
}

function ShareButton({ sessionId }: { sessionId: string }) {
  const [url, setUrl] = useState(`${location.origin}/s/${sessionId}`);
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    // Prefer the LAN address so a teammate's laptop or phone can open it.
    api
      .info()
      .then((i) => {
        if ((location.hostname === "localhost" || location.hostname === "127.0.0.1") && i.lan_urls[0]) {
          const lan = new URL(i.lan_urls[0]);
          lan.port = location.port;
          setUrl(`${lan.origin}/s/${sessionId}`);
        }
      })
      .catch(() => {});
  }, [sessionId]);
  useEffect(() => {
    const dark = document.documentElement.classList.contains("dark");
    QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: dark ? "#ececef" : "#17171a", light: "#00000000" } })
      .then(setQr)
      .catch(() => {});
  }, [url]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* clipboard blocked on http; the URL is visible to copy by hand */
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <Popover
      width={300}
      trigger={(_, toggle) => (
        <Button variant="primary" onClick={toggle}>
          <Link2 className="size-3.5" />
          Share
        </Button>
      )}
    >
      {() => (
        <div className="p-2">
          <p className="text-[13px] font-semibold">Invite to this session</p>
          <p className="mt-0.5 text-xs text-ink-3">Anyone with the link joins as a collaborator and sees a catch-up of everything so far.</p>
          {qr && <img src={qr} alt="QR code for the session link" className="mx-auto my-3 size-40" />}
          <div className="flex items-center gap-1.5 rounded-lg border border-line bg-sunken p-1 pl-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">{url}</span>
            <Button size="sm" onClick={copy}>
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}
