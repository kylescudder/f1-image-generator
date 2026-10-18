import { createFileRoute } from "@tanstack/react-router";
import { owner } from "../../../../server/api.ts";

export const Route = createFileRoute("/api/admin/events")({
  server: { handlers: { GET: owner.events } },
});
