import path from "node:path";
import { cp, mkdir } from "node:fs/promises";
import { SQL } from "bun";
import { mergeConfig, defineConfig } from "vite";
import base from "../vite.config.ts";
import { migrate } from "../server/schema.ts";
import { Store } from "../server/db.ts";
import { seedCalendars } from "../server/calendar.ts";
import { Artwork } from "../server/artwork.ts";
import { OpenRouter } from "../server/openrouter.ts";
import { Emby } from "../server/emby.ts";
import { Jobs } from "../server/jobs.ts";
import { config } from "../server/config.ts";
import { useServices } from "../server/services.ts";
import { guardOverrides } from "../server/guard.ts";
import { owner, library, health } from "../server/api.ts";
import { studio } from "../server/studio.ts";
import sharp from "sharp";

// Never use the developer's application database or real integration credentials.
const databaseUrl =
  process.env.E2E_DATABASE_URL ||
  "postgres://postgres:paddock@127.0.0.1:55432/paddock_e2e_test";
if (!new URL(databaseUrl).pathname.endsWith("_e2e_test"))
  throw new Error("E2E_DATABASE_URL must end in _e2e_test");
const sql = new SQL(databaseUrl);
await migrate(sql);
await sql`TRUNCATE state, events, backgrounds, jobs, attempts, mappings, overlays, studio_versions, studio_drafts`;
const store = await new Store(sql).open();
await seedCalendars(store, process.cwd());
await store.set("settings", {
  ...(await store.settings()),
  autoGenerate: false,
  modelId: "fixture/image",
});
// The fake provider paints flat colours: the first request teal, then pink.
const paints = [
  { r: 20, g: 120, b: 120 },
  { r: 230, g: 80, b: 170 },
];
const painted = (background: { r: number; g: number; b: number }) =>
  sharp({ create: { width: 1920, height: 1080, channels: 3, background } })
    .png()
    .toBuffer();
await mkdir(".local/emby-selection/data", { recursive: true });
await cp("data/fonts", ".local/emby-selection/data/fonts", { recursive: true });
const artwork = new Artwork(
  store,
  process.cwd(),
  path.resolve(".local/emby-selection/data"),
);
const router = new OpenRouter(
  store,
  "fixture-key",
  "http://localhost:4318",
  (async (input, init) => {
    if (String(input).endsWith("/endpoints"))
      return Response.json({
        endpoints: [{ provider_tag: "fixture", supported_parameters: {} }],
      });
    if (init?.method === "POST")
      return Response.json({
        data: [
          {
            b64_json: (
              await painted(paints.shift() ?? { r: 90, g: 90, b: 90 })
            ).toString("base64"),
            media_type: "image/png",
          },
        ],
      });
    return Response.json({
      data: [
        {
          id: "fixture/image",
          name: "Fixture image model",
          architecture: {
            input_modalities: ["text", "image"],
            output_modalities: ["image"],
          },
          supported_parameters: {},
        },
      ],
    });
  }) as typeof fetch,
);
const emby = new Emby(
  store,
  artwork,
  "http://emby.fixture.invalid",
  "fixture-token",
  (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/Library/VirtualFolders"))
      return Response.json({
        Items: [
          { ItemId: "tv", Name: "TV shows", CollectionType: "tvshows" },
          { ItemId: "sports", Name: "Sports", CollectionType: "tvshows" },
        ],
      });
    const parent = url.searchParams.get("ParentId");
    if (url.searchParams.get("IncludeItemTypes") === "Series")
      return Response.json({
        Items:
          parent === "tv"
            ? [
                { Id: "f1", Name: "Formula 1", Path: "/tv/Formula 1" },
                { Id: "other", Name: "Other show" },
                { Id: "empty", Name: "Empty show" },
                { Id: "unavailable", Name: "Unavailable show" },
              ]
            : [{ Id: "f2", Name: "Formula 2" }],
      });
    if (parent === "unavailable") return new Response(null, { status: 503 });
    if (parent === "empty") return Response.json({ Items: [] });
    const episodes = [
      {
        Id: "sprint-quali",
        Name: "Episode 1",
        Path: "/srv/review/Formula 1/Season 2026/17 Singapore/Sprint Qualifying/video.mkv",
      },
      {
        Id: "race",
        Name: "Singapore Race",
        Path: "/tv/Formula 1/Season 2025/Singapore/Race.mkv",
      },
      {
        Id: "unknown",
        Name: "Unidentified session",
        Path: "/tv/Formula 1/Season 2026/unknown.mkv",
      },
    ];
    return Response.json({
      Items:
        parent === "f1"
          ? episodes
          : [
              {
                Id: "other-episode",
                Name: "Unrelated episode",
                Path: "/tv/Other show/Season 1/episode.mkv",
              },
            ],
    });
  }) as typeof fetch,
);
useServices({
  store,
  artwork,
  router,
  emby,
  jobs: new Jobs(store, artwork, router, emby, true, true, String),
  config,
});
guardOverrides.current = {
  identity: () => ({ userId: "browser-fixture-owner", isAuthenticated: true }),
  config: {
    clerkPublishableKey: "",
    clerkSecretKey: "",
    appUrl: "http://localhost:4318",
  },
};
const handlers: Record<
  string,
  (context: { request: Request }) => Promise<Response>
> = {
  "/api/admin/me": owner.me,
  "/api/admin/status": owner.status,
  "/api/admin/settings": owner.settings,
  "/api/admin/events": owner.events,
  "/api/admin/models": owner.models,
  "/api/admin/emby/libraries": owner.embyLibraries,
  "/api/admin/emby/shows": owner.embyShows,
  "/api/admin/emby/candidates": owner.embyCandidates,
  "/api/admin/emby/mappings": owner.saveMappings,
};
// Studio routes carry the weekend (and version) in the path.
function studioRoute(pathname: string, method: string) {
  const match =
    /^\/api\/admin\/studio\/([^/]+)(?:\/(generate|upload|draft|approve|versions\/([^/]+)))?$/.exec(
      pathname,
    );
  if (!match) return null;
  const [, eventId, action, versionId] = match;
  const handler = !action
    ? studio.state
    : action === "draft"
      ? method === "DELETE"
        ? studio.discardDraft
        : studio.saveDraft
      : versionId
        ? studio.versionImage
        : studio[action as "generate" | "upload" | "approve"];
  return (request: Request) =>
    handler({
      request,
      params: {
        eventId: decodeURIComponent(eventId),
        ...(versionId ? { versionId } : {}),
      },
    });
}
export default mergeConfig(
  base,
  defineConfig({
    cacheDir: ".local/emby-selection/vite-cache",
    optimizeDeps: { exclude: ["bun"] },
    resolve: {
      alias: { "@clerk/tanstack-react-start": path.resolve("e2e/clerk.tsx") },
    },
    server: {
      port: 4318,
      strictPort: true,
      watch: { ignored: ["**/.local/**"] },
    },
    plugins: [
      {
        name: "isolated-browser-fixture",
        configureServer(server) {
          server.middlewares.use(async (incoming, outgoing, next) => {
            const url = new URL(incoming.url || "/", "http://localhost:4318");
            if (!url.pathname.startsWith("/api/")) return next();
            try {
              const chunks = [];
              for await (const chunk of incoming)
                chunks.push(Buffer.from(chunk));
              const body = Buffer.concat(chunks);
              const request = new Request(url, {
                method: incoming.method,
                headers: incoming.headers as Record<string, string>,
                ...(body.length ? { body } : {}),
              });
              const dynamic = studioRoute(url.pathname, request.method);
              const handler = handlers[url.pathname];
              const response =
                url.pathname === "/api/library"
                  ? await library(request)
                  : url.pathname === "/api/health"
                    ? health()
                    : handler
                      ? await handler({ request })
                      : dynamic
                        ? await dynamic(request)
                        : new Response(null, { status: 404 });
              outgoing.writeHead(
                response.status,
                Object.fromEntries(response.headers),
              );
              outgoing.end(Buffer.from(await response.arrayBuffer()));
            } catch (error) {
              next(error);
            }
          });
        },
      },
    ],
  }),
);
