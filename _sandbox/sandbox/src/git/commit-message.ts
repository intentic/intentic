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
 * THE CODE IS THE ONLY WITNESS. This prompt used to also carry the session's title as an `intent` hint — what
 * the conversation was ASKED to do — on the theory that a diff shows what moved and leaves the reason to be
 * inferred. In practice the cheap rung this runs on treated the hint as the answer: told "here is the title,
 * here is the diff, write one line", it wrote the title back, so a commit that fixed three things went in
 * wearing the question that started the session. Worse, a title is itself model-written, so a naming pass that
 * failed put its failure into the commit message. The hint is gone. What the change was for is legible in what
 * it did, and that is the only source here that cannot be stale.
 *
 * CONVENTIONAL COMMITS ARE PRESCRIBED, and this is the one place a convention is imposed rather than inferred.
 * The recent subjects still go in — they carry the repo's vocabulary, its scope names and its register, which
 * no rule can supply — but the TYPE is dictated from the list below. Inferring it worked only on a repo that
 * already had the habit, and on every other one it faithfully reproduced whatever mess was in the log.
 *
 * WRITTEN TO BE READ BACK BY A MACHINE. The audience for this history is now as often an agent searching it as
 * a human skimming it, and the two want the same thing for different reasons: real identifiers, stated
 * behaviour change, and no filler. So the body is a short block of dense factual lines that NAME things — the
 * functions, routes, settings and components the change is about — because those are the tokens a later search
 * matches on. Everything that a reader could get from `git show --stat` for free is banned from it: a message
 * that lists its own files spends the reader's context on what git already stored.
 *
 * THE RELEASE NOTE (`Release-Note:` below) is the one part anybody has to ask for. It is gated on the owner
 * naming that repo in settings (SandboxSettings.changelogRepos) and absent everywhere else. What it asks for is
 * not a third description of the diff: it is the sentence someone USING the software would recognise, and the
 * model is told to leave it out entirely when the change is one nobody outside the project would ever notice —
 * which is most of them. */

// The whole prompt's patch budget, split across the repos a commit spans. Generous enough that an ordinary
// change arrives whole, small enough to stay cheap on the rung this runs on — and the stat + file list above it
// survive truncation, so even a clipped patch leaves the model knowing every path that moved.
const MAX_PATCH_BYTES = 48_000;
// How many subjects establish the house style. Enough to show a repo's vocabulary and scope names, few enough
// that one odd commit doesn't become the pattern.
const RECENT_SUBJECTS = 15;
// Untracked files are read from disk (they have no blob to diff against). Bounded on both axes: a `git add -A`
// can sweep a whole build output, and neither the model nor the user is served by a megabyte of it.
const MAX_UNTRACKED_FILES = 10;
const MAX_UNTRACKED_BYTES = 4_000;

/* ONE FILE'S CHANGE, KEPT SEPARATE FROM ITS NEIGHBOURS — and the reason this is a list rather than the single
 * string it used to be.
 *
 * `git diff` emits one blob in path order, and the old budget clipped that blob at N bytes. Path order is
 * alphabetical and says nothing about what matters, so a lockfile or a snapshot landing early in the alphabet
 * ate the entire allowance and every meaningful file after it was cut — the model then wrote a confident
 * message about a dependency bump that was the least interesting thing in the commit. Splitting per file is
 * what lets the budget be spent on the files that carry the change. */
export interface PatchBlock {
    readonly path: string;
    readonly text: string;
}

export interface RepoDiff {
    readonly repo: string;
    // Recent commit subjects, newest first — the repo's own vocabulary, empty on an unborn repo.
    readonly subjects: readonly string[];
    // `--stat` plus the name-status list: every path that moves, whatever the blocks below have room for.
    readonly summary: string;
    readonly blocks: readonly PatchBlock[];
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

/* One `git diff` blob cut back into the files it describes. Split on git's own `diff --git` header rather than
 * by running a diff per path: the format is stable, and N extra git invocations on a wide changeset would cost
 * more than the whole draft.
 *
 * The `b/` side names the block, because that is where the file ENDED — a rename's new name is the one the
 * message should say and the one a later search will look for. A header this cannot parse (a path quoted for
 * having spaces or control characters in it) keeps the raw header as its label; that only affects ordering and
 * the noise check below, never whether the hunk reaches the model. */
const DIFF_HEADER = /^diff --git a\/(.*) b\/(.*)$/;

const splitPatch = (patch: string): PatchBlock[] => {
    const blocks: PatchBlock[] = [];
    let path: string | undefined;
    let lines: string[] = [];
    const flush = (): void => {
        if (path !== undefined) {
            blocks.push({ path, text: lines.join(`\n`) });
        }
    };
    for (const line of patch.split(`\n`)) {
        const header = DIFF_HEADER.exec(line);
        if (header === null) {
            lines.push(line);
            continue;
        }
        flush();
        path = header[2] ?? header[1] ?? line;
        lines = [line];
    }
    flush();
    return blocks;
};

/* FILES A HUMAN DIDN'T WRITE, and which therefore say nothing about what the change means. A lockfile records
 * that dependencies moved — the `package.json` beside it records WHY, in four lines — and a snapshot file
 * restates output that some other file decided. They are not dropped (a commit that only bumps a lockfile still
 * has to be describable), just sorted to the back and shown as a one-line stub, so the budget reaches the code
 * first and the model still knows they moved. */
const GENERATED = [
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/,
    /(^|\/)(dist|build|out|vendor|node_modules|__snapshots__|__generated__)\//,
    /\.(min\.js|min\.css|map|snap|lock)$/,
];

const isGenerated = (path: string): boolean => GENERATED.some((pattern) => pattern.test(path));

// Untracked files, as the synthetic "new file" blocks git cannot produce for them. `--exclude-standard` honours
// .gitignore, so this sees exactly what `git add -A` would stage.
//
// Names and contents are bounded SEPARATELY, and that split is the point: every new path joins the file list
// (in `git diff --name-status`'s own `A<TAB>path` spelling, so it reads as one list with the tracked changes),
// while only the first few are read from disk. A `git add -A` can sweep a whole build output — the model does
// not need to read all of it, but a commit whose message omits half its new files is simply wrong.
const untrackedFiles = async (
    dir: string,
    paths: readonly string[] | undefined,
    git: GitRunner,
): Promise<{ names: string; blocks: PatchBlock[] }> => {
    const listed = (await tryGit(dir, [`ls-files`, `--others`, `--exclude-standard`, ...pathspec(paths)], git))
        .split(`\n`)
        .filter((path) => path !== ``);
    const blocks: PatchBlock[] = [];
    for (const path of listed.slice(0, MAX_UNTRACKED_FILES)) {
        const size = await statWorkspaceFileSize(join(dir, path));
        if (size === undefined) {
            continue;
        }
        const content = size > MAX_UNTRACKED_BYTES ? undefined : await readWorkspaceFile(join(dir, path));
        // A file too large, unreadable, or binary still earns its line — the path is the part the subject needs.
        blocks.push({
            path,
            text: content === undefined || content.includes(`\0`) ? `new file: ${path} (${size} bytes, not shown)` : `new file: ${path}\n${content}`,
        });
    }
    return { names: listed.map((path) => `A\t${path}`).join(`\n`), blocks };
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
        worktree ? untrackedFiles(dir, scope.paths, git) : Promise.resolve({ names: ``, blocks: [] as PatchBlock[] }),
    ]);
    return {
        repo,
        subjects: subjects.split(`\n`).filter((subject: string) => subject !== ``),
        summary: [stat.trim(), names.trim(), untracked.names.trim()].filter((part) => part !== ``).join(`\n`),
        blocks: [...splitPatch(patch.trim()), ...untracked.blocks],
    };
};

// Clip to a byte budget on a line boundary, and SAY that it was clipped — a hunk that stops mid-change with no
// marker reads to the model as a complete edit that simply ends there.
const clip = (text: string, budget: number): string => {
    if (text.length <= budget) {
        return text;
    }
    const cut = text.slice(0, budget);
    return `${cut.slice(0, cut.lastIndexOf(`\n`) + 1)}… (rest of this file's diff truncated)`;
};

/* HOW THE BUDGET IS SHARED OUT, and why it is not simply divided by the number of files.
 *
 * An equal split starves the common case: nine files with a twenty-line change each, beside one with a
 * thousand, and every one of the nine is the reason for the commit. So the allowance is filled level by level —
 * every file that wants less than an equal share takes what it needs and leaves, and whatever it did not use is
 * shared out again among the files still asking. Small and medium files therefore arrive WHOLE, and only the
 * genuinely huge ones get clipped, which is the one place truncation costs nothing: the first hunks of a
 * thousand-line change already say what it is. */
const allocate = (sizes: readonly number[], budget: number): number[] => {
    const shares = sizes.map(() => 0);
    let open = sizes.map((_, index) => index);
    let remaining = budget;
    while (open.length > 0 && remaining > 0) {
        const share = Math.floor(remaining / open.length);
        if (share === 0) {
            break;
        }
        const next: number[] = [];
        for (const index of open) {
            const take = Math.min(sizes[index]! - shares[index]!, share);
            shares[index]! += take;
            remaining -= take;
            if (shares[index]! < sizes[index]!) {
                next.push(index);
            }
        }
        open = next;
    }
    return shares;
};

/* The patch as the model sees it: the files that carry the change first and whole, the generated ones last and
 * named but not shown. Ordering is by SIGNAL, not by path — see PatchBlock — and the generated stub is what
 * keeps a lockfile honest without letting it spend the allowance. */
const renderBlocks = (blocks: readonly PatchBlock[], budget: number): string => {
    const signal = blocks.filter((block) => !isGenerated(block.path));
    const generated = blocks.filter((block) => isGenerated(block.path));
    const shares = allocate(
        signal.map((block) => block.text.length),
        budget,
    );
    return [
        ...signal.map((block, index) => clip(block.text, shares[index]!)),
        ...generated.map((block) => `${block.path}: generated file, ${block.text.split(`\n`).length} lines changed (content not shown)`),
    ].join(`\n`);
};

// The Conventional Commits type set, spelled here because it is PRESCRIBED rather than inferred — see the
// header. Shared with the reply reader below, so the prompt and the parser can never disagree about what
// counts as a type.
const TYPES = [`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`] as const;

// The prompt. Written flat rather than as a system/user pair because the one-shot sends no system prompt at all
// (see one-shot.ts): the instruction, the style examples and the material are one message, in the order the
// model should weigh them.
export const commitMessagePrompt = (diffs: readonly RepoDiff[], wantsNote = false): string => {
    const budget = Math.floor(MAX_PATCH_BYTES / Math.max(1, diffs.length));
    const repos = diffs.map((diff) =>
        [
            `## Repository: ${diff.repo}`,
            diff.subjects.length > 0
                ? `Recent commit subjects here — copy their vocabulary and scope names, not their format:\n${diff.subjects.join(`\n`)}`
                : undefined,
            diff.summary === `` ? undefined : `Files this commit will record:\n${diff.summary}`,
            diff.blocks.length === 0 ? `(no textual diff — see the file list above)` : `Diff:\n${renderBlocks(diff.blocks, budget)}`,
        ]
            .filter((section) => section !== undefined)
            .join(`\n\n`),
    );
    return [
        `Read the diff below and write the commit message for it.`,
        ``,
        `Format:`,
        `<type>(<optional scope>): <subject>`,
        ``,
        `- <what changed, one fact per line>`,
        ``,
        `Rules:`,
        // Stated first because it is the part being dictated rather than inferred, and stated as a closed list
        // because an open one gets `update:` and `misc:`.
        `- The type is EXACTLY one of: ${TYPES.join(`, `)}. Choose by what the change does: feat = new capability,`,
        `  fix = wrong behaviour corrected, refactor = same behaviour rearranged, perf = faster or lighter,`,
        `  docs = documentation, test = tests, build/ci = tooling and pipelines, chore = everything else.`,
        `- Subject: imperative mood, lower case after the colon, no trailing period, under 72 characters.`,
        /* THE INSTRUCTION THAT MAKES THIS HISTORY SEARCHABLE. A message reading "improve error handling" matches
         * nothing anyone would ever look for; the same change written as "surface the 401 from resolveCredential
         * in the account picker" matches the symbol, the surface and the condition. The cheap rung will not do
         * this unprompted — it summarises, because summarising is what it is for — so the demand is explicit and
         * repeated in the body rule below. */
        `- NAME THINGS. Use the real identifiers from the diff — function, component, route, setting, package`,
        `  and option names, spelled as the code spells them. These are what someone searching this history`,
        `  later will search for, and a message without them is unfindable.`,
        `- Then a blank line, then up to 4 body lines starting with "- ". Each states one concrete thing the`,
        `  change does, densest first, naming the things it touches. Say what behaviour is different now, and`,
        `  what it was before when the contrast is the point.`,
        // The single largest source of bloat in a drafted message, and the easiest to state as a ban: the file
        // list is already in the commit, and reproducing it costs the reader (or the agent reading it back)
        // context to learn nothing.
        `- Never list the files that changed. Git already records them; repeating them wastes the reader's time.`,
        `- No filler. No "this commit", no "various", no "various improvements", no "improved code quality", no`,
        `  restating the subject as the first body line.`,
        `- Omit the body entirely when the subject already says everything — a one-line rename needs one line.`,
        // A commit spanning repos gets one message, so it has to describe the change rather than any one repo.
        diffs.length > 1 ? `- This commit spans ${diffs.length} repositories and shares one message. Describe the change as a whole.` : undefined,
        /* THE RELEASE NOTE, asked for in the terms it will be READ in — by someone deciding whether to take an
         * update, not by someone reviewing the diff. Two instructions carry that, and the second is the one that
         * matters: most commits earn no note at all. A model asked for a note on every commit will write one for
         * every commit, and a changelog that lists "audit rail icons" beside a real feature is the noise this
         * whole mechanism exists to remove. Omission is stated as the expected outcome rather than an escape
         * hatch, because the cheap rung does what it is told is normal. */
        wantsNote
            ? `- If (and only if) someone USING this software would notice this change, add a last line spelled exactly: Release-Note: <one plain sentence>.`
            : undefined,
        wantsNote
            ? `- That sentence is for users, not developers: say what they can now do or what no longer goes wrong, in their words, with no file, symbol or internal name in it.`
            : undefined,
        wantsNote
            ? `- OMIT the Release-Note line entirely for anything a user would never see — refactors, tests, build and CI work, dependency bumps, internal cleanup. Most commits get no note, and that is the expected answer.`
            : undefined,
        // The output contract is stated first and last: this model is the cheap rung, and a preamble ("Sure!
        // Here's a commit message:") pasted into the input is the failure this helper is most likely to have.
        `- Reply with the message itself. No preamble, no explanation, no quotes, no code fences.`,
        ``,
        ...repos,
        ``,
        wantsNote
            ? `Reply with the message only — subject, optional body, and a Release-Note line only if a user would notice this change.`
            : `Reply with the message only — subject, and a body only if it says something the subject does not.`,
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

/* THE SHAPE THE PROMPT ASKED FOR, used to find where the message actually starts. A cheap model that ignores
 * "no preamble" writes one line of throat-clearing and then the real answer, and taking line one outright would
 * commit "Here's the commit message:". Anchoring on the type prefix skips straight to the message — and when
 * nothing matches, the reader falls back to line one, which is where it always was. */
const CONVENTIONAL = new RegExp(String.raw`^(?:${TYPES.join(`|`)})(?:\([^)]*\))?!?:\s+\S`, `i`);

// Everything after the wrappers come off: the model's lines, minus any note, starting at the message itself.
const messageLines = (reply: string): string[] => {
    const lines = replyLines(reply).filter((line) => !isNoteLine(line));
    const start = lines.findIndex((line) => CONVENTIONAL.test(line));
    return start === -1 ? lines : lines.slice(start);
};

// The subject: the first line of the message proper. Skipping the note rather than taking line one outright is
// what keeps a model that leads with its note from putting the note in the subject — the answer is still right,
// it simply arrived in the other order, and rejecting it over that would waste a good draft.
export const cleanCommitSubject = (reply: string): string => {
    const [first] = messageLines(reply);
    return first === undefined ? `` : unwrap(first);
};

/* A hard ceiling on the body, over the prompt's own "up to 4". The prompt is an instruction and this is a
 * guarantee: a model that ignores the count would otherwise put a page of prose into the commit box, and the
 * whole point of the body is that it stays cheap to read back. */
const MAX_BODY_LINES = 6;

/* The body: the message's remaining lines, kept as the model wrote them.
 *
 * Bullets are NOT unwrapped here, unlike the subject. A leading "- " is the shape the prompt asked for and the
 * shape that makes a multi-fact body scannable — stripping it would run four separate facts together into
 * something that reads like a paragraph and parses like nothing. */
export const cleanCommitBody = (reply: string): string =>
    messageLines(reply)
        .slice(1, 1 + MAX_BODY_LINES)
        .join(`\n`);

// The note, if the model wrote one — empty when it judged the change invisible to users, which is the common
// case and not a failure. Only the FIRST is taken: a model that writes three has misunderstood the ask, and
// three notes about one commit would reach the changelog as three entries.
export const cleanReleaseNote = (reply: string): string => {
    const line = replyLines(reply).find(isNoteLine);
    return line === undefined ? `` : unwrap(line.slice(RELEASE_NOTE_TRAILER.length));
};

/* The whole message the commit box receives: the subject, the body under it, and the note as a trailer beneath
 * both. The blank lines are load-bearing — they are what make the body a body and the note a git trailer rather
 * than two more lines of the subject's own paragraph, and without them `git log` reads the lot as one run-on
 * subject.
 *
 * With neither body nor note this returns the subject alone, which is the right answer for the many commits
 * whose subject says everything. */
export const cleanCommitMessage = (reply: string): string => {
    const subject = cleanCommitSubject(reply);
    if (subject === ``) {
        return ``;
    }
    const note = cleanReleaseNote(reply);
    return [subject, cleanCommitBody(reply), note === `` ? `` : `${RELEASE_NOTE_TRAILER} ${note}`].filter((part) => part !== ``).join(`\n\n`);
};
