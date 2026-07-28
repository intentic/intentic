import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { readWorkspaceFile, statWorkspaceFileSize } from "../workspace/workspace-files.js";

/* THE MATERIAL A COMMIT MESSAGE IS DRAFTED FROM, and the one rule that matters here: it describes what the
 * Commit button is ABOUT TO RECORD, not what the repo happens to contain. Those differ constantly — a partially
 * staged file, an unstaged edit the user is not ready to commit — and describing the wrong one produces a
 * message that is confidently about changes the commit will not contain. So the two shapes mirror the panel's
 * own target exactly:
 *
 *   staged (default)  → the INDEX vs HEAD; what a bare `git commit` records
 *   all               → the WORKTREE, untracked files included; what "Commit all" sweeps, since gitCommitAll
 *                       runs `git add -A` first and `git diff HEAD` alone would miss every new file
 *
 * The house style is INFERRED, never prescribed. The last handful of subjects go in the prompt and the model is
 * told to match them, which on a Conventional Commits repo reproduces `feat:` / `fix:` without this file
 * knowing what Conventional Commits is — and keeps working on a repo that writes subjects some other way. A
 * hard-coded convention would be wrong for every user whose repo disagrees with it, and this daemon runs on
 * their repos, not on ours. */

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

// The diff selectors for each of the two commit shapes, in one place so the stat, the file list and the patch
// can never disagree about which one they are describing.
const diffArgs = (all: boolean): readonly string[] => (all ? [`diff`, `HEAD`] : [`diff`, `--cached`]);

// Untracked files, as the synthetic "new file" blocks git cannot produce for them. `--exclude-standard` honours
// .gitignore, so this sees exactly what `git add -A` would stage.
//
// Names and contents are bounded SEPARATELY, and that split is the point: every new path joins the file list
// (in `git diff --name-status`'s own `A<TAB>path` spelling, so it reads as one list with the tracked changes),
// while only the first few are read from disk. A `git add -A` can sweep a whole build output — the model does
// not need to read all of it, but a commit whose message omits half its new files is simply wrong.
const untrackedFiles = async (dir: string, git: GitRunner): Promise<{ names: string; patch: string }> => {
    const listed = (await tryGit(dir, [`ls-files`, `--others`, `--exclude-standard`], git)).split(`\n`).filter((path) => path !== ``);
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

// Everything one repo contributes to the draft. `all` picks the worktree over the index — see the header.
export const collectRepoDiff = async (repo: string, dir: string, all: boolean, git: GitRunner = defaultGit): Promise<RepoDiff> => {
    const [subjects, stat, names, patch, untracked] = await Promise.all([
        tryGit(dir, [`log`, `-n`, String(RECENT_SUBJECTS), `--format=%s`], git),
        tryGit(dir, [...diffArgs(all), `--stat`], git),
        tryGit(dir, [...diffArgs(all), `--name-status`], git),
        tryGit(dir, [...diffArgs(all)], git),
        // Only "Commit all" sweeps untracked files; a staged commit records the index, which by definition
        // holds none of them.
        all ? untrackedFiles(dir, git) : Promise.resolve({ names: ``, patch: `` }),
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
export const commitMessagePrompt = (diffs: readonly RepoDiff[]): string => {
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
        `Write the subject line for the git commit described below.`,
        // The output contract is stated first and last: this model is the cheap rung, and a preamble ("Sure!
        // Here's a commit message:") pasted into the input is the failure this helper is most likely to have.
        `Rules:`,
        `- Reply with the subject line ONLY. No preamble, no explanation, no quotes, no code fences.`,
        `- One line. Match the style, prefix convention and capitalisation of the recent subjects shown below.`,
        `- Describe WHAT the change accomplishes, not which files moved.`,
        // A commit spanning repos gets one message, so it has to describe the change rather than any one repo.
        diffs.length > 1 ? `- This commit spans ${diffs.length} repositories and shares one message. Describe the change as a whole.` : undefined,
        ``,
        ...repos,
        ``,
        `Reply with the subject line only.`,
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

// The one line that goes in the input. Everything else the model may have said is dropped — the commit box is
// single-line, so a body has nowhere to go and pasting it in would produce a subject with a paragraph glued to it.
export const cleanCommitSubject = (reply: string): string => {
    const unfenced = reply.trim().replace(FENCE, ``);
    const first = unfenced
        .split(`\n`)
        .map((line) => line.trim())
        .find((line) => line !== ``);
    if (first === undefined) {
        return ``;
    }
    const bare = first.replace(BULLET, ``).replace(LABEL, ``).trim();
    // Symmetric surrounding quotes only: an apostrophe or a quoted term inside the subject is part of it.
    const unquoted = /^(["'`])(.*)\1$/.exec(bare);
    return (unquoted?.[2] ?? bare).trim();
};
