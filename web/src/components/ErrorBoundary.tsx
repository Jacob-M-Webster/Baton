import { Component, type ReactNode } from "react";

/** Keeps a rendering bug in one view from blanking the whole app during a live session. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Baton view crashed:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid flex-1 place-items-center p-6">
        <div className="max-w-sm rounded-2xl border border-line bg-panel p-6 text-center">
          <p className="text-[15px] font-semibold">This view hit a snag</p>
          <p className="mt-1.5 text-[13px] text-ink-3">The session is still running on the server. Reload to pick it back up.</p>
          {/* Shown so whoever hits it can report what broke; the full stack is in the browser console. */}
          <p className="mt-3 rounded-lg bg-sunken px-2.5 py-2 text-left font-mono text-[11.5px] break-words text-ink-2 select-all">
            {this.state.error.name}: {this.state.error.message}
          </p>
          <button
            onClick={() => location.reload()}
            className="mt-4 h-8 rounded-lg bg-ink px-3 text-[13px] font-medium text-canvas hover:bg-ink/88"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
