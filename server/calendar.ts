import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RaceEvent } from "../shared/types.ts";
import { Store } from "./db.ts";

const raceSchema = z.object({
  season: z.string(),
  round: z.string(),
  raceName: z.string(),
  date: z.iso.date(),
  Circuit: z.object({
    circuitId: z.string().regex(/^[a-z0-9_-]+$/),
    circuitName: z.string(),
    Location: z.object({ locality: z.string(), country: z.string() }),
  }),
  FirstPractice: z.object({ date: z.string() }).optional(),
  Sprint: z.unknown().optional(),
  SprintQualifying: z.unknown().optional(),
  SprintShootout: z.unknown().optional(),
});
const envelope = z.object({
  MRData: z.object({
    total: z.string(),
    RaceTable: z.object({ Races: z.array(raceSchema) }),
  }),
});
const venueAliases: Record<string, string> = {
  albert_park: "melbourne",
  shanghai: "shanghai",
  suzuka: "suzuka",
  bahrain: "sakhir",
  jeddah: "jeddah",
  miami: "miami",
  imola: "imola",
  monaco: "monaco",
  catalunya: "barcelona",
  villeneuve: "montreal",
  red_bull_ring: "spielberg",
  silverstone: "silverstone",
  spa: "spa",
  hungaroring: "hungaroring",
  zandvoort: "zandvoort",
  monza: "monza",
  baku: "baku",
  marina_bay: "marina-bay",
  americas: "austin",
  rodriguez: "mexico-city",
  interlagos: "interlagos",
  vegas: "las-vegas",
  las_vegas: "las-vegas",
  losail: "lusail",
  lusail: "lusail",
  yas_marina: "yas-marina",
  madring: "madrid",
  madrid: "madrid",
  sepang: "sepang",
};
export function eventSlug(name: string): string {
  const text = name.toLowerCase();
  // A race keeps its identity when relocated or renamed by a title sponsor.
  if (text.includes("bahrain")) return "bahrain";
  if (
    text.includes("brazil") ||
    text.includes("são paulo") ||
    text.includes("sao paulo")
  )
    return "brazil";
  if (text.includes("barcelona") || text.includes("catalunya"))
    return "barcelona";
  if (text.includes("spanish")) return "spain";
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/grand prix.*$/, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
export function parseCalendar(raw: unknown, expectedYear: number): RaceEvent[] {
  const data = envelope.parse(raw).MRData;
  const races = data.RaceTable.Races;
  if (races.length < 10 || Number(data.total) !== races.length)
    throw new Error(
      "Calendar response is incomplete; the existing calendar was preserved.",
    );
  const slugs = new Set<string>();
  const rounds = new Set<number>();
  return races.map((race) => {
    if (Number(race.season) !== expectedYear)
      throw new Error("Calendar season did not match the request.");
    const slug = eventSlug(race.raceName);
    const round = Number(race.round);
    if (
      !slug ||
      slugs.has(slug) ||
      !Number.isInteger(round) ||
      round < 1 ||
      rounds.has(round)
    )
      throw new Error("Calendar has duplicate events or rounds.");
    slugs.add(slug);
    rounds.add(round);
    return {
      id: `${expectedYear}-${slug}`,
      slug,
      season: expectedYear,
      round,
      name: race.raceName,
      circuit: race.Circuit.circuitName,
      circuitId: race.Circuit.circuitId,
      venueKey: venueAliases[race.Circuit.circuitId] || race.Circuit.circuitId,
      country: race.Circuit.Location.country,
      locality: race.Circuit.Location.locality,
      date: race.date,
      startDate:
        race.FirstPractice?.date ||
        new Date(Date.parse(race.date) - 2 * 86400000)
          .toISOString()
          .slice(0, 10),
      sprint: Boolean(
        race.Sprint || race.SprintQualifying || race.SprintShootout,
      ),
      cancelled: false,
      updatedAt: new Date().toISOString(),
    };
  });
}
export function applyCalendar(
  store: Store,
  year: number,
  incoming: RaceEvent[],
) {
  const ids = new Set(incoming.map((event) => event.id));
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (const old of store.events(year))
      if (!ids.has(old.id) && !old.cancelled)
        store.saveEvent({
          ...old,
          cancelled: true,
          updatedAt: new Date().toISOString(),
        });
    for (const event of incoming) {
      const previous = store.event(event.id);
      const same =
        previous &&
        JSON.stringify({ ...previous, updatedAt: "" }) ===
          JSON.stringify({ ...event, updatedAt: "" });
      store.saveEvent(same ? previous : event);
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}
export function seedCalendars(store: Store, root: string) {
  for (const year of [2025, 2026]) {
    if (store.events(year).length) continue;
    const file = path.join(root, "assets", "calendars", `${year}.json`);
    if (!existsSync(file))
      throw new Error("Calendar seed missing. Run npm run setup.");
    applyCalendar(
      store,
      year,
      parseCalendar(JSON.parse(readFileSync(file, "utf8")), year),
    );
    store.set(`seeded:${year}`, new Date().toISOString());
  }
}
export const syncInterval = 6 * 60 * 60 * 1000;
export async function syncCalendars(
  store: Store,
  now = new Date(),
  fetcher: typeof fetch = fetch,
) {
  const current = now.getUTCFullYear();
  const years = [
    ...new Set([
      ...store.events().map((event) => event.season),
      current,
      current + 1,
    ]),
  ].sort();
  const results: string[] = [];
  for (const year of years) {
    if (store.get(`frozen:${year}`, false)) continue;
    const response = await fetcher(
      `https://api.jolpi.ca/ergast/f1/${year}/?limit=100`,
      {
        signal: AbortSignal.timeout(25000),
        headers: { Accept: "application/json" },
      },
    );
    if (!response.ok)
      throw new Error(
        `Calendar provider returned ${response.status}. Existing images are preserved.`,
      );
    const raw = await response.json();
    // Upcoming seasons are often not announced yet: empty is expected, never a cancellation signal.
    const total = Number(
      (raw as { MRData?: { total?: string } }).MRData?.total,
    );
    if (year > current && total === 0) continue;
    const events = parseCalendar(raw, year);
    applyCalendar(store, year, events);
    const finalDate = Math.max(
      ...events.map((event) => Date.parse(event.date)),
    );
    if (now.getTime() > finalDate + 7 * 86400000)
      store.set(`frozen:${year}`, true);
    results.push(`${year}: ${events.length} weekends`);
  }
  store.set("lastSync", now.toISOString());
  store.set("syncError", null);
  return results.join(" · ");
}
