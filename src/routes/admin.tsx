import { createFileRoute } from "@tanstack/react-router";
import { AdminGate, App } from "../components/App";

export const Route = createFileRoute("/admin")({
  component: Admin,
  validateSearch: (search: Record<string, unknown>): { studio?: string } =>
    typeof search.studio === "string" && search.studio
      ? { studio: search.studio }
      : {},
});

function Admin() {
  const { app } = Route.useRouteContext();
  const { studio } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <App admin>
      {(notify) => (
        <AdminGate
          authConfigured={app.authConfigured}
          hasClerk={Boolean(app.clerkPublishableKey)}
          notify={notify}
          studio={studio}
          openStudio={(eventId) =>
            void navigate({ search: eventId ? { studio: eventId } : {} })
          }
        />
      )}
    </App>
  );
}
