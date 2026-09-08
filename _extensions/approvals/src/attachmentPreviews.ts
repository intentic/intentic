import { sandboxRef, sandboxScopeGuard } from "@intentic/extension-api";
import { host } from "./host";

// Thumbnails for a post's workspace attachment, minted from /workspace/raw on first render and cached by path.
// Sandbox-scoped: a fetched URL belongs to the workspace it came from, so the cache, its refusals, and the disposer
// (which revokes each object URL) all reset when the sandbox does.

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
    // Taken before the fetch, checked after, or a stale sandbox's bytes could land under the new one's same path.
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

// Cached object URL for an attachment, fetching on first ask. Undefined for a non-image, an in-flight fetch, or a
// refused path; the caller shows a name chip until it flips to a thumbnail.
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
