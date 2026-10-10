import { useEffect } from "react";
import { Route, Switch } from "wouter";
import { useIdentity } from "./lib/identity";
import { IdentityModal } from "./components/IdentityModal";
import { Toasts } from "./components/Toasts";
import { Home } from "./pages/Home";
import { SessionPage } from "./pages/SessionPage";
import { Sidebar } from "./components/Sidebar";

export function App() {
  const { user, ready, sync } = useIdentity();
  useEffect(() => {
    sync();
  }, [sync]);
  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {ready && user && (
          <Switch>
            <Route path="/s/:id">{(p) => <SessionPage key={p.id} id={p.id} />}</Route>
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
