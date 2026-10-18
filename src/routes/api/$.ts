import { createFileRoute } from "@tanstack/react-router";

const notFound = () =>
  Response.json({ error: "Endpoint not found." }, { status: 404 });

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: notFound,
      POST: notFound,
      PUT: notFound,
      DELETE: notFound,
    },
  },
});
