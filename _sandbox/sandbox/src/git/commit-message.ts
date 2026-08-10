import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { readWorkspaceFile, statWorkspaceFileSize } from "../workspace/workspace-files.js";

/* THE MATERIAL A COMMIT MESSAGE IS DRAFTED FROM, and the one rule that matters here: it describes what the
 * Commit button is ABOUT TO RECORD, not what the repo happens to contain. Those differ constantly — a partially
 * staged file, an unstaged edit the user is not ready to commit — and describing the wrong one produces a
 * message that is confidently about changes the commit will not contain. So the three shapes mirror the panel's
 * own target exactly, one per shape of CommitSchema:
 *
 *   staged (default)  → the INDEX vs HEAD; what a bare `git commit` records
 *   all               → the WORKTREE, untracked files included; what "Commit all" sweeps, since gitCommitAll
 *                       runs `git add -A` first and `git diff HEAD` alone would miss every new file
 *   paths             → the same WORKTREE reading, narrowed by pathspec: a commit that stages a subset first
 *                       (the Changes panel's origin filter) records exactly those paths and nothing else
 *
 * The house style is INFERRED, never prescribed. The last handful of subjects go in the prompt and the model is
 * told to match them, which on a Conventional Commits repo reproduces `feat:` / `fix:` without this file
 * knowing what Conventional Commits is — and keeps working on a repo that writes subjects some other way. A
 * hard-coded convention would be wrong for every user whose repo disagrees with it, and this daemon runs on
 * their repos, not on ours.
 *
 * THE ONE THING THAT CANNOT BE INFERRED is the release note (`Release-Note:` below), which is why it is the
 * only part of this prompt anybody has to ask for. A repo that has never written one gives the model nothing to
 * copy from, so it is gated on the owner naming that repo in settings (SandboxSettings.changelogRepos) and is
 * absent everywhere else. What it asks for is not a second description of the diff: it is the sentence someone
 * USING the software would recognise, and the model is told to leave it out entirely when the change is one
 * nobody outside the project would ever notice — which is most of them. */

// The whole prompt's patch budget, split across the repos a commit spans. Generous enough that an ordinary
// change arrives whole, small enough to stay cheap on the rung this runs on — and the stat + file list above it
// survive truncation, so even a clipped patch leaves the model knowing every path that moved.
const MAX_PATCH_BYTES = 48_000;
// How many subjects establish the house style. Enough to show a convention, few enough that one odd commit
// doesn't become the pattern.
const RECENT_SUBJECTS = 15;
// Untracked files are read from disk (they have no blob to diff against). Bounded on both axes: a `git add -A`
// can sweep a whole build output, and neither the model nor the user is served by a megabyte of it.
const MAX_UNTRACKED_FILES = 10;
const MAX_UNTRACKED_BYTES = 4_000;

export interface RepoDiff {
    readonly repo: string;
    // Recent commit subjects, newest first — the house style, empty on an unborn repo.
    readonly subjects: readonly string[];
    // `--stat` plus the name-status list: every path that moves, whatever the patch below has room for.
    readonly summary: string;
    readonly patch: string;
}

// git exits non-zero for the ordinary states this runs into (an unborn HEAD has no log and nothing to diff), and
// those are not failures of the draft — the other repos still describe themselves.
const tryGit = async (dir: string, args: readonly string[], git: GitRunner): Promise<string> =>
    git(dir, [...args])
        .then((result) => result.stdout)
        .catch(() => ``);

// The diff base for each commit shape, in one place so the stat, the file list and the patch can never disagree
// about which one they are describing. The pathspec is a SEPARATE tail because `--` ends the option list: every
// flag (`--stat`, `--name-status`) has to be spelled before it or git reads it as a filename.
const diffBase = (worktree: boolean): readonly string[] => (worktree ? [`diff`, `HEAD`] : [`diff`, `--cached`]);
const pathspec = (paths: readonly string[] | undefined): readonly string[] => (paths === undefined ? [] : [`--`, ...paths]);

// Untracked files, as the synthetic "new file" blocks git cannot produce for them. `--exclude-standard` honours
// .gitignore, so this sees exactly what `git add -A` would stage.
//
// Names and contents are bounded SEPARATELY, and that split is the point: every new path joins the file list
// (in `git diff --name-status`'s own `A<TAB>path` spelling, so it reads as one list with the tracked changes),
// while only the first few are read from disk. A `git add -A` can sweep a whole build output — the model does
// not need to read all of it, but a commit whose message omits half its new files is simply wrong.
const untrackedFiles = async (dir: string, paths: readonly string[] | undefined, git: GitRunner): Promise<{ names: string; patch: string }> => {
    const listed = (await tryGit(dir, [`ls-files`, `--others`, `--exclude-standard`, ...pathspec(paths)], git))
        .split(`\n`)
        .filter((path) => path !== ``);
    const blocks: string[] = [];
    for (const path of listed.slice(0, MAX_UNTRACKED_FILES)) {
        const size = await statWorkspaceFileSize(join(dir, path));
        if (size === undefined) {
            continue;
        }
        const content = size > MAX_UNTRACKED_BYTES ? undefined : await readWorkspaceFile(join(dir, path));
        // A file too large, unreadable, or binary still earns its line — the path is the part the subject needs.
        blocks.push(
            content === undefined || content.includes(`\0`) ? `new file: ${path} (${size} bytes, not shown)` : `new file: ${path}\n${content}`,
        );
    }
    return { names: listed.map((path) => `A\t${path}`).join(`\n`), patch: blocks.join(`\n\n`) };
};

// Everything one repo contributes to the draft. The scope is the commit's own — see the header: a commit that
// stages before it records (`all`, or an explicit `paths` subset) is described from the WORKTREE, and one that
// records what is already staged is described from the index.
export interface CommitScope {
    // `commit -a` — the whole worktree, untracked files included.
    readonly all?: boolean;
    // The repo-relative paths the commit will stage first, when it stages only a subset.
    readonly paths?: readonly string[];
}

export const collectRepoDiff = async (repo: string, dir: string, scope: CommitScope, git: GitRunner = defaultGit): Promise<RepoDiff> => {
    const worktree = scope.all === true || scope.paths !== undefined;
    const spec = pathspec(scope.paths);
    const [subjects, stat, names, patch, untracked] = await Promise.all([
        tryGit(dir, [`log`, `-n`, String(RECENT_SUBJECTS), `--format=%s`], git),
        tryGit(dir, [...diffBase(worktree), `--stat`, ...spec], git),
        tryGit(dir, [...diffBase(worktree), `--name-status`, ...spec], git),
        tryGit(dir, [...diffBase(worktree), ...spec], git),
        // Only a commit that stages first sweeps untracked files; a staged commit records the index, which by
        // definition holds none of them.
        worktree ? untrackedFiles(dir, scope.paths, git) : Promise.resolve({ names: ``, patch: `` }),
    ]);
    return {
        repo,
        subjects: subjects.split(`\n`).filter((subject: string) => subject !== ``),
        summary: [stat.trim(), names.trim(), untracked.names.trim()].filter((part) => part !== ``).join(`\n`),
        patch: [patch.trim(), untracked.patch.trim()].filter((part) => part !== ``).join(`\n\n`),
    };
};

// Clip to a byte budget on a line boundary, and SAY that it was clipped — a patch that stops mid-hunk with no
// marker reads to the model as a complete change that simply ends there.
const clip = (patch: string, budget: number): string => {
    if (patch.length <= budget) {
        return patch;
    }
    const cut = patch.slice(0, budget);
    return `${cut.slice(0, cut.lastIndexOf(`\n`) + 1)}… (diff truncated — the file list above is complete)`;
};

// The prompt. Written flat rather than as a system/user pair because the one-shot sends no system prompt at all
// (see one-shot.ts): the instruction, the style examples and the material are one message, in the order the
// model should weigh them.
export const commitMessagePrompt = (diffs: readonly RepoDiff[], intent?: string, wantsNote = false): string => {
    const budget = Math.floor(MAX_PATCH_BYTES / Math.max(1, diffs.length));
    const repos = diffs.map((diff) =>
        [
            `## Repository: ${diff.repo}`,
            diff.subjects.length > 0 ? `Recent commit subjects in this repository (match their style):\n${diff.subjects.join(`\n`)}` : undefined,
            diff.summary === `` ? undefined : `Files this commit will record:\n${diff.summary}`,
            diff.patch === `` ? `(no textual diff — see the file list above)` : `Diff:\n${clip(diff.patch, budget)}`,
        ]
            .filter((section) => section !== undefined)
            .join(`\n\n`),
    );
    return [
        wantsNote
            ? `Write the subject line for the git commit described below, and — only if this change is one a user would notice — a release note under it.`
            : `Write the subject line for the git commit described below.`,
        // The output contract is stated first and last: this model is the cheap rung, and a preamble ("Sure!
        // Here's a commit message:") pasted into the input is the failure this helper is most likely to have.
        `Rules:`,
        wantsNote
            ? `- Reply with the subject line, and nothing else except the note described below. No preamble, no explanation, no quotes, no code fences.`
            : `- Reply with the subject line ONLY. No preamble, no explanation, no quotes, no code fences.`,
        `- One line. Match the style, prefix convention and capitalisation of the recent subjects shown below.`,
        `- Describe WHAT the change accomplishes, not which files moved.`,
        /* THE RELEASE NOTE, asked for in the terms it will be READ in — by someone deciding whether to take an
         * update, not by someone reviewing the diff. Two instructions carry that, and the second is the one that
         * matters: most commits earn no note at all. A model asked for a note on every commit will write one for
         * every commit, and a changelog that lists "audit rail icons" beside a real feature is the noise this
         * whole mechanism exists to remove. Omission is stated as the expected outcome rather than an escape
         * hatch, because the cheap rung does what it is told is normal. */
        wantsNote
            ? `- If (and only if) someone USING this software would notice this change, add a second line spelled exactly: Release-Note: <one plain sentence>.`
            : undefined,
        wantsNote
            ? `- That sentence is for users, not developers: say what they can now do or what no longer goes wrong, in their words, with no file, symbol or internal name in it.`
            : undefined,
        wantsNote
            ? `- OMIT the Release-Note line entirely for anything a user would never see — refactors, tests, build and CI work, dependency bumps, internal cleanup. Most commits get no note, and that is the expected answer.`
            : undefined,
        // A commit spanning repos gets one message, so it has to describe the change rather than any one repo.
        diffs.length > 1 ? `- This commit spans ${diffs.length} repositories and shares one message. Describe the change as a whole.` : undefined,
        /* WHAT THE WORK WAS FOR, when the caller knows — the session's own name for the job it was given.
         *
         * Context, never the answer, and the wording says so twice over. A diff shows what moved and leaves the
         * model to infer the point of it, which on a mechanical rung produces a subject that restates the file
         * list ("update review panel and commit message composables"); knowing the job turns the same diff into
         * a sentence about the reason. But the ask is exactly what goes stale — it is the drift this whole
         * feature exists to correct — so it is offered as a hint to be OVERRULED by the code rather than as a
         * line to reproduce. A model told "here is the title, here is the diff" writes the title back. */
        intent === undefined ? undefined : `- Context: this work came from a session tasked with "${intent}".`,
        intent === undefined ? undefined : `  Use it only to understand the intent; if the diff shows something else, describe the diff.`,
        ``,
        ...repos,
        ``,
        wantsNote
            ? `Reply with the subject line, plus a Release-Note line only if a user would notice this change.`
            : `Reply with the subject line only.`,
    ]
        .filter((line) => line !== undefined)
        .join(`\n`);
};

// Wrappers a model reaches for even when told not to. Stripped rather than rejected: the message is right and
// only its packaging is wrong, and a helper that refuses a good answer over a pair of backticks is worse than
// one that unwraps it.
const FENCE = /^```[\w-]*\n?|\n?```$/g;
const LABEL = /^(?:subject|commit message|message)\s*:\s*/i;
const BULLET = /^[-*]\s+/;

/* WHAT A NOTE IS CARRIED ON: git's own trailer convention, rather than a shape invented here. `git log
 * --format=%(trailers:key=Release-Note,valueonly)` reads it back at release time, `git interpret-trailers`
 * understands it, and anyone who opens the commit sees a labelled line instead of a stray sentence. The
 * harvest and the writer therefore share ONE spelling, which is this constant. */
export const RELEASE_NOTE_TRAILER = `Release-Note:`;

const isNoteLine = (line: string): boolean => line.toLowerCase().startsWith(RELEASE_NOTE_TRAILER.toLowerCase());

// The wrappers a model reaches for around any one line, off.
const unwrap = (line: string): string => {
    const bare = line.replace(BULLET, ``).replace(LABEL, ``).trim();
    // Symmetric surrounding quotes only: an apostrophe or a quoted term inside the subject is part of it.
    const unquoted = /^(["'`])(.*)\1$/.exec(bare);
    return (unquoted?.[2] ?? bare).trim();
};

const replyLines = (reply: string): string[] =>
    reply
        .trim()
        .replace(FENCE, ``)
        .split(`\n`)
        .map((line) => line.trim())
        .filter((line) => line !== ``);

// The subject: the first line that is not the note. Skipping the trailer rather than taking line one outright is
// what keeps a model that leads with its note from putting the note in the subject — the answer is still right,
// it simply arrived in the other order, and rejecting it over that would waste a good draft.
export const cleanCommitSubject = (reply: string): string => {
    const first = replyLines(reply).find((line) => !isNoteLine(line));
    return first === undefined ? `` : unwrap(first);
};

// The note, if the model wrote one — empty when it judged the change invisible to users, which is the common
// case and not a failure. Only the FIRST is taken: a model that writes three has misunderstood the ask, and
// three notes about one commit would reach the changelog as three entries.
export const cleanReleaseNote = (reply: string): string => {
    const line = replyLines(reply).find(isNoteLine);
    return line === undefined ? `` : unwrap(line.slice(RELEASE_NOTE_TRAILER.length));
};

/* The whole message the commit box receives: the subject, and beneath it the note as a trailer. The blank line
 * between them is load-bearing — it is what makes the note a git trailer rather than the second line of the
 * subject's own paragraph, and without it `git log` reads the pair as one run-on subject.
 *
 * With no note this returns the subject alone, byte for byte what the box got before any of this existed, which
 * is what keeps every repo that never asked for notes exactly where it was. */
export const cleanCommitMessage = (reply: string): string => {
    const subject = cleanCommitSubject(reply);
    const note = cleanReleaseNote(reply);
    if (subject === `` || note === ``) {
        return subject;
    }
    return `${subject}\n\n${RELEASE_NOTE_TRAILER} ${note}`;
};
