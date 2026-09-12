import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { forgetHostedImage, parseImageRef, resolveHostedImage } from "./hosted-image.js";

// The pool's whole value is that a warm machine already holds the image. A tag stops naming the same bytes the
// moment it is re-pushed, so these pin the one property the pool depends on: what this returns is a name that
// cannot change under a machine that is already holding it.

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const DIGEST = `sha256:a2efc11a3e6b517557ad0b46cbae6f2b6270b632d93e09cb8b816c7ad8487125`;

const config = (image: string): Config => ({ hosted: { image } }) as unknown as Config;

// A registry that answers the manifest HEAD straight away, with no auth challenge.
const stubRegistry = (digest: string | null, status = 200) => {
    const calls: string[] = [];
    vi.stubGlobal(`fetch`, (url: URL | string) => {
        calls.push(String(url));
        return Promise.resolve(new Response(null, { status, headers: digest === null ? {} : { "docker-content-digest": digest } }));
    });
    return calls;
};

afterEach(() => {
    vi.unstubAllGlobals();
    forgetHostedImage();
});

describe(`parseImageRef`, () => {
    it(`splits a registry ref into the three parts a manifest lookup needs`, () => {
        expect(parseImageRef(`ghcr.io/intentic/sandbox:stable`)).toEqual({ registry: `ghcr.io`, repository: `intentic/sandbox`, tag: `stable` });
    });

    it(`defaults a ref with no tag to latest, the same as a registry would`, () => {
        expect(parseImageRef(`ghcr.io/intentic/sandbox`)?.tag).toBe(`latest`);
    });

    // Already the strongest name there is; resolving it again could only weaken it.
    it(`declines a ref that is already a digest`, () => {
        expect(parseImageRef(`ghcr.io/intentic/sandbox@${DIGEST}`)).toBeUndefined();
    });

    // A bare name is docker hub's, whose host this must not invent.
    it(`declines a ref that names no registry host`, () => {
        expect(parseImageRef(`sandbox:stable`)).toBeUndefined();
    });
});

describe(`resolveHostedImage`, () => {
    it(`pins a tag to the digest the registry reports`, async () => {
        const calls = stubRegistry(DIGEST);
        expect(await resolveHostedImage(config(`ghcr.io/intentic/sandbox:stable`), logger)).toBe(`ghcr.io/intentic/sandbox@${DIGEST}`);
        expect(calls[0]).toBe(`https://ghcr.io/v2/intentic/sandbox/manifests/stable`);
    });

    // ghcr answers an anonymous manifest HEAD with a challenge; the realm it names is where the token comes from.
    it(`answers a bearer challenge and retries, rather than giving up on a registry that wants a token`, async () => {
        const seen: string[] = [];
        vi.stubGlobal(`fetch`, (url: URL | string) => {
            const target = String(url);
            seen.push(target);
            if (target.startsWith(`https://ghcr.io/token`)) {
                return Promise.resolve(new Response(JSON.stringify({ token: `t0k3n` }), { status: 200 }));
            }
            if (seen.filter((entry) => entry.includes(`/manifests/`)).length === 1) {
                return Promise.resolve(new Response(null, { status: 401, headers: { "www-authenticate": `Bearer realm="https://ghcr.io/token",service="ghcr.io"` } }));
            }
            return Promise.resolve(new Response(null, { status: 200, headers: { "docker-content-digest": DIGEST } }));
        });
        expect(await resolveHostedImage(config(`ghcr.io/intentic/sandbox:stable`), logger)).toBe(`ghcr.io/intentic/sandbox@${DIGEST}`);
        expect(seen.some((entry) => entry.includes(`scope=repository%3Aintentic%2Fsandbox%3Apull`))).toBe(true);
    });

    /* FAILS OPEN TO THE TAG, which is the whole reason this can sit on the provisioning path. A registry that is
     * down must cost what today already costs — a claim that may have to pull — and never a sign-up that cannot
     * be served at all. */
    it(`falls back to the configured tag when the registry cannot be reached`, async () => {
        vi.stubGlobal(`fetch`, () => Promise.reject(new Error(`ENOTFOUND`)));
        expect(await resolveHostedImage(config(`ghcr.io/intentic/sandbox:stable`), logger)).toBe(`ghcr.io/intentic/sandbox:stable`);
    });

    it(`falls back to the tag when the registry answers without a digest header`, async () => {
        stubRegistry(null);
        expect(await resolveHostedImage(config(`ghcr.io/intentic/sandbox:stable`), logger)).toBe(`ghcr.io/intentic/sandbox:stable`);
    });

    it(`returns an already-pinned ref untouched, and asks the registry nothing`, async () => {
        const calls = stubRegistry(DIGEST);
        expect(await resolveHostedImage(config(`ghcr.io/intentic/sandbox@${DIGEST}`), logger)).toBe(`ghcr.io/intentic/sandbox@${DIGEST}`);
        expect(calls).toEqual([]);
    });

    // Every provision and every reconcile tick asks; the answer only changes on a push.
    it(`asks the registry once per window, not once per caller`, async () => {
        const calls = stubRegistry(DIGEST);
        const image = config(`ghcr.io/intentic/sandbox:stable`);
        await resolveHostedImage(image, logger);
        await resolveHostedImage(image, logger);
        expect(calls).toHaveLength(1);
    });
});
