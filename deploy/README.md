# Paddock on Herman

Public site: **https://paddock.thescudders.org**. Deploy hook:
**https://deploy-paddock.thescudders.org/hooks/paddock**.

This follows the current Thursday Office Tracker deployment on Herman: GitHub-hosted AMD64/ARM64 builds, an immutable GHCR digest and provenance attestation, Cloudflare Access Service Auth, the existing Tunnel/Caddy `platform-web` network, a restricted queue receiver, and `com.herman.paddock-deploy` running as Colima's owner. It does not install a self-hosted Actions runner or give the receiver a Docker socket.

## Host setup

Run on **Herman**, from a reviewed checkout. Forge currently cannot authenticate to Herman over SSH; the app and release tooling can be prepared there, but hostname/Access registration needs the existing Herman credentials.

```sh
mkdir -p /Users/kyle/platform/apps
git clone git@github.com:kylescudder/f1-image-generator.git /Users/kyle/platform/apps/paddock
cd /Users/kyle/platform/apps/paddock
python3 -B deploy/bootstrap-herman.py
```

The bootstrap is resumable. It creates private directories and a signing secret, sends that secret to the repository's `production` environment through stdin, starts the receiver, and installs the LaunchAgent. It preserves existing private files. It creates `.env` with blank integration credentials; copy the approved Clerk, OpenRouter, and Emby configuration from Herman's existing secret store when permissions are ready. Set the exact `CLERK_OWNER_USER_ID`; until then every admin endpoint is denied and no automatic inference runs. The public gallery works without integration keys.

## Cloudflare

Use Herman's existing platform tooling and Cloudflare permissions. Before exposing the hook, create a **dedicated** Access application covering all of `deploy-paddock.thescudders.org`, with one **Service Auth** policy allowing only a new service token named `github-paddock-deploy`. Store its returned client ID/secret in protected files and pipe them to GitHub `production` secrets named `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. Record the application/token resource IDs and expiry in `state/cloudflare-resources.json`, matching the Office Tracker convention. Do not print secret values. Do not add an Access login wall to the public artwork hostname.

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

For this user-owned private repository, the official `@actions/attest` toolkit signs with GitHub's private Sigstore instance and `skipWrite: true`, then stores the bundle in GHCR with `@sigstore/oci`. GitHub's repository attestation storage requires Enterprise for private repositories. Both Release and Herman verify the registry bundle using `gh attestation verify --bundle-from-oci`; no extra signing key or public transparency-log disclosure is needed. See the [toolkit storage documentation](https://github.com/actions/toolkit/tree/main/packages/attest#storage).

Once the receiver/Access routes and three production secrets exist:

```sh
gh variable set PADDOCK_BASE_URL --body https://paddock.thescudders.org --repo kylescudder/f1-image-generator
gh variable set DEPLOY_ENABLED --body true --repo kylescudder/f1-image-generator
gh workflow run Release --ref main --repo kylescudder/f1-image-generator
```

Release checks that Access blocks anonymous callers, unrelated hook paths return 404, and invalid HMAC signatures are rejected by the receiver. It then queues the exact digest and waits for the public health endpoint's `X-Paddock-Revision` to equal that commit. Herman verifies the repository, workflow, `refs/heads/main`, GitHub-hosted runner provenance, and requested revision independently before pulling.

The private repository's GHCR package must be readable by Herman's existing registry credentials. No private registry credential is sent to GitHub by the deployer.

## Data, backups and rollback

The app uses SQLite and files in `data/` rather than requiring a separate Postgres service. `compose.yaml` mounts that directory on the existing `platform-web` network, with no host ports. Run a single app instance: the in-process queue/scheduler owns inference and six-hour calendar checks. Runtime limits are 1 GiB and 2 CPUs to support 4K rendering.

Before an image replacement, the deployer takes a consistent online SQLite backup from the current container and retains 14 backups. New schema initialization is additive. Failed health restores the previous image; database files and immutable generated backgrounds remain available. Include `data/`, protected `.env*`, `secrets/`, and deployment state in Herman's established encrypted NAS backup. Render cache in `data/renders` is disposable. Original backgrounds are versioned in Git.

```sh
cd /Users/kyle/platform/apps/paddock
docker compose --env-file .env ps
launchctl print gui/501/com.herman.paddock-deploy
tail -n 100 state/deploy.log
./deploy/herman-deploy.sh sha256:<previous-attested-main-digest>
```

Host `deploy/` and Compose changes require updating the reviewed host checkout and recreating the receiver/reinstalling the LaunchAgent when relevant; routine app releases run only the independently verified image. Pause releases with `gh variable set DEPLOY_ENABLED --body false --repo kylescudder/f1-image-generator`.
