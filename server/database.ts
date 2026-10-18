import { SQL } from "bun";

// Created lazily so importing server code never needs a database (e.g. in the router).
let pool: SQL | undefined;

export async function connection(): Promise<SQL> {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const url = new URL(process.env.DATABASE_URL);
  // Herman mounts the password as a Docker secret rather than an environment value.
  if (process.env.DATABASE_PASSWORD_FILE)
    url.password = (await Bun.file(process.env.DATABASE_PASSWORD_FILE).text()).trim();
  pool = new SQL(url.toString(), { max: 4, idleTimeout: 20, connectionTimeout: 10 });
  return pool;
}
export async function closeConnection() {
  const current = pool;
  pool = undefined;
  await current?.close();
}
