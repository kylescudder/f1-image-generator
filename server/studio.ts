import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { admin } from "./guard.ts";
import { saveImage } from "./jobs.ts";
import type { Services } from "./services.ts";
import {
  overlayElements,
  resolveColour,
  sessionKeys,
  type OverlayColours,
  type OverlayElement,
  type RaceEvent,
  type StudioState,
} from "../shared/types.ts";

// The image studio: draft versions and overlay colours for one weekend
// (venue and season). Nothing is live until a draft is approved.

const hex = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i)
  .transform((value) => value.toLowerCase());
const colour = z
  .object({
    linked: z.boolean(),
    colour: hex,
    sessions: z
      .object({
        "sprint-qualifying": hex.optional(),
        sprint: hex.optional(),
        qualifying: hex.optional(),
        race: hex.optional(),
      })
      .strict(),
  })
  .strict();
const coloursSchema = z
  .object({ logo: colour, title: colour, session: colour, round: colour })
  .strict();
const generateSchema = z
  .object({
    feedback: z.string().trim().min(1).max(1000).optional(),
    direction: z.string().trim().max(1000).optional(),
    baseVersionId: z.string().max(100).optional(),
  })
  .strict();
const uploadSchema = z
  .object({
    image: z
      .string()
      .max(28_000_000)
      .regex(/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=\r\n]+$/),
  })
  .strict();
const draftSchema = z
  .object({
    selectedVersionId: z.string().max(100).nullable(),
    colours: coloursSchema,
  })
  .strict();
const approveSchema = z
  .object({
    versionId: z.string().max(100).nullable(),
    colours: coloursSchema,
  })
  .strict();

const venueOf = (event: RaceEvent) => `${event.venueKey}:${event.season}`;
const notFound = () =>
  Response.json({ error: "Weekend not found." }, { status: 404 });
const archived = () =>
  Response.json(
    { error: "The studio is unavailable for archived weekends." },
    { status: 400 },
  );

// Colours equal to the design source are stored as "no override", so those
// weekends keep their existing render version and Emby is not re-uploaded.
function sameColours(event: RaceEvent, a: OverlayColours, b: OverlayColours) {
  return sessionKeys(event.sprint).every((session) =>
    (Object.keys(overlayElements) as OverlayElement[]).every(
      (element) =>
        resolveColour(a, element, session) ===
        resolveColour(b, element, session),
    ),
  );
}

async function weekend(
  params: Record<string, string>,
  services: Services,
  mutable = true,
) {
  const event = await services.store.event(params.eventId);
  if (!event) return { response: notFound() };
  if (mutable && event.cancelled) return { response: archived() };
  return { event };
}

async function state(
  event: RaceEvent,
  { store, artwork, jobs }: Services,
): Promise<StudioState> {
  const venue = venueOf(event);
  const live = await artwork.background(event);
  // The live background is always available to edit, even if it was made outside the studio.
  if (live && existsSync(live.file))
    await store.addStudioVersion({
      venue,
      file: live.file,
      version: live.version,
      source: "current",
      parentId: null,
      feedback: null,
      prompt: null,
      model: null,
    });
  const versions = await store.studioVersions(venue);
  const draft = await store.studioDraft(venue);
  const settings = await store.settings();
  const base = `/api/admin/studio/${encodeURIComponent(event.id)}/versions`;
  return {
    event: {
      id: event.id,
      season: event.season,
      round: event.round,
      name: event.name,
      circuit: event.circuit,
      locality: event.locality,
      country: event.country,
      displayName: artwork.style(event).displayName,
    },
    sessions: sessionKeys(event.sprint),
    versions: versions.map((version, index) => ({
      id: version.id,
      number: index + 1,
      source: version.source,
      parentId: version.parentId,
      feedback: version.feedback,
      model: version.model,
      createdAt: version.createdAt,
      live: version.version === live?.version,
      preview: `${base}/${version.id}?width=1920`,
      thumbnail: `${base}/${version.id}?width=640`,
    })),
    draft: draft
      ? {
          ...draft,
          selectedVersionId: versions.some(
            (version) => version.id === draft.selectedVersionId,
          )
            ? draft.selectedVersionId
            : null,
        }
      : null,
    defaultColours: artwork.defaultColours(event),
    approvedColours: await artwork.colours(event),
    overlay: artwork.studioOverlay(event),
    allowance: {
      used: await store.attempts(),
      limit: settings.monthlyGenerationLimit,
    },
    generation: await jobs.generationStatus(),
    job: await store.latestJob("studio", event.id),
  };
}

export const studio = {
  state: admin(async (_request, { params, services }) => {
    const { event, response } = await weekend(params, services, false);
    if (!event) return response;
    return Response.json(await state(event, services));
  }),
  generate: admin(async (request, { params, services }) => {
    const { event, response } = await weekend(params, services);
    if (!event) return response;
    const body = generateSchema.parse(await request.json());
    return Response.json(await services.jobs.studio(event.id, body), {
      status: 202,
    });
  }),
  upload: admin(async (request, { params, services }) => {
    const { event, response } = await weekend(params, services);
    if (!event) return response;
    const { image } = uploadSchema.parse(await request.json());
    const bytes = await sharp(Buffer.from(image.split(",")[1], "base64"), {
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .png()
      .toBuffer();
    const { file, version } = await saveImage(
      services.artwork.dataDir,
      event.venueKey,
      bytes,
    );
    const venue = venueOf(event);
    const added = await services.store.addStudioVersion({
      venue,
      file,
      version,
      source: "upload",
      parentId: null,
      feedback: null,
      prompt: null,
      model: null,
    });
    const draft = await services.store.studioDraft(venue);
    await services.store.saveStudioDraft(venue, {
      selectedVersionId: added.id,
      colours: draft?.colours ?? (await services.artwork.colours(event)),
    });
    return Response.json(await state(event, services));
  }),
  saveDraft: admin(async (request, { params, services }) => {
    const { event, response } = await weekend(params, services);
    if (!event) return response;
    const draft = draftSchema.parse(await request.json());
    const venue = venueOf(event);
    if (draft.selectedVersionId) {
      const version = await services.store.studioVersion(
        draft.selectedVersionId,
      );
      if (version?.venue !== venue)
        return Response.json(
          { error: "That version belongs to a different weekend." },
          { status: 400 },
        );
    }
    await services.store.saveStudioDraft(venue, draft);
    return Response.json({ ok: true });
  }),
  discardDraft: admin(async (_request, { params, services }) => {
    const { event, response } = await weekend(params, services);
    if (!event) return response;
    await services.store.deleteStudioDraft(venueOf(event));
    return Response.json(await state(event, services));
  }),
  approve: admin(async (request, { params, services }) => {
    const { event, response } = await weekend(params, services);
    if (!event) return response;
    const { versionId, colours } = approveSchema.parse(await request.json());
    const { store, artwork, emby, jobs } = services;
    const venue = venueOf(event);
    if (versionId) {
      const version = await store.studioVersion(versionId);
      if (version?.venue !== venue)
        return Response.json(
          { error: "That version belongs to a different weekend." },
          { status: 400 },
        );
      await store.saveBackground(venue, version.file, version.version);
    }
    await store.saveOverlay(
      venue,
      sameColours(event, colours, artwork.defaultColours(event))
        ? null
        : colours,
    );
    await store.deleteStudioDraft(venue);
    if (emby.configured)
      // An update already in progress covers this change too.
      void jobs.syncEmby().catch(() => undefined);
    return Response.json(await state(event, services));
  }),
  versionImage: admin(async (request, { params, services }) => {
    const { event, response } = await weekend(params, services, false);
    if (!event) return response;
    const version = await services.store.studioVersion(params.versionId);
    if (version?.venue !== venueOf(event) || !existsSync(version.file))
      return new Response(null, { status: 404 });
    const width =
      Number(new URL(request.url).searchParams.get("width")) === 640
        ? 640
        : 1920;
    // Versions never change, so each resized preview is rendered once.
    const cached = path.join(
      services.artwork.dataDir,
      "renders",
      `studio-${version.version}-${width}.jpg`,
    );
    if (!existsSync(cached)) {
      const bytes = await sharp(version.file, { limitInputPixels: 40_000_000 })
        .resize(width, (width * 1080) / 1920, { fit: "cover" })
        .jpeg({ quality: 88 })
        .toBuffer();
      const temporary = `${cached}.${process.pid}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, cached);
    }
    return new Response(new Uint8Array(await readFile(cached)), {
      headers: { "Content-Type": "image/jpeg" },
    });
  }),
};
