import { createFileRoute } from "@tanstack/react-router";
import { library } from "../../../server/api.ts";

export const Route = createFileRoute("/api/library")({
  server: { handlers: { GET: ({ request }) => library(request) } },
});
