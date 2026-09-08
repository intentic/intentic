#!/usr/bin/env node
// Confirms the images an end user pulls are readable without a credential, since every job in ci.yml/nightly.yml runs
// `docker login` first and so can't tell a public package from a private one. Asks the registry's token endpoint
// directly, not `docker pull` (which would use the runner's login), and confirms the tag's manifest actually exists.

// What connect scripts pull unauthenticated: sandbox stable/core-stable, dind-host latest (Windows self-host).
const images = (process.env.IMAGES ?? "ghcr.io/intentic/sandbox:stable ghcr.io/intentic/sandbox:core-stable ghcr.io/intentic/dind-host:latest")
    .split(/\s+/)
    .filter(Boolean);

// Manifest request needs these accept types, or ghcr answers 404 for a multi-arch (OCI index) image.
const MANIFEST_TYPES = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

let failed = 0;

for (const ref of images) {
    const at = ref.lastIndexOf(":");
    const tag = ref.slice(at + 1);
    const path = ref.slice(0, at).replace(/^ghcr\.io\//, "");
    const name = path.slice(path.lastIndexOf("/") + 1);

    const answer = await fetch(`https://ghcr.io/token?scope=repository:${path}:pull&service=ghcr.io`).catch((error) => error);
    const token = answer instanceof Response && answer.ok ? ((await answer.json().catch(() => ({}))).token ?? "") : "";
    if (token === "") {
        const status = answer instanceof Response ? answer.status : `no answer (${answer.message})`;
        console.error(`FAIL ${ref}`);
        console.error(`     ghcr.io answered ${status} and issued no anonymous pull token for ${path}, so the package`);
        console.error(`     is PRIVATE and every user's installer fails at its first pull. Make it public at`);
        console.error(`     https://github.com/orgs/intentic/packages -> ${name} -> Package settings -> Change visibility.`);
        failed = 1;
        continue;
    }

    const manifest = await fetch(`https://ghcr.io/v2/${path}/manifests/${tag}`, {
        headers: { authorization: `Bearer ${token}`, accept: MANIFEST_TYPES },
    }).catch((error) => error);
    if (!(manifest instanceof Response) || manifest.status !== 200) {
        const status = manifest instanceof Response ? manifest.status : `no answer (${manifest.message})`;
        console.error(`FAIL ${ref}`);
        console.error(`     the package is public, but ghcr.io answered ${status} for the ${tag} tag — nothing has been`);
        console.error(`     published under it. Check that the release pushed its images (see publish-images.sh).`);
        failed = 1;
        continue;
    }

    console.log(`ok   ${ref} — public, and the tag resolves.`);
}

process.exit(failed);
