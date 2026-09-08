import { ref, watch } from "vue";
import { SandboxHttpError, sandboxBlob } from "../../sandbox/client/sandboxClient";
import { useEndpoint } from "../../sandbox/secrets/useEndpoint";

// Thumbnail cache for an attachment's workspace path, shared by the composer chip, sent bubbles, and restored
// transcripts. `rememberPreview` seeds the composer's own upload; everything else re-fetches from /workspace/raw on
// first ask, retrying transport failures and parking only on a daemon refusal (404/400/413).

const previews = ref<Record<string, string>>({});
// Every path a bubble has asked about, whatever came of it; the set a newly resolved address re-tries.
const asked = new Set<string>();
// Paths with an attempt chain running, including backoff sleeps; a path leaves only when its chain ends.
const loading = new Set<string>();
// The timer of a chain waiting out backoff, so a resolved address can cancel it and retry immediately.
const sleeping = new Map<string, ReturnType<typeof setTimeout>>();
// Paths the daemon refused for good; these stay parked and the chip keeps its filename.
const refused = new Set<string>();

// Extensions the <img> thumb can actually display, matches what the composer previews (image/* uploads).
const IMAGE_EXTS = new Set([`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `avif`]);

// The daemon's final answer: gone (404), refused (400), or over /workspace/raw's size ceiling (413).
// Anything else says nothing about the file (no endpoint yet, a dropped connection, a mid-boot 5xx).
const isRefusal = (error: unknown): boolean => error instanceof SandboxHttpError && [400, 404, 413].includes(error.status);

// Backoff schedule for a fetch that may just be racing the daemon's boot; running out ends the chain, not the path.
const RETRY_MS = [200, 600, 1_500, 4_000, 8_000];

const load = (path: string, attempt = 0): void => {
    loading.add(path);
    void sandboxBlob(`/workspace/raw?path=${encodeURIComponent(path)}`).then(
        (blob) => {
            loading.delete(path);
            previews.value = { ...previews.value, [path]: URL.createObjectURL(blob) };
        },
        (error: unknown) => {
            if (isRefusal(error)) {
                loading.delete(path);
                refused.add(path);
                return;
            }
            const delay = RETRY_MS[attempt];
            if (delay === undefined) {
                loading.delete(path);
                return;
            }
            // Still claimed while the chain sleeps: dropping it would let a re-render start a second chain beside it.
            sleeping.set(
                path,
                setTimeout(() => {
                    sleeping.delete(path);
                    load(path, attempt + 1);
                }, delay),
            );
        },
    );
};

// The bytes are already in this window, filed under the path they were uploaded to; called by the composer as
// it stages a file. Marked `asked` too, so the endpoint watch below leaves it alone.
export const rememberPreview = (path: string, url: string): void => {
    asked.add(path);
    previews.value = { ...previews.value, [path]: url };
};

// Drops a path whose staged object URL was just revoked, so the cache doesn't hand out a dead URL. Only ever
// a file that was never sent.
export const forgetPreview = (path: string): void => {
    asked.delete(path);
    const { [path]: _dropped, ...rest } = previews.value;
    previews.value = rest;
};

// Cached preview URL for an attachment path, kicking off the fetch on first ask. Undefined for non-images,
// in-flight fetches, and refused paths; the caller renders a name chip until it resolves.
export const attachmentPreview = (path: string): string | undefined => {
    const cached = previews.value[path];
    if (cached !== undefined || !IMAGE_EXTS.has(path.split(`.`).at(-1)?.toLowerCase() ?? ``)) {
        return cached;
    }
    asked.add(path);
    if (!loading.has(path) && !refused.has(path)) {
        load(path);
    }
    return undefined;
};

// Restarts any backoff-waiting chain once an address resolves; those attempts had nothing to test against.
watch(useEndpoint().daemonBase, (base) => {
    if (base === undefined || base === ``) {
        return;
    }
    for (const path of asked) {
        if (previews.value[path] !== undefined || refused.has(path)) {
            continue;
        }
        const timer = sleeping.get(path);
        if (timer !== undefined) {
            clearTimeout(timer);
            sleeping.delete(path);
        } else if (loading.has(path)) {
            // A request already on the wire: its own handler carries the chain from here.
            continue;
        }
        load(path);
    }
});
