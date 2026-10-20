import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type {
  AppSettings,
  ImageModel,
  Job,
  RaceEvent,
} from "../shared/types.ts";
import { Store } from "./db.ts";
import { Artwork } from "./artwork.ts";
import { OpenRouter } from "./openrouter.ts";
import { Emby } from "./emby.ts";
import { syncCalendars, syncInterval } from "./calendar.ts";
import { RequestError } from "./errors.ts";

export async function saveImage(
  dataDir: string,
  venueKey: string,
  image: Buffer,
) {
  const version = createHash("sha256").update(image).digest("hex").slice(0, 24);
  const directory = path.join(dataDir, "backgrounds");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${venueKey}-${version}.png`);
  await writeFile(`${file}.tmp`, image);
  await rename(`${file}.tmp`, file);
  return { file, version };
}
const constraints =
  "Use 16:9 landscape composition. Keep the upper third relatively calm and dark enough for a centered venue title and a smaller session label. Leave bottom-right space for a cream year/round caption. Background art only: no words, numbers, captions, logos, watermarks or lettering.";
export function backgroundPrompt(event: RaceEvent, direction?: string) {
  return `Create one Formula 1 Grand Prix thumbnail background, matching the supplied reference's richly textured retro travel-poster illustration style. Actual venue: ${event.circuit}, ${event.locality}, ${event.country}. Depict the actual circuit and appropriate local landmarks, with a red open-wheel racing car large in the lower foreground, dynamic track perspective, rich atmospheric lighting and a limited cinematic palette. ${constraints} The event is ${event.name}, but the depicted physical location MUST be ${event.locality}, ${event.country}; do not reuse scenery from an event's former location.${direction ? ` Additional direction from the artwork owner: ${direction}` : ""}`;
}
export function revisionPrompt(event: RaceEvent, feedback: string) {
  return `Revise the supplied Formula 1 Grand Prix thumbnail background for ${event.circuit}, ${event.locality}, ${event.country}. Apply this change: ${feedback}. Keep everything else about the image the same: its illustration style, composition, venue and lighting. ${constraints}`;
}

export class Jobs {
  private queue: { job: Job; run: () => Promise<string> }[] = [];
  private busy = false;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private store: Store,
    private artwork: Artwork,
    private router: OpenRouter,
    private emby: Emby,
    private enabled: boolean,
    private inferenceReady: boolean,
    private redact: (error: unknown) => string,
  ) {}
  private async enqueue(
    kind: Job["kind"],
    eventId: string | null,
    key: string,
    run: () => Promise<string>,
  ): Promise<Job> {
    if (this.pending.has(key))
      throw new Error("This task is already queued or running.");
    this.pending.add(key);
    let job: Job;
    try {
      job = await this.store.createJob(kind, eventId, "Waiting to start");
    } catch (error) {
      this.pending.delete(key);
      throw error;
    }
    this.queue.push({
      job,
      run: async () => {
        try {
          return await run();
        } finally {
          this.pending.delete(key);
        }
      },
    });
    setImmediate(
      () => void this.drain().catch((error) => console.error(error)),
    );
    return job;
  }
  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        await this.store.updateJob(item.job.id, "running", "Working…");
        try {
          await this.store.updateJob(
            item.job.id,
            "completed",
            await item.run(),
          );
        } catch (error) {
          const message = this.redact(error);
          await this.store.updateJob(item.job.id, "failed", message);
          if (item.job.kind === "sync")
            await this.store.set("syncError", message);
          if (item.job.kind === "generate" && item.job.eventId) {
            const event = await this.store.event(item.job.eventId);
            if (event)
              await this.store.set(
                `generationFailure:${event.venueKey}`,
                new Date().toISOString().slice(0, 7),
              );
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }
  sync() {
    return this.enqueue("sync", null, "sync", async () => {
      const result = await syncCalendars(this.store);
      const embyResult = await this.emby.sync();
      await this.autoGenerate();
      return `${result}. ${embyResult}`;
    });
  }
  syncEmby() {
    return this.enqueue("emby", null, "emby", () => this.emby.sync());
  }
  private async ready(eventId: string) {
    const event = await this.store.event(eventId);
    if (!event) throw new Error("Weekend not found.");
    if (event.cancelled)
      throw new Error("Generation is disabled for archived weekends.");
    if (!this.enabled || !this.inferenceReady)
      throw new Error(
        "Configure Clerk sign-in and OPENROUTER_API_KEY before generating.",
      );
    if (!(await this.store.settings()).modelId)
      throw new Error("Choose an image-generation model in Settings first.");
    return event;
  }
  private async model() {
    const settings = await this.store.settings();
    const model = (await this.router.models()).models.find(
      (model) => model.id === settings.modelId,
    );
    if (!model)
      throw new Error(
        "The selected model is no longer available. Refresh models and select another.",
      );
    return { model, settings };
  }
  private async reference(file: string) {
    const bytes = await sharp(await readFile(file), {
      limitInputPixels: 40_000_000,
    })
      .resize(1152, 648, { fit: "cover" })
      .jpeg({ quality: 85 })
      .toBuffer();
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  }
  // One paid request: reserve an attempt, generate, and store the image file.
  private async produce(
    event: RaceEvent,
    model: ImageModel,
    settings: AppSettings,
    prompt: string,
    reference: string,
  ) {
    // Reserve durably before the request; failures/retries also consume an attempt.
    if (
      !(await this.store.reserveAttempt(
        model.id,
        settings.monthlyGenerationLimit,
      ))
    )
      throw new Error(
        "Monthly background-generation limit reached. Change the allowance in Settings or wait until next month.",
      );
    const result = await this.router.generate(
      model,
      prompt,
      reference,
      settings.resolution,
      settings.quality,
    );
    const image = await sharp(result.bytes, {
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .png()
      .toBuffer();
    const { file, version } = await saveImage(
      this.artwork.dataDir,
      event.venueKey,
      image,
    );
    await this.store.set(`generation:${version}`, {
      model: model.id,
      prompt,
      createdAt: new Date().toISOString(),
      cost: result.cost ?? null,
    });
    const cost =
      result.cost !== undefined
        ? ` OpenRouter reported $${result.cost.toFixed(4)}.`
        : "";
    return { file, version, cost };
  }
  private styleReference() {
    const asset =
      this.artwork.manifest.backgrounds["montreal"] ||
      Object.values(this.artwork.manifest.backgrounds)[0];
    return this.reference(path.join(this.artwork.root, asset.file));
  }
  async generate(eventId: string) {
    const event = await this.ready(eventId);
    return this.enqueue(
      "generate",
      eventId,
      `generate:${event.venueKey}`,
      async () => {
        const { model, settings } = await this.model();
        const { file, version, cost } = await this.produce(
          event,
          model,
          settings,
          backgroundPrompt(event),
          await this.styleReference(),
        );
        await this.store.saveBackground(
          `${event.venueKey}:${event.season}`,
          file,
          version,
        );
        const embyResult = await this.emby.sync();
        return `Background ready for ${event.locality}; all session variants updated. ${embyResult}${cost}`;
      },
    );
  }
  // Tells the studio whether image requests can run, without spending anything.
  async generationStatus() {
    const reason = !this.enabled
      ? "Configure Clerk sign-in before generating."
      : !this.inferenceReady
        ? "Add OPENROUTER_API_KEY on the host to generate images."
        : !(await this.store.settings()).modelId
          ? "Choose an image-generation model in Settings first."
          : "";
    if (reason) return { ready: false, referenceImages: false, reason };
    try {
      const { model } = await this.model();
      return {
        ready: true,
        referenceImages: model.inputModalities.includes("image"),
        reason: "",
      };
    } catch (error) {
      return {
        ready: false,
        referenceImages: false,
        reason: this.redact(error),
      };
    }
  }
  // Studio requests add a draft version; nothing changes until it is approved.
  async studio(
    eventId: string,
    request: { feedback?: string; direction?: string; baseVersionId?: string },
  ) {
    const event = await this.ready(eventId);
    const venue = `${event.venueKey}:${event.season}`;
    const base = request.baseVersionId
      ? await this.store.studioVersion(request.baseVersionId)
      : undefined;
    const { model, settings } = await this.model();
    if (request.feedback !== undefined) {
      if (!base || base.venue !== venue)
        throw new RequestError("Choose a version of this weekend to revise.");
      if (!model.inputModalities.includes("image"))
        throw new RequestError(
          "The selected model can't take a reference image, so it can't revise a version. Choose a model with reference image support in Settings.",
        );
    }
    if ((await this.store.attempts()) >= settings.monthlyGenerationLimit)
      throw new Error(
        "Monthly background-generation limit reached. Change the allowance in Settings or wait until next month.",
      );
    return this.enqueue(
      "studio",
      eventId,
      `generate:${event.venueKey}`,
      async () => {
        const { model, settings } = await this.model();
        const feedback = request.feedback;
        const prompt =
          feedback !== undefined
            ? revisionPrompt(event, feedback)
            : backgroundPrompt(event, request.direction);
        const { file, version, cost } = await this.produce(
          event,
          model,
          settings,
          prompt,
          feedback !== undefined && base
            ? await this.reference(base.file)
            : await this.styleReference(),
        );
        const added = await this.store.addStudioVersion({
          venue,
          file,
          version,
          source: feedback !== undefined ? "feedback" : "generate",
          parentId: feedback !== undefined && base ? base.id : null,
          feedback: feedback ?? request.direction ?? null,
          prompt,
          model: model.id,
        });
        const draft = await this.store.studioDraft(venue);
        await this.store.saveStudioDraft(venue, {
          selectedVersionId: added.id,
          colours: draft?.colours ?? (await this.artwork.colours(event)),
        });
        return `New studio version ready for ${event.locality}. It stays a draft until you use it.${cost}`;
      },
    );
  }
  async autoGenerate() {
    const settings = await this.store.settings();
    if (
      !settings.autoGenerate ||
      !settings.modelId ||
      !this.enabled ||
      !this.inferenceReady
    )
      return;
    // Generate only for open seasons, once per physical venue. Failed tasks need an owner retry.
    const venues = new Set<string>();
    const index = await this.store.backgrounds();
    for (const event of (await this.store.events()).reverse()) {
      if (
        event.cancelled ||
        (await this.store.get(`frozen:${event.season}`, false)) ||
        (await this.artwork.background(event, index)) ||
        venues.has(event.venueKey)
      )
        continue;
      venues.add(event.venueKey);
      if (
        (await this.store.get(`generationFailure:${event.venueKey}`, "")) ===
        new Date().toISOString().slice(0, 7)
      )
        continue;
      if ((await this.store.attempts()) >= settings.monthlyGenerationLimit)
        break;
      try {
        await this.generate(event.id);
      } catch {
        /* already running or waiting for configuration */
      }
    }
  }
  start() {
    const tick = async () => {
      const last = await this.store.get<string | null>("lastSync", null);
      const attempted = await this.store.get<string | null>(
        "lastSyncAttempt",
        null,
      );
      // Network failures retry hourly; successful checks follow the six-hour policy.
      if (
        (!last || Date.now() - Date.parse(last) >= syncInterval) &&
        (!attempted || Date.now() - Date.parse(attempted) >= 3600000)
      ) {
        await this.store.set("lastSyncAttempt", new Date().toISOString());
        try {
          await this.sync();
        } catch {
          /* a sync is already running */
        }
      }
    };
    // A failed tick (e.g. the database restarting) is retried on the next minute.
    const guarded = () => void tick().catch((error) => console.error(error));
    this.timer = setInterval(guarded, 60000);
    this.timer.unref();
    setImmediate(guarded);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
