import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AppSettings,
  EmbyMapping,
  Job,
  RaceEvent,
} from "../shared/types.ts";

export class Store {
  db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, "paddock.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, season INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backgrounds (venue TEXT PRIMARY KEY, file TEXT NOT NULL, version TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, eventId TEXT, status TEXT NOT NULL, message TEXT NOT NULL, createdAt TEXT NOT NULL, finishedAt TEXT);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, month TEXT NOT NULL, model TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mappings (eventId TEXT NOT NULL, session TEXT NOT NULL, itemId TEXT NOT NULL UNIQUE, itemName TEXT NOT NULL, lastImageVersion TEXT, lastSyncedAt TEXT, error TEXT, PRIMARY KEY(eventId,session));`);
    this.db
      .prepare(
        "UPDATE jobs SET status='failed', message='Interrupted by a restart. You can retry.', finishedAt=? WHERE status IN ('running','queued')",
      )
      .run(new Date().toISOString());
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value FROM state WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  settings(): AppSettings {
    return this.get("settings", {
      modelId: "",
      monthlyGenerationLimit: 5,
      autoGenerate: true,
      resolution: "2K",
      quality: "high",
      embyLibraryId: "",
    });
  }
  events(season?: number): RaceEvent[] {
    const rows =
      season === undefined
        ? this.db.prepare("SELECT payload FROM events").all()
        : this.db
            .prepare("SELECT payload FROM events WHERE season=?")
            .all(season);
    return rows
      .map((row) => JSON.parse(row.payload as string) as RaceEvent)
      .sort((a, b) => a.season - b.season || a.round - b.round);
  }
  event(id: string): RaceEvent | undefined {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.payload as string) : undefined;
  }
  saveEvent(event: RaceEvent) {
    this.db
      .prepare(
        "INSERT INTO events(id,season,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,season=excluded.season",
      )
      .run(event.id, event.season, JSON.stringify(event));
  }
  background(venue: string): { file: string; version: string } | undefined {
    return this.db
      .prepare("SELECT file,version FROM backgrounds WHERE venue=?")
      .get(venue) as { file: string; version: string } | undefined;
  }
  latestBackground(
    venue: string,
    season: number,
  ): { file: string; version: string } | undefined {
    const rows = this.db
      .prepare("SELECT venue,file,version FROM backgrounds WHERE venue LIKE ?")
      .all(`${venue}:%`) as unknown as {
      venue: string;
      file: string;
      version: string;
    }[];
    return rows
      .filter((row) => Number(row.venue.split(":").at(-1)) <= season)
      .sort(
        (a, b) =>
          Number(b.venue.split(":").at(-1)) - Number(a.venue.split(":").at(-1)),
      )[0];
  }
  saveBackground(venue: string, file: string, version: string) {
    this.db
      .prepare(
        "INSERT INTO backgrounds VALUES(?,?,?) ON CONFLICT(venue) DO UPDATE SET file=excluded.file,version=excluded.version",
      )
      .run(venue, file, version);
  }
  jobs(): Job[] {
    return this.db
      .prepare("SELECT * FROM jobs ORDER BY createdAt DESC LIMIT 30")
      .all() as unknown as Job[];
  }
  createJob(kind: Job["kind"], eventId: string | null, message: string): Job {
    const job: Job = {
      id: randomUUID(),
      kind,
      eventId,
      status: "queued",
      message,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.db
      .prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?)")
      .run(
        job.id,
        job.kind,
        job.eventId,
        job.status,
        job.message,
        job.createdAt,
        null,
      );
    return job;
  }
  updateJob(id: string, status: Job["status"], message: string) {
    this.db
      .prepare("UPDATE jobs SET status=?,message=?,finishedAt=? WHERE id=?")
      .run(
        status,
        message,
        status === "running" || status === "queued"
          ? null
          : new Date().toISOString(),
        id,
      );
  }
  attempts(month = new Date().toISOString().slice(0, 7)): number {
    return Number(
      this.db
        .prepare("SELECT count(*) AS count FROM attempts WHERE month=?")
        .get(month)?.count || 0,
    );
  }
  reserveAttempt(model: string, limit: number, now = new Date()): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const month = now.toISOString().slice(0, 7);
      if (this.attempts(month) >= limit) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare("INSERT INTO attempts VALUES(?,?,?,?)")
        .run(randomUUID(), month, model, now.toISOString());
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  mappings(): EmbyMapping[] {
    return this.db
      .prepare("SELECT * FROM mappings ORDER BY eventId,session")
      .all() as unknown as EmbyMapping[];
  }
  saveMapping(mapping: EmbyMapping) {
    this.db
      .prepare(
        `INSERT INTO mappings VALUES(?,?,?,?,?,?,?) ON CONFLICT(eventId,session) DO UPDATE SET itemId=excluded.itemId,itemName=excluded.itemName,lastImageVersion=excluded.lastImageVersion,lastSyncedAt=excluded.lastSyncedAt,error=excluded.error`,
      )
      .run(
        mapping.eventId,
        mapping.session,
        mapping.itemId,
        mapping.itemName,
        mapping.lastImageVersion,
        mapping.lastSyncedAt,
        mapping.error,
      );
  }
  close() {
    this.db.close();
  }
}
