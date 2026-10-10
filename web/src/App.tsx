import { useEffect } from "react";
import { Route, Switch, useLocation } from "wouter";
import { useIdentity } from "./lib/identity";
import { IdentityModal } from "./components/IdentityModal";
import { Toasts } from "./components/Toasts";
import { Home } from "./pages/Home";
import { SessionPage } from "./pages/SessionPage";
import { Sidebar } from "./components/Sidebar";
import { Pitch } from "./pages/Pitch";
import { ErrorBoundary } from "./components/ErrorBoundary";

export function App() {
  const { user, ready, sync } = useIdentity();
  const [loc] = useLocation();
  useEffect(() => {
    sync();
  }, [sync]);
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
