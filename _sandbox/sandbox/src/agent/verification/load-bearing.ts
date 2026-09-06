import { defaultGit, type GitRunner } from "@intentic/scaffold";

/* WHAT THE REPOSITORY DEFENDS, asked of the lines a turn DELETED rather than of the lines it wrote.
 *
 * Every other check in this daemon reads a turn's additions. Post-edit diagnostics ask whether the file still
 * type-checks (agent-diagnostics.ts); the proof ledger asks whether anything ran after the last edit
 * (agent-verification.ts). A deletion passes both trivially, and that is the whole problem: the change that
 * takes production down two days later is a five-line simplification that type-checks perfectly, leaves the
 * suite green (nothing covered the deleted line, which is exactly why it survived), and reads in review as the
 * diff making the code nicer. A hardcoded sleep inside a retry, a duplicate-looking guard, an ordering that
 * nobody wrote down. Every gate agrees it is fine. That is what makes it worth a machine.
 *
 * MARKERS CANNOT CARRY THIS, and measuring before building is what settled the design. Across this repository
 * the imperative markers, "do not remove", "do not delete", "do not touch", occur SEVEN times in total, while
 * `deliberately` occurs 1435 times and `on purpose` 557. The code that hurts you when it goes is load-bearing
 * precisely because nobody wrote down why. So a marker is not the signal here. It is at most a reason to ask
 * git a question, and only the rare imperative form stands on its own.
 *
 * THE SIGNAL IS THE HISTORY, and one command answers all of it. `git log -S<line>` walks the commits where
 * that exact text entered or left the file, which yields three independent facts from one subprocess: how many
 * times its presence has changed (someone has tried this deletion before and it came back), what the commit
 * that introduced it was doing (a line born in a commit that says `fix:` or names an incident is a scar), and
 * how long it has stood (old code that churn has flowed around has been read and left alone many times).
 *
 * CHEAP FIRST, PROBE SECOND, the split chores already draw between chore-signals.ts and probe-runner.ts. Line
 * shape decides what is worth asking about; git is asked only about those, at most MAX_PROBES of them, and
 * concurrently because they are independent processes. A turn that deleted ordinary code spawns nothing.
 *
 * NAMED SIGNALS, NEVER A SCORE. A defence says "this exact line has entered and left this file three times,
 * most recently in 8b0e44 'fix: nightly export dies on cold replica'". A reviewer can act on that sentence and
 * argue with it. `risk: 0.73` is unreviewable, and a number invites tuning a threshold instead of reading the
 * evidence.
 *
 * WHAT IT WILL NOT DO. It never blocks an edit and never runs anything itself. It cannot see a deletion made
 * by a shell command that rewrote a file (`sed -i`), the same honest limit the proof ledger has with an
 * unrecognised command. And it never claims the deletion is wrong: only that the repository has an opinion
 * about that line which the turn has not addressed. */

// Shorter than this and a pickaxe means nothing: `});` occurs in every commit that ever touched the file, so
// the query answers "yes, this file has a history" dressed up as evidence about a line.
const MIN_LINE = 16;

// How many lines git is asked about per turn. The cap is on SUBPROCESSES, not on files: six concurrent `git
// log` walks is the ceiling this feature is allowed to cost a turn that is otherwise finished.
export const MAX_PROBES = 6;

// How far back one probe reads. The count is what classifies (once ⇒ introduced and never disturbed, more ⇒
// contested), and past a handful the extra commits only lengthen the sentence.
const HISTORY_DEPTH = 8;

// Old enough that the line has been read and left alone by everyone who has worked on the file since. Six
// months rather than a year: long enough to mean survivorship, short enough to still fire on a young codebase,
// which is where the agent is trusted most and the tribal memory is thinnest.
const SURVIVOR_DAYS = 180;

/* An instruction not to touch it, which is the one marker that defends a line on its own, with no history to
 * consult. Rare (seven occurrences repo-wide) and unambiguous when it appears: somebody stood exactly here and
 * wrote down that the next person would want to delete this. */
const IMPERATIVE = /\b(?:do not|don'?t|never)\s+(?:remove|delete|change|touch|edit|refactor|simplify|inline)\b|\bload[-\s]?bearing\b|\bleave (?:this|it) (?:alone|as[-\s]?is|here)\b/i;

/* An explanation of why the code is odd. NOT a defence, only a reason to ask git: this vocabulary is how
 * careful authors write ordinary comments, so treating it as evidence would flag half of every honest
 * refactor. It earns the line a probe and nothing more. */
const EXPLANATORY = /\b(?:deliberate(?:ly)?|intentional(?:ly)?|on purpose|workaround|hack\b|beware|careful|required (?:for|by)|needed (?:for|by)|must (?:run|come|happen|stay))\b/i;

/* Code whose purpose is invisible from its own text: a wait whose duration was found by experiment, a retry
 * around somebody else's flakiness, a suppression that hides a warning somebody decided to accept. These are
 * what a model tidying up removes first, and what the tidying breaks.
 *
 * NOTHING GENERIC BELONGS IN HERE, however defensible it sounds. `await` was in this list and had to come out:
 * it appears on most lines of an async codebase, so it turned the probe budget into a lottery over whichever
 * six lines the diff happened to start with, and spent it before the sleep three files down was ever reached.
 * The budget is the scarce thing, and a candidacy rule that matches everything is the same as none at all. */
const CONSTRUCTS =
    /\b(?:sleep|setTimeout|setInterval|nextTick|flush|debounce|throttle|delay|retry|retries|backoff|attempt|fallback|timeout|deadline|catch|rescue)\b|eslint-disable|@ts-(?:expect-error|ignore)|#\s*noqa|type:\s*ignore|nolint|#\[allow\(/i;

// A commit that was repairing something. The vocabulary is case-insensitive; a ticket reference is not, or
// `abc-1` in a filename would read as one.
const REPAIR_WORDS = /\b(?:fix(?:e[sd])?|hotfix|revert(?:s|ed)?|regress(?:ion)?|incident|outage|flaky|race|deadlock|hang|leak|patch|workaround|broke|broken)\b/i;
const TICKET_REF = /\b[A-Z][A-Z0-9]+-\d+\b/;

/* WHY A REMOVAL IS DEFENDED. Four kinds, ordered by how much they are worth: an instruction beats a history,
 * and a history that has already reversed this exact deletion beats one that merely records its birth. */
export type DefenceKind =
    // The removed text says, in words, not to remove it.
    | "declared"
    // This exact text has entered and left the file more than once. Someone has run this experiment.
    | "contested"
    // The commit that introduced it was repairing something.
    | "scar"
    // It has stood untouched for longer than SURVIVOR_DAYS.
    | "survivor";

export interface Defence {
    readonly kind: DefenceKind;
    // The removed line, trimmed, as the reviewer will look for it in the diff.
    readonly line: string;
    // The evidence, in git's own words wherever it has any. One sentence, because it is read inside a list.
    readonly detail: string;
}

interface Commit {
    readonly hash: string;
    readonly at: number;
    readonly subject: string;
}

// Field separator inside one log line: git emits it only where `%x1f` asks for it, and a commit subject may
// contain every other character there is. Spelled as an escape because a raw control byte in source is
// invisible in a diff and is the kind of thing a well-meaning editor strips.
const FIELD = "\u001f";

/* Is this line worth a subprocess? Imperative first, because those are decided without one and must never be
 * crowded out of the probe budget by a `catch` on line 12. */
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

/* The commits where this exact text entered or left the file, newest first.
 *
 * A failure here is an ANSWER, not an error: an untracked file, a path outside any repository, a shallow clone
 * with no history to walk. All of them mean the same thing for this question, the repository defends nothing
 * about this line, and a turn must not be sent back to work because git was unavailable. */
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

/* What one line's history says, or nothing. At most one defence per line: a line that is contested AND a scar
 * AND old is one thing to look at, and the strongest reading is the one worth the reviewer's attention. */
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

/* EVERY DEFENCE THE HISTORY OFFERS for one file's removed lines, within the probe budget the caller still has.
 *
 * `dir` is the repository the turn worked in and `path` is named the way git will resolve it from there. `now`
 * is a parameter rather than a `Date.now()` call so the age boundary is a fact a test states rather than one it
 * waits for. */
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
    /* The budget gates PROBES and nothing else. A spent budget, and the no-repository turn that starts with
     * none, must still get the marker half: it costs nothing, it is the half that is never wrong, and a check
     * that went silent wherever git was unavailable would be silent in the ACP and translator turns that have
     * no worktree to ask about. */
    const probes = unique.filter((entry) => entry.rank > 0).slice(0, Math.max(0, budget));
    const probed = await Promise.all(probes.map(async ({ line }) => defenceOf(line, await historyOf(git, dir, path, line), now)));
    return [...declared, ...probed.filter((defence): defence is Defence => defence !== undefined)];
};

// How many subprocesses `defencesOf` would spend on this file, so a caller splitting one budget across several
// files can ask before it commits to any of them.
export const probeCost = (removed: readonly string[]): number =>
    new Set(removed.filter((line) => (probeRank(line) ?? 0) > 0).map((line) => line.trim())).size;
