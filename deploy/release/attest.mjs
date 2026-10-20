// GitHub documents skipWrite for private, non-Enterprise repositories:
// https://github.com/actions/toolkit/tree/main/packages/attest#storage
// Keep the signed bundle in GHCR, where the host already fetches it independently.
import { attestProvenance } from "@actions/attest";
import { attachArtifactToImage, getRegistryCredentials } from "@sigstore/oci";

const { IMAGE, DIGEST, GH_TOKEN, GITHUB_REPOSITORY, GITHUB_REF } = process.env;
if (
  IMAGE !== "ghcr.io/kylescudder/paddock" ||
  GITHUB_REPOSITORY !== "kylescudder/paddock" ||
  GITHUB_REF !== "refs/heads/main" ||
  !/^sha256:[a-f0-9]{64}$/.test(DIGEST ?? "") ||
  !GH_TOKEN
) {
  throw new Error("Expected a main-branch release and exact image digest.");
}

const attestation = await attestProvenance({
  subjects: [{ name: IMAGE, digest: { sha256: DIGEST.slice(7) } }],
  token: GH_TOKEN,
  sigstore: "github",
  skipWrite: true,
});
const artifact = await attachArtifactToImage({
  credentials: getRegistryCredentials(IMAGE),
  imageName: IMAGE,
  imageDigest: DIGEST,
  artifact: Buffer.from(JSON.stringify(attestation.bundle)),
  mediaType: attestation.bundle.mediaType,
  annotations: {
    "dev.sigstore.bundle.content": "dsse-envelope",
    "dev.sigstore.bundle.predicateType": "https://slsa.dev/provenance/v1",
  },
  fetchOpts: { timeout: 30000, retry: 3 },
});
console.log(`Stored signed provenance in GHCR: ${IMAGE}@${artifact.digest}`);
