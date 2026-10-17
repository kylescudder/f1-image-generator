import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Job } from "../shared/types.ts";
import { Store } from "./db.ts";
import { Artwork } from "./artwork.ts";
import { OpenRouter } from "./openrouter.ts";
import { Emby } from "./emby.ts";
import { syncCalendars, syncInterval } from "./calendar.ts";

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
  private enqueue(
    kind: Job["kind"],
    eventId: string | null,
    key: string,
    run: () => Promise<string>,
  ): Job {
    if (this.pending.has(key))
      throw new Error("This task is already queued or running.");
    const job = this.store.createJob(kind, eventId, "Waiting to start");
    this.pending.add(key);
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
    setImmediate(() => void this.drain());
    return job;
  }
  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        this.store.updateJob(item.job.id, "running", "Working…");
        try {
          this.store.updateJob(item.job.id, "completed", await item.run());
        } catch (error) {
          const message = this.redact(error);
          this.store.updateJob(item.job.id, "failed", message);
          if (item.job.kind === "sync") this.store.set("syncError", message);
          if (item.job.kind === "generate" && item.job.eventId) {
            const event = this.store.event(item.job.eventId);
            if (event)
              this.store.set(
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
      this.autoGenerate();
      return `${result}. ${embyResult}`;
    });
  }
  syncEmby() {
    return this.enqueue("emby", null, "emby", () => this.emby.sync());
  }
  generate(eventId: string) {
    const event = this.store.event(eventId);
    if (!event) throw new Error("Weekend not found.");
    if (event.cancelled)
      throw new Error("Generation is disabled for archived weekends.");
    if (!this.enabled || !this.inferenceReady)
      throw new Error(
        "Configure Clerk owner access and OPENROUTER_API_KEY before generating.",
      );
    if (!this.store.settings().modelId)
      throw new Error("Choose an image-generation model in Settings first.");
    return this.enqueue(
      "generate",
      eventId,
      `generate:${event.venueKey}`,
      async () => {
        const settings = this.store.settings();
        const catalog = await this.router.models();
        const model = catalog.models.find(
          (model) => model.id === settings.modelId,
        );
        if (!model)
          throw new Error(
            "The selected model is no longer available. Refresh models and select another.",
          );
        const referenceAsset =
          this.artwork.manifest.backgrounds["montreal"] ||
          Object.values(this.artwork.manifest.backgrounds)[0];
        const referenceBytes = await sharp(
          await readFile(path.join(this.artwork.root, referenceAsset.file)),
        )
          .resize(1152, 648)
          .jpeg({ quality: 85 })
          .toBuffer();
        const reference = `data:image/jpeg;base64,${referenceBytes.toString("base64")}`;
        const prompt = `Create one Formula 1 Grand Prix thumbnail background, matching the supplied reference's richly textured retro travel-poster illustration style. Actual venue: ${event.circuit}, ${event.locality}, ${event.country}. Depict the actual circuit and appropriate local landmarks, with a red open-wheel racing car large in the lower foreground, dynamic track perspective, rich atmospheric lighting and a limited cinematic palette. Use 16:9 landscape composition. Keep the upper third relatively calm and dark enough for a centered venue title and a smaller session label. Leave bottom-right space for a cream year/round caption. Background art only: no words, numbers, captions, logos, watermarks or lettering. The event is ${event.name}, but the depicted physical location MUST be ${event.locality}, ${event.country}; do not reuse scenery from an event's former location.`;
        // Reserve durably before the request; failures/retries also consume an attempt.
        if (
          !this.store.reserveAttempt(model.id, settings.monthlyGenerationLimit)
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
        const version = createHash("sha256")
          .update(image)
          .digest("hex")
          .slice(0, 24);
        const directory = path.join(this.artwork.dataDir, "backgrounds");
        await mkdir(directory, { recursive: true });
        const file = path.join(directory, `${event.venueKey}-${version}.png`);
        await writeFile(`${file}.tmp`, image);
        await rename(`${file}.tmp`, file);
        this.store.saveBackground(
          `${event.venueKey}:${event.season}`,
          file,
          version,
        );
        this.store.set(`generation:${version}`, {
          model: model.id,
          prompt,
          createdAt: new Date().toISOString(),
          cost: result.cost ?? null,
        });
        const embyResult = await this.emby.sync();
        return `Background ready for ${event.locality}; all session variants updated. ${embyResult}${result.cost !== undefined ? ` OpenRouter reported $${result.cost.toFixed(4)}.` : ""}`;
      },
    );
  }
  autoGenerate() {
    const settings = this.store.settings();
    if (
      !settings.autoGenerate ||
      !settings.modelId ||
      !this.enabled ||
      !this.inferenceReady
    )
      return;
    // Generate only for open seasons, once per physical venue. Failed tasks need an owner retry.
    const venues = new Set<string>();
    for (const event of this.store.events().reverse()) {
      if (
        event.cancelled ||
        this.store.get(`frozen:${event.season}`, false) ||
        this.artwork.background(event) ||
        venues.has(event.venueKey)
      )
        continue;
      venues.add(event.venueKey);
      if (
        this.store.get(`generationFailure:${event.venueKey}`, "") ===
        new Date().toISOString().slice(0, 7)
      )
        continue;
      if (this.store.attempts() >= settings.monthlyGenerationLimit) break;
      try {
        this.generate(event.id);
      } catch {
        /* already running or waiting for configuration */
      }
    }
  }
  start() {
    const tick = () => {
      const last = this.store.get<string | null>("lastSync", null);
      const attempted = this.store.get<string | null>("lastSyncAttempt", null);
      // Network failures retry hourly; successful checks follow the six-hour policy.
      if (
        (!last || Date.now() - Date.parse(last) >= syncInterval) &&
        (!attempted || Date.now() - Date.parse(attempted) >= 3600000)
      ) {
        this.store.set("lastSyncAttempt", new Date().toISOString());
        try {
          this.sync();
        } catch {
          /* a sync is already running */
        }
      }
    };
    this.timer = setInterval(tick, 60000);
    this.timer.unref();
    setImmediate(tick);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
