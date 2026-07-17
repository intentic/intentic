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
    // Whether the host fetches the file as text or raw bytes before rendering.
    readonly fetch: "text" | "blob";
    readonly component: () => Promise<Component>;
}

const viewers = shallowRef<readonly RegisteredViewer[]>([]);

export const registerViewer = (viewer: RegisteredViewer): Disposable => {
    viewers.value = [...viewers.value, viewer];
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
