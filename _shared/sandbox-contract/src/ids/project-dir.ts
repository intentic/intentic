import { MEMORY_FILE, PUBLIC_DIR, REFERENCE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { STARTER_REPO } from "../state/starter.js";

// A PROJECT SANDBOX is made for one folder on the owner's computer, synced live into `/work/<name>` rather than into
// /work itself: the workspace root is the daemon's own, where it keeps its state, seeds its starter repo and serves
// `public/` to anyone with a link. `<name>` is derived from the folder's name once, on the owner's side, and every
// later reader (the sync agent, `ic`, the daemon) only validates it. `_sandbox/ic/src/sandbox/project_dir.rs` holds the
// validation again for the host side; `project-dir.fixture.json` is the one set of cases both run.

// Top-level names the daemon treats as its own, so a project can never land on one: the public outbox, the reference
// shelf, the starter repo seeded on first boot, the root repo's id and the three repo roles repo discovery refuses
// (`_sandbox/sandbox/src/workspace/layout/repo-discovery.ts`), and the standing-instructions file it writes. Then the
// names every walk of the workspace skips at any depth (@intentic/workspace-ignore IGNORED_DIRS, and the private file
// the git scopes leave out), where a project would sync and never be seen; the daemon's tests hold this list to that
// one. Everything else of either kind starts with a dot (`.intentic`, `.venv`), which the name rule below refuses.
export const RESERVED_PROJECT_DIR_NAMES: readonly string[] = [
    PUBLIC_DIR,
    REFERENCE_DIR,
    STARTER_REPO,
    "root",
    "intent",
    "desired-state",
    "app",
    MEMORY_FILE,
    "node_modules",
    "dist",
    "venv",
    "claude.json",
];

// Starts alphanumeric, so no dot-file and no leading dash an argv could read as a flag; no separator, so it is always
// one path segment; bounded, since it also names a git dir and a folder in every view of the workspace.
const PROJECT_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROJECT_DIR_NAME_MAX = 64;

// Used when nothing of the folder's name survives the slug (a name in another script, or only punctuation).
const FALLBACK_NAME = "project";

// Combining marks, which NFKD splits off an accented letter.
const COMBINING_MARKS = /[\u0300-\u036f]/g;

export const isProjectDirName = (name: string): boolean => PROJECT_DIR_NAME.test(name) && !RESERVED_PROJECT_DIR_NAMES.includes(name);

// The workspace-relative name for a folder the owner picked, always one `isProjectDirName` accepts. Accents are folded
// to their base letter first, so `Café` keeps its `e` rather than losing it to a dash.
export const projectDirNameFor = (folderBasename: string): string => {
    const slug = folderBasename
        .normalize("NFKD")
        .replace(COMBINING_MARKS, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^[._-]+/, "")
        .slice(0, PROJECT_DIR_NAME_MAX)
        .replace(/[.-]+$/, "");
    const name = slug === "" ? FALLBACK_NAME : slug;
    return RESERVED_PROJECT_DIR_NAMES.includes(name) ? `${name}-project` : name;
};

// Where a project folder lands in the sandbox, and the name back out of such a path: exactly `<root>/<name>`, anything
// else (a deeper path, a trailing slash, a reserved name) is not a project dir.
export const projectRemoteDir = (name: string): string => `${WORKSPACE_ROOT}/${name}`;

export const projectDirNameOf = (remoteDir: string, root: string = WORKSPACE_ROOT): string | undefined => {
    const prefix = `${root}/`;
    if (!remoteDir.startsWith(prefix)) {
        return undefined;
    }
    const name = remoteDir.slice(prefix.length);
    return isProjectDirName(name) ? name : undefined;
};
