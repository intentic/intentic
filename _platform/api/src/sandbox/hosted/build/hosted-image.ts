import type { Logger } from "pino";
import type { Config } from "../../../config.js";

/* WHICH IMAGE THE WARM POOL IS ACTUALLY HOLDING, as a digest rather than as a tag, and the outage that makes
 * this worth a module.
 *
 * A pool machine's entire value is that the sandbox image is already on its disk: it boots once with
 * SANDBOX_PREWARM=1, pulls, warms the starter's dev server, and stops, so a later claim is a start (seconds)
 * rather than a pull (minutes). That value is silently destroyed every time `ghcr.io/intentic/sandbox:stable`
 * is re-pushed. The pool stored the TAG, the reconcile compared the tag against the config's tag — identical
 * before and after a re-push, so no drift was ever detected — and the claim then rewrote the machine's config
 * with that same tag, which Fly re-resolves to the NEW digest. The machine therefore had to pull a fresh image
 * before it could start, `startAfterUpdate` allows thirty seconds for that, and so every claim failed with
 * "did not start after its config was replaced" and fell through to a cold build. Measured in production: four
 * claims after one re-push, four failures, every affected user waiting out the full three-to-five minutes the
 * pool exists to avoid.
 *
 * A digest is the fix because it is the only name that means the same rootfs tomorrow. Pinned, a claim cannot
 * change what the machine is holding, so it cannot trigger a pull; and the drift check becomes true drift,
 * so a re-push drains and rebuilds the pool IN THE BACKGROUND, before anybody's sign-up meets it. */

// One resolution per window: reconcile ticks and every provision ask, and the answer only changes on a push.
const CACHE_TTL_MS = 60_000;
// A registry that will not answer promptly must not hold up a provision; the fallback below is the tag.
const TIMEOUT_MS = 5_000;

// Both the OCI index and the older docker manifest list, else a registry answers with the wrong digest for a
// multi-arch tag (the per-platform manifest, not the index the tag actually names).
const MANIFEST_ACCEPT = [
    `application/vnd.oci.image.index.v1+json`,
    `application/vnd.docker.distribution.manifest.list.v2+json`,
    `application/vnd.oci.image.manifest.v1+json`,
    `application/vnd.docker.distribution.manifest.v2+json`,
].join(`,`);

interface ImageRef {
    readonly registry: string;
    readonly repository: string;
    readonly tag: string;
}

// `ghcr.io/intentic/sandbox:stable` → its three parts. A ref that is already a digest, or that names no
// registry host, returns undefined: the first needs no resolving and the second is not ours to guess at.
export const parseImageRef = (ref: string): ImageRef | undefined => {
    if (ref.includes(`@`)) {
        return undefined;
    }
    const slash = ref.indexOf(`/`);
    if (slash === -1) {
        return undefined;
    }
    const registry = ref.slice(0, slash);
    // A registry host is the thing with a dot or a port; without one this is a docker-hub short name.
    if (!registry.includes(`.`) && !registry.includes(`:`)) {
        return undefined;
    }
    const rest = ref.slice(slash + 1);
    const colon = rest.lastIndexOf(`:`);
    return colon === -1 ? { registry, repository: rest, tag: `latest` } : { registry, repository: rest.slice(0, colon), tag: rest.slice(colon + 1) };
};

// The registry's own bearer dance, read off its 401 rather than hard-coded per registry: ghcr, docker hub and
// a self-hosted registry all answer the same shape, and a registry needing no token never sends one.
const tokenFor = async (challenge: string, repository: string): Promise<string | undefined> => {
    const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
    if (realm === undefined) {
        return undefined;
    }
    const service = /service="([^"]+)"/.exec(challenge)?.[1];
    const url = new URL(realm);
    url.searchParams.set(`scope`, `repository:${repository}:pull`);
    if (service !== undefined) {
        url.searchParams.set(`service`, service);
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
        return undefined;
    }
    const body = (await response.json()) as { token?: unknown; access_token?: unknown };
    const token = body.token ?? body.access_token;
    return typeof token === `string` && token !== `` ? token : undefined;
};

// HEAD, not GET: the digest is a response header, and the manifest body is not needed to learn it.
const headDigest = async (ref: ImageRef, token: string | undefined): Promise<Response> =>
    fetch(`https://${ref.registry}/v2/${ref.repository}/manifests/${ref.tag}`, {
        method: `HEAD`,
        headers: { Accept: MANIFEST_ACCEPT, ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });

export const digestOf = async (ref: ImageRef): Promise<string | undefined> => {
    let response = await headDigest(ref, undefined);
    if (response.status === 401) {
        const token = await tokenFor(response.headers.get(`www-authenticate`) ?? ``, ref.repository);
        if (token === undefined) {
            return undefined;
        }
        response = await headDigest(ref, token);
    }
    if (!response.ok) {
        return undefined;
    }
    const digest = response.headers.get(`docker-content-digest`);
    return digest !== null && digest.startsWith(`sha256:`) ? digest : undefined;
};

let cached: { readonly ref: string; readonly pinned: string; readonly at: number } | undefined;

// Tests reset the memo; nothing else should touch it.
export const forgetHostedImage = (): void => {
    cached = undefined;
};

const memo = (configured: string, now: () => number): string | undefined =>
    cached !== undefined && cached.ref === configured && now() - cached.at < CACHE_TTL_MS ? cached.pinned : undefined;

/* FAILS OPEN TO THE TAG, deliberately. A registry that is slow, down, or private in a way this cannot
 * authenticate against must not stop the lane handing anybody a sandbox — it only costs what today already
 * costs. The caller cannot tell the difference, which is the point: every consumer keeps comparing whatever
 * this returns against whatever it returned when the row was written. */
export const resolveHostedImage = async (config: Config, logger?: Logger, now: () => number = Date.now): Promise<string> => {
    const configured = config.hosted.image;
    const parsed = parseImageRef(configured);
    if (parsed === undefined) {
        return configured;
    }
    const remembered = memo(configured, now);
    if (remembered !== undefined) {
        return remembered;
    }
    const digest = await digestOf(parsed).catch(() => undefined);
    if (digest === undefined) {
        logger?.warn({ image: configured }, `hosted image: could not resolve a digest; using the tag, so a claim may have to pull`);
        return configured;
    }
    const pinned = `${parsed.registry}/${parsed.repository}@${digest}`;
    if (cached?.pinned !== pinned) {
        logger?.info({ image: configured, pinned }, `hosted image: resolved`);
    }
    cached = { ref: configured, pinned, at: now() };
    return pinned;
};
