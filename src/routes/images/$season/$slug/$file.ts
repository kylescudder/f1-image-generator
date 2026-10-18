import { createFileRoute } from "@tanstack/react-router";
import { image } from "../../../../../server/api.ts";

export const Route = createFileRoute("/images/$season/$slug/$file")({
  server: {
    handlers: { GET: ({ request, params }) => image(request, params) },
  },
});
