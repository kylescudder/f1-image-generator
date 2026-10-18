import { createFileRoute } from "@tanstack/react-router";
import { owner } from "../../../../../../../server/api.ts";

export const Route = createFileRoute(
  "/api/admin/emby/mappings/$eventId/$session",
)({
  server: { handlers: { DELETE: owner.deleteMapping } },
});
