import path from "node:path";
import { closeConnection } from "./database.ts";
import { services } from "./services.ts";

const client = path.resolve("dist/client");
const built = Bun.file("dist/server/server.js");
if (!(await built.exists()))
  throw new Error("Build the app before starting production: bun run build.");
const app = (await import(path.resolve("dist/server/server.js"))).default as {
  fetch: (request: Request) => Response | Promise<Response>;
};
// Fail fast (and start the calendar schedule) if the database is not reachable.
const { jobs } = await services();

const revision = process.env.PADDOCK_REVISION || "development";
function secure(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // Release verification waits for this to match the deployed commit.
  headers.set("X-Paddock-Revision", revision);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
async function serve(request: Request) {
  const url = new URL(request.url);
  if (request.method === "GET" || request.method === "HEAD") {
    const file = path.join(client, path.normalize(decodeURIComponent(url.pathname)));
    if (file.startsWith(`${client}${path.sep}`)) {
      const asset = Bun.file(file);
      if (await asset.exists())
        return new Response(request.method === "HEAD" ? null : asset, {
          headers: {
            "Content-Type": asset.type,
            // Vite fingerprints everything under /assets.
            "Cache-Control": url.pathname.startsWith("/assets/")
              ? "public, max-age=31536000, immutable"
              : "public, max-age=3600",
          },
        });
    }
  }
  return app.fetch(request);
}
const server = Bun.serve({
  port: Number(process.env.PORT || 3000),
  hostname: "0.0.0.0",
  // Owner background uploads are base64 JSON of up to 28 MB.
  maxRequestBodySize: 30 * 1024 * 1024,
  fetch: async (request) => secure(await serve(request)),
});
console.log(`Paddock is ready at ${server.url}`);
process.once("SIGTERM", async () => {
  jobs.stop();
  await server.stop();
  await closeConnection();
  process.exit(0);
});
