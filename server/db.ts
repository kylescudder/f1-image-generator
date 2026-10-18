import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import type {
  AppSettings,
  EmbyMapping,
  Job,
  RaceEvent,
} from "../shared/types.ts";

type Background = { file: string; version: string };
const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();
// Bun returns JSONB as text; both text and parsed values are accepted.
const parse = <T>(value: unknown) =>
  (typeof value === "string" ? JSON.parse(value) : value) as T;

export class Store {
  constructor(public sql: SQL) {}
  // Creating a Store marks work interrupted by a previous process as retryable.
  async open() {
    await this.sql`UPDATE jobs SET status='failed',
      message='Interrupted by a restart. You can retry.', finished_at=${new Date().toISOString()}
      WHERE status IN ('running','queued')`;
    return this;
  }
  async get<T>(key: string, fallback: T): Promise<T> {
    const [row] = await this.sql`SELECT value FROM state WHERE key=${key}`;
    return row ? parse<T>(row.value) : fallback;
  }
  async set(key: string, value: unknown) {
    await this.sql`INSERT INTO state (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value=excluded.value`;
  }
  async settings(): Promise<AppSettings> {
    return this.get("settings", {
      modelId: "",
      monthlyGenerationLimit: 5,
      autoGenerate: true,
      resolution: "2K",
      quality: "high",
      embyLibraryId: "",
    });
  }
  async events(season?: number): Promise<RaceEvent[]> {
    const rows =
      season === undefined
        ? await this.sql`SELECT payload FROM events`
        : await this.sql`SELECT payload FROM events WHERE season=${season}`;
    return rows
      .map((row: { payload: unknown }) => parse<RaceEvent>(row.payload))
      .sort((a: RaceEvent, b: RaceEvent) => a.season - b.season || a.round - b.round);
  }
  async event(id: string): Promise<RaceEvent | undefined> {
    const [row] = await this.sql`SELECT payload FROM events WHERE id=${id}`;
    return row ? parse<RaceEvent>(row.payload) : undefined;
  }
  async saveEvent(event: RaceEvent) {
    await this.sql`INSERT INTO events (id, season, payload)
      VALUES (${event.id}, ${event.season}, ${JSON.stringify(event)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET payload=excluded.payload, season=excluded.season`;
  }
  // Applies a whole season's changes atomically so a failure never leaves a half-updated calendar.
  async transaction<T>(work: (tx: Store) => Promise<T>): Promise<T> {
    return this.sql.begin((tx) => work(new Store(tx as unknown as SQL)));
  }
  async backgrounds(): Promise<Map<string, Background>> {
    const rows = await this.sql`SELECT venue, file, version FROM backgrounds`;
    return new Map(
      rows.map((row: { venue: string } & Background) => [row.venue, row]),
    );
  }
  async background(venue: string): Promise<Background | undefined> {
    return (await this.backgrounds()).get(venue);
  }
  // Newest generated background at or before this season; later seasons never alter history.
  async latestBackground(
    venue: string,
    season: number,
    index?: Map<string, Background>,
  ): Promise<Background | undefined> {
    const all = index ?? (await this.backgrounds());
    return [...all.entries()]
      .filter(([key]) => key.startsWith(`${venue}:`))
      .map(([key, value]) => ({ year: Number(key.split(":").at(-1)), value }))
      .filter(({ year }) => year <= season)
      .sort((a, b) => b.year - a.year)[0]?.value;
  }
  async saveBackground(venue: string, file: string, version: string) {
    await this.sql`INSERT INTO backgrounds (venue, file, version) VALUES (${venue}, ${file}, ${version})
      ON CONFLICT (venue) DO UPDATE SET file=excluded.file, version=excluded.version`;
  }
  async jobs(): Promise<Job[]> {
    const rows = await this.sql`SELECT * FROM jobs ORDER BY created_at DESC LIMIT 30`;
    return rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      kind: row.kind as Job["kind"],
      eventId: row.event_id as string | null,
      status: row.status as Job["status"],
      message: row.message as string,
      createdAt: iso(row.created_at as Date)!,
      finishedAt: iso(row.finished_at as Date | null),
    }));
  }
  async createJob(
    kind: Job["kind"],
    eventId: string | null,
    message: string,
  ): Promise<Job> {
    const job: Job = {
      id: randomUUID(),
      kind,
      eventId,
      status: "queued",
      message,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    await this.sql`INSERT INTO jobs (id, kind, event_id, status, message, created_at)
      VALUES (${job.id}, ${job.kind}, ${job.eventId}, ${job.status}, ${job.message}, ${job.createdAt})`;
    return job;
  }
  async updateJob(id: string, status: Job["status"], message: string) {
    const finished =
      status === "running" || status === "queued"
        ? null
        : new Date().toISOString();
    await this.sql`UPDATE jobs SET status=${status}, message=${message}, finished_at=${finished}
      WHERE id=${id}`;
  }
  async attempts(month = new Date().toISOString().slice(0, 7)): Promise<number> {
    const [row] = await this.sql`SELECT count(*)::int AS count FROM attempts WHERE month=${month}`;
    return Number(row?.count || 0);
  }
  async reserveAttempt(model: string, limit: number, now = new Date()): Promise<boolean> {
    const month = now.toISOString().slice(0, 7);
    return this.sql.begin(async (tx) => {
      // Serialises concurrent reservations so the monthly allowance can never be exceeded.
      await tx`SELECT pg_advisory_xact_lock(hashtext('paddock-attempts'))`;
      const [row] = await tx`SELECT count(*)::int AS count FROM attempts WHERE month=${month}`;
      if (Number(row.count) >= limit) return false;
      await tx`INSERT INTO attempts (id, month, model, created_at)
        VALUES (${randomUUID()}, ${month}, ${model}, ${now.toISOString()})`;
      return true;
    });
  }
  async mappings(): Promise<EmbyMapping[]> {
    const rows = await this.sql`SELECT * FROM mappings ORDER BY event_id, session`;
    return rows.map((row: Record<string, unknown>) => ({
      eventId: row.event_id as string,
      session: row.session as EmbyMapping["session"],
      itemId: row.item_id as string,
      itemName: row.item_name as string,
      lastImageVersion: row.last_image_version as string | null,
      lastSyncedAt: iso(row.last_synced_at as Date | null),
      error: row.error as string | null,
    }));
  }
  async saveMapping(mapping: EmbyMapping, sql: SQL = this.sql) {
    await sql`INSERT INTO mappings (event_id, session, item_id, item_name, last_image_version, last_synced_at, error)
      VALUES (${mapping.eventId}, ${mapping.session}, ${mapping.itemId}, ${mapping.itemName},
        ${mapping.lastImageVersion}, ${mapping.lastSyncedAt}, ${mapping.error})
      ON CONFLICT (event_id, session) DO UPDATE SET item_id=excluded.item_id, item_name=excluded.item_name,
        last_image_version=excluded.last_image_version, last_synced_at=excluded.last_synced_at, error=excluded.error`;
  }
  async deleteMapping(eventId: string, session: string) {
    await this.sql`DELETE FROM mappings WHERE event_id=${eventId} AND session=${session}`;
  }
  // Remaps are saved together: either every row changes or none do.
  async replaceMappings(values: EmbyMapping[]) {
    await this.sql.begin(async (tx) => {
      for (const item of values) await this.saveMapping(item, tx as unknown as SQL);
    });
  }
}
