# Herman session handoff

The user authorized the app, single-owner Clerk authentication, OpenRouter models discovered dynamically in Settings, automatic calendar/Emby updates, and CI/CD/Cloudflare using Herman's established pattern. Public hostname: **paddock.thescudders.org**. They explicitly deferred Clerk owner ID and integration-key setup until a Herman session has the needed permissions; do not ask them to paste keys in chat.

## Implemented

The app imports 2025/2026 artwork and measured overlays, adds Singapore sprint variants, handles reordered rounds and venue changes, serves 4K PNG/hybrid SVG at stable event/session URLs, and provides gallery/viewer/copy-image interactions. Discovery supports both OpenRouter's dedicated image API and legacy image chat models. Protected APIs verify the one allowed Clerk user on the server. Administration and inference stay closed until its ID and keys are configured.

The app needs one persistent `data/` directory and one instance. SQLite is used instead of a separate Postgres service. Madrid/Sepang backgrounds are pending; selecting an OpenRouter model with automatic filling enabled queues them, or the owner can upload artwork. No paid inference calls were made from Forge.

## Deployment to finish on Herman

Forge reaches `herman.local`, but its SSH identity was rejected. No Cloudflare DNS/Access, host services, or private Herman configuration was modified from Forge. Follow [deploy/README.md](../deploy/README.md) in a Herman-local session rather than assuming those resources exist.

1. Read `/Users/kyle/platform/runbook.md`, applicable host instructions, and current Office Tracker conventions. Use existing Colima, `platform-web`, Tunnel and Caddy; no self-hosted Actions runner or exposed Docker socket.
2. Open the reviewed checkout at `/Users/kyle/platform/apps/paddock`. Run `python3 -B deploy/bootstrap-herman.py`. It preserves private files and prepares the app-specific receiver, signing key and LaunchAgent.
3. With Herman's Cloudflare permissions, create a dedicated Service Auth app/policy/token for `deploy-paddock.thescudders.org`, allowing only `github-paddock-deploy`. Put client credentials in GitHub production secrets without displaying them. Use `scripts/hostname.py` for the exact hook path and public app route, as documented. Preserve other services/DNS.
4. Copy approved Clerk/OpenRouter/Emby values from Herman's secret store to private runtime `.env`. Configure the Clerk production domain and owner ID when permissions are ready. Missing values may remain blank for a public-gallery-only first deployment.
5. Set `DEPLOY_ENABLED=true` only after Access, hook and three production secrets exist. Run Release on main. Herman verifies provenance before starting the image; the workflow waits for public `X-Paddock-Revision` to match the commit.
6. Verify the live gallery, Clerk owner access and rejection of another account. Refresh/select an image model and allowance, generate Madrid/Sepang, then connect Emby and review mappings across both seasons. Paid inference, real Clerk sign-in, and real Emby writes were not tested without Herman credentials.

The release default `DEPLOY_ENABLED=false` allows image publishing before provisioning. Intended `PADDOCK_BASE_URL`: `https://paddock.thescudders.org`. The production environment permits main only. Secret values never belong in source, images, workflow logs or chat.

The deployer adapts current Office Tracker tooling for SQLite online backups. Failed health restores the previous image; data and immutable generated backgrounds persist. Include runtime configuration/data in Herman's established encrypted backups.
