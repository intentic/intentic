import { readFile } from "node:fs/promises";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { inWorktree, type IsolationPlan } from "../agents/isolation.js";
import { type Defence, defencesOf, MAX_PROBES, probeCost } from "./load-bearing.js";

/* WHAT THIS TURN DELETED, which is the one thing no other record in the daemon keeps.
 *
 * The proof ledger next door (agent-verification.ts) records which files a turn EDITED, because that is all
 * "has anything been proven since" needs. It is not enough here: a turn that adds thirty lines and a turn that
 * removes a `sleep` are the same row in that ledger, and only one of them is about to take a nightly job down.
 * So this is a second, narrower record over the same hooks, and it keeps content rather than paths.
 *
 * THE SNAPSHOT IS TAKEN BEFORE THE EDIT, at PreToolUse, and only on the FIRST touch of a path in this turn. It
 * has to be before: PostToolUse arrives after the bytes are gone, and no hook input carries them (`Edit` has
 * `old_string`, `Write` and the hashline tools have nothing at all). It has to be the first touch: five edits
 * to one file across a turn are one before-and-after question, not five, and comparing against the fourth edit
 * would call the turn's own scaffolding a deletion.
 *
 * A LINE THAT MOVED IS NOT A LINE THAT WENT. The removed set is computed against the current content of EVERY
 * path this turn touched, not just the one it left, so extracting a helper into a new module reports nothing.
 * That is the largest false-positive class there is, it costs one extra comparison over content already read,
 * and without it the check would be loudest during exactly the refactors it has least to say about.
 *
 * PER-TURN AND IN MEMORY, like the proof ledger and for the same reason: what an earlier turn removed is not
 * this turn's question, so there is nothing to persist and nothing to age out.
 *
 * WHAT IT CANNOT SEE: a file rewritten by a shell command rather than by an edit tool, because no hook fires
 * for the bytes `sed -i` replaces. The same honest limit the proof ledger has with an unrecognised command,
 * and the same remedy, the landing moment reads the branch diff and misses nothing. */

// How many files the follow-up names. Past three the message stops being a thing to act on and becomes a
// report, and the turn is being asked to do one thing.
const MAX_FILES = 3;

// How many defended lines are quoted per file. One is usually the whole story; three is the ceiling before the
// message reads as a diff the model has already seen.
const MAX_LINES_PER_FILE = 3;

export interface PathRemoval {
    // As the agent named it, so the follow-up spells the path the way the model will look for it.
    readonly path: string;
    readonly lines: readonly string[];
}

export interface RemovalLedger {
    /* The file's content as it stood before the first edit of this turn. Ignored on later touches of the same
     * path, and `undefined` records a file that did not exist yet, which is not the same as an empty one: a
     * turn that creates a file and then trims it has removed nothing. */
    readonly notePrior: (path: string, content: string | undefined) => void;
    // What is gone, per path, given a reader for how each file stands now. Empty ⇒ nothing to ask about.
    readonly removals: (read: FileReader) => Promise<readonly PathRemoval[]>;
}

// How the caller reads a file as it stands now. Undefined ⇒ the file is gone, which is the largest removal
// there is and the one a naive diff would miss entirely.
export type FileReader = (path: string) => Promise<string | undefined>;

const meaningfulLines = (content: string): string[] => content.split("\n").map((line) => line.trim()).filter((line) => line !== "");

export const createRemovalLedger = (): RemovalLedger => {
    const priors = new Map<string, string | undefined>();
    return {
        notePrior: (path, content) => {
            if (priors.has(path)) {
                return;
            }
            priors.set(path, content);
        },
        removals: async (read) => {
            const now = new Map<string, string>();
            for (const path of priors.keys()) {
                const content = await read(path);
                if (content !== undefined) {
                    now.set(path, content);
                }
            }
            // Everything the turn left standing, anywhere it touched. A line still present in one of these has
            // moved, not gone.
            const surviving = new Set([...now.values()].flatMap(meaningfulLines));
            const out: PathRemoval[] = [];
            for (const [path, prior] of priors) {
                if (prior === undefined) {
                    continue;
                }
                const lines = [...new Set(meaningfulLines(prior))].filter((line) => !surviving.has(line));
                if (lines.length > 0) {
                    out.push({ path, lines });
                }
            }
            return out;
        },
    };
};

export interface RemovalDeps {
    // The turn's own tree, and the repository git is asked from. Absent ⇒ no history to consult, so only a
    // removal that defends itself in words is reported.
    readonly cwd?: string | undefined;
    readonly isolation?: IsolationPlan | undefined;
    readonly read?: FileReader | undefined;
    readonly git?: GitRunner | undefined;
    // The clock, as a value: an age boundary is a fact a test states rather than one it waits for.
    readonly now?: number | undefined;
}

export const readWorkspaceFile: FileReader = async (path) =>
    readFile(path, "utf8").then(
        (content) => content,
        // A file the turn deleted, or one it moved. Not an error: it is the answer, and the loudest one.
        () => undefined,
    );

const quote = (defence: Defence): string => `- \`${defence.line}\` — ${defence.detail}`;

const nudgeText = (found: ReadonlyArray<readonly [string, readonly Defence[]]>): string => {
    const sections = found.slice(0, MAX_FILES).map(([path, defences]) => {
        const shown = defences.slice(0, MAX_LINES_PER_FILE).map(quote);
        const rest = defences.length - shown.length;
        // A cap that hides its own existence reads as the whole finding, which is the one thing a check about
        // unnoticed deletions must never do.
        return [path, ...shown, ...(rest > 0 ? [`- ... and ${rest} more in this file`] : [])].join("\n");
    });
    const restFiles = found.length - Math.min(found.length, MAX_FILES);
    return [
        `This turn deleted code the repository's own history defends:`,
        "",
        sections.join("\n\n"),
        ...(restFiles > 0 ? ["", `... and ${restFiles} more ${restFiles === 1 ? "file" : "files"} like this.`] : []),
        "",
        `Do one of three things before finishing, and say which: restore it, write a test that fails without it, or state what makes the removal safe now.`,
        `A passing suite does not settle this on its own. Nothing in it covered these lines, which is how they survived this long.`,
    ].join("\n");
};

/* THE `verify-removals` BUILT-IN, as one function: what this turn should be told, or nothing.
 *
 * A built-in rather than something the rule table could express, for the same reason the proof ledger is one:
 * what it reads is a running record of the turn's own deletions against what git says about them, and only the
 * daemon is standing where both are visible. The table's job is to say WHEN it applies and to what paths.
 *
 * ONE PROBE BUDGET FOR THE WHOLE TURN, spent on the files with the most to answer for. A turn that deleted
 * defended-looking lines from nine files does not get nine files' worth of subprocesses; it gets MAX_PROBES,
 * and the message says as much rather than presenting a truncated list as the whole finding. */
export const verifyRemovalsMessage = async (ledger: RemovalLedger, deps: RemovalDeps = {}): Promise<string | undefined> => {
    const read = deps.read ?? readWorkspaceFile;
    const removals = await ledger.removals(async (path) => read(inWorktree(path, deps.isolation)));
    if (removals.length === 0) {
        return undefined;
    }
    // Most defended-looking lines first, so a tight budget is spent where the question is sharpest rather than
    // on whichever file the agent happened to open first.
    const ranked = [...removals].sort((a, b) => probeCost(b.lines) - probeCost(a.lines));
    const found: (readonly [string, readonly Defence[]])[] = [];
    let budget = deps.cwd === undefined ? 0 : MAX_PROBES;
    for (const { path, lines } of ranked) {
        const defences = await defencesOf(deps.cwd ?? "", inWorktree(path, deps.isolation), lines, budget, deps.now ?? Date.now(), deps.git ?? defaultGit);
        budget -= Math.min(budget, probeCost(lines));
        if (defences.length > 0) {
            found.push([path, defences]);
        }
    }
    return found.length === 0 ? undefined : nudgeText(found);
};
