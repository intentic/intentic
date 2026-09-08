import type { Disposable } from "@intentic/extension-api";
import type { Component } from "vue";
import { shallowRef } from "vue";

// Registry of custom file viewers from extensions (contributes.viewers); FileViewer resolves an open file
// to one by extension and renders it. Module-level singleton, same shape as the view registry.

export interface RegisteredViewer {
    // The owning extension's id; error attribution and manifest-gating key off this.
    readonly owner: string;
    readonly id: string;
    // Bare file extensions (no dot) this viewer handles, from its manifest.
    readonly extensions: readonly string[];
    // Decoded text, whole-file bytes, or a streaming URL; from the manifest, so extensions can't widen their reach.
    readonly fetch: "text" | "blob" | "url";
    readonly component: () => Promise<Component>;
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

// The viewer registered for a file extension (lowercased); last registration wins, so a later extension
// can override a builtin.
export const viewerForExtension = (ext: string): RegisteredViewer | undefined => {
    const lower = ext.toLowerCase();
    return viewers.value.toReversed().find((entry) => entry.extensions.includes(lower));
};
