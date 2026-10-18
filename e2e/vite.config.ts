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

// Never use the developer's application database or real integration credentials.
const databaseUrl =
  process.env.E2E_DATABASE_URL ||
  "postgres://postgres:paddock@127.0.0.1:55432/paddock_e2e_test";
if (!new URL(databaseUrl).pathname.endsWith("_e2e_test"))
  throw new Error("E2E_DATABASE_URL must end in _e2e_test");
const sql = new SQL(databaseUrl);
await migrate(sql);
await sql`TRUNCATE state, events, backgrounds, jobs, attempts, mappings`;
const store = await new Store(sql).open();
await seedCalendars(store, process.cwd());
await store.set("settings", {
  ...(await store.settings()),
  autoGenerate: false,
});
await mkdir(".local/emby-selection/data", { recursive: true });
await cp("data/fonts", ".local/emby-selection/data/fonts", { recursive: true });
const artwork = new Artwork(
  store,
  process.cwd(),
  path.resolve(".local/emby-selection/data"),
);
const router = new OpenRouter(store, "", "http://localhost:4318", (async (
  _input,
) =>
  Response.json({
    data: [
      {
        id: "fixture/image",
        name: "Fixture image model",
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["image"],
        },
        supported_parameters: {},
      },
    ],
  })) as typeof fetch);
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
        Path: "/tv/Formula 1/Season 2026/17 Singapore/Sprint Qualifying/video.mkv",
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
  jobs: new Jobs(store, artwork, router, emby, false, false, String),
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
              const handler = handlers[url.pathname];
              const response =
                url.pathname === "/api/library"
                  ? await library(request)
                  : url.pathname === "/api/health"
                    ? health()
                    : handler
                      ? await handler({ request })
                      : new Response(null, { status: 404 });
              outgoing.writeHead(
                response.status,
                Object.fromEntries(response.headers),
              );
              outgoing.end(await response.text());
            } catch (error) {
              next(error);
            }
          });
        },
      },
    ],
  }),
);
