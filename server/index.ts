import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { config, authConfigured } from "./config.ts";
import { Store } from "./db.ts";
import { seedCalendars } from "./calendar.ts";
import { Artwork } from "./artwork.ts";
import { OpenRouter } from "./openrouter.ts";
import { Emby } from "./emby.ts";
import { Jobs } from "./jobs.ts";
import { createApp, safeError } from "./app.ts";

const store = new Store(config.dataDir);
seedCalendars(store, config.root);
const artwork = new Artwork(store, config.root, config.dataDir);
// Preserve source weekends omitted from a later calendar as archived entries.
if (!store.get("archiveSeeded", false)) {
  for (const prior of store.events(2025)) {
    const source = artwork.manifest.seasons["2026"]?.[prior.venueKey];
    const id = `2026-${prior.slug}`;
    if (source && !store.event(id))
      store.saveEvent({
        ...prior,
        id,
        season: 2026,
        date: "",
        startDate: "",
        round: (source as unknown as { sourceRound: number }).sourceRound,
        cancelled: true,
        updatedAt: new Date().toISOString(),
      });
  }
  store.set("archiveSeeded", true);
}
const router = new OpenRouter(store, config.openrouterKey, config.appUrl);
const emby = new Emby(store, artwork, config.embyUrl, config.embyKey);
const jobs = new Jobs(
  store,
  artwork,
  router,
  emby,
  authConfigured,
  Boolean(config.openrouterKey),
  (error) =>
    safeError(error, [
      config.openrouterKey,
      config.embyKey,
      config.clerkSecretKey,
    ]),
);
const app = createApp({ store, artwork, router, emby, jobs, config });
const production = process.env.NODE_ENV === "production";
if (production) {
  const dist = path.join(config.root, "dist");
  if (!existsSync(path.join(dist, "index.html")))
    throw new Error(
      "Build the frontend before starting production: npm run build.",
    );
  app.use(express.static(dist));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(dist, "index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true, allowedHosts: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const server = app.listen(config.port, "0.0.0.0", () =>
  console.log(`Paddock is ready at http://localhost:${config.port}`),
);
jobs.start();
process.once("SIGTERM", () => {
  jobs.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
});
