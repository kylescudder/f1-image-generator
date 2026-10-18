import { createFileRoute } from "@tanstack/react-router";
import { owner } from "../../../../../server/api.ts";

export const Route = createFileRoute("/api/admin/emby/sync")({
  server: { handlers: { POST: owner.embySync } },
});
