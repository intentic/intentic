import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { readWorkspaceFile, statWorkspaceFileSize } from "../../workspace/files/workspace-files.js";
import { BULLET, FENCE } from "@intentic/sandbox-contract";

/* THE MATERIAL A COMMIT MESSAGE IS DRAFTED FROM, and the one rule that matters here: it describes what a commit
 * WOULD RECORD, not what the repo happens to contain. Those differ constantly, a partially staged file, an
 * unstaged edit the user is not ready to commit, and describing the wrong one produces a message that is
 * confidently about changes the commit will not contain. So the scope is stated per call, one shape per shape
 * of CommitSchema (the live caller is agents/landed-subject.ts, which passes the paths one):
 *
 *   staged (default)  → the INDEX vs HEAD; what a bare `git commit` records
 *   all               → the WORKTREE, untracked files included; what a commit that runs `git add -A` first
 *                       sweeps, since `git diff HEAD` alone would miss every new file
 *   paths             → the same WORKTREE reading, narrowed by pathspec: the files one agent landed, or any
 *                       commit that stages a subset first, records exactly those paths and nothing else
 *
 * THE CODE IS THE ONLY WITNESS. This prompt used to also carry the session's title as an `intent` hint, what
 * the conversation was ASKED to do, on the theory that a diff shows what moved and leaves the reason to be
 * inferred. In practice the cheap rung this runs on treated the hint as the answer: told "here is the title,
 * here is the diff, write one line", it wrote the title back, so a commit that fixed three things went in
 * wearing the question that started the session. Worse, a title is itself model-written, so a naming pass that
 * failed put its failure into the commit message. The hint is gone. What the change was for is legible in what
 * it did, and that is the only source here that cannot be stale.
 *
 * CONVENTIONAL COMMITS ARE PRESCRIBED, and this is the one place a convention is imposed rather than inferred.
 * The recent subjects still go in, they carry the repo's vocabulary, its scope names and its register, which
 * no rule can supply, but the TYPE is dictated from the list below. Inferring it worked only on a repo that
 * already had the habit, and on every other one it faithfully reproduced whatever mess was in the log.
 *
 * WRITTEN TO BE READ BACK BY A MACHINE. The audience for this history is now as often an agent searching it as
 * a human skimming it, and the two want the same thing for different reasons: real identifiers, stated
 * behaviour change, and no filler. So the body is a short block of dense factual lines that NAME things, the
 * functions, routes, settings and components the change is about, because those are the tokens a later search
 * matches on. Everything that a reader could get from `git show --stat` for free is banned from it: a message
 * that lists its own files spends the reader's context on what git already stored.
 *
 * THE RELEASE NOTE (`Release-Note:` below) is the one part anybody has to ask for. It is gated on the owner
 * naming that repo in settings (SandboxSettings.changelogRepos) and absent everywhere else. What it asks for is
 * not a third description of the diff: it is the sentence someone USING the software would recognise, and the
 * model is told to leave it out entirely when the change is one nobody outside the project would ever notice,
 * which is most of them. */

// The whole prompt's patch budget, split across the repos a commit spans. Generous enough that an ordinary
// change arrives whole, small enough to stay cheap on the rung this runs on, and the stat + file list above it
// survive truncation, so even a clipped patch leaves the model knowing every path that moved.
const MAX_PATCH_BYTES = 48_000;
// How many subjects establish the house style. Enough to show a repo's vocabulary and scope names, few enough
// that one odd commit doesn't become the pattern.
const RECENT_SUBJECTS = 15;
// Untracked files are read from disk (they have no blob to diff against). Bounded on both axes: a `git add -A`
// can sweep a whole build output, and neither the model nor the user is served by a megabyte of it.
const MAX_UNTRACKED_FILES = 10;
const MAX_UNTRACKED_BYTES = 4_000;

/* ONE FILE'S CHANGE, KEPT SEPARATE FROM ITS NEIGHBOURS, and the reason this is a list rather than the single
 * string it used to be.
 *
 * `git diff` emits one blob in path order, and the old budget clipped that blob at N bytes. Path order is
 * alphabetical and says nothing about what matters, so a lockfile or a snapshot landing early in the alphabet
 * ate the entire allowance and every meaningful file after it was cut, the model then wrote a confident
 * message about a dependency bump that was the least interesting thing in the commit. Splitting per file is
 * what lets the budget be spent on the files that carry the change. */
export interface PatchBlock {
    readonly path: string;
    readonly text: string;
}

export interface RepoDiff {
    readonly repo: string;
    // Recent commit subjects, newest first, the repo's own vocabulary, empty on an unborn repo.
    readonly subjects: readonly string[];
    // `--stat` plus the name-status list: every path that moves, whatever the blocks below have room for.
    readonly summary: string;
    readonly blocks: readonly PatchBlock[];
}

// git exits non-zero for the ordinary states this runs into (an unborn HEAD has no log and nothing to diff), and
// those are not failures of the draft, the other repos still describe themselves.
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
 * The `b/` side names the block, because that is where the file ENDED, a rename's new name is the one the
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
 * that dependencies moved, the `package.json` beside it records WHY, in four lines, and a snapshot file
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
// while only the first few are read from disk. A `git add -A` can sweep a whole build output, the model does
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
        // A file too large, unreadable, or binary still earns its line, the path is the part the subject needs.
        blocks.push({
            path,
            text: content === undefined || content.includes(`\0`) ? `new file: ${path} (${size} bytes, not shown)` : `new file: ${path}\n${content}`,
        });
    }
    return { names: listed.map((path) => `A\t${path}`).join(`\n`), blocks };
};

// Everything one repo contributes to the draft. The scope is the commit's own, see the header: a commit that
// stages before it records (`all`, or an explicit `paths` subset) is described from the WORKTREE, and one that
// records what is already staged is described from the index.
export interface CommitScope {
    // `commit -a`, the whole worktree, untracked files included.
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

// Clip to a byte budget on a line boundary, and SAY that it was clipped, a hunk that stops mid-change with no
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
 * thousand, and every one of the nine is the reason for the commit. So the allowance is filled level by level,
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
 * named but not shown. Ordering is by SIGNAL, not by path, see PatchBlock, and the generated stub is what
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

// The Conventional Commits type set, spelled here because it is PRESCRIBED rather than inferred, see the
// header. Shared with the reply reader below, so the prompt and the parser can never disagree about what
// counts as a type.
const TYPES = [`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`] as const;

/* HOW LONG A NOTE MAY BE, one number, read by every part of the mechanism: the prompt below asks for a sentence
 * that fits it, the reader clips a longer one on a word boundary (clipNote), and the store's own slice is the
 * backstop behind that (agents/agents-registry.ts, sanitizeNote). Sharing it is the whole point. A ceiling the
 * model is never told about is one it cannot spend well, and the two numbers disagreeing is what published notes
 * ending mid-word.
 *
 * 160 characters is a full sentence in a changelog bullet and on an update card, and roughly half of what the
 * cheap rung writes when nothing bounds it, which is the shorter, plainer note this is for. */
export const MAX_NOTE_LENGTH = 160;

/* HOW LONG A DRAFTED SUBJECT MAY BE, and why this number is not the 72 the prompt asks for or the 80 a card is.
 *
 * What this bounds is a whole conventional HEADER, `type(scope): text`, because that is what the drafter returns
 * and what the commit box files. 100 is the ceiling every conventional commit-msg hook puts on that line
 * (commitlint's `header-max-length`, config-conventional's default and this repo's), so it is the point past
 * which a subject stops being one that git will accept. The prompt still asks for under 72, and should: a
 * shorter subject reads better in a log. The two numbers are different jobs — one is style, this one is the wall.
 *
 * IT IS EMPHATICALLY NOT THE CARD'S 80. This used to be scrubbed through the session-title cleaner
 * (agents-registry.ts, MAX_TITLE_LENGTH), and an 80-character cut on a line whose real ceiling is 100 filed
 * `feat(access): StatusBadge on member roster and expired tokens, ui.inputSm on inv` into the commit box — a
 * header severed mid-word at exactly 80, which the user then had to finish by hand before they could commit.
 * That is the same mistake sharing the title's ceiling once made of the release notes, which published ending
 * "…versus addin" (see sanitizeNote's comment). A title is bounded by the width of a card. A commit subject is
 * bounded by what git will take. */
export const MAX_SUBJECT_LENGTH = 100;

// The prompt. Written flat rather than as a system/user pair because the one-shot sends no system prompt at all
// (see claude/claude-one-shot.ts): the instruction, the style examples and the material are one message, in the order the
// model should weigh them.
export const commitMessagePrompt = (diffs: readonly RepoDiff[], wantsNote = false, removedSurfaces: readonly string[] = []): string => {
    const budget = Math.floor(MAX_PATCH_BYTES / Math.max(1, diffs.length));
    const repos = diffs.map((diff) =>
        [
            `## Repository: ${diff.repo}`,
            diff.subjects.length > 0
                ? `Recent commit subjects here. Copy their vocabulary and scope names, not their format:\n${diff.subjects.join(`\n`)}`
                : undefined,
            diff.summary === `` ? undefined : `Files this commit will record:\n${diff.summary}`,
            diff.blocks.length === 0 ? `(no textual diff; see the file list above)` : `Diff:\n${renderBlocks(diff.blocks, budget)}`,
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
        `Rules:`,
        // Stated first because it is the part being dictated rather than inferred, and stated as a closed list
        // because an open one gets `update:` and `misc:`.
        `- The type is EXACTLY one of: ${TYPES.join(`, `)}. Choose by what the change does: feat = new capability,`,
        `  fix = wrong behaviour corrected, refactor = same behaviour rearranged, perf = faster or lighter,`,
        `  docs = documentation, test = tests, build/ci = tooling and pipelines, chore = everything else.`,
        `- Subject: imperative mood, no trailing period, under 72 characters.`,
        /* THE ONE CONTRADICTION THIS PROMPT USED TO CONTAIN, resolved out loud, because the cheap rung resolved
         * it the other way and a hook then refused the answer.
         *
         * "lower case after the colon" and "name things, spelled as the code spells them" (the rule below) are
         * in direct conflict the moment the thing worth naming is what the subject is ABOUT: `StatusBadge`,
         * `API` and `OAuth` are spelled with a capital or they are spelled wrong. Told both in one breath, the
         * cheap rung obeyed the naming rule and led with the identifier, and `subject-case` refused the commit.
         * Both halves are kept, in the order that makes them compatible: a verb first, the name straight after,
         * which is also simply the better subject. A worked pair beside it does more here than the rule does —
         * the rung follows examples where it argues with prose.
         *
         * The draft is repaired mechanically either way (conventionalSubject below), so this text is what keeps
         * repair rare rather than what makes it unnecessary. */
        `- Begin the subject with a LOWERCASE word, and make it the verb: "show", "stop", "drop", "rename".`,
        `  A name from the code goes straight after it, spelled exactly as the code spells it.`,
        `    good: feat(access): show StatusBadge on the member roster`,
        `    bad:  feat(access): StatusBadge on the member roster`,
        `    bad:  feat(access): Show StatusBadge on the member roster`,
        /* THE INSTRUCTION THAT MAKES THIS HISTORY SEARCHABLE. A message reading "improve error handling" matches
         * nothing anyone would ever look for; the same change written as "surface the 401 from resolveCredential
         * in the account picker" matches the symbol, the surface and the condition. The cheap rung will not do
         * this unprompted, it summarises, because summarising is what it is for, so the demand is explicit.
         * It carries more weight now than it used to: the subject is the ONLY line describing the change, so
         * every identifier that does not fit in it is one this history cannot be searched by. */
        `- NAME THINGS. Use the real identifiers from the diff: function, component, route, setting, package`,
        `  and option names, spelled as the code spells them. These are what someone searching this history`,
        `  later will search for, and a message without them is unfindable.`,
        /* ONE LINE, and the ban is stated before anything else can invite a second. The body used to be up to
         * two "- " lines under the subject, and it was the wrong thing to spend on twice over: it is the bulk of
         * what the model generates (so the bulk of the seconds the user waits for a message that is meant to be
         * there before they finish reading the file list), and what it bought was reliably the subject said
         * again at greater length. What actually earns its place beside the subject is the Release-Note, a
         * sentence for a different audience that the subject genuinely cannot carry. */
        `- ONE LINE ONLY. No body, no bullet list, no blank line after the subject, no explanation under it.`,
        // The single largest source of bloat in a drafted message, and the easiest to state as a ban: the file
        // list is already in the commit, and reproducing it costs the reader (or the agent reading it back)
        // context to learn nothing.
        `- Never list the files that changed. Git already records them; repeating them wastes the reader's time.`,
        `- No filler. No "this commit", no "various", no "various improvements", no "improved code quality".`,
        // A commit spanning repos gets one message, so it has to describe the change rather than any one repo.
        diffs.length > 1 ? `- This commit spans ${diffs.length} repositories and shares one message. Describe the change as a whole.` : undefined,
        /* THE RELEASE NOTE, asked for in the terms it will be READ in, by someone deciding whether to take an
         * update, not by someone reviewing the diff. Two instructions carry that, and the second is the one that
         * matters: most commits earn no note at all. A model asked for a note on every commit will write one for
         * every commit, and a changelog that lists "audit rail icons" beside a real feature is the noise this
         * whole mechanism exists to remove. Omission is stated as the expected outcome rather than an escape
         * hatch, because the cheap rung does what it is told is normal. */
        wantsNote
            ? `- If (and only if) someone USING this software would notice this change, add a last line spelled exactly: Release-Note: <one plain sentence>.`
            : undefined,
        // The budget, said out loud, because it is enforced either way (MAX_NOTE_LENGTH): a model that does not
        // know the ceiling writes past it and gets cut mid-word, which is worse than the shorter sentence it
        // would have written had it been asked for one.
        wantsNote
            ? `- That sentence is for users, not developers: say what they can now do or what no longer goes wrong, in their words, with no file, symbol or internal name in it. ONE sentence, at most ${MAX_NOTE_LENGTH} characters. Anything past that is cut off.`
            : undefined,
        wantsNote
            ? `- OMIT the Release-Note line entirely for anything a user would never see: refactors, tests, build and CI work, dependency bumps, internal cleanup. Most commits get no note, and that is the expected answer.`
            : undefined,
        /* THE BREAKING NOTE is rarer still, and the bar is stated as removal rather than change: the cheap rung
         * told to flag "changes" flags every diff, because every diff changes something. What it is asked for is
         * the sentence the update card will show as a warning, so it must say what stops working and what to do
         *, and the "!" demand beside it is what ties the sentence to the major version bump the release
         * tooling derives from the type.
         *
         * WHERE THE MARKER GOES IS SPELLED OUT, in both shapes, because "mark the type" plus a scopeless example
         * is an instruction a model can follow to the letter and still land on `feat!(git):` — the one spelling
         * commitlint reads as having no type and no subject at all (see HEADER). The repair below catches it;
         * this is what keeps it from being written. */
        wantsNote && removedSurfaces.length === 0
            ? `- If (and only if) this change REMOVES or breaks something users already rely on (a feature gone, a command renamed, a file format no longer read), add a line spelled exactly: Breaking-Note: <what stops working and what to do instead, one plain sentence of at most ${MAX_NOTE_LENGTH} characters>, and put a "!" immediately before the colon: "feat!:" without a scope, "feat(scope)!:" with one, never "feat!(scope):". This is rare; when in doubt, omit it.`
            : undefined,
        /* THE FORCED CASE, replacing the judgment call above whenever the detector already knows the answer
         * (git/changes/contract-shrink.ts): this commit removes named wire surfaces, so whether it breaks something is
         * not the model's to weigh, only what the warning sentence should say. Stated with the removed paths
         * in front of it because the sentence has to be ABOUT them, and a model told only "this is breaking"
         * writes a warning about whatever the diff's largest file was. Independent of wantsNote: the note is a
         * changelog courtesy, the declaration is what lets the change ship at all (COMPATIBILITY.md). */
        ...(removedSurfaces.length > 0
            ? [
                  `- This commit REMOVES these surfaces from the machine-read wire contract (the schemas other software parses):`,
                  ...removedSurfaces.slice(0, 10).map((surface) => `    ${surface}`),
                  `- Because of that, two things are REQUIRED, not optional: put a "!" immediately before the colon ("feat!:" without a scope, "feat(scope)!:" with one, never "feat!(scope):"), and add a line spelled exactly: Breaking-Note: <what stops working for a user of the software and what to do instead, one plain sentence of at most ${MAX_NOTE_LENGTH} characters>. Write the sentence about the removals listed above.`,
              ]
            : []),
        // The output contract is stated first and last: this model is the cheap rung, and a preamble ("Sure!
        // Here's a commit message:") pasted into the input is the failure this helper is most likely to have.
        `- Reply with the message itself. No preamble, no explanation, no quotes, no code fences.`,
        ``,
        ...repos,
        ``,
        wantsNote
            ? `Reply with the subject line only, plus a Release-Note line if (and only if) a user would notice this change.`
            : `Reply with the subject line only.`,
    ]
        .filter((line) => line !== undefined)
        .join(`\n`);
};

// Wrappers a model reaches for even when told not to. Stripped rather than rejected: the message is right and
// only its packaging is wrong, and a helper that refuses a good answer over a pair of backticks is worse than
// one that unwraps it.
const LABEL = /^(?:subject|commit message|message)\s*:\s*/i;

/* WHAT A NOTE IS CARRIED ON: git's own trailer convention, rather than a shape invented here. `git log
 * --format=%(trailers:key=Release-Note,valueonly)` reads it back at release time, `git interpret-trailers`
 * understands it, and anyone who opens the commit sees a labelled line instead of a stray sentence. The
 * harvest and the writer therefore share ONE spelling, which is this constant. */
const RELEASE_NOTE_TRAILER = `Release-Note:`;

/* The note's rarer sibling: the sentence for a change that TAKES something away from users, harvested into
 * the Release's "Breaking changes" section the same way (publish-github.sh), and the reason the update card
 * can warn before the update instead of the user finding out after. Same trailer convention, same one
 * spelling shared by writer and harvest. */
const BREAKING_NOTE_TRAILER = `Breaking-Note:`;

const startsWithTrailer = (line: string, trailer: string): boolean => line.toLowerCase().startsWith(trailer.toLowerCase());

const isNoteLine = (line: string): boolean => startsWithTrailer(line, RELEASE_NOTE_TRAILER) || startsWithTrailer(line, BREAKING_NOTE_TRAILER);

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
 * commit "Here's the commit message:". Anchoring on the type prefix skips straight to the message, and when
 * nothing matches, the reader falls back to line one, which is where it always was. */
const CONVENTIONAL = new RegExp(String.raw`^(?:${TYPES.join(`|`)})(?:\([^)]*\))?!?:\s+\S`, `i`);

// Everything after the wrappers come off: the model's lines, minus any note, starting at the message itself.
const messageLines = (reply: string): string[] => {
    const lines = replyLines(reply).filter((line) => !isNoteLine(line));
    const start = lines.findIndex((line) => CONVENTIONAL.test(line));
    return start === -1 ? lines : lines.slice(start);
};

/* WHAT A COMMIT-MSG HOOK WOULD REFUSE, PUT RIGHT BEFORE ANYBODY IS ASKED TO PUT IT RIGHT.
 *
 * The rung that writes these messages is the cheap one, by design: this is a one-line job on a small prompt and
 * paying a frontier model for it would be absurd. What the cheap rung does is break the mechanical rules while
 * getting the sentence right — a capital on the first word, a full stop on the end, a line four characters over
 * the ceiling — and every one of those came back to the user as a red "Commit failed" box under a message that
 * was otherwise exactly what they wanted. The refusal is the whole cost of running this cheaply, and the
 * refusals are all deterministic, so they are corrected here instead of being reported.
 *
 * THE TARGET IS THE STRICTEST COMMON CONFIG, not this repo's. config-conventional's defaults are what an
 * arbitrary workspace's hook runs, and the daemon drafts for whatever repos the user has, so a subject that
 * leaves here must satisfy the strict reading even though this repo now allows a leading identifier
 * (commitlint.config.ts). Three repairs cover every error-level rule that repair can reach:
 *
 *   subject-case      a leading capital, lowered when it is an ordinary word and BACKTICKED when it is a name;
 *   subject-full-stop a trailing period, dropped;
 *   header-max-length an over-long header, clipped on a word boundary;
 *   type-case         a capitalised type (`Feat:`), lowered when the header is rebuilt.
 *
 * What is NOT repaired: an empty subject, and a reply with no conventional type at all. Both mean the model
 * answered something other than the question, there is no correct mechanical guess at what it meant, and the
 * ask already hands those to the next model in the chain (agents/land/landed-subject.ts, messageAnswer). A
 * subject that is one PascalCase token with no spaces in it (`fix: StopTheReordering`) is left alone for the
 * same reason: it is not a sentence, and nothing here could turn it into one. */

// A leading word that is a NAME rather than a capitalised English word, which is the distinction that decides
// whether lowering its first letter is a correction or a corruption. Prose does not put two capitals in a row,
// a capital after a lowercase, or a dot in the middle of a word; code does all three constantly. So `API`,
// `OAuth`, `ESLint`, `StatusBadge`, `ui.inputSm` and `resolveRoleModels()` are names, and `Sandbox`, `Show`,
// `Fix` and `A11y` are words — the last of which is exactly right to lower, since `a11y` is how it is written.
const looksLikeName = (word: string): boolean => /\p{Lu}\p{Lu}|\p{Ll}\p{Lu}/u.test(word) || /[._/]\p{L}|\(\)/u.test(word);

// The leading token, without the punctuation that trails it, so a name is quoted and the comma after it is not.
const LEAD = /^[\p{L}\d._/]+(?:\(\))?/u;

/* THE SUBJECT'S FIRST LETTER, MADE LOWERCASE OR MADE EXEMPT.
 *
 * An ordinary word is simply lowered: that is what the prompt asked for and it loses nothing. A NAME cannot be
 * lowered — `statusBadge` and `eSLint` are different tokens from the ones in the code, and the whole point of
 * naming things in a subject is that a later search matches them — so it is wrapped in backticks instead, which
 * is not a dodge but the documented way out: the `subject-case` rule in @commitlint/rules checks nothing at all
 * unless the subject starts with a cased letter (it short-circuits on its own `startsWithLetterRegex`), and
 * @commitlint/ensure strips backticked spans before it looks anyway. A backticked identifier also reads as one,
 * which is more than the mangled spelling managed.
 *
 * Gated on the FIRST CHARACTER alone, because that is the only character `subject-case` reads. A name in any
 * other position was never in danger and is left exactly as the model wrote it, `resolveRoleModels()` included:
 * quoting one to protect it from a rule that never looked at it would be noise the drafter has to explain. */
const leadingCase = (text: string): string => {
    if (!/^\p{Lu}/u.test(text)) {
        return text;
    }
    const lead = LEAD.exec(text)?.[0];
    if (lead === undefined) {
        return text;
    }
    return looksLikeName(lead) ? `\`${lead}\`${text.slice(lead.length)}` : text.charAt(0).toLowerCase() + text.slice(1);
};

// A subject shouted in full. Lowered whole rather than by its first letter, because an all-caps line has no
// identifiers left to protect: their spelling is already gone.
const isShout = (text: string): boolean => text === text.toUpperCase() && /\p{Lu}/u.test(text);

// `subject-full-stop`, which reads the last character only, so `foo.` and `foo...` both break it.
const TRAILING_STOP = /\.+$/u;

/* Clipped on a WORD BOUNDARY, never at the byte, and this is the difference between a subject the user commits
 * and one they have to finish typing. A header cut at a count reads as a shorter, wrong sentence that stops
 * mid-noun ("… ui.inputSm on inv"), and the punctuation left dangling at the cut ("… expired tokens,") makes it
 * read as truncated even when the words are whole. */
const clipSubject = (subject: string): string => {
    if (subject.length <= MAX_SUBJECT_LENGTH) {
        return subject;
    }
    const cut = subject.slice(0, MAX_SUBJECT_LENGTH);
    const boundary = cut.lastIndexOf(` `);
    return (boundary === -1 ? cut : cut.slice(0, boundary)).replace(/[\p{P}\s]+$/u, ``);
};

/* AND A NOTE CUT THE SAME WAY, which the subject has had and the two sentences beside it have not. The store's
 * ceiling is a hard slice (agents-registry.ts, sanitizeLine), so a note that ran long arrived in the commit box
 * severed at exactly 160 characters, mid-word: `…, GitStageSchema, and numer`. It then reads as a sentence
 * somebody fumbled, in the one place a sentence is all there is — a changelog bullet, an update card's warning.
 *
 * The prompt asks for a sentence that fits (MAX_NOTE_LENGTH is stated in it); this is what happens when the
 * cheap rung writes past the ask anyway, which it does. Clipped HERE, where the note is read off the reply, so
 * the store's slice becomes the backstop it is for the subject rather than the working limit.
 *
 * WITH AN ELLIPSIS, unlike the subject, because these are different kinds of line: a subject that stops early
 * still reads as a subject, while prose that simply stops reads as prose that was cut. The mark costs one
 * character of the budget, so the cut is made one short of it and the result still fits what the store keeps. */
const clipNote = (note: string): string => {
    if (note.length <= MAX_NOTE_LENGTH) {
        return note;
    }
    const cut = note.slice(0, MAX_NOTE_LENGTH - 1);
    const boundary = cut.lastIndexOf(` `);
    return `${(boundary === -1 ? cut : cut.slice(0, boundary)).replace(/[\p{P}\s]+$/u, ``)}…`;
};

/* The header taken apart so the repairs above land on the SUBJECT rather than on the `feat(scope):` in front of
 * it — and taken apart ONCE, because this file now has two readers of a header (the drafter's repair below, and
 * the commit seam's after it) and a second regex is how the two would come to disagree about what a header is.
 * The type comes back spelled as it was written; what to do about a `Feat` is the reader's call, and only one of
 * them is entitled to rewrite one.
 *
 * THE MARKER IS READ ON EITHER SIDE OF THE SCOPE, though only one side is legal. Conventional Commits puts the
 * `!` last, `feat(git)!:`, and the prompt's own example carries no scope to put it after (`feat!:`), so a model
 * told to mark the TYPE writes exactly what it was shown and pushes the scope behind it: `feat!(git):`. That
 * parses as no conventional header at all, which is why the refusal it earns is unreadable — commitlint says
 * "subject may not be empty; type may not be empty" about a line that visibly has both, and the panel prints
 * that verdict over a drafted message no amount of retrying can get past. Measured over this workspace's own
 * history: 5 of 1056 landed subjects, each one a commit box its author could not use.
 *
 * So the marker is accepted where it was written and emitted where it belongs. Its MEANING was never in doubt
 * (this change breaks something), and that is the part a repair must not lose. */
const HEADER = /^(\w+)(!?)(\([^)]*\))?(!?)\s*:\s*(.*?)\s*$/u;

interface HeaderParts {
    readonly type: string;
    // The scope with its parentheses, `(git)`, or empty: this is only ever passed through, never read into.
    readonly scope: string;
    // `!` when the marker was written on either side of the scope, empty when there was none.
    readonly breaking: string;
    readonly text: string;
}

const headerParts = (header: string): HeaderParts | undefined => {
    const parts = HEADER.exec(header.trim());
    if (parts === null) {
        return undefined;
    }
    const [, type = ``, aheadOfScope = ``, scope = ``, afterScope = ``, text = ``] = parts;
    return { type, scope, breaking: aheadOfScope === `` && afterScope === `` ? `` : `!`, text };
};

// One spelling out, whatever spelling came in: the marker after the scope, and exactly one space after the
// colon. Those two are `header-trim` and, more to the point, the whole difference between a header a
// conventional parser reads and one it does not see at all.
const spellHeader = (parts: HeaderParts): string => `${parts.type}${parts.scope}${parts.breaking}: ${parts.text}`;

// The prescribed set, matched case-insensitively: a capitalised type is a spelling of a known type, not an
// unknown one, and reading it as unknown is what would leave `Feat!(api):` unrepaired.
const isConventionalType = (type: string): boolean => TYPES.some((known) => known === type.toLowerCase());

export const conventionalSubject = (header: string): string => {
    const parts = headerParts(header);
    // A reply with no conventional type has no parts worth taking apart and is only clipped: the hook refuses it
    // whatever this did, and half-fixing it would hide which rung wrote it.
    if (parts === undefined || !isConventionalType(parts.type)) {
        return clipSubject(header);
    }
    const cased = isShout(parts.text) ? parts.text.toLowerCase() : leadingCase(parts.text);
    // The drafter's own header, so the type is lowered and the sentence is put right: this is the one reader
    // entitled to rewrite what a model wrote.
    return clipSubject(spellHeader({ ...parts, type: parts.type.toLowerCase(), text: cased.replace(TRAILING_STOP, ``) }));
};

/* THE SAME REFUSAL, CAUGHT WHERE A MESSAGE BECOMES A COMMIT (git.routes.ts, the commit route), because the
 * repair above only ever guards the messages this daemon DRAFTS and the commit box records whatever is in it: a
 * message drafted before that repair existed and still sitting on an agent's card, one an extension filed, one
 * the user typed by hand around a marker they put on the wrong side of the scope. Every one of those reached git
 * unread, and came back as the verdict nobody can act on.
 *
 * WHAT IS REPAIRED HERE IS ONLY WHAT A PARSER CANNOT READ, a far narrower set than the drafter's: the `!` ahead
 * of the scope, and a colon with no space after it (`feat:no space`). Both make conventional-commits-parser find
 * no header at all, so commitlint answers "subject may not be empty; type may not be empty" about a line that
 * plainly has both. Every other rule earns an ACCURATE verdict — `type must be lower-case`, `subject may not end
 * with a full stop` — and those stay the message's author's to fix. This daemon does not get to lower a capital
 * or strip a full stop out of a sentence a person typed, and it cannot know which of those rules the repo even
 * enforces: a subject may lead with an identifier here and may not one directory over (commitlint.config.ts).
 *
 * A first line it cannot recognise as a conventional header comes back untouched, and the recognition is
 * deliberately narrow — a known type, or a scope or a marker saying a header was meant. `http://host is down` is
 * also a word, a colon and some text, and rewriting it to `http: //host is down` would be this repair inventing
 * a convention for a repo that never asked for one. */
export const parsableMessage = (message: string): string => {
    const [header = ``, ...body] = message.split(`\n`);
    const parts = headerParts(header);
    if (parts === undefined || !(isConventionalType(parts.type) || parts.scope !== `` || parts.breaking !== ``)) {
        return message;
    }
    // An empty subject is not a spelling problem, it is the message being unfinished, and `subject-empty` is then
    // the truth: leave it to be told rather than rebuilding a header around nothing.
    if (parts.text === ``) {
        return message;
    }
    return [spellHeader(parts), ...body].join(`\n`);
};

// The subject: the first line of the message proper, unwrapped and then made committable. Skipping the note
// rather than taking line one outright is what keeps a model that leads with its note from putting the note in
// the subject, the answer is still right, it simply arrived in the other order, and rejecting it over that would
// waste a good draft.
export const cleanCommitSubject = (reply: string): string => {
    const [first] = messageLines(reply);
    return first === undefined ? `` : conventionalSubject(unwrap(first));
};

/* THERE IS NO BODY READER, and its absence is deliberate rather than an omission.
 *
 * A drafted message used to carry up to two "- " lines under the subject, and dropping them cost nothing anyone
 * missed: they were the model's own summary of a diff the commit already records, they were most of what it
 * generated (and therefore most of the seconds the user waits for a message that is supposed to be sitting in
 * the box by the time they have finished reading the file list), and the one thing beside the subject that
 * genuinely says something new, the Release-Note, is read separately below.
 *
 * So a model that writes a body anyway simply has it dropped: `cleanCommitSubject` takes the first line and the
 * note readers take the trailers, and everything in between falls on the floor. Nothing has to enforce the
 * prompt's "one line only", the reader cannot express a body to begin with. */

// The note, if the model wrote one, empty when it judged the change invisible to users, which is the common
// case and not a failure. Only the FIRST is taken: a model that writes three has misunderstood the ask, and
// three notes about one commit would reach the changelog as three entries.
export const cleanReleaseNote = (reply: string): string => {
    const line = replyLines(reply).find((candidate) => startsWithTrailer(candidate, RELEASE_NOTE_TRAILER));
    return line === undefined ? `` : clipNote(unwrap(line.slice(RELEASE_NOTE_TRAILER.length)));
};

// The breaking sentence, if the model wrote one, empty for every change that takes nothing away, which is
// nearly all of them. First only, same as the note: one landing breaks one way or the model has misread it.
export const cleanBreakingNote = (reply: string): string => {
    const line = replyLines(reply).find((candidate) => startsWithTrailer(candidate, BREAKING_NOTE_TRAILER));
    return line === undefined ? `` : clipNote(unwrap(line.slice(BREAKING_NOTE_TRAILER.length)));
};

/* THE TWO ENFORCERS BEHIND THE FORCED CASE, what turns "the prompt demanded it" into "the draft carries it".
 * A model that ignores the demand (the cheap rung sometimes does) would otherwise hand a detected shrink back
 * undeclared, and the whole point of detecting mechanically is that the declaration cannot depend on the model
 * having a good day. The subject marker is pure transformation; the note has a truthful floor. */

// The `!` on a conventional subject, added when the type carries none and MOVED when it carries one ahead of
// the scope, the illegal spelling HEADER explains above. Reading it there matters most here: this is the
// enforcer for a shrink the detector already proved, and a marker it could not see meant the removal shipped as
// a minor bump, on a header the hook was going to refuse anyway. A subject that is not conventional at all is
// returned untouched, the commit-msg hook rejects it before the marker could matter.
// Re-clipped after the insert, not before: the marker is one character, and a subject already sitting on the
// ceiling would leave here at 101 and be refused for a length the drafter never wrote.
const TYPE_HEAD = new RegExp(String.raw`^(${TYPES.join(`|`)})!?(\([^)]*\))?!?:`, `i`);
export const markSubjectBreaking = (subject: string): string => clipSubject(subject.replace(TYPE_HEAD, `$1$2!:`));

/* The sentence used when the model wrote none: the removed surfaces' schema names, stated plainly. Weaker than
 * a written warning, it names what shrank without saying what to do instead, but it is TRUE, it reaches the
 * release's "Breaking changes" section instead of nothing reaching it, and the user sees it in the commit box
 * before filing, where it can still be reworded. Clipped to the same ceiling every note answers to. */
export const fallbackBreakingNote = (removedSurfaces: readonly string[]): string => {
    const names = [...new Set(removedSurfaces.map((surface) => surface.split(`.`)[0]))].join(`, `);
    const sentence = `The wire contract no longer offers what it did under ${names}. Anything reading those surfaces must stop relying on them.`;
    // Through the same clip every written note answers to, so a shrink that names twenty schemas ends on a whole
    // one rather than halfway through its name.
    return clipNote(sentence);
};
