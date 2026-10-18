import { createFileRoute } from "@tanstack/react-router";
import { studio } from "../../../../../../server/studio.ts";

export const Route = createFileRoute("/api/admin/studio/$eventId/upload")({
  server: { handlers: { POST: studio.upload } },
});
