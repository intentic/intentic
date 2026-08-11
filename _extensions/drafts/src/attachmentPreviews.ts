import { ref } from "vue";
import { host } from "./host";

/* Thumbnails for a draft's workspace attachments (.intentic/artifacts/attachments/…), minted from
 * /workspace/raw on first render — the same shape the chat's bubbles use, scoped to this extension because a
 * module-level object-URL cache belongs to whoever created the URLs.
 *
 * Module-level: one fetch per path across every row that shows it. A refused path (outside the workspace, or
 * past the raw route's ceiling) is remembered so it is not re-asked every render; a transport failure is not,
 * so a daemon that was mid-boot answers on a later ask. */

const previews = ref<Record<string, string>>({});
const loading = new Set<string>();
const refused = new Set<string>();

const IMAGE_EXTS = new Set([`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `avif`]);

const load = (path: string): void => {
    loading.add(path);
    void host()
        .sandbox.request(`/workspace/raw?path=${encodeURIComponent(path)}`)
        .then(async (response) => {
            loading.delete(path);
            if (!response.ok) {
                if (response.status === 400 || response.status === 404 || response.status === 413) {
                    refused.add(path);
                }
                return;
            }
            previews.value = { ...previews.value, [path]: URL.createObjectURL(await response.blob()) };
        })
        .catch(() => loading.delete(path));
};

// The preview URL for a workspace attachment: the cached object URL, kicking off the byte fetch on first ask.
// undefined for non-images, while the bytes are in flight, and for a refused path — the caller renders the name
// chip and (reactively) flips to a thumb when the URL lands.
export const attachmentPreview = (path: string): string | undefined => {
    const cached = previews.value[path];
    if (cached !== undefined || !IMAGE_EXTS.has(path.split(`.`).at(-1)?.toLowerCase() ?? ``)) {
        return cached;
    }
    if (!loading.has(path) && !refused.has(path)) {
        load(path);
    }
    return undefined;
};
