import { errorMessage, stderrOf } from "@intentic/base/errors";
import type { GitRunner } from "@intentic/base/git";
import type { GitChange } from "@intentic/sandbox-contract/schemas/git/git";
import { parseNameStatusZ } from "../../../git/changes/changes-porcelain.js";
import { UNDERIVED } from "../rederive.js";

// WHAT `git apply` SAYS OF A DELTA, read by a land (land.ts): whether a patch applies or un-applies, and which of the
// delta's changes a refusal names. A land judges with it before writing and proves with it after: a patch un-applies
// exactly when its post-image is in the tree.

// `git apply --check`, the exit code as a throw: undefined when the patch applies, else the stderr, which names every
// file patch that failed since git checks the whole list before giving up. `reverse` tells a clash from content main
// already has: a patch un-applies cleanly exactly when its post-image is already there.
export const refusal = async (main: string, patch: string, direction: "forward" | "reverse", git: GitRunner): Promise<string | undefined> => {
    try {
        await git(main, ["apply", "--check", ...(direction === "reverse" ? ["--reverse"] : []), patch]);
        return undefined;
    } catch (error) {
        return gitSaid(error);
    }
};

export const applies = async (main: string, patch: string, direction: "forward" | "reverse", git: GitRunner): Promise<boolean> =>
    (await refusal(main, patch, direction, git)) === undefined;

// What git said, off the runner's rejection; the message itself when the throw carries no stderr.
export const gitSaid = (error: unknown): string => {
    const stderr = stderrOf(error);
    return stderr !== undefined && stderr !== "" ? stderr : errorMessage(error);
};

// One change of a delta with the complete path set its diff spans: a rename is one change across two paths, so naming
// only the destination breaks `-M` pairing and creates instead of renaming.
export interface DeltaChange {
    // Destination path: what a conflict report names, since it's the path the user goes looking for.
    readonly path: string;
    // Every path this change's own diff spans: the destination, plus a rename's source.
    readonly paths: readonly string[];
    // What must not exist once this change has applied: a deletion's own path, a rename's source.
    readonly removes: readonly string[];
}

// A `--name-status` row's path set; `from` is git's rename source. A copy carries none (parseNameStatusZ reports it as
// a plain add).
export const deltaChangeOf = (change: GitChange): DeltaChange => ({
    path: change.path,
    paths: change.from === undefined ? [change.path] : [change.from, change.path],
    removes: change.status === "deleted" ? [change.path] : change.from === undefined ? [] : [change.from],
});

// How `git apply` names the file a refusal or a failed write is about, one line each, the path as the capture. A line
// none of these place is scanned for a known path instead, so an unknown wording still names what it names.
// allow(dependency-text): git apply, run untranslated by the base runner; a refusal naming nothing placeable is probed change by change (probeEach), a failed write naming nothing is rethrown.
const REFUSAL_LINES: readonly RegExp[] = [
    /^error: patch failed: (.+):\d+$/,
    /^error: (.+): (?:patch does not apply|already exists in (?:working directory|index)|does not (?:exist|match) in index|No such file or directory|wrong type|has type \d+, expected \d+)$/,
    /^error: cannot apply binary patch to '(.+)' without full index line$/,
    /^error: (?:binary patch does not apply to|binary patch to) '(.+)'/,
    /^error: the patch applies to '(.+)' \(/,
    /^error: unable to (?:write|add|remove) file '(.+)'/,
    /^error: (?:cannot|could not) (?:open|read|stat) '(.+)'/,
];

// Where a path may sit in a message: after the start, a space or a quote, and before a colon, a quote, a space, a
// bracket or the end. Keeps `a.ts` from matching inside `ba.ts`.
const boundedAt = (line: string, path: string, at: number): boolean => {
    const before = at === 0 ? " " : line[at - 1];
    const after = at + path.length >= line.length ? " " : line[at + path.length];
    return (
        (before === " " || before === "'" || before === '"') && (after === " " || after === "'" || after === '"' || after === ":" || after === ")")
    );
};

// The changes a refusal names, matched by any of their paths (a rename is named on either leg). Empty when the message
// held nothing this reader could place, which callers treat as unknown, never as nothing.
// allow(dependency-text): git apply's stderr (REFUSAL_LINES, then its `error:` verdict lines); unplaced reads as unknown, as above.
export const changesNamedIn = (stderr: string, byPath: ReadonlyMap<string, DeltaChange>): Set<DeltaChange> => {
    const named = new Set<DeltaChange>();
    for (const line of stderr.split("\n")) {
        const captured = REFUSAL_LINES.map((pattern) => pattern.exec(line)?.[1]).find((path) => path !== undefined && byPath.has(path));
        const placed = captured === undefined ? undefined : byPath.get(captured);
        if (placed !== undefined) {
            named.add(placed);
            continue;
        }
        if (!line.startsWith("error:")) {
            continue;
        }
        for (const [path, change] of byPath) {
            const at = line.indexOf(path);
            if (at !== -1 && boundedAt(line, path, at)) {
                named.add(change);
            }
        }
    }
    return named;
};

// Every path of a change set, each pointing back at its change; a rename answers on either leg.
export const changesByPath = (changes: readonly DeltaChange[]): Map<string, DeltaChange> => {
    const byPath = new Map<string, DeltaChange>();
    for (const change of changes) {
        for (const path of change.paths) {
            byPath.set(path, change);
        }
    }
    return byPath;
};

// A delta's changes, `from`..`tip` as `main` reads it, derived files left out (rederive.ts).
export const deltaChanges = async (main: string, from: string, tip: string, git: GitRunner): Promise<DeltaChange[]> =>
    parseNameStatusZ((await git(main, ["diff", "--name-status", "-z", "-M", from, tip, ...UNDERIVED])).stdout).map(deltaChangeOf);
