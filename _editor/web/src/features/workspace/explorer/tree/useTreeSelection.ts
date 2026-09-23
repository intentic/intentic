import { computed, type Ref, ref, watch } from "vue";
import { selectRange } from "../treeSelect";

// Which rows the tree's verbs act on. Click selects, Ctrl/Cmd toggles and Shift ranges from the anchor; the lead is the
// keyboard's cursor and the one tab stop; opening a file collapses the selection to it.

export interface TreeSelectionHost {
    // The file the editor has open.
    readonly selectedPath: () => string | null | undefined;
    // Visible order, markers excluded: what Shift ranges over.
    readonly order: Readonly<Ref<readonly string[]>>;
}

export const useTreeSelection = (host: TreeSelectionHost) => {
    const opened = host.selectedPath();
    const selection = ref<Set<string>>(new Set(opened ? [opened] : []));
    // Pivots Shift-range.
    const anchor = ref<string | null>(opened ?? null);
    const lead = ref<string | null>(opened ?? null);

    // Opening a file collapses selection to it; Ctrl/Shift-click never emit openFile, so multi-select survives.
    watch(host.selectedPath, (path) => {
        selection.value = new Set(path ? [path] : []);
        anchor.value = path ?? null;
        lead.value = path ?? null;
    });

    const selectSingle = (path: string): void => {
        selection.value = new Set([path]);
        anchor.value = path;
        lead.value = path;
    };
    const extendTo = (path: string): void => {
        selection.value = new Set(selectRange(host.order.value, anchor.value ?? path, path));
        lead.value = path;
    };
    const toggleAt = (path: string): void => {
        const next = new Set(selection.value);
        if (next.has(path)) {
            next.delete(path);
        } else {
            next.add(path);
        }
        selection.value = next;
        anchor.value = path;
        lead.value = path;
    };
    // What just landed (a paste, a copy out of an archive, an extract), the last of it leading.
    const selectLanded = (paths: readonly string[]): void => {
        selection.value = new Set(paths);
        anchor.value = paths.at(-1) ?? null;
        lead.value = anchor.value;
    };
    // Nothing selected and nothing to range from; the lead stays, so the keyboard picks up where it was.
    const clear = (): void => {
        selection.value = new Set();
        anchor.value = null;
    };
    // The tree's one tab stop: the lead if visible, else the first row, so Tab enters even when a filter hides the lead.
    const tabbablePath = computed<string | null>(() =>
        lead.value !== null && host.order.value.includes(lead.value) ? lead.value : (host.order.value[0] ?? null),
    );

    return { selection, anchor, lead, selectSingle, extendTo, toggleAt, selectLanded, clear, tabbablePath };
};
