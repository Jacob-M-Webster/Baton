import { useEffect } from "react";
import { Route, Switch, useLocation } from "wouter";
import { useIdentity } from "./lib/identity";
import { useAccess } from "./lib/access";
import { AccessGate } from "./components/AccessGate";
import { IdentityModal } from "./components/IdentityModal";
import { Toasts } from "./components/Toasts";
import { Home } from "./pages/Home";
import { SessionPage } from "./pages/SessionPage";
import { Sidebar } from "./components/Sidebar";
import { Pitch } from "./pages/Pitch";
import { Insights } from "./pages/Insights";
import { SettingsPage } from "./pages/Settings";
import { ErrorBoundary } from "./components/ErrorBoundary";

export function App() {
  const { user, ready, sync } = useIdentity();
  const access = useAccess();
  const [loc] = useLocation();
  useEffect(() => {
    access.check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (access.ok) sync();
  }, [sync, access.ok]);
  if (!access.checked) return null;
  if (access.required && !access.ok) return <AccessGate />;
  if (loc === "/pitch") return <Pitch />;
  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {ready && user && (
          <Switch>
            <Route path="/s/:id">
              {(p) => (
                <ErrorBoundary key={p.id}>
                  <SessionPage id={p.id} />
                </ErrorBoundary>
              )}
            </Route>
            <Route path="/insights">
              <Insights />
            </Route>
            <Route path="/settings">
              <SettingsPage />
            </Route>
            <Route>
              <Home />
            </Route>
          </Switch>
        )}
      </main>
      {ready && !user && <IdentityModal />}
      <Toasts />
    </div>
  );
}
