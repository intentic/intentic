#!/usr/bin/env node
/* Assert that the images an end user's machine pulls are readable WITHOUT a credential.
 *
 *   node _tools/scripts/image/verify-images-public.mjs
 *   IMAGES="ghcr.io/intentic/sandbox:stable ..." node _tools/scripts/image/verify-images-public.mjs
 *
 * This is the one check in the pipeline that runs credential-free, and it exists because everything else here
 * does not: every job in ci.yml and nightly.yml opens with a `docker login ghcr.io`, so no other job can tell a
 * public package from a private one. That blindness shipped — ghcr.io/intentic/sandbox was published private
 * (GHCR package visibility is separate from repository visibility and defaults to private; see
 * publish-images.sh), CI stayed green throughout, and every `irm https://intentic.dev/connect.ps1 | iex` died at
 * `error from registry: unauthorized` on the first pull. Even nightly's desktop-setup tier, which runs the
 * SHIPPED connect.sh on a clean host, hands its runner login through and so cannot catch this.
 *
 * It asks the registry's token endpoint rather than running `docker pull`: the docker CLI would present
 * whatever login the runner's shared config holds, which is precisely the blindness being fixed. ghcr.io issues
 * an anonymous pull token only for a public package, and the manifest request that follows proves the tag
 * behind it actually exists — a public package with no `stable` in it fails a user's install just as hard.
 *
 * WHY THIS IS JAVASCRIPT. It was a shell script that read the token out of the endpoint's JSON with a `sed`
 * substitution over the response body — a regex against JSON, which is right until the day the field moves or
 * a value carries an escape. Two `fetch` calls and a `.json()` say the same thing and cannot be wrong about
 * it. */

// Exactly the references the connect scripts pull unauthenticated on a user's machine — `stable` and
// `core-stable` for the sandbox (release-images.sh moves both on every release), `latest` for the dind-host
// that the Windows self-host path stands up.
const images = (process.env.IMAGES ?? "ghcr.io/intentic/sandbox:stable ghcr.io/intentic/sandbox:core-stable ghcr.io/intentic/dind-host:latest")
    .split(/\s+/)
    .filter(Boolean);

// The media types a manifest request must declare it accepts, or the registry answers 404 for an image whose
// manifest is an OCI index — which every multi-arch sandbox tag is.
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
