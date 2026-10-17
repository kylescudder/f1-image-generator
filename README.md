<img src="assets/icon.svg" width="48" height="48" alt="">

# Paddock

A calendar-aware Formula 1 artwork library for **paddock.thescudders.org**, hosted on Herman. Imports the existing 2025/2026 illustrations and removes the Illustrator overlay step.

- Season/weekend gallery, full-size viewer, hover/focus copy-image button, stable URLs, PNG downloads and self-contained hybrid SVG masters.
- Measured Formula1 typography, vector logo, per-venue colours, and current year/round. Normal weekends get two competitive sessions; sprint weekends get four.
- Six-hour calendar checks and **Sync now**. Stable event identities survive round changes and relocations; cancellations are archived and completed seasons freeze after their final calendar.
- **Clerk owner-only administration.** Every protected API checks the verified Clerk user ID against `CLERK_OWNER_USER_ID`. Other accounts cannot generate, change settings, inspect Emby, or run sync controls. Missing owner configuration denies all admin access and disables scheduled inference.
- **OpenRouter image generation.** Settings discovers image models live, combining the dedicated Image API catalogue with older chat image models. No hardcoded model list or default paid model. Provider capabilities are checked before requests; unsupported parameters are omitted. Catalogue caching is one hour, with refresh and stale-cache indicators.
- Missing venue backgrounds are generated once and reused. Initially five attempts per UTC month, persisted in SQLite, including failures. Allowance and model are owner settings. Existing background/session/round composition makes no inference calls.
- Reviewed Emby episode mappings and automatic direct PNG uploads. The app updates Emby's stored artwork rather than relying on changed hosted bytes.

## Local development

Requires Node **24+**, npm, and Python 3 only for optional archive reimport.

```sh
npm ci
npm run setup
npm run dev
```

Open **http://localhost:3000**. The gallery works immediately without credentials. Setup downloads matching font families from official F1 assets into ignored `data/fonts/`; production images cache them for offline startup. Fonts are rendered into vector paths and are not served as font files.

For integrations, copy `.env.example` to `.env` and supply environment values locally or on Herman. Never commit `.env` or paste keys into issues/chat.

```sh
npm test
npm run build
NODE_ENV=production npm start
```

Standalone Docker: `docker compose -f compose.local.yaml up --build -d`. Herman uses root `compose.yaml` with its existing platform network and an attested immutable image.

## Clerk and OpenRouter

Set `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and your exact `CLERK_OWNER_USER_ID` server-side. Configure Clerk's URLs for `https://paddock.thescudders.org` and restrict sign-ups to your account in its dashboard. The server ID check remains authoritative even if another account can sign in. No first-user-becomes-owner behavior exists.

Set `OPENROUTER_API_KEY`, restart the app, then sign into **Owner workspace → Settings**. Choose a live image model, supported quality/resolution, allowance, and whether to fill missing venues automatically. Saving with automation enabled queues missing active venues. Public visitors and non-owner accounts cannot reach the provider. Keys never enter the frontend build or API responses.

Discovery uses `GET /api/v1/images/models` and `GET /api/v1/models?output_modalities=image&sort=newest`. Dedicated image models use `/api/v1/images`; legacy image chat models use `/api/v1/chat/completions`. New models appear without code changes. The allowance limits **attempt count**, not a guaranteed dollar budget. OpenRouter bills usage separately. Provider failures are visible in Activity and are not silently retried with another paid model.

Original illustrations are raster, even inside Illustrator. SVG masters embed them with vector text/logo paths; PNG exports are 3840×2160. Raster backgrounds retain their original detail. Madrid and Sepang have no matching original illustration and remain pending until generated or uploaded; Sakhir's artwork is preserved for 2025, not relabelled as Sepang.

## Emby

Set `EMBY_URL` (reachable from Herman) and an administrator `EMBY_API_KEY`. In **Owner workspace → Emby**, load libraries, choose/save F1, and inspect episodes. Review year/venue/session suggestions, save correct mappings, then use **Update Emby now**. Ambiguous matches need an explicit choice. Both seasons are available for mapping.

Mappings use persistent event/session identities rather than round numbers. Paddock uploads base64 PNGs to Emby's Primary episode-image endpoint and remembers each rendered version. Failures stay visible and retryable; placeholders and cancelled sessions are not pushed over existing artwork. Keys remain environment-only.

## Hosting and data

See [Herman deployment](deploy/README.md) and [Herman handoff](docs/herman-handoff.md). GitHub Actions publishes attested multi-platform images; Herman's existing Cloudflare Access → Tunnel → Caddy pattern queues verified deployments with backups and rollback.

SQLite state, generated backgrounds and cached exports live in persistent `data/`. Run one app instance for the scheduler/queue; no separate Postgres service is needed. Later-season background overrides do not change completed seasons.

## Sources and checks

- [Artwork audit](docs/artwork-audit.md): 48 Illustrator files, 126 artboards, 25 original backgrounds.
- [Font sources](docs/font-sources.md); `assets/artwork.json` contains measured layouts and provenance.
- `python3 scripts/import-archive.py --archive ~/Archive.zip` reproduces the import with checked-in measurements. Optional `--inspect-ai` rebuilds measurements using PyMuPDF.
- `npm test` checks authorization, limits, discovery, rendering, calendar reconciliation and Emby uploads with isolated test providers.
- Deploy tests cover signature/timestamp/path/queue gates, provenance rejection, backup failure and rollback.

Primary references: [Clerk](https://clerk.com/docs/reference/express/overview), [OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/image-generation), [Jolpica](https://github.com/jolpica/jolpica-f1/blob/main/docs/endpoints/races.md), [Emby](https://dev.emby.media/reference/RestAPI/ImageService/postItemsByIdImagesByType.html).
