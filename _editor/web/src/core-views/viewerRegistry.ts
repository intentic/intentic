import type { Disposable } from "@intentic/extension-api";
import type { Component } from "vue";
import { shallowRef } from "vue";

/* Runtime registry of custom file viewers contributed by extensions (contributes.viewers). The host merges each
 * api.viewers.register call with its manifest declaration (file extensions + fetch kind) and stores it here;
 * FileViewer resolves an open file to a viewer by extension and renders it. A module-level singleton (the app's
 * no-Pinia convention), the same shape as the view registry. */

export interface RegisteredViewer {
    // The owning extension's id — error attribution + manifest-gating key off this.
    readonly owner: string;
    readonly id: string;
    // Bare file extensions (no dot) this viewer handles, from its manifest.
    readonly extensions: readonly string[];
    // What the host puts in the viewer's hands: decoded text, the whole file's bytes, or a streaming URL it
    // range-reads itself (audio/video). From the manifest, so the extension cannot widen its own reach.
    readonly fetch: "text" | "blob" | "url";
    readonly component: () => Promise<Component>;
}

const viewers = shallowRef<readonly RegisteredViewer[]>([]);

// Keyed by owner + viewer id, exactly like the view registry: re-registering the same identity is a
// re-activation, so it replaces its predecessor in place instead of stacking a second entry that would shadow
// the first for the same file extensions.
export const registerViewer = (viewer: RegisteredViewer): Disposable => {
    const index = viewers.value.findIndex((existing) => existing.owner === viewer.owner && existing.id === viewer.id);
    viewers.value = index === -1 ? [...viewers.value, viewer] : viewers.value.with(index, viewer);
    return {
        dispose: (): void => {
            viewers.value = viewers.value.filter((entry) => entry !== viewer);
        },
    };
};

// The viewer registered for a file extension (lowercased), or undefined. Last registration wins, so a
// later-loaded extension can override a builtin viewer for the same type.
export const viewerForExtension = (ext: string): RegisteredViewer | undefined => {
    const lower = ext.toLowerCase();
    return viewers.value.toReversed().find((entry) => entry.extensions.includes(lower));
};
