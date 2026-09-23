import type { Disposable } from "@intentic/extension-api";
import { useLatest } from "@intentic/ui/async";
import { type Component, type Ref, type ShallowRef, shallowRef, watch } from "vue";

// Registry of custom file viewers from extensions (contributes.viewers); FileViewer resolves an open file
// to one by extension and renders it. Module-level singleton, same shape as the view registry.

export interface RegisteredViewer {
    // The owning extension's id; error attribution and manifest-gating key off this.
    readonly owner: string;
    readonly id: string;
    // Bare file extensions (no dot) this viewer handles, from its manifest.
    readonly extensions: readonly string[];
    // Decoded text, whole-file bytes, a streaming URL, or the path alone; from the manifest, so extensions can't widen
    // their reach.
    readonly fetch: "text" | "blob" | "url" | "path";
    // Writes the file back; outranks a render-only viewer claiming the same extension.
    readonly edit: boolean;
    readonly component: () => Promise<Component>;
    // Two versions drawn as one, what changed marked in place; only a `blob` viewer that declared it has one.
    readonly compare?: () => Promise<Component>;
}

const viewers = shallowRef<readonly RegisteredViewer[]>([]);

// Keyed by owner + viewer id, like the view registry: re-registering the same identity replaces its
// predecessor in place instead of stacking a shadowing second entry.
export const registerViewer = (viewer: RegisteredViewer): Disposable => {
    const index = viewers.value.findIndex((existing) => existing.owner === viewer.owner && existing.id === viewer.id);
    viewers.value = index === -1 ? [...viewers.value, viewer] : viewers.value.with(index, viewer);
    return {
        dispose: (): void => {
            viewers.value = viewers.value.filter((entry) => entry !== viewer);
        },
    };
};

// Every viewer claiming an extension (lowercased), latest registration first, so a later extension can override a
// builtin.
const claimants = (ext: string): RegisteredViewer[] => {
    const lower = ext.toLowerCase();
    return viewers.value.filter((entry) => entry.extensions.includes(lower)).toReversed();
};

// The viewer registered for a file extension: an editing viewer over a render-only one, and among equals the last
// registration.
export const viewerForExtension = (ext: string): RegisteredViewer | undefined => {
    const claiming = claimants(ext);
    return claiming.find((entry) => entry.edit) ?? claiming[0];
};

// The viewer that can draw bytes handed to it, for a surface holding content rather than a workspace path (one side
// of a diff): a `path` viewer reads through its own backend and cannot be given a blob, so it is passed over even
// when it edits.
export const renderViewerForExtension = (ext: string): RegisteredViewer | undefined => claimants(ext).find((entry) => entry.fetch !== `path`);

// The viewer that can draw two versions of this format as one marked document, for a diff's Changes reading.
export const compareViewerForExtension = (ext: string): RegisteredViewer | undefined => claimants(ext).find((entry) => entry.compare !== undefined);

// The component of whichever viewer `viewer` names: undefined while it imports, and dropped when the viewer changes.
export const useViewerComponent = (viewer: Readonly<Ref<RegisteredViewer | undefined>>): Readonly<ShallowRef<Component | undefined>> => {
    const component = shallowRef<Component>();
    const latest = useLatest();
    watch(
        viewer,
        (next) => {
            const isLatest = latest();
            component.value = undefined;
            void next?.component().then((loaded) => {
                if (isLatest()) {
                    component.value = loaded;
                }
            });
        },
        { immediate: true },
    );
    return component;
};
