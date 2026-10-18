import { createFileRoute } from "@tanstack/react-router";
import { owner } from "../../../../../server/api";

export const Route = createFileRoute("/api/admin/emby/shows")({
  server: { handlers: { GET: owner.embyShows } },
});
