import { readFile } from "node:fs/promises";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { inWorktree, type IsolationPlan } from "../../agents/worktrees/isolation.js";
import { type Defence, defencesOf, MAX_PROBES, probeCost } from "./load-bearing.js";

// Tracks what a turn deleted (content, not paths). Snapshots each touched path's content at PreToolUse, on first touch
// only; removed lines are those missing from the final content of every path touched, so a moved line doesn't count as
// gone. Misses a file rewritten by a shell command rather than an edit tool; the landing diff catches that.

// How many files the follow-up names; past this it reads as a report, not one thing to act on.
const MAX_FILES = 3;

// How many defended lines are quoted per file; one is usually the whole story.
const MAX_LINES_PER_FILE = 3;

export interface PathRemoval {
    // As the agent named it, so the follow-up matches what the model will look for.
    readonly path: string;
    readonly lines: readonly string[];
}

export interface RemovalLedger {
    // Content before the turn's first edit of a path; undefined means it did not exist, not that it was empty.
    readonly notePrior: (path: string, content: string | undefined) => void;
    // What is gone per path, given a reader for current content; empty means nothing to ask about.
    readonly removals: (read: FileReader) => Promise<readonly PathRemoval[]>;
}

// How the caller reads a file now; undefined means the file is gone, the largest removal there is.
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
            // Everything the turn left standing, anywhere it touched; a line still present here has moved, not gone.
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
    // The turn's tree and the repo git is asked from; absent means only a self-defended removal is reported.
    readonly cwd?: string | undefined;
    readonly isolation?: IsolationPlan | undefined;
    readonly read?: FileReader | undefined;
    readonly git?: GitRunner | undefined;
    // The clock as a value, so an age boundary is a fact a test states rather than waits for.
    readonly now?: number | undefined;
}

export const readWorkspaceFile: FileReader = async (path) =>
    readFile(path, "utf8").then(
        (content) => content,
        // A file the turn deleted or moved; not an error, the answer itself.
        () => undefined,
    );

const quote = (defence: Defence): string => `- \`${defence.line}\` — ${defence.detail}`;

const nudgeText = (found: ReadonlyArray<readonly [string, readonly Defence[]]>): string => {
    const sections = found.slice(0, MAX_FILES).map(([path, defences]) => {
        const shown = defences.slice(0, MAX_LINES_PER_FILE).map(quote);
        const rest = defences.length - shown.length;
        // A cap that hides its own existence would read as the whole finding, which this check must never do.
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

// A built-in rather than a rule-table entry, since only the daemon sees both the turn's own deletions and git in one
// place. One probe budget for the whole turn, spent on the files with the most to answer for; the message says so
// rather than presenting a truncated list as the whole finding.
export const verifyRemovalsMessage = async (ledger: RemovalLedger, deps: RemovalDeps = {}): Promise<string | undefined> => {
    const read = deps.read ?? readWorkspaceFile;
    const removals = await ledger.removals(async (path) => read(inWorktree(path, deps.isolation)));
    if (removals.length === 0) {
        return undefined;
    }
    // Most defended lines first, so a tight budget goes to the sharpest question, not whichever file came first.
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
