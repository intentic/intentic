import { sandboxRef } from "@intentic/extension-api";

/* The live Monaco selection, as a module-level singleton (like useWorkspaceTabs): CodeView reports it, the chat composer's editor-context chip reads it. */

export interface EditorSelection {
    // Workspace-relative path of the file the selection lives in.
    readonly path: string;
    // 1-based inclusive line range.
    readonly startLine: number;
    readonly endLine: number;
    readonly text: string;
}

// A path in one sandbox's /work, so a switch empties the slot.
const current = sandboxRef<EditorSelection | undefined>(() => undefined);

const report = (selection: EditorSelection): void => {
    current.value = selection;
};

// Clears the slot when it still belongs to `path`, on cursor collapse and on editor unmount.
const clear = (path: string): void => {
    if (current.value?.path === path) {
        current.value = undefined;
    }
};

export function useEditorSelection() {
    return { selection: current, report, clear };
}
