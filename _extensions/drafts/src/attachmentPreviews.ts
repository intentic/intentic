import { sandboxRef, sandboxScopeGuard } from "@intentic/extension-api";
import { host } from "./host";

/* Thumbnails for a draft's workspace attachments (.intentic/artifacts/attachments/…), minted from
 * /workspace/raw on first render — the same shape the chat's bubbles use, scoped to this extension because a
 * module-level object-URL cache belongs to whoever created the URLs.
 *
 * Module-level: one fetch per path across every row that shows it. A refused path (outside the workspace, or
 * past the raw route's ceiling) is remembered so it is not re-asked every render; a transport failure is not,
 * so a daemon that was mid-boot answers on a later ask.
 *
 * ALL THREE ARE SANDBOX-SCOPED, and this cache is the one where carrying over is worst: the key is a workspace
 * path, two sandboxes have the same attachment paths, and the value is a URL to bytes fetched from the box the
 * reader has left — so a draft row would show a thumbnail of a different workspace's picture. The refusals go
 * with it, since a path this box has is not refused just because the last one lacked it. Object URLs hold their
 * blob until revoked, hence the disposer: nothing else is ever going to hand those bytes back. */

const previews = sandboxRef<Record<string, string>>(
    () => ({}),
    (previous) => {
        for (const url of Object.values(previous)) {
            URL.revokeObjectURL(url);
        }
    },
);
const loading = sandboxRef(() => new Set<string>());
const refused = sandboxRef(() => new Set<string>());

const IMAGE_EXTS = new Set([`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `avif`]);

const load = (path: string): void => {
    // Taken before the fetch, asked after it. Without it the bytes of the box the reader has left are minted
    // into a URL and filed under a path the box they are now on very likely also has.
    const current = sandboxScopeGuard();
    loading.value.add(path);
    void host()
        .sandbox.request(`/workspace/raw?path=${encodeURIComponent(path)}`)
        .then(async (response) => {
            loading.value.delete(path);
            if (!response.ok) {
                if (response.status === 400 || response.status === 404 || response.status === 413) {
                    refused.value.add(path);
                }
                return;
            }
            const blob = await response.blob();
            if (!current()) {
                return;
            }
            previews.value = { ...previews.value, [path]: URL.createObjectURL(blob) };
        })
        .catch(() => loading.value.delete(path));
};

// The preview URL for a workspace attachment: the cached object URL, kicking off the byte fetch on first ask.
// undefined for non-images, while the bytes are in flight, and for a refused path — the caller renders the name
// chip and (reactively) flips to a thumb when the URL lands.
export const attachmentPreview = (path: string): string | undefined => {
    const cached = previews.value[path];
    if (cached !== undefined || !IMAGE_EXTS.has(path.split(`.`).at(-1)?.toLowerCase() ?? ``)) {
        return cached;
    }
    if (!loading.value.has(path) && !refused.value.has(path)) {
        load(path);
    }
    return undefined;
};
