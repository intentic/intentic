import { definePreference } from "@intentic/ui/preference";
import { type Ref, ref, watch } from "vue";
import { workspaceDir } from "../health/workspaceScope";

// The desk: the main pane's "nothing open" surface drawn as large tiles of one folder. Opt-in, since it takes the
// place of the drop target a reader between files gets today. Which folder is module-level state, so closing the last
// tab brings back the folder the reader left, not the root.

const STORAGE_KEY = `ui-workspace-desk`;

const desk: Ref<boolean> = definePreference<boolean>({
    key: STORAGE_KEY,
    read: (raw) => raw === `1`,
    write: (value) => (value ? `1` : `0`),
});

// Root-relative; the scope root ("" for the whole tree) is the desk's own root.
const deskDir = ref<string>(workspaceDir.value);

// Whether `dir` lies at or under the scope root; a path outside it names nothing this desk can show.
const withinScope = (dir: string, root: string): boolean => root === `` || dir === root || dir.startsWith(`${root}/`);

// Re-roots when the scope moves: a folder path means nothing under a different project root.
watch(workspaceDir, (root) => {
    deskDir.value = root;
});

// A sandbox switch is a different /work; the folder the reader was in is not there.
export const resetDesk = (): void => {
    deskDir.value = workspaceDir.value;
};

export function useDesk() {
    const openDir = (dir: string): void => {
        deskDir.value = withinScope(dir, workspaceDir.value) ? dir : workspaceDir.value;
    };
    return { desk, deskDir, openDir };
}
