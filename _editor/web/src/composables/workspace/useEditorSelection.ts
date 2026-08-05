import { ref } from "vue";

/* The live Monaco selection, as a module-level singleton (like useWorkspaceTabs): CodeView reports it, the
 * chat composer's editor-context chip reads it. Only one code editor is mounted at a time (the active
 * workspace tab), so a single slot is enough — clear() is path-guarded so a fast tab switch's unmount can't
 * wipe the successor's report. */

export interface EditorSelection {
    // Workspace-relative path of the file the selection lives in.
    readonly path: string;
    // 1-based inclusive line range.
    readonly startLine: number;
    readonly endLine: number;
    readonly text: string;
}

const current = ref<EditorSelection | undefined>();

const report = (selection: EditorSelection): void => {
    current.value = selection;
};

// Clears the slot when it still belongs to `path` — on cursor collapse and on editor unmount.
const clear = (path: string): void => {
    if (current.value?.path === path) {
        current.value = undefined;
    }
};

export function useEditorSelection() {
    return { selection: current, report, clear };
}
