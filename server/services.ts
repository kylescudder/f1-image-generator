import { config, authConfigured } from "./config.ts";
import { connection } from "./database.ts";
import { Store } from "./db.ts";
import { seedCalendars } from "./calendar.ts";
import { Artwork } from "./artwork.ts";
import { OpenRouter } from "./openrouter.ts";
import { Emby } from "./emby.ts";
import { Jobs } from "./jobs.ts";
import { redactSecrets } from "./errors.ts";

export interface Services {
  store: Store;
  artwork: Artwork;
  router: OpenRouter;
  emby: Emby;
  jobs: Jobs;
  config: typeof config;
}

// Vite can load server modules more than once in development, so the shared
// connection pool and job queue live on globalThis rather than module state.
const slot = globalThis as unknown as { __paddock?: Promise<Services> };

async function create(): Promise<Services> {
  const store = await new Store(await connection()).open();
  await seedCalendars(store, config.root);
  const artwork = new Artwork(store, config.root, config.dataDir);
  // Preserve source weekends omitted from a later calendar as archived entries.
  if (!(await store.get("archiveSeeded", false))) {
    for (const prior of await store.events(2025)) {
      const source = artwork.manifest.seasons["2026"]?.[prior.venueKey];
      const id = `2026-${prior.slug}`;
      if (source && !(await store.event(id)))
        await store.saveEvent({
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
    await store.set("archiveSeeded", true);
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
    redactSecrets,
  );
  jobs.start();
  return { store, artwork, router, emby, jobs, config };
}

// The first caller starts the calendar sync schedule; a failed start is retried.
export function services(): Promise<Services> {
  slot.__paddock ??= create().catch((error) => {
    slot.__paddock = undefined;
    throw error;
  });
  return slot.__paddock;
}
// Tests inject isolated services; production never calls this.
export function useServices(value: Services | undefined) {
  slot.__paddock = value && Promise.resolve(value);
}
