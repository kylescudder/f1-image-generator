import { closeConnection, connection } from "../server/database.ts";

// Read-only acceptance checks run by Herman against the candidate container
// before the release is acknowledged. They never write to the library.
const origin = process.env.VERIFY_ORIGIN || "http://127.0.0.1:3000";

async function request(path: string, status = 200, init?: RequestInit) {
  const response = await fetch(origin + path, {
    ...init,
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== status)
    throw new Error(`${path}: expected ${status}, received ${response.status}`);
  return response;
}
const fail = (message: string): never => {
  throw new Error(message);
};

try {
  const sql = await connection();
  const [permissions] = await sql`
    SELECT current_user AS role,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
      rolsuper, rolcreatedb, rolcreaterole
    FROM pg_roles WHERE rolname = current_user
  `;
  const expectedRole = new URL(process.env.DATABASE_URL!).username;
  if (
    permissions?.role !== expectedRole ||
    !expectedRole.endsWith("_runtime") ||
    permissions.can_create ||
    permissions.rolsuper ||
    permissions.rolcreatedb ||
    permissions.rolcreaterole
  )
    fail("Runtime database role is not restricted");
  const [events] = await sql`SELECT count(*)::int AS count FROM events`;
  if (!events?.count) fail("Calendar data is missing from the database");

  const page = await (await request("/")).text();
  if (!page.includes("Paddock")) fail("Frontend page is missing");
  const assets = [
    ...page.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g),
  ];
  if (assets.length < 2) fail("Built assets are missing");
  for (const [, asset] of assets) {
    const response = await request(asset);
    if (
      !response.headers
        .get("Content-Type")
        ?.includes(asset.endsWith(".css") ? "text/css" : "javascript")
    )
      fail("Built asset has an unexpected content type");
    if (!response.headers.get("Cache-Control")?.includes("immutable"))
      fail("Fingerprinted assets are not cacheable");
  }

  const health = await request("/api/health");
  const body = (await health.json()) as { ok: boolean; revision: string };
  if (
    !body.ok ||
    health.headers.get("X-Paddock-Revision") !== process.env.PADDOCK_REVISION ||
    body.revision !== process.env.PADDOCK_REVISION ||
    health.headers.get("Cache-Control") !== "no-store"
  )
    fail("Health revision/cache headers are incorrect");

  const library = (await (await request("/api/library")).json()) as {
    seasons: number[];
    events: {
      slug: string;
      cancelled: boolean;
      images: { session: string; thumbnail: string; svg: string }[];
    }[];
  };
  const weekend = library.events.find((event) => !event.cancelled);
  if (!library.seasons.length || !weekend?.images.length)
    fail("Public library is empty");
  const [artwork] = weekend!.images;
  const thumbnail = await request(artwork.thumbnail);
  const etag = thumbnail.headers.get("ETag");
  if (thumbnail.headers.get("Content-Type") !== "image/png" || !etag)
    fail("Thumbnail is not a cacheable PNG");
  const magic = new Uint8Array(await thumbnail.arrayBuffer()).slice(0, 4);
  if (magic.join() !== "137,80,78,71") fail("Thumbnail bytes are not a PNG");
  await request(artwork.thumbnail, 304, {
    headers: { "If-None-Match": etag! },
  });
  const svg = await request(artwork.svg);
  if (
    svg.headers.get("Content-Type") !== "image/svg+xml" ||
    !svg.headers.get("Content-Security-Policy")?.includes("sandbox") ||
    !(await svg.text()).includes("<path")
  )
    fail("SVG master is not sandboxed vector artwork");
  await request("/images/1900/nowhere/race.png", 404);

  // Owner APIs must refuse anonymous callers, whether or not Clerk is configured yet.
  for (const path of ["/api/admin/status", "/api/admin/models"]) {
    const response = await fetch(origin + path, {
      signal: AbortSignal.timeout(15000),
    });
    if (![401, 503].includes(response.status))
      fail(`${path} is reachable without owner authentication`);
  }
  const mutation = await fetch(origin + "/api/admin/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId: "2026-singapore" }),
    signal: AbortSignal.timeout(15000),
  });
  if (![401, 503].includes(mutation.status))
    fail("Generation is reachable without owner authentication");
  await request("/api/nope", 404);
  console.log(
    "Frontend/assets, revision, library, image caching, SVG sandboxing, owner denial and runtime permissions passed",
  );
} finally {
  await closeConnection();
}
