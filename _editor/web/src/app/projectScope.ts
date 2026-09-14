import { ref, watch } from "vue";
import { activeSandboxId } from "../features/sandbox/overview/activeSandbox";
import { removeStoredValue, storedValue, storeValue } from "../lib/browserStorage";

// Which project the whole shell is looking at: one repository under the workspace root, or everything. A sandbox-wide
// selection, not a view's: the workspace roots at it, the agents board files conversations under it, and every
// surface that reads repository facts (the rail's tiles, extension views, preview targets, the Changes list) reads
// only its own. Kept per sandbox in browser storage, like the rail's pins: chrome, not data, and a switch of sandbox
// switches it.

const storageKey = (sandboxId: string | undefined): string => `intentic.project.${sandboxId ?? `local`}`;

const read = (sandboxId: string | undefined): string | undefined => {
    const stored = storedValue(storageKey(sandboxId));
    return stored === undefined || stored === `` ? undefined : stored;
};

export const projectScope = ref<string | undefined>(read(activeSandboxId.value));

export const setProjectScope = (project: string | undefined): void => {
    projectScope.value = project;
    if (project === undefined) {
        removeStoredValue(storageKey(activeSandboxId.value));
    } else {
        storeValue(storageKey(activeSandboxId.value), project);
    }
};

// Whether a workspace-relative path (a repository id, a folder, a file) is the project or inside it. Segment-wise, so
// `apps/web2` is not inside `apps/web`.
export const inProject = (path: string, project: string): boolean => path === project || path.startsWith(`${project}/`);

// The predicate every scoped source applies: everything when nothing is open, else what is inside the project.
export const withinScope = (path: string): boolean => projectScope.value === undefined || inProject(path, projectScope.value);

watch(activeSandboxId, (id, previous) => {
    if (id !== previous) {
        projectScope.value = read(id);
    }
});
