import { createFileRoute } from "@tanstack/react-router";
import { AdminGate, App } from "../components/App";

export const Route = createFileRoute("/admin")({ component: Admin });

function Admin() {
  const { app } = Route.useRouteContext();
  return (
    <App admin>
      {(notify) => (
        <AdminGate
          authConfigured={app.authConfigured}
          hasClerk={Boolean(app.clerkPublishableKey)}
          notify={notify}
        />
      )}
    </App>
  );
}
