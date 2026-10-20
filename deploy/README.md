# Paddock on the host

## Shared deployment service

This app is registered as `paddock` in the central deployment registry
`/Users/kyle/platform/deploy-core/apps.json`. LaunchAgent
`com.kylescudder.deploy-core` runs the single installed engine. Application hooks
are `deploy/hooks.py`; the receiver, credentials, queues,
state and database contracts below remain app-specific. Manual deployment uses
`./deploy/host-deploy.sh sha256:<digest>`.

Engine updates, application registration, failure inspection and service rollback
are documented in [deploy-core](https://github.com/kylescudder/deploy-core).
There are no vendored engine files, lock files or sync PRs. Do not install an
app-specific LaunchAgent. Apply future engine changes once through the central service.


Public site: **https://paddock.thescudders.org**. Deploy hook:
**https://deploy-paddock.thescudders.org/hooks/paddock**.

This follows the current Thursday Office Tracker deployment on the host: GitHub-hosted AMD64/ARM64 builds, an immutable GHCR digest and provenance attestation, Cloudflare Access Service Auth, the existing Tunnel/Caddy `platform-web` network, a restricted queue receiver, and `com.kylescudder.deploy-core` running as Colima's owner. It does not install a self-hosted Actions runner or give the receiver a Docker socket.

## Deployer

Application-specific behavior is in `hooks.py`; deployment definitions are central.

## Host setup

Run on **the host**, from a reviewed checkout. Forge currently cannot authenticate to the host over SSH; the app and release tooling can be prepared there, but hostname/Access registration needs the existing the host credentials.

```sh
mkdir -p /Users/kyle/platform/apps
git clone git@github.com:kylescudder/paddock.git /Users/kyle/platform/apps/paddock
cd /Users/kyle/platform/apps/paddock
python3 -B deploy/bootstrap-host.py <host LocalHostName>
```

The bootstrap is resumable. It creates private directories and a signing secret, sends that secret to the repository's `production` environment through stdin, starts the receiver, and prepares the receiver; register the app centrally. It preserves existing private files. It creates `.env` with blank integration credentials; copy the approved Clerk, OpenRouter, and Emby configuration from the host's existing secret store when permissions are ready. Until the Clerk keys are set, every admin endpoint is denied and no automatic inference runs. The public gallery works without integration keys.

## Cloudflare

Use the host's existing platform tooling and Cloudflare permissions. Before exposing the hook, create a **dedicated** Access application covering all of `deploy-paddock.thescudders.org`, with one **Service Auth** policy allowing only a new service token named `github-paddock-deploy`. Store its returned client ID/secret in protected files and pipe them to GitHub `production` secrets named `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. Record the application/token resource IDs and expiry in `state/cloudflare-resources.json`, matching the Office Tracker convention. Do not print secret values. Do not add an Access login wall to the public artwork hostname.

After that policy exists, register only the exact webhook path:

```sh
cd /Users/kyle/platform
python3 scripts/hostname.py add paddock-deploy deploy-paddock.thescudders.org --upstream paddock-deploy-hook:9000 --path /hooks/paddock --dry-run
python3 scripts/hostname.py add paddock-deploy deploy-paddock.thescudders.org --upstream paddock-deploy-hook:9000 --path /hooks/paddock
python3 scripts/hostname.py add paddock paddock.thescudders.org --upstream paddock:3000 --dry-run
python3 scripts/hostname.py add paddock paddock.thescudders.org --upstream paddock:3000
```

The helper owns DNS, Tunnel ingress and Caddy registration. Inspect its dry-run output and preserve unrelated routes. Reuse the existing platform tunnel; no per-app tunnel token is needed.

## First deploy and CI/CD

Every push to `main` runs Release. CI checks the app and deploy tooling, builds/publishes both architectures, attests the multi-platform digest, then moves the `main` tag. The first release can publish while the webhook is being provisioned: `DEPLOY_ENABLED=false` prevents an unconfigured production request.

For this user-owned private repository, the official `@actions/attest` toolkit signs with GitHub's private Sigstore instance and `skipWrite: true`, then stores the bundle in GHCR with `@sigstore/oci`. GitHub's repository attestation storage requires Enterprise for private repositories. Both Release and the host verify the registry bundle using `gh attestation verify --bundle-from-oci`; no extra signing key or public transparency-log disclosure is needed. See the [toolkit storage documentation](https://github.com/actions/toolkit/tree/main/packages/attest#storage).

Once the receiver/Access routes and three production secrets exist:

```sh
gh variable set PADDOCK_BASE_URL --body https://paddock.thescudders.org --repo kylescudder/paddock
gh variable set DEPLOY_ENABLED --body true --repo kylescudder/paddock
gh workflow run Release --ref main --repo kylescudder/paddock
```

Release checks that Access blocks anonymous callers, unrelated hook paths return 404, and invalid HMAC signatures are rejected by the receiver. It then queues the exact digest and waits for two things: the host's acknowledgement (an authenticated `GET` of the hook, returning `status: deployed` with the exact revision and image) and the public `X-Paddock-Revision` header equalling that commit. The host verifies the repository, workflow, `refs/heads/main`, GitHub-hosted runner provenance, and requested revision independently before pulling.

After starting a candidate, the host runs `deploy/verify.ts` inside it. The read-only checks cover the restricted runtime database role, seeded calendar data, the frontend and fingerprinted assets, health revision and cache headers, the public library, PNG thumbnails with ETag/304, sandboxed SVG masters, 404s, and that owner APIs and generation refuse anonymous callers. Only after they pass does the host write `state/public/deployment.json`, which the receiver exposes (revision and image only). A failed check restores the previous image and leaves the earlier acknowledgement in place, so CI cannot report an early green release. Recreate the receiver (`docker compose -f deploy/compose.deploy-hook.yaml --env-file .env.deploy-hook up -d`) after pulling this change so it mounts `state/public`.

The private repository's GHCR package must be readable by the host's existing registry credentials. No private registry credential is sent to GitHub by the deployer.

## Data, backups and rollback

State is in the `paddock` PostgreSQL database on the host's existing `platform-db` network; `data/` holds only generated backgrounds, the disposable render cache and fonts. Provision it like Office Tracker: `python3 /Users/kyle/platform/scripts/provision-project.py paddock`, which creates the `paddock_owner` (migrations) and `paddock_runtime` (restricted app) roles and protected `projects/paddock/{owner,runtime}-password` files. Only `runtime-password` is mounted into the app. `compose.yaml` joins `platform-web` and `platform-db`, with no host ports. Run a single app instance: the in-process queue/scheduler owns inference and six-hour calendar checks. Runtime limits are 1 GiB and 2 CPUs to support 4K rendering.

After verifying an image and before replacing the app, the deployer saves a private `pg_dump` (latest 14 retained), then runs `server/migrate.ts` in a one-shot container with the owner credential. A failed backup or migration leaves the current app running. Failed health restores the previous image; migrations are not reversed, so schema changes must stay additive and compatible with the previous runtime. Register `paddock` for the host's weekly encrypted database backups. Include `data/`, protected `.env*`, `secrets/`, and deployment state in the host's established encrypted NAS backup. Render cache in `data/renders` is disposable. Original backgrounds are versioned in Git.

```sh
cd /Users/kyle/platform/apps/paddock
docker compose --env-file .env ps
launchctl print gui/501/com.kylescudder.deploy-core
tail -n 100 state/deploy.log
./deploy/host-deploy.sh sha256:<previous-attested-main-digest>
```

Host `deploy/` and Compose changes require updating the reviewed host checkout and recreating the receiver when relevant; routine app releases run only the independently verified image. Pause releases with `gh variable set DEPLOY_ENABLED --body false --repo kylescudder/paddock`.
