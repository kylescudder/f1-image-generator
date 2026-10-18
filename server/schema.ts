import type { SQL } from "bun";

// Idempotent, additive schema. Run by the owner role in `db:migrate` before the app starts.
export async function migrate(sql: SQL) {
  await sql`CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    season INTEGER NOT NULL,
    payload JSONB NOT NULL
  )`;
  await sql`CREATE INDEX IF NOT EXISTS events_season ON events (season)`;
  await sql`CREATE TABLE IF NOT EXISTS backgrounds (
    venue TEXT PRIMARY KEY,
    file TEXT NOT NULL,
    version TEXT NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    event_id TEXT,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ
  )`;
  await sql`CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created_at DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    month TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`;
  await sql`CREATE INDEX IF NOT EXISTS attempts_month ON attempts (month)`;
  await sql`CREATE TABLE IF NOT EXISTS mappings (
    event_id TEXT NOT NULL,
    session TEXT NOT NULL,
    item_id TEXT NOT NULL UNIQUE,
    item_name TEXT NOT NULL,
    last_image_version TEXT,
    last_synced_at TIMESTAMPTZ,
    error TEXT,
    PRIMARY KEY (event_id, session)
  )`;
  // Approved overlay colours per venue and season; absent means design-source defaults.
  await sql`CREATE TABLE IF NOT EXISTS overlays (
    venue TEXT PRIMARY KEY,
    colours JSONB NOT NULL
  )`;
  // Studio candidates. Nothing here is live until a version is approved.
  await sql`CREATE TABLE IF NOT EXISTS studio_versions (
    id TEXT PRIMARY KEY,
    venue TEXT NOT NULL,
    file TEXT NOT NULL,
    version TEXT NOT NULL,
    source TEXT NOT NULL,
    parent_id TEXT,
    feedback TEXT,
    prompt TEXT,
    model TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (venue, version)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS studio_drafts (
    venue TEXT PRIMARY KEY,
    selected_version_id TEXT,
    colours JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`;
}
