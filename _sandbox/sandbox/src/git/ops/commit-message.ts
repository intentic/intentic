import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { readWorkspaceFile, statWorkspaceFileSize } from "../../workspace/files/workspace-files.js";
import { BULLET, FENCE } from "@intentic/sandbox-contract";

// Drafts a commit message from what a commit WOULD record, not what the repo contains; the diff is the only source
// used, no session title or other context. Scope decides the base:
// - staged (default): index vs HEAD
// - all: the worktree, untracked files included
// - paths: the worktree narrowed to those paths

// Patch budget, split across repos; stat/file list survive truncation even when the patch itself is clipped.
const MAX_PATCH_BYTES = 48_000;
// Subjects sampled for house style: enough for vocabulary, too few for one odd commit to set the pattern.
const RECENT_SUBJECTS = 15;
// Untracked files are read from disk (no blob to diff); bounded on both axes against a swept build output.
const MAX_UNTRACKED_FILES = 10;
const MAX_UNTRACKED_BYTES = 4_000;

// One file's change kept separate from its neighbors, so the budget can be spent per file instead of by whichever file
// git's alphabetical order puts first.
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

// git exits non-zero for ordinary states here (an unborn HEAD); not a draft failure, so this reads as empty rather than
// throwing.
const tryGit = async (dir: string, args: readonly string[], git: GitRunner): Promise<string> =>
    git(dir, [...args])
        .then((result) => result.stdout)
        .catch(() => ``);

// One diff base per commit shape, shared by stat/file-list/patch so they can't disagree. Pathspec is a separate tail:
// `--` ends the option list, so flags must precede it.
const diffBase = (worktree: boolean): readonly string[] => (worktree ? [`diff`, `HEAD`] : [`diff`, `--cached`]);
const pathspec = (paths: readonly string[] | undefined): readonly string[] => (paths === undefined ? [] : [`--`, ...paths]);

// Splits git's diff blob on its own `diff --git` header rather than diffing per path (cheaper on a wide changeset);
// labeled by the `b/` (post-rename) side, since that's the name a later search wants.
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

// Generated files (lockfiles, snapshots, build output); not dropped, just sorted last and shown as a one-line stub so
// the budget reaches real code first.
const GENERATED = [
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/,
    /(^|\/)(dist|build|out|vendor|node_modules|__snapshots__|__generated__)\//,
    /\.(min\.js|min\.css|map|snap|lock)$/,
];

const isGenerated = (path: string): boolean => GENERATED.some((pattern) => pattern.test(path));

// Synthetic "new file" blocks for untracked paths (`--exclude-standard` matches what `git add -A` would stage); names
// and contents are bounded separately, so every new path is listed even when only a few are read.
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

// One repo's contribution to the draft; `all`/`paths` describe the worktree (what staging would sweep), otherwise it's
// the index.
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
        // Only a commit that stages first sweeps untracked files; a staged commit's index holds none.
        worktree ? untrackedFiles(dir, scope.paths, git) : Promise.resolve({ names: ``, blocks: [] as PatchBlock[] }),
    ]);
    return {
        repo,
        subjects: subjects.split(`\n`).filter((subject: string) => subject !== ``),
        summary: [stat.trim(), names.trim(), untracked.names.trim()].filter((part) => part !== ``).join(`\n`),
        blocks: [...splitPatch(patch.trim()), ...untracked.blocks],
    };
};

// Clips to a budget on a line boundary and marks the cut; an unmarked stop reads as a complete edit that just ends.
const clip = (text: string, budget: number): string => {
    if (text.length <= budget) {
        return text;
    }
    const cut = text.slice(0, budget);
    return `${cut.slice(0, cut.lastIndexOf(`\n`) + 1)}… (rest of this file's diff truncated)`;
};

// Fills the budget level by level so small/medium files arrive whole and only the huge ones get clipped, rather than
// splitting it evenly per file.
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

// Orders blocks by signal, not path: real changes first (and whole where possible), generated files last as a named
// stub that costs no budget.
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

// Prescribed Conventional Commits types; shared with the reply parser so prompt and parser can't disagree.
const TYPES = [`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`] as const;

// Shared by the prompt, clipNote and the store's own slice (sanitizeNote); one number, so none can disagree.
export const MAX_NOTE_LENGTH = 160;

// Header ceiling git hooks enforce (100, header-max-length); distinct from the 72-char style ask.
export const MAX_SUBJECT_LENGTH = 100;

// One flat message, not a system/user pair: the one-shot sends no system prompt (claude/claude-one-shot.ts), so
// instructions, examples and material are ordered in one text.
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
        // Stated first as the dictated part; a closed list, since an open one invites `update:`/`misc:`.
        `- The type is EXACTLY one of: ${TYPES.join(`, `)}. Choose by what the change does: feat = new capability,`,
        `  fix = wrong behaviour corrected, refactor = same behaviour rearranged, perf = faster or lighter,`,
        `  docs = documentation, test = tests, build/ci = tooling and pipelines, chore = everything else.`,
        `- Subject: imperative mood, no trailing period, under 72 characters.`,
        // Verb-first, name second resolves "lowercase the subject" vs "name things as the code spells them"
        // (StatusBadge, API); conventionalSubject repairs it either way, so this keeps repairs rare.
        `- Begin the subject with a LOWERCASE word, and make it the verb: "show", "stop", "drop", "rename".`,
        `  A name from the code goes straight after it, spelled exactly as the code spells it.`,
        `    good: feat(access): show StatusBadge on the member roster`,
        `    bad:  feat(access): StatusBadge on the member roster`,
        `    bad:  feat(access): Show StatusBadge on the member roster`,
        // Real identifiers make history searchable ("improve error handling" matches nothing; naming resolveCredential
        // does); the cheap rung won't do this unprompted, so it's demanded explicitly.
        `- NAME THINGS. Use the real identifiers from the diff: function, component, route, setting, package`,
        `  and option names, spelled as the code spells them. These are what someone searching this history`,
        `  later will search for, and a message without them is unfindable.`,
        // No body: it only restated the subject at length and cost generation time; the Release-Note is the one line
        // that actually adds something.
        `- ONE LINE ONLY. No body, no bullet list, no blank line after the subject, no explanation under it.`,
        // Files already show in the commit itself; repeating them costs context to learn nothing new.
        `- Never list the files that changed. Git already records them; repeating them wastes the reader's time.`,
        `- No filler. No "this commit", no "various", no "various improvements", no "improved code quality".`,
        // A commit spanning repos gets one message, so it has to describe the change rather than any one repo.
        diffs.length > 1 ? `- This commit spans ${diffs.length} repositories and shares one message. Describe the change as a whole.` : undefined,
        // Asked in the terms a user reads it in, not a diff reviewer's; omission is the expected outcome (most commits
        // earn no note), not an escape hatch.
        wantsNote
            ? `- If (and only if) someone USING this software would notice this change, add a last line spelled exactly: Release-Note: <one plain sentence>.`
            : undefined,
        // Stated in the prompt since it's enforced anyway: an unstated ceiling gets written past and cut mid-word.
        wantsNote
            ? `- That sentence is for users, not developers: say what they can now do or what no longer goes wrong, in their words, with no file, symbol or internal name in it. ONE sentence, at most ${MAX_NOTE_LENGTH} characters. Anything past that is cut off.`
            : undefined,
        wantsNote
            ? `- OMIT the Release-Note line entirely for anything a user would never see: refactors, tests, build and CI work, dependency bumps, internal cleanup. Most commits get no note, and that is the expected answer.`
            : undefined,
        // Bar is removal, not "changes" (every diff changes something); marker position is spelled out in both shapes
        // since "mark the type" plus a scopeless example alone yields the unparsable `feat!(scope):`.
        wantsNote && removedSurfaces.length === 0
            ? `- If (and only if) this change REMOVES or breaks something users already rely on (a feature gone, a command renamed, a file format no longer read), add a line spelled exactly: Breaking-Note: <what stops working and what to do instead, one plain sentence of at most ${MAX_NOTE_LENGTH} characters>, and put a "!" immediately before the colon: "feat!:" without a scope, "feat(scope)!:" with one, never "feat!(scope):". This is rare; when in doubt, omit it.`
            : undefined,
        // Forced when contract-shrink.ts already detected a removal: only the sentence's wording is the model's job.
        // Independent of wantsNote — this declaration is what lets the change ship, not a changelog courtesy.
        ...(removedSurfaces.length > 0
            ? [
                  `- This commit REMOVES these surfaces from the machine-read wire contract (the schemas other software parses):`,
                  ...removedSurfaces.slice(0, 10).map((surface) => `    ${surface}`),
                  `- Because of that, two things are REQUIRED, not optional: put a "!" immediately before the colon ("feat!:" without a scope, "feat(scope)!:" with one, never "feat!(scope):"), and add a line spelled exactly: Breaking-Note: <what stops working for a user of the software and what to do instead, one plain sentence of at most ${MAX_NOTE_LENGTH} characters>. Write the sentence about the removals listed above.`,
              ]
            : []),
        // Stated first and last: a cheap model's most likely failure is a preamble pasted ahead of the message.
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

// Label wrappers a model adds despite instructions; stripped rather than rejected as a bad reply.
const LABEL = /^(?:subject|commit message|message)\s*:\s*/i;

// git's own trailer convention (readable via `git interpret-trailers` / `%(trailers:key=...)`), shared by writer and
// harvest as one spelling.
const RELEASE_NOTE_TRAILER = `Release-Note:`;

// The breaking-change sibling of Release-Note, harvested into the release's "Breaking changes" section
// (publish-github.sh) the same way.
const BREAKING_NOTE_TRAILER = `Breaking-Note:`;

const startsWithTrailer = (line: string, trailer: string): boolean => line.toLowerCase().startsWith(trailer.toLowerCase());

const isNoteLine = (line: string): boolean => startsWithTrailer(line, RELEASE_NOTE_TRAILER) || startsWithTrailer(line, BREAKING_NOTE_TRAILER);

// Strips the wrappers a model reaches for around any single line.
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

// Anchors on the type prefix to skip a preamble line a cheap model sometimes adds ahead of the real message.
const CONVENTIONAL = new RegExp(String.raw`^(?:${TYPES.join(`|`)})(?:\([^)]*\))?!?:\s+\S`, `i`);

// Everything after the wrappers come off: the model's lines, minus any note, starting at the message itself.
const messageLines = (reply: string): string[] => {
    const lines = replyLines(reply).filter((line) => !isNoteLine(line));
    const start = lines.findIndex((line) => CONVENTIONAL.test(line));
    return start === -1 ? lines : lines.slice(start);
};

// Repairs the mechanical rules a commit-msg hook enforces (against the strictest common config, not this repo's relaxed
// one), since the cheap rung reliably breaks them while getting the sentence right:
// - subject-case: a leading capital, lowered (or backticked if it's a name)
// - subject-full-stop: a trailing period, dropped
// - header-max-length: an over-long header, clipped on a word boundary
// - type-case: a capitalised type, lowered
// Not repaired: an empty subject, no conventional type, or a subject that's one bare PascalCase token — none of those
// are a sentence to fix.

// Distinguishes a name (`API`, `StatusBadge`, `ui.inputSm`) from an English word (`Sandbox`, `A11y`): prose never puts
// two capitals together, a capital after lowercase, or a mid-word dot.
const looksLikeName = (word: string): boolean => /\p{Lu}\p{Lu}|\p{Ll}\p{Lu}/u.test(word) || /[._/]\p{L}|\(\)/u.test(word);

// The leading token without trailing punctuation, so a name is quoted but a following comma is not.
const LEAD = /^[\p{L}\d._/]+(?:\(\))?/u;

// A word is lowered; a name is backticked instead (subject-case only checks the first character, and backticks make it
// not a cased letter). Names elsewhere in the subject are never touched.
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

// An all-caps subject; lowered whole rather than by first letter, since no identifier spelling survives to protect.
const isShout = (text: string): boolean => text === text.toUpperCase() && /\p{Lu}/u.test(text);

// `subject-full-stop`, which reads the last character only, so `foo.` and `foo...` both break it.
const TRAILING_STOP = /\.+$/u;

// Cut on a word boundary, never mid-word or leaving dangling punctuation, or the subject reads as truncated even when
// it technically fits.
const clipSubject = (subject: string): string => {
    if (subject.length <= MAX_SUBJECT_LENGTH) {
        return subject;
    }
    const cut = subject.slice(0, MAX_SUBJECT_LENGTH);
    const boundary = cut.lastIndexOf(` `);
    return (boundary === -1 ? cut : cut.slice(0, boundary)).replace(/[\p{P}\s]+$/u, ``);
};

// Clipped here (ahead of the store's own hard slice) on a word boundary, with a trailing ellipsis since cut prose reads
// as unfinished, unlike a short subject; cut one char short to leave room for it.
const clipNote = (note: string): string => {
    if (note.length <= MAX_NOTE_LENGTH) {
        return note;
    }
    const cut = note.slice(0, MAX_NOTE_LENGTH - 1);
    const boundary = cut.lastIndexOf(` `);
    return `${(boundary === -1 ? cut : cut.slice(0, boundary)).replace(/[\p{P}\s]+$/u, ``)}…`;
};

// Splits a header once so both repair sites agree on what one is. Reads the `!` marker on either side of the scope,
// though only after it is legal.
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

// One canonical spelling out: marker after the scope, one space after the colon — the difference between a header a
// parser reads and one it can't see.
const spellHeader = (parts: HeaderParts): string => `${parts.type}${parts.scope}${parts.breaking}: ${parts.text}`;

// Matched case-insensitively: a capitalised type is a known type misspelled, not an unknown one.
const isConventionalType = (type: string): boolean => TYPES.some((known) => known === type.toLowerCase());

export const conventionalSubject = (header: string): string => {
    const parts = headerParts(header);
    // No conventional type: only clipped, since the hook refuses it either way and half-fixing would mislead.
    if (parts === undefined || !isConventionalType(parts.type)) {
        return clipSubject(header);
    }
    const cased = isShout(parts.text) ? parts.text.toLowerCase() : leadingCase(parts.text);
    // The drafter's own header: the one reader entitled to rewrite the type and sentence a model wrote.
    return clipSubject(spellHeader({ ...parts, type: parts.type.toLowerCase(), text: cased.replace(TRAILING_STOP, ``) }));
};

// Repairs only spellings a parser can't find a header in at all (`!` ahead of the scope, no space after `:`); every
// other rule is left for the hook to report, since this daemon doesn't know a given repo's exact config.
export const parsableMessage = (message: string): string => {
    const [header = ``, ...body] = message.split(`\n`);
    const parts = headerParts(header);
    if (parts === undefined || !(isConventionalType(parts.type) || parts.scope !== `` || parts.breaking !== ``)) {
        return message;
    }
    // An empty subject isn't a spelling problem; `subject-empty` is already the honest answer.
    if (parts.text === ``) {
        return message;
    }
    return [spellHeader(parts), ...body].join(`\n`);
};

// First line of the message proper (notes skipped), unwrapped and made committable; a model that leads with its note
// still lands on the right subject.
export const cleanCommitSubject = (reply: string): string => {
    const [first] = messageLines(reply);
    return first === undefined ? `` : conventionalSubject(unwrap(first));
};

// No body reader by design: anything past the first line and the trailers just falls on the floor, so "one line only"
// needs no separate enforcement.

// The note, or empty when the model judged the change invisible to users (the common case). Only the first is taken;
// more than one means the model misread the ask.
export const cleanReleaseNote = (reply: string): string => {
    const line = replyLines(reply).find((candidate) => startsWithTrailer(candidate, RELEASE_NOTE_TRAILER));
    return line === undefined ? `` : clipNote(unwrap(line.slice(RELEASE_NOTE_TRAILER.length)));
};

// The breaking sentence, or empty for the near-total majority of changes that take nothing away. First only, like the
// note.
export const cleanBreakingNote = (reply: string): string => {
    const line = replyLines(reply).find((candidate) => startsWithTrailer(candidate, BREAKING_NOTE_TRAILER));
    return line === undefined ? `` : clipNote(unwrap(line.slice(BREAKING_NOTE_TRAILER.length)));
};

// Enforces the forced breaking-note case mechanically, since a model can ignore the prompt's demand; the marker is pure
// transformation, the note has a truthful floor.

// Adds or relocates the `!` (repairing the illegal ahead-of-scope spelling); non-conventional subjects pass through.
// Re-clipped after inserting it, since the marker can push a subject past the ceiling.
const TYPE_HEAD = new RegExp(String.raw`^(${TYPES.join(`|`)})!?(\([^)]*\))?!?:`, `i`);
export const markSubjectBreaking = (subject: string): string => clipSubject(subject.replace(TYPE_HEAD, `$1$2!:`));

// Fallback sentence naming the shrunk schemas when the model wrote none; weaker than a real warning but true, and still
// reaches Breaking changes and the commit box for editing.
export const fallbackBreakingNote = (removedSurfaces: readonly string[]): string => {
    const names = [...new Set(removedSurfaces.map((surface) => surface.split(`.`)[0]))].join(`, `);
    const sentence = `The wire contract no longer offers what it did under ${names}. Anything reading those surfaces must stop relying on them.`;
    // Same clip as any written note, so many schema names still end on a whole one.
    return clipNote(sentence);
};
