import { createFileRoute } from "@tanstack/react-router";
import { studio } from "../../../../../../server/studio.ts";

export const Route = createFileRoute("/api/admin/studio/$eventId/draft")({
  server: { handlers: { PUT: studio.saveDraft, DELETE: studio.discardDraft } },
});
