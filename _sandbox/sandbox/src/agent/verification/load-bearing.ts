import { defaultGit, type GitRunner } from "@intentic/scaffold";

// Asks what the repository defends about deleted lines, since every other check here reads only what a turn added. The
// signal is `git log -S<line>`'s history: how often a line has come and gone, whether it was born fixing an incident,
// how long it stood untouched. Named as a sentence a reviewer can argue with, never a score; never blocks, and misses a
// shell-command deletion.

// Shorter than this and a pickaxe means nothing: `});` occurs in every commit that ever touched the file.
const MIN_LINE = 16;

// How many lines git is asked about per turn; the cap is on subprocesses, not files.
export const MAX_PROBES = 6;

// How far back one probe reads; the count classifies (once = never disturbed, more = contested).
const HISTORY_DEPTH = 8;

// Old enough to mean survivorship; six months, not a year, so it still fires on a young codebase.
const SURVIVOR_DAYS = 180;

// An instruction not to touch it, rare and unambiguous, the one marker that defends a line on its own.
const IMPERATIVE = /\b(?:do not|don'?t|never)\s+(?:remove|delete|change|touch|edit|refactor|simplify|inline)\b|\bload[-\s]?bearing\b|\bleave (?:this|it) (?:alone|as[-\s]?is|here)\b/i;

// Explains why code is odd, not a defence: this vocabulary appears in ordinary comments, earning only a probe.
const EXPLANATORY = /\b(?:deliberate(?:ly)?|intentional(?:ly)?|on purpose|workaround|hack\b|beware|careful|required (?:for|by)|needed (?:for|by)|must (?:run|come|happen|stay))\b/i;

// Code whose purpose is invisible from its own text; nothing generic belongs here, or the budget is a lottery.
const CONSTRUCTS =
    /\b(?:sleep|setTimeout|setInterval|nextTick|flush|debounce|throttle|delay|retry|retries|backoff|attempt|fallback|timeout|deadline|catch|rescue)\b|eslint-disable|@ts-(?:expect-error|ignore)|#\s*noqa|type:\s*ignore|nolint|#\[allow\(/i;

// A commit repairing something; case-insensitive, unlike the ticket reference, or a filename could count.
const REPAIR_WORDS = /\b(?:fix(?:e[sd])?|hotfix|revert(?:s|ed)?|regress(?:ion)?|incident|outage|flaky|race|deadlock|hang|leak|patch|workaround|broke|broken)\b/i;
const TICKET_REF = /\b[A-Z][A-Z0-9]+-\d+\b/;

// Why a removal is defended, four kinds ordered by strength: an instruction beats a history, and a reversed deletion
// beats one that only recorded its birth.
export type DefenceKind =
    // The removed text says, in words, not to remove it.
    | "declared"
    // This exact text has entered and left the file more than once.
    | "contested"
    // The commit that introduced it was repairing something.
    | "scar"
    // It has stood untouched for longer than SURVIVOR_DAYS.
    | "survivor";

export interface Defence {
    readonly kind: DefenceKind;
    // The removed line, trimmed, as the reviewer will look for it in the diff.
    readonly line: string;
    // The evidence in git's own words where possible; one sentence, read inside a list.
    readonly detail: string;
}

interface Commit {
    readonly hash: string;
    readonly at: number;
    readonly subject: string;
}

// Field separator inside one log line, an escape since a raw control byte is invisible in a diff.
const FIELD = "\u001f";

// Whether a line is worth a subprocess: imperative first, since those are decided without one and must not be crowded
// out by an ordinary `catch`.
export const probeRank = (line: string): number | undefined => {
    const text = line.trim();
    if (text.length < MIN_LINE) {
        return undefined;
    }
    if (IMPERATIVE.test(text)) {
        return 0;
    }
    if (EXPLANATORY.test(text)) {
        return 1;
    }
    return CONSTRUCTS.test(text) ? 2 : undefined;
};

// Commits where this exact text entered or left the file, newest first. A failure here (untracked file, no repo,
// shallow clone) is an answer, not an error: the repository defends nothing about this line.
const historyOf = async (git: GitRunner, dir: string, path: string, line: string): Promise<readonly Commit[]> => {
    const args = ["log", `--format=%h${FIELD}%at${FIELD}%s`, "-n", String(HISTORY_DEPTH), `-S${line}`, "--", path];
    const stdout = await git(dir, args).then(
        (result) => result.stdout,
        () => "",
    );
    return stdout
        .split("\n")
        .filter((row) => row !== "")
        .flatMap((row) => {
            const [hash, at, ...rest] = row.split(FIELD);
            const seconds = Number(at);
            return hash === undefined || !Number.isFinite(seconds) ? [] : [{ hash, at: seconds, subject: rest.join(FIELD) }];
        });
};

const named = (commit: Commit): string => (commit.subject === "" ? commit.hash : `${commit.hash} "${commit.subject}"`);

const daysSince = (seconds: number, now: number): number => Math.floor((now - seconds * 1000) / 86_400_000);

// What one line's history says, or nothing; at most one defence per line, the strongest reading.
const defenceOf = (line: string, commits: readonly Commit[], now: number): Defence | undefined => {
    const introduced = commits.at(-1);
    if (introduced === undefined) {
        return undefined;
    }
    if (commits.length > 1) {
        const last = commits[0];
        return {
            kind: "contested",
            line,
            detail: `this exact line has entered and left this file ${commits.length} times, most recently in ${named(last ?? introduced)}`,
        };
    }
    if (REPAIR_WORDS.test(introduced.subject) || TICKET_REF.test(introduced.subject)) {
        return { kind: "scar", line, detail: `introduced while repairing something: ${named(introduced)}` };
    }
    const age = daysSince(introduced.at, now);
    return age >= SURVIVOR_DAYS ? { kind: "survivor", line, detail: `untouched for ${age} days, since ${named(introduced)}` } : undefined;
};

// Every defence the history offers for one file's removed lines, within the caller's remaining probe budget. `now` is a
// parameter, not `Date.now()`, so the age boundary is a fact a test states rather than waits for.
export const defencesOf = async (
    dir: string,
    path: string,
    removed: readonly string[],
    budget: number,
    now: number,
    git: GitRunner = defaultGit,
): Promise<readonly Defence[]> => {
    const ranked = removed
        .map((line) => ({ line: line.trim(), rank: probeRank(line) }))
        .filter((entry): entry is { line: string; rank: number } => entry.rank !== undefined)
        .sort((a, b) => a.rank - b.rank);
    // The same line deleted from two places is one question to ask git.
    const unique = [...new Map(ranked.map((entry) => [entry.line, entry])).values()];
    const declared = unique
        .filter((entry) => entry.rank === 0)
        .map(({ line }): Defence => ({ kind: "declared", line, detail: `the code says so itself` }));
    // Budget gates probes only: the marker half costs nothing and must answer even with no repository to ask.
    const probes = unique.filter((entry) => entry.rank > 0).slice(0, Math.max(0, budget));
    const probed = await Promise.all(probes.map(async ({ line }) => defenceOf(line, await historyOf(git, dir, path, line), now)));
    return [...declared, ...probed.filter((defence): defence is Defence => defence !== undefined)];
};

// How many subprocesses defencesOf would spend on this file, so a shared budget can be split beforehand.
export const probeCost = (removed: readonly string[]): number =>
    new Set(removed.filter((line) => (probeRank(line) ?? 0) > 0).map((line) => line.trim())).size;
