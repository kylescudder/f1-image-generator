import { syncInterval } from "./calendar.ts";
import { services } from "./services.ts";
import type { PublicLibrary } from "../shared/types.ts";

export class SeasonNotFound extends Error {
  constructor() {
    super("Season not found.");
  }
}
// The public collection for one season; defaults to the current (or newest) year.
export async function buildLibrary(season?: number): Promise<PublicLibrary> {
  const { store, artwork } = await services();
  const years = [
    ...new Set((await store.events()).map((event) => event.season)),
  ].sort((a, b) => b - a);
  const year =
    season ||
    (years.includes(new Date().getUTCFullYear())
      ? new Date().getUTCFullYear()
      : years[0]);
  if (!years.includes(year)) throw new SeasonNotFound();
  const lastSync = await store.get<string | null>("lastSync", null);
  return {
    seasons: years,
    season: year,
    events: await artwork.libraryEvents(await store.events(year)),
    lastSync,
    nextSync: lastSync
      ? new Date(Date.parse(lastSync) + syncInterval).toISOString()
      : null,
    syncError: await store.get("syncError", null),
    frozen: await store.get(`frozen:${year}`, false),
  };
}
