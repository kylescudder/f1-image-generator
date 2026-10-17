import express, { type Request, type RequestHandler } from "express";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { z } from "zod";
import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { config as defaults } from "./config.ts";
import { Store } from "./db.ts";
import { Artwork } from "./artwork.ts";
import { OpenRouter } from "./openrouter.ts";
import { Emby } from "./emby.ts";
import { Jobs } from "./jobs.ts";
import { ownerDecision, sameOrigin } from "./security.ts";
import { sessionKeys, type SessionKey } from "../shared/types.ts";
import { syncInterval } from "./calendar.ts";

export interface Services {
  store: Store;
  artwork: Artwork;
  router: OpenRouter;
  emby: Emby;
  jobs: Jobs;
  config: typeof defaults;
}
export function safeError(error: unknown, secrets: string[]) {
  let message =
    error instanceof Error ? error.message : "Something went wrong. Try again.";
  for (const secret of secrets)
    if (secret) message = message.replaceAll(secret, "[redacted]");
  return message.slice(0, 1000);
}
export function createApp(
  services: Services,
  testAuth?: {
    middleware: RequestHandler;
    identity: (req: Request) => {
      userId: string | null;
      isAuthenticated: boolean;
    };
  },
) {
  const { store, artwork, router, emby, jobs, config } = services;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  const configured = Boolean(
    config.clerkPublishableKey && config.clerkSecretKey && config.ownerId,
  );
  app.use((_req, res, next) => {
    res.setHeader(
      "X-Paddock-Revision",
      process.env.PADDOCK_REVISION || "development",
    );
    next();
  });
  app.get("/api/health", (_req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json({
        ok: true,
        revision: process.env.PADDOCK_REVISION || "development",
      }),
  );
  app.get("/api/config", (_req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json({
        clerkPublishableKey: config.clerkPublishableKey,
        authConfigured: configured,
      }),
  );
  app.get("/api/library", (req, res) => {
    const years = [
      ...new Set(store.events().map((event) => event.season)),
    ].sort((a, b) => b - a);
    const year = Number(
      req.query.season ||
        (years.includes(new Date().getUTCFullYear())
          ? new Date().getUTCFullYear()
          : years[0]),
    );
    if (!years.includes(year)) {
      res.status(404).json({ error: "Season not found." });
      return;
    }
    const lastSync = store.get<string | null>("lastSync", null);
    res.setHeader("Cache-Control", "no-cache");
    res.json({
      seasons: years,
      season: year,
      events: store.events(year).map((event) => artwork.libraryEvent(event)),
      lastSync,
      nextSync: lastSync
        ? new Date(Date.parse(lastSync) + syncInterval).toISOString()
        : null,
      syncError: store.get("syncError", null),
      frozen: store.get(`frozen:${year}`, false),
    });
  });
  // Public routes are read-only. No public route invokes an inference provider.
  app.get("/images/:season/:slug/:session.:format", async (req, res) => {
    const event = store.event(`${req.params.season}-${req.params.slug}`);
    const session = req.params.session as SessionKey;
    if (
      !event ||
      !sessionKeys(event.sprint).includes(session) ||
      !["png", "svg"].includes(String(req.params.format))
    ) {
      res.status(404).end();
      return;
    }
    const width = [640, 1920, 3840].includes(Number(req.query.width))
      ? Number(req.query.width)
      : 3840;
    const etag = `"${artwork.version(event, session)}-${req.params.format}-${width}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }
    if (req.query.download === "1")
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${event.season}-${event.slug}-${session}.${req.params.format}"`,
      );
    if (req.params.format === "svg") {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
      );
      res.type("image/svg+xml").send(await artwork.svg(event, session));
    } else res.type("png").send(await artwork.png(event, session, width));
  });
  app.use("/api/admin", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  if (testAuth) app.use("/api/admin", testAuth.middleware);
  else if (configured)
    app.use(
      "/api/admin",
      clerkMiddleware({
        publishableKey: config.clerkPublishableKey,
        authorizedParties: [config.appUrl],
      }),
    );
  app.use(
    "/api/admin",
    (req, res, next) => {
      if (!configured && !testAuth) {
        res
          .status(503)
          .json({
            error:
              "Owner access is not configured. Set Clerk keys and CLERK_OWNER_USER_ID on Herman.",
          });
        return;
      }
      const identity = testAuth ? testAuth.identity(req) : getAuth(req);
      const status = ownerDecision(identity, config.ownerId);
      if (status !== 200) {
        res
          .status(status)
          .json({
            error:
              status === 401
                ? "Sign in to manage your library."
                : status === 403
                  ? "This library is managed by its owner only."
                  : "Owner access is not configured.",
          });
        return;
      }
      next();
    },
    sameOrigin(config.appUrl),
    express.json({ limit: "30mb" }),
  );
  app.get("/api/admin/me", (_req, res) => res.json({ owner: true }));
  app.get("/api/admin/status", (_req, res) =>
    res.json({
      settings: store.settings(),
      configured: {
        openrouter: Boolean(config.openrouterKey),
        emby: emby.configured,
      },
      generationsThisMonth: store.attempts(),
      jobs: store.jobs(),
      mappings: store.mappings(),
    }),
  );
  app.get("/api/admin/events", (_req, res) =>
    res.json(store.events().map((event) => artwork.libraryEvent(event))),
  );
  app.get("/api/admin/models", async (req, res) =>
    res.json(await router.models(req.query.refresh === "true")),
  );
  app.post("/api/admin/settings", async (req, res) => {
    const settings = z
      .object({
        modelId: z.string().max(200),
        monthlyGenerationLimit: z.number().int().min(0).max(100),
        autoGenerate: z.boolean(),
        resolution: z.string().max(40),
        quality: z.string().max(40),
        embyLibraryId: z.string().max(100),
      })
      .strict()
      .parse(req.body);
    if (settings.modelId) {
      const catalog = await router.models();
      if (!catalog.models.some((model) => model.id === settings.modelId)) {
        res
          .status(400)
          .json({
            error:
              "Choose a model from the current image-generation catalogue.",
          });
        return;
      }
    }
    store.set("settings", settings);
    res.json(settings);
    jobs.autoGenerate();
  });
  app.post("/api/admin/sync", (_req, res) => res.status(202).json(jobs.sync()));
  app.post("/api/admin/emby/sync", (_req, res) =>
    res.status(202).json(jobs.syncEmby()),
  );
  app.post("/api/admin/generate", (req, res) => {
    const { eventId } = z
      .object({ eventId: z.string().max(200) })
      .strict()
      .parse(req.body);
    res.status(202).json(jobs.generate(eventId));
  });
  app.post("/api/admin/background", async (req, res) => {
    const { eventId, image } = z
      .object({
        eventId: z.string().max(200),
        image: z
          .string()
          .max(28_000_000)
          .regex(/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=\r\n]+$/),
      })
      .strict()
      .parse(req.body);
    const event = store.event(eventId);
    if (!event) {
      res.status(404).json({ error: "Weekend not found." });
      return;
    }
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
    store.saveBackground(`${event.venueKey}:${event.season}`, file, version);
    res.json({ ok: true });
    if (emby.configured) {
      try {
        jobs.syncEmby();
      } catch {
        /* an update is already in progress */
      }
    }
  });
  app.get("/api/admin/emby/libraries", async (_req, res) =>
    res.json(await emby.libraries()),
  );
  app.get("/api/admin/emby/candidates", async (_req, res) =>
    res.json(await emby.candidates()),
  );
  app.post("/api/admin/emby/mappings", (req, res) => {
    const values = z
      .array(
        z
          .object({
            eventId: z.string().max(200),
            session: z.enum([
              "qualifying",
              "race",
              "sprint-qualifying",
              "sprint",
            ]),
            itemId: z.string().min(1).max(100),
            itemName: z.string().max(1000),
          })
          .strict(),
      )
      .max(1000)
      .parse(req.body);
    for (const item of values) {
      const event = store.event(item.eventId);
      if (
        !event ||
        event.cancelled ||
        !sessionKeys(event.sprint).includes(item.session)
      ) {
        res
          .status(400)
          .json({ error: "Mapping includes an unavailable event or session." });
        return;
      }
    }
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of values) {
        const previous = store
          .mappings()
          .find(
            (mapping) =>
              mapping.eventId === item.eventId &&
              mapping.session === item.session,
          );
        store.saveMapping({
          ...item,
          lastImageVersion:
            previous?.itemId === item.itemId ? previous.lastImageVersion : null,
          lastSyncedAt:
            previous?.itemId === item.itemId ? previous.lastSyncedAt : null,
          error: null,
        });
      }
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    res.json({ saved: values.length });
  });
  app.delete("/api/admin/emby/mappings/:eventId/:session", (req, res) => {
    store.db
      .prepare("DELETE FROM mappings WHERE eventId=? AND session=?")
      .run(String(req.params.eventId), String(req.params.session));
    res.json({ ok: true });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  app.use(
    (
      error: unknown,
      _req: Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const message =
        error instanceof z.ZodError
          ? "Some fields are invalid. Check your settings and try again."
          : safeError(error, [
              config.openrouterKey,
              config.embyKey,
              config.clerkSecretKey,
            ]);
      const status =
        error instanceof z.ZodError
          ? 400
          : /already queued|UNIQUE constraint|already.*running/.test(message)
            ? 409
            : /limit reached/.test(message)
              ? 429
              : 500;
      res.status(status).json({ error: message });
    },
  );
  return app;
}
