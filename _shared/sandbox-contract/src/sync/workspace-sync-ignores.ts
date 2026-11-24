import { REFERENCE_DIR, STATE_DIR } from "@intentic/constants";

// FILE SYNC'S IGNORE LIST, shared by its two ends (2026-11-24). The device agent creates every Mutagen session with it
// (machine sync/ssh.ts), and the sandbox daemon reads it to decide which of its watcher's changes are worth telling a
// device about (sandbox hosts/sync/sync-changes.ts): one list, so the signal cannot drift from what the session carries.

// Mutagen's two-way ignore set: also excludes secrets and the daemon's `.intentic` state, never the search-ignore
// set's job. `.git` matches every level, since git state travels by git's own protocol (git-bridge.ts), not file sync.
// Every name here is frozen into a session at its creation, so changing the list replaces every session this agent
// holds, each from a settled state (mutagen.ts readyForReplacement). A project folder's share of it (PROJECT_IGNORES) is
// also `project-ignores.fixture.json`, which the desktop app's NOT_SYNCED is held to: change them together.
// The folders Cargo fills inside a profile folder that no run starts from.
const CARGO_PROFILE_CACHES = ["incremental", ".fingerprint", "deps", "build", "examples"] as const;

export const IGNORES: readonly string[] = [
    "node_modules",
    "dist",
    ".turbo",
    ".cache",
    ".next",
    ".angular",
    // Astro's build cache; `.astro/dev.json` holds machine-local paths, so both sides regenerating it is a
    // create-vs-create conflict that never settles.
    ".astro",
    // What the daemon's own walk already leaves out (@intentic/workspace-ignore IGNORED_DIRS): Python environments and
    // bytecode, Gradle's caches and scratch space. An environment holds interpreter paths and compiled wheels for the
    // machine that built it, so carried across it is broken on the other side, and each side rebuilding its own is the
    // same create-vs-create standoff as `.astro`.
    ".venv",
    "venv",
    "__pycache__",
    ".gradle",
    ".tmp",
    ".env",
    // The machine-local env files every framework's loader reads over `.env` (Vite, Next, CRA): secrets by convention,
    // and per machine by name. `.env.example` and the other committed variants still sync.
    ".env.local",
    ".env.*.local",
    ".secrets.json",
    "claude.json",
    // No `capabilities.json` entry: its credentials live in the vault now, and the daemon's own copy sits under
    // STATE_DIR already. Keeping it would only exclude a same-named file of the user's.
    // ANCHORED TO THE ROOT, unlike `.git` below, because two different directories share this name: the WORKSPACE's
    // state dir (the sandbox's own, carried one-way by the `-state` session) and a REPOSITORY's own `.intentic/`,
    // which is committed content — this repo keeps its `checks.json` there. Depth-matched, the one pattern swallowed
    // both, and since the bridge moves git state while file sync moves the files, a tracked file that never arrives
    // reads as deleted in the clone for good: `intentic/.intentic/checks.json` sat in VS Code's Source Control as a
    // phantom `D` that no amount of syncing could clear.
    `/${STATE_DIR}`,
    // The reference shelf, anchored for the same reason the state dir above is: the TOP-LEVEL `refs/` is consultation
    // material — already excluded from workspace views, search and dependency setup by this same constant — while a
    // repository's own `refs/` at any depth is ordinary content. Left in, it is the whole cost of syncing: measured on
    // a dogfooding machine as 215,555 of the workspace's 222,000 entries, an 18 GB upload, and a full rescan of all of
    // it every poll on an endpoint that has no file watcher.
    `/${REFERENCE_DIR}`,
    ".git",
    ".pnpm-store",
    // The image build's staging tree, for the same reason as `.astro` above and measured on a dogfooding machine:
    // both sides write their own `package.json`/`pnpm-lock.yaml` per extension into it, which is 98 create-vs-create
    // conflicts that two-way-safe will never settle — and while they stand, that pairing propagates nothing at all.
    ".image-out",
    // A REPOSITORY's own `.intentic/` travels (its `checks.json` is committed), but these two folders under it are the
    // machine's own: `.intentic/local` (caches, logs, runtime and temporary files) and the older `.intentic/cache`.
    // Each end writes its own, so carried across they are create-vs-create conflicts that two-way-safe will never
    // settle, measured on a dogfooding machine as a stuck `index.db-shm` of a search index that has since been removed.
    // `**/` is Mutagen's (doublestar) spelling for "at any depth, the root included"; a path without it is anchored.
    `**/${STATE_DIR}/cache`,
    `**/${STATE_DIR}/local`,
    // Cargo's build output: a profile folder under `target/`, natively or under a target triple
    // (`target/x86_64-pc-windows-msvc/release`). Measured on rog, 2026-10-26: three crates' `target/` were 16 of the
    // workspace's 18 GB and 31,000 of its 44,000 entries, SHA-1 hashed and shipped both ways on every `cargo build`
    // either side ran, and rescanned every poll. Matched by its profile folders rather than a bare `target`, which is
    // also an ordinary folder name in source trees; what is left of `target/` (CACHEDIR.TAG, .rustc_info.json) is bytes.
    "**/target/debug",
    "**/target/release",
    "**/target/*/debug",
    "**/target/*/release",
    // Every other profile's (a custom `--profile fast` lands in `target/fast`) caches, natively and under a triple:
    // the incremental state, fingerprints, compiled dependencies, build-script output and examples. Measured on the
    // owner's shinobi workspace, 2026-11: `target/fast` alone was 1.2-1.9 GB of these, carried both ways on every
    // build. The profile folder's own top level (the finished binary, its `.d` file) still travels, so a build made on
    // one side can be started by hand on the other; a device run never needs it, since `devices run` pushes its
    // artifact over the device link (sandbox bin/devices).
    ...CARGO_PROFILE_CACHES.flatMap((cache) => [`**/target/*/${cache}`, `**/target/*/*/${cache}`]),
];

// WHETHER THE WORKSPACE SESSION LEAVES A PATH OUT, by IGNORES, for a path relative to the workspace root. A path is left
// out when it or any folder above it matches, since Mutagen never looks inside an ignored folder. Only the spellings
// IGNORES uses are understood: a pattern without `/` matches a single name at any depth, with `*` inside one name; a
// leading `/` anchors it to the root; `**` is any number of folders, the root included. Any other pattern matches
// nothing. That errs on one side only: a change this reads as carried costs a device one sync cycle it did not need,
// while a change read as ignored would wait for the session's backstop scan.
type Glob = readonly string[];

const UNDERSTOOD = /^[^?[\]!\\{}]+$/;

const globOf = (pattern: string): { readonly anywhere: boolean; readonly segments: Glob } | undefined => {
    if (!UNDERSTOOD.test(pattern)) {
        return undefined;
    }
    if (pattern.startsWith("/")) {
        return { anywhere: false, segments: pattern.slice(1).split("/") };
    }
    return pattern.includes("/") ? { anywhere: false, segments: pattern.split("/") } : { anywhere: true, segments: [pattern] };
};

const nameMatches = (glob: string, name: string): boolean => {
    if (!glob.includes("*")) {
        return glob === name;
    }
    const parts = glob.split("*").map((part) => part.replace(/[.+^${}()|\\]/g, "\\$&"));
    return new RegExp(`^${parts.join("[^/]*")}$`).test(name);
};

const segmentsMatch = (glob: Glob, path: readonly string[]): boolean => {
    const [head, ...rest] = glob;
    if (head === undefined) {
        return path.length === 0;
    }
    if (head === "**") {
        // zero folders, or one more and try again
        return segmentsMatch(rest, path) || (path.length > 0 && segmentsMatch(glob, path.slice(1)));
    }
    const [name, ...tail] = path;
    return name !== undefined && nameMatches(head, name) && segmentsMatch(rest, tail);
};

export const syncIgnoreMatcher = (patterns: readonly string[]): ((relPath: string) => boolean) => {
    const globs = patterns.flatMap((pattern) => globOf(pattern) ?? []);
    const named = globs.filter((glob) => glob.anywhere).map((glob) => glob.segments[0] ?? "");
    const rooted = globs.filter((glob) => !glob.anywhere).map((glob) => glob.segments);
    return (relPath: string): boolean => {
        const segments = relPath.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
        if (segments.some((segment) => named.some((glob) => nameMatches(glob, segment)))) {
            return true;
        }
        // The path itself and every folder above it, each against every rooted pattern.
        return segments.some((_, index) => rooted.some((glob) => segmentsMatch(glob, segments.slice(0, index + 1))));
    };
};

// The workspace session's own rules: what the sandbox's change signal leaves out.
export const workspaceSyncIgnores: (relPath: string) => boolean = syncIgnoreMatcher(IGNORES);
