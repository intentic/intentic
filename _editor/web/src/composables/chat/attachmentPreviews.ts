import { ref, watch } from "vue";
import { SandboxHttpError, sandboxBlob } from "../sandbox/sandboxClient";
import { useEndpoint } from "../sandbox/useEndpoint";

/* Image thumbnails for attachments that carry only a workspace path, a restored or cached transcript's
 * chips, whose send-time object URLs died with their page. The bytes still sit in the workspace
 * (.intentic/records/artifacts/attachments/…), so a thumb is re-minted from /workspace/raw on first render.
 *
 * Module-level cache: one fetch per path across every bubble and window that shows it, and the object URLs
 * live for the page (the same lifetime the composer's own previews get).
 *
 * WHY A FAILED FETCH IS NOT THE END OF IT. A restored transcript paints from its cached snapshot on the very
 * first frame, before `sandbox.list` has said where the sandbox is, so the first ask for these bytes routinely
 * happens while there is no address to send it to at all (sandboxRequest refuses outright), and a daemon still
 * finishing its boot refuses for a few seconds after that. A restarted dev server is the everyday way to be on
 * the losing side of that race, and treating its answer as final is what turned an attached screenshot into a
 * bare `image.png` chip for the rest of the page's life. So only the daemon's own "there is nothing here to
 * serve" is final; every other rejection is the transport talking, and the path is tried again, on a backoff,
 * and again the moment an address resolves. */

const previews = ref<Record<string, string>>({});
// Every path a bubble has asked about, whatever came of it, the set a newly resolved address re-tries.
const asked = new Set<string>();
// Paths with an attempt chain running, sleeps between retries included, so the N bubbles showing one screenshot
// still fetch it once. A path leaves only when its chain truly ends.
const loading = new Set<string>();
// The timer of a chain currently waiting out its backoff, so a resolved address can cut the wait short instead
// of being turned away by the claim that wait holds.
const sleeping = new Map<string, ReturnType<typeof setTimeout>>();
// Paths the daemon positively refused. No later attempt could come back with a different answer, so these are
// the one case that stays parked, the chip keeps its filename and stops asking.
const refused = new Set<string>();

// Extensions the <img> thumb can actually display, matches what the composer previews (image/* uploads).
const IMAGE_EXTS = new Set([`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `avif`]);

// The daemon looked, and will keep answering the same: the file is gone (404), the path is one it will not serve
// (400), or it is past /workspace/raw's in-memory ceiling (413). Anything else, no endpoint yet, a connection
// that dropped, a 5xx from a daemon mid-boot, says nothing about the file.
const isRefusal = (error: unknown): boolean => error instanceof SandboxHttpError && [400, 404, 413].includes(error.status);

// Front-loaded over ~14s: a daemon merely finishing its boot answers within the first couple of tries, and the
// tail covers a slower one without leaving a chip that quietly polls forever. Running out is not permanent, it
// ends this chain, leaving the path eligible for the next render or address change to pick up.
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
            // Deliberately still claimed while the chain sleeps: dropping it here would let the next render
            // start a second chain beside this one, and each of those would spawn its own.
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

// The preview URL for a workspace attachment: the cached object URL, kicking off the byte fetch on first ask.
// undefined for non-images, while the bytes are in flight, and for a path the daemon refused, the caller
// renders the name chip and (reactively) flips to a thumb when the URL lands.
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

/* An address where there was none is the news every chip waiting on the boot race was missing, so this is where
 * that race is settled, and a switch to a sandbox reached over the loopback shortcut lands here too.
 *
 * A chain waiting out its backoff is restarted rather than left to its timer: those attempts were spent against
 * an address that did not exist, so they have nothing to say about this one, and the thumb should not sit out the
 * remainder of a sleep that was only ever waiting for this. */
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
