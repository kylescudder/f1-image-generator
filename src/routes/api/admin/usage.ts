import { createFileRoute } from "@tanstack/react-router";
import { owner } from "../../../../server/api.ts";

export const Route = createFileRoute("/api/admin/usage")({
  server: { handlers: { GET: owner.usage } },
});
