import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Log } from "@intentic/local-agent";
import { clearableOnDevice, type DeviceConflict } from "@intentic/sandbox-contract";

// BUILD OUTPUT IS NOT A CONFLICT. Two-way-safe exists to stop one person's edit overwriting another's, and for that it
// is right; but the standoff it produces most often on a workspace has no two sides at all. An agent moves or deletes a
// package directory in the sandbox. This device still holds `node_modules`, `dist`, `.turbo` and `.cache` inside it —
// content the session is told to ignore, which Mutagen therefore scans as `untracked` and refuses to destroy along with
// the directory, because it cannot know whether anyone wanted it. So the deletion never lands, the conflict stands, and
// a monorepo where every package carries three ignored directories produces one of these per directory an agent moves.
//
// Everything here removes ONLY content the session already ignores — content no sync would ever have carried, and that
// a build puts back. That is the single invariant, and every function below defends it separately: the matcher refuses
// patterns it does not understand, the husk check refuses anything it cannot read, the sweep refuses a path it cannot
// spell to a remote shell, and the heal re-checks on disk rather than trusting what Mutagen reported.

// Mutagen's ignore syntax is broader than what this agent writes. Only the two spellings it actually uses are
// understood: a bare name, matching that segment at any depth, and a `/`-anchored name, matching only at the sync root.
// Anything else matches NOTHING, so a pattern this matcher was never taught can only leave residue standing — never
// widen what gets deleted.
const PLAIN_PATTERN = /^[^/*?[\]!\\]+$/;

export const ignoreMatcher = (patterns: readonly string[]): ((path: string) => boolean) => {
    const anywhere = new Set<string>();
    const atRoot = new Set<string>();
    for (const pattern of patterns) {
        if (PLAIN_PATTERN.test(pattern)) {
            anywhere.add(pattern);
        } else if (pattern.startsWith("/") && PLAIN_PATTERN.test(pattern.slice(1))) {
            atRoot.add(pattern.slice(1));
        }
    }
    return (path: string): boolean => {
        const segments = path.split("/");
        return segments.some((segment) => anywhere.has(segment)) || (segments.length === 1 && atRoot.has(segments[0] ?? ""));
    };
};

// A path this module will join onto the sync root and delete: relative, forward-slashed, no traversal, no backslash
// (which `split("/")` would carry a whole second segment past), no NUL. Mutagen spells its conflict roots exactly this
// way, so anything else is a path this agent does not recognise and leaves standing.
export const isSafeRelativePath = (path: string): boolean =>
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

// Stricter, for the one place a path reaches a REMOTE shell: ssh joins its arguments into a command string the far side
// re-parses, so only paths that survive that unchanged are ever asked about. A folder with a space in its name is left
// out of the sweep rather than mangled into a different path.
export const isShellSafePath = (path: string): boolean => isSafeRelativePath(path) && /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(path);

// Whether this directory holds nothing but ignored content, all the way down. An entry the session would have carried
// makes it false; so does an entry that cannot be read, or one that is neither file nor directory — unknown is never
// read as derived. An EMPTY directory is a husk: there is nothing in it to lose.
export const isDerivedHusk = async (root: string, path: string, ignored: (path: string) => boolean): Promise<boolean> => {
    const entries = await readdir(join(root, path), { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) {
        return false;
    }
    for (const entry of entries) {
        const child = `${path}/${entry.name}`;
        if (ignored(child)) {
            continue;
        }
        if (!entry.isDirectory()) {
            return false;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- depth-first by design, and the common case returns on the first real file
        if (!(await isDerivedHusk(root, child, ignored))) {
            return false;
        }
    }
    return true;
};

// Walks the synced folder once, pruning at every ignore match, and returns the OUTERMOST directories holding nothing
// but ignored content. Outermost because a husk inside a husk goes with its parent, and because each one is asked about
// by name afterwards. The sync root itself is never returned even when the whole tree reads as residue: this sweeps
// inside a folder, it does not empty one.
export const findDerivedHusks = async (root: string, ignored: (path: string) => boolean): Promise<string[]> => {
    const husks: string[] = [];
    const walk = async (path: string): Promise<boolean> => {
        const entries = await readdir(path === "" ? root : join(root, path), { withFileTypes: true }).catch(() => undefined);
        if (entries === undefined) {
            return false;
        }
        let husk = true;
        const nested: string[] = [];
        for (const entry of entries) {
            const child = path === "" ? entry.name : `${path}/${entry.name}`;
            if (ignored(child)) {
                continue;
            }
            if (!entry.isDirectory()) {
                husk = false;
                continue; // a real file here, but residue may still sit deeper: the siblings are still worth walking
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- depth-first by design; the walk prunes at every ignore match
            if (await walk(child)) {
                nested.push(child);
            } else {
                husk = false;
            }
        }
        // A husk reports itself to its parent and keeps its own quiet; only a directory that is NOT residue has to name
        // the residue inside it.
        if (!husk) {
            husks.push(...nested);
        }
        return husk;
    };
    await walk("");
    return husks;
};

export interface ResidueExec {
    /** stdout, or undefined when the command failed — which must never be read as "the sandbox does not have it". */
    readonly run: (command: string, args: readonly string[]) => Promise<string | undefined>;
}

// `$0` is the placeholder ssh's remote shell needs before positional arguments; `$1` is the sync root, and the rest are
// the paths. Quoted here rather than by a helper because ssh joins its argv into one string that the far side re-parses:
// these quotes are what survive that. No single quote appears inside, which is what makes the wrapping pair safe.
const ABSENT_PROBE = `'d=$1; shift; for p in "$@"; do [ -e "$d/$p" ] || printf "%s\\n" "$p"; done'`;

// Which of these paths the sandbox does NOT have, while their parent directory still exists there. Both halves matter:
// absence alone would sweep a whole tree against a sandbox that is mid-rebuild with an empty /work, whereas a parent
// that is still present says the directory really was removed from somewhere that remains. One ssh call, and undefined
// when it failed — a sandbox that did not answer must remove nothing.
export const absentInSandbox = async (
    exec: ResidueExec,
    alias: string,
    remoteDir: string,
    paths: readonly string[],
): Promise<ReadonlySet<string> | undefined> => {
    const askable = paths.filter(isShellSafePath);
    if (askable.length === 0) {
        return new Set();
    }
    const out = await exec.run("ssh", ["-o", "BatchMode=yes", alias, "sh", "-c", ABSENT_PROBE, "_", remoteDir, ...askable]);
    if (out === undefined) {
        return undefined;
    }
    return new Set(
        out
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== ""),
    );
};

// The sync root for a root-level path, which is never asked about: it exists whenever ssh answered at all.
const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

// Residue the sandbox has no counterpart for: gone there, present here, and holding nothing but ignored content.
// `undefined` from the probe means the sandbox was not asked successfully, and nothing is swept.
export const sweepableHusks = (husks: readonly string[], absent: ReadonlySet<string> | undefined): string[] =>
    absent === undefined ? [] : husks.filter((path) => absent.has(path) && !absent.has(parentOf(path)));

// `recursive` because a husk is a tree of ignored directories; `force` so a race that already removed it counts as done
// rather than as a failure that leaves the session wedged.
const removeResidue = async (root: string, path: string): Promise<boolean> =>
    await rm(join(root, path), { recursive: true, force: true }).then(
        () => true,
        () => false,
    );

export interface ResidueOutcome {
    /** Paths removed from this device, each already logged by name. */
    readonly removed: readonly string[];
    /** Conflicts left standing for a person: two real copies, which nothing here will choose between. */
    readonly standing: number;
}

// THE HEAL. Clears the residue behind every conflict that is derived-leftover on this device's side, and leaves every
// other conflict exactly where it is. Mutagen's own report says which is which, but it is not taken at its word: each
// path is re-read from disk here, so a report that has gone stale between the read and the removal costs nothing.
export const clearConflictResidue = async (args: {
    readonly root: string;
    readonly conflicts: readonly DeviceConflict[];
    readonly ignores: readonly string[];
    readonly log: Log;
}): Promise<ResidueOutcome> => {
    const ignored = ignoreMatcher(args.ignores);
    const removed: string[] = [];
    let standing = 0;
    for (const conflict of args.conflicts) {
        if (!clearableOnDevice(conflict) || !isSafeRelativePath(conflict.path)) {
            standing += 1;
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one path at a time, and a stale report must not remove the next one
        if (!(await isDerivedHusk(args.root, conflict.path, ignored))) {
            // The report said residue and the disk says otherwise: something real arrived since. Left for a person.
            standing += 1;
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequenced so a failure names one path
        if (await removeResidue(args.root, conflict.path)) {
            removed.push(conflict.path);
        } else {
            standing += 1;
        }
    }
    if (removed.length > 0) {
        args.log(
            `  cleared build output this device had left in ${removed.length} director${removed.length === 1 ? "y" : "ies"} the sandbox deleted, which was holding those deletions back: ${removed.join(", ")}`,
        );
    }
    return { removed, standing };
};

// THE SWEEP. The same removal, found by walking rather than by waiting for Mutagen to flag it. Run where a session is
// about to be created from nothing, since residue that is merely sitting there — never yet conflicted — is what a fresh
// session with no history to compare against propagates BACK to the sandbox as empty directories.
export const sweepDerivedResidue = async (args: {
    readonly exec: ResidueExec;
    readonly root: string;
    readonly alias: string;
    readonly remoteDir: string;
    readonly ignores: readonly string[];
    readonly log: Log;
}): Promise<readonly string[]> => {
    const ignored = ignoreMatcher(args.ignores);
    const husks = await findDerivedHusks(args.root, ignored);
    if (husks.length === 0) {
        return [];
    }
    const absent = await absentInSandbox(args.exec, args.alias, args.remoteDir, [...husks, ...husks.map(parentOf)].filter((path) => path !== ""));
    const sweepable = sweepableHusks(husks, absent);
    const removed: string[] = [];
    for (const path of sweepable) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequenced so a failure names one path
        if (await removeResidue(args.root, path)) {
            removed.push(path);
        }
    }
    if (removed.length > 0) {
        args.log(`  swept ${removed.length} director${removed.length === 1 ? "y" : "ies"} of build output the sandbox no longer has: ${removed.join(", ")}`);
    }
    return removed;
};
