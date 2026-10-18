import { afterAll, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SQL } from "bun";
import sharp from "sharp";
import { migrate } from "../server/schema.ts";
import { Store } from "../server/db.ts";
import { seedCalendars } from "../server/calendar.ts";
import { Artwork } from "../server/artwork.ts";
import { OpenRouter } from "../server/openrouter.ts";
import { Emby } from "../server/emby.ts";
import { Jobs } from "../server/jobs.ts";
import { studio } from "../server/studio.ts";
import { useServices, type Services } from "../server/services.ts";
import { guardOverrides } from "../server/guard.ts";
import { config } from "../server/config.ts";
import type {
  ImageModel,
  OverlayColours,
  StudioState,
} from "../shared/types.ts";

const root = process.cwd();
const databaseUrl =
  process.env.TEST_DATABASE_URL ||
  "postgres://postgres:paddock@127.0.0.1:55432/paddock_test";
if (!new URL(databaseUrl).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must name a database ending in _test");
const sql = new SQL(databaseUrl, { max: 4 });
await migrate(sql);

const appUrl = "https://paddock.thescudders.org";
const model: ImageModel = {
  id: "fixture/editor",
  name: "Fixture editor",
  route: "images",
  inputModalities: ["text", "image"],
  outputModalities: ["image"],
  parameters: { input_references: { type: "range", min: 0, max: 1 } },
};
const solid = (r: number, g: number, b: number) =>
  sharp({
    create: { width: 320, height: 180, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
const average = async (dataUrl: string) => {
  const { channels } = await sharp(
    Buffer.from(dataUrl.split(",")[1], "base64"),
  ).stats();
  return channels.slice(0, 3).map((channel) => Math.round(channel.mean));
};

let dataDir = "";
let store: Store;
let artwork: Artwork;
let jobs: Jobs;
// Each provider request answers with the next colour and records what was sent.
let outputs: Buffer[] = [];
let sent: { prompt: string; reference: string | undefined }[] = [];

beforeEach(async () => {
  await sql`TRUNCATE state, events, backgrounds, jobs, attempts, mappings, overlays, studio_versions, studio_drafts`;
  store = await new Store(sql).open();
  await seedCalendars(store, root);
  dataDir ||= await mkdtemp(path.join(tmpdir(), "paddock-studio-"));
  await cp(path.join(root, "data/fonts"), path.join(dataDir, "fonts"), {
    recursive: true,
  });
  artwork = new Artwork(store, root, dataDir);
  outputs = [await solid(220, 30, 30), await solid(30, 30, 220)];
  sent = [];
  const router = new OpenRouter(store, "fixture-key", appUrl, (async (
    url,
    init,
  ) => {
    if (String(url).endsWith("/endpoints"))
      return Response.json({
        endpoints: [
          {
            provider_tag: "fixture",
            supported_parameters: model.parameters,
          },
        ],
      });
    const body = JSON.parse(String(init?.body));
    sent.push({
      prompt: body.prompt,
      reference: body.input_references?.[0]?.image_url?.url,
    });
    return Response.json({
      data: [
        {
          b64_json: outputs.shift()!.toString("base64"),
          media_type: "image/png",
        },
      ],
    });
  }) as typeof fetch);
  await store.set("modelCatalog", {
    models: [
      model,
      { ...model, id: "fixture/text-only", inputModalities: ["text"] },
    ],
    fetchedAt: new Date().toISOString(),
  });
  await store.set("settings", {
    ...(await store.settings()),
    modelId: model.id,
    monthlyGenerationLimit: 2,
    autoGenerate: false,
  });
  const emby = new Emby(store, artwork, "", "");
  jobs = new Jobs(store, artwork, router, emby, true, true, String);
  useServices({ store, artwork, router, emby, jobs, config } as Services);
  guardOverrides.current = {
    identity: () => ({ userId: "studio-owner", isAuthenticated: true }),
    config: { clerkPublishableKey: "", clerkSecretKey: "", appUrl },
  };
});
afterAll(async () => {
  guardOverrides.current = undefined;
  useServices(undefined);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const call = async (
  handler: (context: {
    request: Request;
    params?: Record<string, string>;
  }) => Promise<Response>,
  eventId: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
) =>
  handler({
    request: new Request(`${appUrl}/api/admin/studio/${eventId}`, {
      method,
      headers: { "Content-Type": "application/json", Origin: appUrl },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    params: { eventId, ...extra },
  });
const open = async (eventId: string) => {
  const response = await call(studio.state, eventId);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as StudioState;
};
const settle = async (eventId: string) => {
  for (let tries = 0; tries < 200; tries++) {
    const job = await store.latestJob("studio", eventId);
    if (job && (job.status === "completed" || job.status === "failed"))
      return job;
    await Bun.sleep(25);
  }
  throw new Error("Studio job did not finish.");
};
const imageVersions = async (eventId: string) =>
  (await artwork.libraryEvent((await store.event(eventId))!)).images.map(
    (image) => image.png,
  );

test("studio versions stay drafts, feedback revises the selected version, and approval recolours every session", async () => {
  const eventId = "2026-singapore";
  const before = await imageVersions(eventId);
  const opened = await open(eventId);
  // The live background is offered as the starting point.
  assert.equal(opened.versions.length, 1);
  assert.equal(opened.versions[0].source, "current");
  assert.equal(opened.versions[0].live, true);
  assert.equal(opened.draft, null);
  assert.deepEqual(opened.approvedColours, opened.defaultColours);
  assert.deepEqual(opened.sessions, [
    "sprint-qualifying",
    "sprint",
    "qualifying",
    "race",
  ]);
  assert.equal(opened.overlay.sessions.race?.length, "RACE".length);

  // A fresh generation with extra direction becomes version 2.
  let response = await call(studio.generate, eventId, "POST", {
    direction: "Feature the Singapore Flyer",
  });
  assert.equal(response.status, 202);
  assert.equal((await settle(eventId)).status, "completed");
  let state = await open(eventId);
  assert.equal(state.versions.length, 2);
  const fresh = state.versions[1];
  assert.equal(fresh.source, "generate");
  assert.equal(state.draft?.selectedVersionId, fresh.id);
  assert.match(sent[0].prompt, /Singapore Flyer/);

  // Feedback sends that version as the reference image.
  response = await call(studio.generate, eventId, "POST", {
    feedback: "Change the car colour to pink",
    baseVersionId: fresh.id,
  });
  assert.equal(response.status, 202);
  assert.equal((await settle(eventId)).status, "completed");
  state = await open(eventId);
  const revised = state.versions[2];
  assert.equal(revised.source, "feedback");
  assert.equal(revised.parentId, fresh.id);
  assert.equal(revised.feedback, "Change the car colour to pink");
  assert.match(sent[1].prompt, /Change the car colour to pink/);
  const [r, g, b] = await average(sent[1].reference!);
  assert.ok(r > 180 && g < 70 && b < 70, `reference was ${r},${g},${b}`);

  // Nothing is live yet: the public renders are unchanged.
  assert.deepEqual(await imageVersions(eventId), before);
  assert.equal(state.versions.find((version) => version.live)?.number, 1);

  // Both requests used the allowance; the next one is refused before any request.
  assert.deepEqual(state.allowance, { used: 2, limit: 2 });
  response = await call(studio.generate, eventId, "POST", {});
  assert.equal(response.status, 429);
  assert.equal(sent.length, 2);

  // Colours are saved with the draft; one session label can differ.
  const colours: OverlayColours = {
    ...state.defaultColours,
    title: { linked: true, colour: "#123456", sessions: {} },
    session: {
      linked: false,
      colour: state.defaultColours.session.colour,
      sessions: { race: "#ff00ff" },
    },
  };
  response = await call(studio.saveDraft, eventId, "PUT", {
    selectedVersionId: revised.id,
    colours,
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await open(eventId)).draft?.colours, colours);

  // Approval publishes the version and colours to every session.
  response = await call(studio.approve, eventId, "POST", {
    versionId: revised.id,
    colours,
  });
  assert.equal(response.status, 200);
  state = (await response.json()) as StudioState;
  assert.equal(state.draft, null);
  assert.equal(state.versions.find((version) => version.live)?.id, revised.id);
  const after = await imageVersions(eventId);
  after.forEach((url, index) => assert.notEqual(url, before[index]));
  const event = (await store.event(eventId))!;
  const race = await artwork.svg(event, "race");
  const qualifying = await artwork.svg(event, "qualifying");
  assert.match(race, /fill="#ff00ff"/);
  assert.doesNotMatch(qualifying, /fill="#ff00ff"/);
  assert.match(qualifying, /fill="#123456"/);
  const png = await artwork.png(event, "race", 640);
  const pixel = await sharp(png)
    .extract({ left: 320, top: 180, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  // The centre of the frame shows the approved (blue) revision.
  assert.ok(pixel[2] > 180 && pixel[0] < 70, `pixel was ${[...pixel]}`);
});

test("default colours and discarded drafts leave renders untouched, and invalid studio requests are refused", async () => {
  const eventId = "2026-australian";
  const before = await imageVersions(eventId);
  const state = await open(eventId);
  const current = state.versions[0];

  // A discarded draft disappears and the live thumbnail is unchanged.
  const pink: OverlayColours = {
    ...state.defaultColours,
    logo: { linked: true, colour: "#ff69b4", sessions: {} },
  };
  await call(studio.saveDraft, eventId, "PUT", {
    selectedVersionId: current.id,
    colours: pink,
  });
  const discarded = await call(studio.discardDraft, eventId, "DELETE");
  assert.equal(((await discarded.json()) as StudioState).draft, null);
  assert.deepEqual(await imageVersions(eventId), before);

  // Approving design-source colours (even unlinked) stores no override.
  const unlinked: OverlayColours = {
    ...state.defaultColours,
    round: {
      linked: false,
      colour: state.defaultColours.round.colour,
      sessions: {
        qualifying: state.defaultColours.round.colour,
        race: state.defaultColours.round.colour,
      },
    },
  };
  await call(studio.approve, eventId, "POST", {
    versionId: current.id,
    colours: unlinked,
  });
  assert.equal(await store.overlay("melbourne:2026"), undefined);
  assert.deepEqual(await imageVersions(eventId), before);

  // A recoloured logo is rendered from the recoloured source SVG.
  await call(studio.approve, eventId, "POST", {
    versionId: null,
    colours: pink,
  });
  const svg = await artwork.svg((await store.event(eventId))!, "race");
  const logo = /href="data:image\/svg\+xml;base64,([^"]+)"/.exec(svg)![1];
  assert.match(Buffer.from(logo, "base64").toString(), /fill="#ff69b4"/);

  // Versions from another weekend cannot be selected or approved.
  const other = (await open("2026-singapore")).versions[0];
  for (const response of [
    await call(studio.saveDraft, eventId, "PUT", {
      selectedVersionId: other.id,
      colours: pink,
    }),
    await call(studio.approve, eventId, "POST", {
      versionId: other.id,
      colours: pink,
    }),
    await call(studio.generate, eventId, "POST", {
      feedback: "Brighter sky",
      baseVersionId: other.id,
    }),
  ])
    assert.equal(response.status, 400);

  // Invalid colours are rejected.
  const invalid = await call(studio.saveDraft, eventId, "PUT", {
    selectedVersionId: null,
    colours: { ...pink, title: { linked: true, colour: "red", sessions: {} } },
  });
  assert.equal(invalid.status, 400);

  // A model without reference-image input cannot revise, and spends nothing.
  await store.set("settings", {
    ...(await store.settings()),
    modelId: "fixture/text-only",
  });
  const blocked = await call(studio.generate, eventId, "POST", {
    feedback: "Brighter sky",
    baseVersionId: current.id,
  });
  assert.equal(blocked.status, 400);
  assert.equal((await open(eventId)).generation.referenceImages, false);
  assert.equal(await store.attempts(), 0);
  assert.equal(sent.length, 0);

  // Uploads become a selected version; previews are served resized.
  const upload = await call(studio.upload, eventId, "POST", {
    image: `data:image/png;base64,${(await solid(10, 200, 10)).toString("base64")}`,
  });
  const uploaded = (await upload.json()) as StudioState;
  const added = uploaded.versions.at(-1)!;
  assert.equal(added.source, "upload");
  assert.equal(uploaded.draft?.selectedVersionId, added.id);
  const preview = await call(studio.versionImage, eventId, "GET", undefined, {
    versionId: added.id,
  });
  assert.equal(preview.headers.get("Content-Type"), "image/jpeg");
  const metadata = await sharp(await preview.arrayBuffer()).metadata();
  assert.equal(metadata.width, 1920);

  // Archived weekends are read-only.
  const archived = {
    ...(await store.event(eventId))!,
    id: "2026-archived",
    cancelled: true,
  };
  await store.saveEvent(archived);
  const refused = await call(studio.generate, archived.id, "POST", {});
  assert.equal(refused.status, 400);
});
