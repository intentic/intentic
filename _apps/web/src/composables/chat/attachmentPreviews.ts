import { ref } from "vue";
import { sandboxBlob } from "../sandbox/sandboxClient";

/* Image thumbnails for attachments that carry only a workspace path — a restored or cached transcript's
 * chips, whose send-time object URLs died with their page. The bytes still sit in the workspace
 * (.intentic/attachments/…), so a thumb is re-minted from /workspace/raw on first render.
 *
 * Module-level cache: one fetch per path across every bubble and window that shows it, and the object URLs
 * live for the page (the same lifetime the composer's own previews get). A failed fetch — the attachment was
 * deleted from the workspace — parks the path permanently, so the chip stays a name chip without a retry per
 * re-render. */

const previews = ref<Record<string, string>>({});
const requested = new Set<string>();

// Extensions the <img> thumb can actually display — matches what the composer previews (image/* uploads).
const IMAGE_EXTS = new Set([`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `avif`]);

// The preview URL for a workspace attachment: the cached object URL, kicking off the byte fetch on first
// ask. undefined for non-images, while the bytes are in flight, and for a path that failed to load — the
// caller renders the name chip and (reactively) flips to a thumb when the URL lands.
export const attachmentPreview = (path: string): string | undefined => {
    const cached = previews.value[path];
    if (cached !== undefined || !IMAGE_EXTS.has(path.split(`.`).at(-1)?.toLowerCase() ?? ``) || requested.has(path)) {
        return cached;
    }
    requested.add(path);
    void sandboxBlob(`/workspace/raw?path=${encodeURIComponent(path)}`).then(
        (blob) => {
            previews.value = { ...previews.value, [path]: URL.createObjectURL(blob) };
        },
        () => undefined,
    );
    return undefined;
};
