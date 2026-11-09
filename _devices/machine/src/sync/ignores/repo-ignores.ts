import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errnoCode, errorMessage } from "@intentic/base/errors";
import { REFERENCE_DIR, STATE_DIR } from "@intentic/constants";
import { z } from "zod";

// A REPOSITORY SAYS WHAT OF ITS OWN NOT TO SYNC, in a committed `<repo>/.intentic/sync.json`:
//
//     { "ignore": ["/runs", "bench/data/*.bin"] }
//
// The built-in list (ssh.ts IGNORES) knows build output by name; it cannot know that one game's `runs/` is 27,000 files
// of session recordings nobody edits on the device. Measured on rog, 2026-11-09: with Cargo's caches already left out,
// that folder was 27k of the 33k entries the sandbox's agent rescans every 2 s. The file lives in the repository rather
// than on the device because it describes the project, not the computer: every device that syncs it wants the same,
// an agent can add a line and the owner sees it in a diff, and the device already holds a copy (a repository's own
// `.intentic/` is synced; only the workspace root's is not), so this agent reads it locally with no new protocol.
//
// A pattern is a path from the folder holding that `.intentic/`, a leading `/` optional and meaning the same: `runs`
// is `<repo>/runs` and nothing deeper. `*` matches within one name. Nothing else: no `**`, `?`, `[...]`, and no `!`,
// which in Mutagen's syntax would switch a built-in ignore back on (`!.env` would put secrets on the wire). The narrow
// grammar is also what the copy-first comparison (project-files.ts ignoreExpression) matches exactly, so a project's
// listing and its session never disagree about what is ignored.
//
// Changing the file changes the session's ignore list, which is part of what `sessionMatchesSpec` compares: the next
// pass of the watcher recreates the session the way it recreates any drifted one, a two-way session only once it has
// settled. Ignoring a path deletes nothing on either side; its two copies just stop travelling. These patterns are
// never residue (residue.ts): what a person chose not to sync is not build output a build puts back.

const REPO_SYNC_FILE = "sync.json";

// Enough for any real list, few enough that a file someone generated cannot balloon every session's arguments.
const MAX_PATTERNS = 100;

const RepoSyncSchema = z.object({ ignore: z.array(z.string()).max(MAX_PATTERNS) });

// One name of a pattern: no separator, no glob but `*`, no escape, no negation, no brace.
const NAME = /^[^/*?[\]!\\{}]*(?:\*[^/*?[\]!\\{}]*)*$/;

// The pattern as a path under its repository with no leading or trailing `/`, or why it is refused.
export const repoPattern = (raw: string): { readonly path: string } | { readonly refused: string } => {
    const path = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (path === "") {
        return { refused: "it is empty" };
    }
    if (raw.trimStart().startsWith("!")) {
        return { refused: "a `!` pattern would sync something the built-in list keeps out" };
    }
    const names = path.split("/");
    if (names.some((name) => name === "" || name === "." || name === "..")) {
        return { refused: "it has an empty, `.` or `..` part" };
    }
    if (names.some((name) => !NAME.test(name) || name.replaceAll("*", "") === "")) {
        return { refused: "only plain names with `*` inside one name are understood (no `**`, `?`, `[...]`, `!`)" };
    }
    return { path };
};

export interface RepoIgnores {
    // Session-root-anchored Mutagen patterns (`/integra/runs`), sorted, without duplicates.
    readonly patterns: readonly string[];
    // What was refused and why, one line each, naming the file.
    readonly problems: readonly string[];
}

const readSyncFile = (file: string, scope: string, patterns: Set<string>, problems: string[]): void => {
    let text: string;
    try {
        text = readFileSync(file, "utf8");
    } catch (error) {
        if (errnoCode(error) !== "ENOENT" && errnoCode(error) !== "ENOTDIR") {
            problems.push(`${file} could not be read (${errorMessage(error)}), so nothing in it is left out of sync`);
        }
        return;
    }
    let parsed: z.infer<typeof RepoSyncSchema>;
    try {
        parsed = RepoSyncSchema.parse(JSON.parse(text));
    } catch (error) {
        problems.push(
            `${file} is not {"ignore": [up to ${MAX_PATTERNS} paths]} (${errorMessage(error).split("\n")[0]}), so nothing in it is left out of sync`,
        );
        return;
    }
    for (const raw of parsed.ignore) {
        const read = repoPattern(raw);
        if ("refused" in read) {
            problems.push(`${file}: ${JSON.stringify(raw)} is not left out of sync: ${read.refused}`);
        } else {
            patterns.add(`/${scope === "" ? "" : `${scope}/`}${read.path}`);
        }
    }
};

// Folders under the workspace root never searched for a repository's file: hidden ones (the root's own `.intentic`
// among them), the reference shelf, and the names the built-in list never syncs.
const SKIPPED = new Set([REFERENCE_DIR, "node_modules", "dist", "target"]);

// A folder that is not there (or not a folder) has no repositories; one that cannot be listed is said, not skipped.
const childDirs = (dir: string, problems: string[]): string[] => {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED.has(entry.name))
            .map((entry) => entry.name)
            .sort();
    } catch (error) {
        if (errnoCode(error) !== "ENOENT" && errnoCode(error) !== "ENOTDIR") {
            problems.push(`${dir} could not be listed (${errorMessage(error)}), so no repository in it leaves anything out of sync`);
        }
        return [];
    }
};

// Every `.intentic/sync.json` a pairing's folder holds where a repository would keep one. A project pairing's folder IS
// the repository, so only its own root. A workspace's repositories sit at its top level (`/work/integra`) or one below
// (`/work/extensions/<repo>`); those two levels are read and nothing deeper, so a pass costs a couple of directory
// listings whatever the tree holds. Never the workspace root's own `.intentic/`, which is the sandbox's state.
export const readRepoIgnores = (localDir: string, project: boolean): RepoIgnores => {
    const patterns = new Set<string>();
    const problems: string[] = [];
    if (project) {
        readSyncFile(join(localDir, STATE_DIR, REPO_SYNC_FILE), "", patterns, problems);
    } else {
        for (const top of childDirs(localDir, problems)) {
            readSyncFile(join(localDir, top, STATE_DIR, REPO_SYNC_FILE), top, patterns, problems);
            for (const below of childDirs(join(localDir, top), problems)) {
                readSyncFile(join(localDir, top, below, STATE_DIR, REPO_SYNC_FILE), `${top}/${below}`, patterns, problems);
            }
        }
    }
    return { patterns: [...patterns].sort(), problems };
};

// What was last said about each pairing's files, so a refused pattern is logged when it appears or changes rather than
// on every pass of the watcher.
const reported = new Map<string, string>();

export const reportRepoIgnoreProblems = (key: string, localDir: string, project: boolean, log: (line: string) => void): void => {
    const { problems } = readRepoIgnores(localDir, project);
    const said = problems.join("\n");
    if (reported.get(key) === said) {
        return;
    }
    reported.set(key, said);
    for (const problem of problems) {
        log(`${key}: ${problem}`);
    }
};
