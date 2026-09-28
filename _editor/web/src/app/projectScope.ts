import { sandboxRef } from "@intentic/extension-api";
import { isProjectDirName } from "@intentic/sandbox-contract";
import { activeSandboxId } from "../features/sandbox/overview/activeSandbox";
import { storedValue, storeValue } from "../lib/browserStorage";

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

export const projectScope = sandboxRef<string | undefined>(() => read(activeSandboxId.value));

// Everything is stored too, as the empty value `read` gives back as no project: a choice made rather than none made,
// which is what keeps `adoptProjectScope` from narrowing a workspace its owner (or a link they followed) widened.
export const setProjectScope = (project: string | undefined): void => {
    projectScope.value = project;
    storeValue(storageKey(activeSandboxId.value), project ?? ``);
};

// A project sandbox's own folder, as its daemon's hello names it (`projectDir`), is the scope its workspace opens on the
// first time this browser hears it. Once anything is stored for the sandbox, that is the owner's choice and stands:
// every reconnect says hello again. By the id of the sandbox that spoke, which a switch may have taken out of view.
export const adoptProjectScope = (sandboxId: string, projectDir: string): void => {
    if (!isProjectDirName(projectDir) || storedValue(storageKey(sandboxId)) !== undefined) {
        return;
    }
    storeValue(storageKey(sandboxId), projectDir);
    if (sandboxId === activeSandboxId.value) {
        projectScope.value = projectDir;
    }
};

// Whether a workspace-relative path (a repository id, a folder, a file) is the project or inside it. Segment-wise, so
// `apps/web2` is not inside `apps/web`.
export const inProject = (path: string, project: string): boolean => path === project || path.startsWith(`${project}/`);

// The predicate every scoped source applies: everything when nothing is open, else what is inside the project.
export const withinScope = (path: string): boolean => projectScope.value === undefined || inProject(path, projectScope.value);

// Whether a DIRECTORY is worth descending for the open project: inside it, or on the way down to it, since a project id
// can be nested (`apps` has to be walked to reach the project `apps/web`). For a file this is `withinScope`.
export const reachesScope = (dir: string): boolean =>
    projectScope.value === undefined || inProject(dir, projectScope.value) || inProject(projectScope.value, dir);
