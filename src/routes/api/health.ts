import { createFileRoute } from "@tanstack/react-router";
import { health } from "../../../server/api.ts";

export const Route = createFileRoute("/api/health")({
  server: { handlers: { GET: () => health() } },
});
