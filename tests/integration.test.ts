import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { SQL } from "bun";
import sharp from "sharp";
import { migrate } from "../server/schema.ts";
import { Store } from "../server/db.ts";
import {
  applyCalendar,
  eventSlug,
  parseCalendar,
  seedCalendars,
  syncCalendars,
} from "../server/calendar.ts";
import { Artwork } from "../server/artwork.ts";
import {
  OpenRouter,
  assertSafeImage,
  imageRequest,
  normalizeModels,
  readImageUrl,
} from "../server/openrouter.ts";
import { Emby, inferSession, matchItem } from "../server/emby.ts";
import { useServices, type Services } from "../server/services.ts";
import { guardOverrides } from "../server/guard.ts";
import { owner } from "../server/api.ts";
import { config } from "../server/config.ts";
import { sessionKeys, type ImageModel } from "../shared/types.ts";

const root = process.cwd();
const snapshot = (year: number) =>
  JSON.parse(readFileSync(`assets/calendars/${year}.json`, "utf8"));
// An isolated database: tests refuse to run against anything not named *_test.
const databaseUrl =
  process.env.TEST_DATABASE_URL ||
  "postgres://postgres:paddock@127.0.0.1:55432/paddock_test";
if (!new URL(databaseUrl).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must name a database ending in _test");
const sql = new SQL(databaseUrl, { max: 4 });
await migrate(sql);
async function fixture() {
  await sql`TRUNCATE state, events, backgrounds, jobs, attempts, mappings`;
  return {
    store: await new Store(sql).open(),
    close() {},
  };
}
const model: ImageModel = {
  id: "new-provider/new-image-model",
  name: "A newly released model",
  created: 1,
  route: "images",
  inputModalities: ["text", "image"],
  outputModalities: ["image"],
  parameters: {
    aspect_ratio: { type: "enum", values: ["16:9", "1:1"] },
    resolution: { type: "enum", values: ["1K", "2K"] },
    input_references: { type: "range", min: 0, max: 2 },
    n: { type: "range", min: 1, max: 1 },
  },
};

test("live seed calendar creates Singapore sprint sessions, relocated Bahrain, and stable renamed events", () => {
  const events = parseCalendar(snapshot(2026), 2026);
  const singapore = events.find((event) => event.venueKey === "marina-bay")!;
  assert.equal(singapore.round, 17);
  assert.deepEqual(sessionKeys(singapore.sprint), [
    "sprint-qualifying",
    "sprint",
    "qualifying",
    "race",
  ]);
  assert.equal(
    events.find((event) => event.slug === "bahrain")?.venueKey,
    "sepang",
  );
  assert.equal(
    eventSlug("Bahrain Grand Prix"),
    eventSlug("Bahrain Grand Prix in Malaysia"),
  );
  assert.equal(
    eventSlug("São Paulo Grand Prix"),
    eventSlug("Brazilian Grand Prix"),
  );
  assert.equal(new Set(events.map((event) => event.id)).size, events.length);
});
test("truncated or cross-season feeds cannot overwrite a valid calendar", () => {
  const data = snapshot(2026);
  data.MRData.RaceTable.Races.pop();
  assert.throws(() => parseCalendar(data, 2026), /incomplete/);
  assert.throws(() => parseCalendar(snapshot(2026), 2025), /season/);
});
test("round/format changes preserve Emby mapping and stable image URL, invalidate render version, and archive removals", async () => {
  const f = await fixture();
  try {
    const incoming = parseCalendar(snapshot(2026), 2026);
    const singapore = incoming.find((event) => event.slug === "singapore")!;
    const previous = incoming.map((event) =>
      event.id === singapore.id
        ? { ...event, round: 18, sprint: false }
        : event,
    );
    await applyCalendar(f.store, 2026, previous);
    const artwork = new Artwork(f.store, root, path.join(root, "data"));
    const before = await artwork.libraryEvent(
      (await f.store.event(singapore.id))!,
    );
    await f.store.saveMapping({
      eventId: singapore.id,
      session: "race",
      itemId: "episode-42",
      itemName: "Singapore Race",
      lastImageVersion: "old",
      lastSyncedAt: null,
      error: null,
    });
    const removed = incoming.find((event) => event.slug === "monaco")!;
    await applyCalendar(
      f.store,
      2026,
      incoming.filter((event) => event.id !== removed.id),
    );
    const after = await artwork.libraryEvent(
      (await f.store.event(singapore.id))!,
    );
    assert.equal(after.images.length, 4);
    assert.equal(
      before.images.at(-1)!.png.split("?")[0],
      after.images.at(-1)!.png.split("?")[0],
    );
    assert.notEqual(before.images.at(-1)!.png, after.images.at(-1)!.png);
    assert.equal((await f.store.mappings())[0].itemId, "episode-42");
    assert.equal((await f.store.event(removed.id))?.cancelled, true);
  } finally {
    f.close();
  }
});
test("completed seasons are not fetched or modified by later calendar syncs", async () => {
  const f = await fixture();
  const years: string[] = [];
  try {
    await seedCalendars(f.store, root);
    await f.store.set("frozen:2025", true);
    await syncCalendars(f.store, new Date("2026-10-17T12:00:00Z"), (async (
      url,
    ) => {
      years.push(String(url));
      return Response.json(
        String(url).includes("2027")
          ? { MRData: { total: "0" } }
          : snapshot(2026),
      );
    }) as typeof fetch);
    assert.equal(
      years.some((url) => url.includes("/2025/")),
      false,
    );
    assert.ok(await f.store.get("lastSync", null));
  } finally {
    f.close();
  }
});
test("new generation models appear automatically, dedicated image route wins, and text-only models are excluded", () => {
  const raw = {
    id: model.id,
    name: model.name,
    created: 100,
    architecture: {
      input_modalities: ["text", "image"],
      output_modalities: ["image"],
    },
    supported_parameters: model.parameters,
  };
  const catalog = normalizeModels(
    [raw],
    [
      { ...raw, supported_parameters: ["modalities"] },
      {
        id: "text-only",
        name: "Text only",
        architecture: { output_modalities: ["text"] },
      },
    ],
  );
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].route, "images");
  assert.equal(catalog[0].id, model.id);
  const body = imageRequest(
    catalog[0],
    "A venue",
    "data:image/png;base64,AA==",
    "4K",
    "high",
  ) as Record<string, unknown>;
  assert.equal(body.resolution, "2K");
  assert.equal(body.aspect_ratio, "16:9");
  assert.equal(body.quality, undefined);
  assert.equal(body.output_format, undefined);
  assert.ok(body.input_references);
});
test("model refresh uses live catalogues, preserves cache on transient failures and exposes stale state", async () => {
  const f = await fixture();
  let fail = false;
  try {
    const router = new OpenRouter(
      f.store,
      "",
      "https://paddock.thescudders.org",
      (async (url) => {
        if (fail) throw new Error("Temporary outage");
        return Response.json({
          data: String(url).includes("/images/")
            ? [
                {
                  id: model.id,
                  name: model.name,
                  architecture: {
                    input_modalities: ["text"],
                    output_modalities: ["image"],
                  },
                  supported_parameters: model.parameters,
                },
              ]
            : [],
        });
      }) as typeof fetch,
    );
    assert.equal((await router.models(true)).models[0].id, model.id);
    await f.store.set("modelCatalog", {
      ...(await router.models()),
      fetchedAt: "2020-01-01",
    });
    fail = true;
    assert.equal((await router.models()).stale, true);
    await assert.rejects(() => router.models(true), /Temporary outage/);
  } finally {
    f.close();
  }
});
test("unified inference checks one provider capability map and never mixes unsupported fields", async () => {
  const f = await fixture();
  let sent: Record<string, unknown> | null = null;
  try {
    const router = new OpenRouter(
      f.store,
      "isolated-fixture-key",
      "https://paddock.thescudders.org",
      (async (url, init) => {
        if (String(url).endsWith("/endpoints"))
          return Response.json({
            endpoints: [
              {
                provider_tag: "provider/region",
                supported_parameters: {
                  aspect_ratio: { type: "enum", values: ["16:9"] },
                  resolution: { type: "enum", values: ["1K"] },
                },
              },
            ],
          });
        sent = JSON.parse(String(init?.body));
        return Response.json({
          data: [{ b64_json: "AA==", media_type: "image/png" }],
        });
      }) as typeof fetch,
    );
    await router.generate(model, "Venue", null, "2K", "high");
    assert.ok(sent);
    assert.equal((sent as Record<string, unknown>).resolution, "1K");
    assert.equal((sent as Record<string, unknown>).quality, undefined);
    assert.deepEqual((sent as Record<string, unknown>).provider, {
      only: ["provider/region"],
      allow_fallbacks: false,
    });
  } finally {
    f.close();
  }
});
test("monthly attempt reservations persist through restarts and reset by UTC month", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++)
      assert.equal(
        await f.store.reserveAttempt(
          model.id,
          5,
          new Date("2026-10-31T23:59:00Z"),
        ),
        true,
      );
    assert.equal(
      await f.store.reserveAttempt(
        model.id,
        5,
        new Date("2026-10-31T23:59:59Z"),
      ),
      false,
    );
    // A restart opens a fresh store on the same database.
    f.store = await new Store(sql).open();
    assert.equal(await f.store.attempts("2026-10"), 5);
    assert.equal(
      await f.store.reserveAttempt(
        model.id,
        5,
        new Date("2026-11-01T00:00:00Z"),
      ),
      true,
    );
  } finally {
    f.close();
  }
});
test("new venue overrides cannot change historical seasons", async () => {
  const f = await fixture();
  try {
    await f.store.saveBackground(
      "marina-bay:2026",
      "/fixture/new-venue.png",
      "new",
    );
    assert.equal(await f.store.latestBackground("marina-bay", 2025), undefined);
    assert.equal(
      (await f.store.latestBackground("marina-bay", 2026))?.version,
      "new",
    );
    assert.equal(
      (await f.store.latestBackground("marina-bay", 2027))?.version,
      "new",
    );
  } finally {
    f.close();
  }
});
test("unsafe SVG and private provider download URLs are rejected", async () => {
  assert.throws(
    () =>
      assertSafeImage(
        Buffer.from('<svg><image href="file:///etc/passwd"/></svg>'),
      ),
    /external/,
  );
  assert.throws(
    () => assertSafeImage(Buffer.from("<svg><script>bad()</script></svg>")),
    /active/,
  );
  assert.doesNotThrow(() =>
    assertSafeImage(Buffer.from('<svg><path fill="url(#gradient)"/></svg>')),
  );
  await assert.rejects(
    () => readImageUrl("https://127.0.0.1/private"),
    /public HTTPS/,
  );
  await assert.rejects(() => readImageUrl("file:///private"), /public HTTPS/);
});
test("Emby matching ignores mutable round numbers and distinguishes sprint qualifying from race qualifying", () => {
  const events = parseCalendar(snapshot(2026), 2026);
  const candidate = matchItem(
    {
      Id: "42",
      Name: "Formula 1 2026 Singapore Sprint Qualifying",
      Path: "/F1/2026/18 Singapore/Sprint Qualifying.mkv",
    },
    events,
  );
  assert.deepEqual(candidate.candidates, [
    { eventId: "2026-singapore", session: "sprint-qualifying", score: 100 },
  ]);
  assert.equal(inferSession("Singapore Race Quali"), "qualifying");
  assert.equal(inferSession("Singapore FP1"), null);
  assert.equal(inferSession("Race Highlights"), null);
});
test("Emby uploads a base64 PNG once per changed version, and keeps errors retryable", async () => {
  const f = await fixture();
  let writes = 0;
  let fail = false;
  let version = "first";
  try {
    await seedCalendars(f.store, root);
    await f.store.saveMapping({
      eventId: "2026-singapore",
      session: "race",
      itemId: "42",
      itemName: "Singapore race",
      lastImageVersion: null,
      lastSyncedAt: null,
      error: null,
    });
    const artwork = {
      background: () => ({}),
      version: () => version,
      png: async () => Buffer.from("isolated-png-fixture"),
    } as unknown as Artwork;
    const emby = new Emby(
      f.store,
      artwork,
      "http://isolated-emby.invalid",
      "isolated-fixture-token",
      (async (url, init) => {
        assert.ok(String(url).endsWith("/Items/42/Images/Primary"));
        assert.equal(init?.method, "POST");
        assert.equal(
          (init?.headers as Record<string, string>)["Content-Type"],
          "image/png",
        );
        assert.equal(
          init?.body,
          Buffer.from("isolated-png-fixture").toString("base64"),
        );
        writes++;
        return new Response(null, { status: fail ? 500 : 204 });
      }) as typeof fetch,
    );
    await emby.sync();
    await emby.sync();
    assert.equal(writes, 1);
    version = "second";
    fail = true;
    await emby.sync();
    assert.equal((await f.store.mappings())[0].lastImageVersion, "first");
    assert.match((await f.store.mappings())[0].error!, /500/);
    fail = false;
    await emby.sync();
    assert.equal((await f.store.mappings())[0].lastImageVersion, "second");
    assert.equal((await f.store.mappings())[0].error, null);
  } finally {
    f.close();
  }
});
test("owner routes deny anonymous/other users and cross-origin mutations before any inference runs", async () => {
  const f = await fixture();
  let inferenceCalls = 0;
  useServices({
    store: f.store,
    artwork: {} as Artwork,
    router: {} as OpenRouter,
    emby: { configured: false } as Emby,
    jobs: {
      generate: async () => {
        inferenceCalls++;
        return { id: "queued" };
      },
      autoGenerate: async () => {},
    },
    config,
  } as unknown as Services);
  guardOverrides.current = {
    config: {
      clerkPublishableKey: "pk_test_fixture",
      clerkSecretKey: "sk_test_fixture",
      ownerId: "user_owner",
      appUrl: "https://paddock.thescudders.org",
    },
    identity: (request) => {
      const userId = request.headers.get("x-test-user");
      return { userId: userId || null, isAuthenticated: Boolean(userId) };
    },
  };
  try {
    const send = (user: string, origin = "https://paddock.thescudders.org") =>
      owner.generate({
        request: new Request(
          "https://paddock.thescudders.org/api/admin/generate",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Test-User": user,
              Origin: origin,
            },
            body: JSON.stringify({ eventId: "2026-singapore" }),
          },
        ),
      });
    assert.equal((await send("")).status, 401);
    assert.equal((await send("user_other")).status, 403);
    assert.equal(
      (await send("user_owner", "https://attacker.invalid")).status,
      403,
    );
    assert.equal(inferenceCalls, 0);
    assert.equal((await send("user_owner")).status, 202);
    assert.equal(inferenceCalls, 1);
  } finally {
    guardOverrides.current = undefined;
    useServices(undefined);
    f.close();
  }
});
test("without a configured owner all admin APIs fail closed", async () => {
  const f = await fixture();
  useServices({ store: f.store, config } as unknown as Services);
  guardOverrides.current = {
    config: {
      clerkPublishableKey: "",
      clerkSecretKey: "",
      ownerId: "",
      appUrl: "https://paddock.thescudders.org",
    },
  };
  try {
    const response = await owner.status({
      request: new Request("https://paddock.thescudders.org/api/admin/status"),
    });
    assert.equal(response.status, 503);
  } finally {
    guardOverrides.current = undefined;
    useServices(undefined);
    f.close();
  }
});
test("rendered Singapore sprint output is an actual 4K PNG and SVG uses paths instead of system fonts", async () => {
  const f = await fixture();
  try {
    await seedCalendars(f.store, root);
    const artwork = new Artwork(f.store, root, path.join(root, "data"));
    const event = (await f.store.event("2026-singapore"))!;
    const svg = await artwork.svg(event, "sprint-qualifying");
    assert.ok(svg.includes("<path"));
    assert.ok(svg.includes("data:image/png;base64,"));
    assert.equal(svg.includes("<text"), false);
    const image = await artwork.png(event, "sprint-qualifying", 3840);
    const metadata = await sharp(image).metadata();
    assert.equal(metadata.width, 3840);
    assert.equal(metadata.height, 2160);
    assert.equal(metadata.format, "png");
  } finally {
    f.close();
  }
});
