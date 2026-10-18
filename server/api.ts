import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { buildLibrary, SeasonNotFound } from "./library.ts";
import { admin } from "./guard.ts";
import { errorResponse } from "./errors.ts";
import { services } from "./services.ts";
import { sessionKeys, type SessionKey } from "../shared/types.ts";

// Framework-agnostic request handlers; src/routes only maps URLs onto these.

export const health = () =>
  Response.json(
    { ok: true, revision: process.env.PADDOCK_REVISION || "development" },
    { headers: { "Cache-Control": "no-store" } },
  );

export async function library(request: Request) {
  try {
    const requested = new URL(request.url).searchParams.get("season");
    return Response.json(await buildLibrary(Number(requested) || undefined), {
      headers: { "Cache-Control": "no-cache" },
    });
  } catch (error) {
    if (error instanceof SeasonNotFound)
      return Response.json({ error: error.message }, { status: 404 });
    return errorResponse(error);
  }
}

// Public routes are read-only. No public route invokes an inference provider.
export async function image(
  request: Request,
  params: { season: string; slug: string; file: string },
) {
  try {
    const match = /^(.+)\.(png|svg)$/.exec(params.file);
    const { store, artwork } = await services();
    const event = await store.event(`${params.season}-${params.slug}`);
    const session = match?.[1] as SessionKey | undefined;
    if (
      !match ||
      !event ||
      !session ||
      !sessionKeys(event.sprint).includes(session)
    )
      return new Response(null, { status: 404 });
    const format = match[2];
    const query = new URL(request.url).searchParams;
    const width = [640, 1920, 3840].includes(Number(query.get("width")))
      ? Number(query.get("width"))
      : 3840;
    const etag = `"${await artwork.version(event, session)}-${format}-${width}"`;
    const headers: Record<string, string> = {
      ETag: etag,
      "Cache-Control": "public, max-age=0, must-revalidate",
    };
    if (request.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers });
    if (query.get("download") === "1")
      headers["Content-Disposition"] =
        `attachment; filename="${event.season}-${event.slug}-${session}.${format}"`;
    if (format === "svg") {
      headers["Content-Security-Policy"] =
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
      headers["Content-Type"] = "image/svg+xml";
      return new Response(await artwork.svg(event, session), { headers });
    }
    headers["Content-Type"] = "image/png";
    return new Response(
      new Uint8Array(await artwork.png(event, session, width)),
      { headers },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

const settingsSchema = z
  .object({
    modelId: z.string().max(200),
    monthlyGenerationLimit: z.number().int().min(0).max(100),
    autoGenerate: z.boolean(),
    resolution: z.string().max(40),
    quality: z.string().max(40),
    embyLibraryId: z.string().max(100),
  })
  .strict();
const mappingsSchema = z
  .array(
    z
      .object({
        eventId: z.string().max(200),
        session: z.enum(["qualifying", "race", "sprint-qualifying", "sprint"]),
        itemId: z.string().min(1).max(100),
        itemName: z.string().max(1000),
      })
      .strict(),
  )
  .max(1000);
const backgroundSchema = z
  .object({
    eventId: z.string().max(200),
    image: z
      .string()
      .max(28_000_000)
      .regex(/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=\r\n]+$/),
  })
  .strict();

export const owner = {
  me: admin(() => Response.json({ owner: true })),
  status: admin(async (_request, { services: { store, config, emby } }) =>
    Response.json({
      settings: await store.settings(),
      configured: {
        openrouter: Boolean(config.openrouterKey),
        emby: emby.configured,
      },
      generationsThisMonth: await store.attempts(),
      jobs: await store.jobs(),
      mappings: await store.mappings(),
    }),
  ),
  events: admin(async (_request, { services: { store, artwork } }) =>
    Response.json(await artwork.libraryEvents(await store.events())),
  ),
  models: admin(async (request, { services: { router } }) =>
    Response.json(
      await router.models(
        new URL(request.url).searchParams.get("refresh") === "true",
      ),
    ),
  ),
  settings: admin(async (request, { services: { store, router, jobs } }) => {
    const settings = settingsSchema.parse(await request.json());
    if (settings.modelId) {
      const catalog = await router.models();
      if (!catalog.models.some((model) => model.id === settings.modelId))
        return Response.json(
          {
            error: "Choose a model from the current image-generation catalogue.",
          },
          { status: 400 },
        );
    }
    await store.set("settings", settings);
    setImmediate(() => void jobs.autoGenerate().catch(console.error));
    return Response.json(settings);
  }),
  sync: admin(async (_request, { services: { jobs } }) =>
    Response.json(await jobs.sync(), { status: 202 }),
  ),
  embySync: admin(async (_request, { services: { jobs } }) =>
    Response.json(await jobs.syncEmby(), { status: 202 }),
  ),
  embyLibraries: admin(async (_request, { services: { emby } }) =>
    Response.json(await emby.libraries()),
  ),
  embyCandidates: admin(async (_request, { services: { emby } }) =>
    Response.json(await emby.candidates()),
  ),
  generate: admin(async (request, { services: { jobs } }) => {
    const { eventId } = z
      .object({ eventId: z.string().max(200) })
      .strict()
      .parse(await request.json());
    return Response.json(await jobs.generate(eventId), { status: 202 });
  }),
  background: admin(
    async (request, { services: { store, config, emby, jobs } }) => {
      const { eventId, image } = backgroundSchema.parse(await request.json());
      const event = await store.event(eventId);
      if (!event)
        return Response.json({ error: "Weekend not found." }, { status: 404 });
      const bytes = await sharp(Buffer.from(image.split(",")[1], "base64"), {
        limitInputPixels: 40_000_000,
      })
        .rotate()
        .png()
        .toBuffer();
      const version = createHash("sha256")
        .update(bytes)
        .digest("hex")
        .slice(0, 24);
      const directory = path.join(config.dataDir, "backgrounds");
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, `${event.venueKey}-${version}.png`);
      await writeFile(`${file}.tmp`, bytes);
      await rename(`${file}.tmp`, file);
      await store.saveBackground(`${event.venueKey}:${event.season}`, file, version);
      if (emby.configured)
        // An update already in progress covers this change too.
        void jobs.syncEmby().catch(() => undefined);
      return Response.json({ ok: true });
    },
  ),
  saveMappings: admin(async (request, { services: { store } }) => {
    const values = mappingsSchema.parse(await request.json());
    for (const item of values) {
      const event = await store.event(item.eventId);
      if (
        !event ||
        event.cancelled ||
        !sessionKeys(event.sprint).includes(item.session)
      )
        return Response.json(
          { error: "Mapping includes an unavailable event or session." },
          { status: 400 },
        );
    }
    const existing = await store.mappings();
    await store.replaceMappings(
      values.map((item) => {
        const previous = existing.find(
          (mapping) =>
            mapping.eventId === item.eventId && mapping.session === item.session,
        );
        const same = previous?.itemId === item.itemId;
        return {
          ...item,
          lastImageVersion: same ? previous.lastImageVersion : null,
          lastSyncedAt: same ? previous.lastSyncedAt : null,
          error: null,
        };
      }),
    );
    return Response.json({ saved: values.length });
  }),
  deleteMapping: admin(
    async (_request, { params, services: { store } }) => {
      await store.deleteMapping(params.eventId, params.session);
      return Response.json({ ok: true });
    },
  ),
};
