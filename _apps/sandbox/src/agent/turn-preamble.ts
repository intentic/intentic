import type { RepoSync } from "../agents/sync.js";
import { SETUP_NOTICE_HEADER } from "../workspace/workspace-setup.js";
import { DELEGATION_NOTE_HEADER } from "./delegation.js";
import { TURN_CONTEXT_NOTE_HEADER } from "./turn-context.js";

// Turn preambles: notes the daemon prepends to a user message before it reaches the model — the delegation
// how-to (when stableSystemPrompt keeps it out of the system prompt), the dependency-readiness notice (which
// must ride the user message because it changes the moment an install finishes, while the system prefix stays
// byte-stable for the prompt cache), the workspace context retrieved for this very message (same reason), and
// the literal-slash note below. They are protocol, not something the
// user said — but the SDK transcript stores the combined prompt verbatim, so a reopened tab would redraw them
// as the user's own words: the "Dependencies are NOT installed" text stapled onto their message after every
// refresh or sandbox rebuild. Builder and stripper live together so restore recognizes exactly what a turn
// injected — including in transcripts written before this module existed, which used the same shape.

const SEPARATOR = "\n\n---\n\n";

/* The note a `/`-leading prompt earns when the name is no command this session has (agent-commands.ts owns
 * that call). Its job is positional before it is semantic: with anything ahead of it the user's text no longer
 * opens the message, so the CLI's slash parser never claims it and the words reach the model instead of being
 * answered with "Unknown command" and dropped. It says something true and useful while it is there — the model
 * would otherwise have to guess whether `/workspace` names a command, a route, or a path. */
export const LITERAL_SLASH_NOTE_HEADER = "## Reading the message below";

export const LITERAL_SLASH_NOTE =
    `${LITERAL_SLASH_NOTE_HEADER}\n\n` +
    "It opens with `/` but names no slash command available here — the leading token is the user's own words " +
    "(a route, a path, a filename). Read the whole message as ordinary prose.";

/* WHERE A CWD-ISOLATED RUNTIME'S TREE IS, told in words because there is no seam to enforce it.
 *
 * An isolated conversation on the Claude Code loop has its worktree bind-mounted over /work, so every absolute
 * path the agent inherited from a memory, an AGENTS.md or its own earlier turn already names its own space
 * (agents/isolation.ts) — and when the container can't build that namespace, the tool-input rewrite keeps the
 * same guarantee one layer up (agents/worktree-redirect.ts). Neither layer reaches the runtimes that declare
 * `isolation: "cwd"`: Codex drives an SDK with no spawn seam to enter, and an ACP agent talks to a pooled
 * connection that outlives the turn. They are cwd'd into their worktree and nothing else, so an absolute
 * /work path lands in the SHARED checkout — which is exactly how three agents once spent a morning writing
 * into main while their worktrees stayed empty.
 *
 * A note is second-best to a mechanism and says so in its own text; it is what these runtimes can be given
 * today. It names both trees, because "don't touch /work" without "your tree is HERE" just costs a retry. */
export const WORKTREE_NOTE_HEADER = "## Where this turn's files live";

export const worktreeNote = (worktree: string, root: string): string =>
    `${WORKTREE_NOTE_HEADER}\n\n` +
    `This conversation works on its own git branch, checked out at \`${worktree}\` — and this runtime reaches ` +
    `it by working directory alone, so \`${root}\` is still the SHARED checkout every other agent is editing. ` +
    `Use relative paths, or absolute paths under \`${worktree}\`. An absolute \`${root}/…\` path (from a memory, ` +
    `an AGENTS.md, or an earlier turn) writes outside your branch, where the work is neither reviewed nor landed.`;

/* WHAT MOVED UNDERNEATH THIS BRANCH while the conversation was waiting (agents/sync.ts took the rebase; this
 * is how the agent hears about it).
 *
 * Three things earn their place and nothing else does. The ground MOVED, so a file the agent remembers from
 * three turns ago is not the file on disk. The rebase applied by TEXT, which is not the same as still working —
 * main renaming something the branch calls merges perfectly and compiles into nothing. And a rebase that was
 * rolled back leaves the branch on a stale base, so the land at the end of this turn will refuse: saying so
 * up front is the difference between an agent that expects it and one that treats it as its own bug.
 *
 * The OVERLAP is the note's point. "main moved 200 files" is noise a model will dutifully go and read; the two
 * of them this agent had also edited are the re-check instruction, and they are named.
 *
 * TWO MOMENTS, one note. `start` is the pre-turn rebase, where the agent is reading a tree it last saw turns
 * ago and its memory of it is already suspect. `parked` is the rebase taken while the turn sat on a question
 * or a plan approval, and there the staleness is SHARPER, not milder: the reads are minutes old and the model
 * is holding line numbers and hunk context it is about to edit against. Same three facts, addressed to an
 * agent that has to be told its fresh knowledge just went stale. */
export const SYNC_NOTE_HEADER = "## Your branch moved onto newer main";

// How many overlapping paths are worth naming before the list stops being read. The rest survive as a count —
// the agent has git, and a number is enough to make it look.
const NAMED_PATHS = 10;

const repoPaths = (repos: readonly RepoSync[], of: (repo: RepoSync) => readonly string[]): string[] =>
    repos.flatMap((repo) => of(repo).map((path) => (repo.repo === "root" ? path : `${repo.repo}/${path}`)));

export const syncNote = (repos: readonly RepoSync[], when: "start" | "parked"): string | undefined => {
    if (repos.length === 0) {
        return undefined;
    }
    const moved = repos.filter((repo) => repo.blocked !== true);
    const blocked = repos.filter((repo) => repo.blocked === true);
    const overlap = repoPaths(moved, (repo) => repo.overlap);
    const rest = repoPaths(moved, (repo) => repo.moved).length - overlap.length;
    const commits = moved.reduce((total, repo) => total + repo.commits, 0);
    const lines = [SYNC_NOTE_HEADER, ""];
    if (moved.length > 0) {
        lines.push(
            (when === "start"
                ? `The user's main line moved while this conversation was idle, so your branch was rebased onto it before this turn — `
                : `The user's main line moved while you were waiting for their answer, so your branch was just rebased onto it — `) +
                `${commits} commit${commits === 1 ? "" : "s"} now sit underneath your work.`,
        );
        if (overlap.length > 0) {
            lines.push(
                "",
                "Your own changes to these were replayed on top of someone else's, so re-read them before you build on them:",
                ...overlap.slice(0, NAMED_PATHS).map((path) => `  - ${path}`),
                ...(overlap.length > NAMED_PATHS ? [`  …and ${overlap.length - NAMED_PATHS} more`] : []),
            );
        }
        lines.push(
            "",
            `It applied cleanly line by line, which does not mean the result still builds${rest > 0 ? ` (${rest} other file${rest === 1 ? "" : "s"} moved too)` : ""}. ` +
                (when === "start"
                    ? `Check before you trust what you remember about this tree.`
                    : `Anything you read before you asked is now a stale read: line numbers have shifted and an edit anchored to them ` +
                      `will be REJECTED rather than applied. Re-read what you are about to touch.`),
        );
    }
    if (blocked.length > 0) {
        lines.push(
            "",
            `The rebase would NOT apply in ${blocked.map((repo) => repo.repo).join(", ")} and was rolled back — that branch is still on its old base, ` +
                `${blocked.reduce((total, repo) => total + repo.commits, 0)} commits behind. Expect the land at the end of this turn to refuse those paths ` +
                `and ask for a resolve; that is the state you inherited, not something you did.`,
        );
    }
    return lines.join("\n");
};

// Every note this module knows how to put in front of a user message — the builder's flatten check and the
// stripper's anchor read the same list, which is what keeps the two from drifting.
const INJECTED = [
    DELEGATION_NOTE_HEADER,
    SETUP_NOTICE_HEADER,
    TURN_CONTEXT_NOTE_HEADER,
    LITERAL_SLASH_NOTE_HEADER,
    WORKTREE_NOTE_HEADER,
    SYNC_NOTE_HEADER,
];

/* Notes in front of the user's message, separated from it exactly ONCE however many passes add to them.
 *
 * The preamble is built in two layers: honoured() adds what is true of every runtime, and the harness arm then
 * adds its own around that (turn-plan.ts). Nesting a second separator would break the invariant the stripper is
 * written against — it anchors on the FIRST one, so the inner layer would come back out of a restore as the
 * user's own words, which is the exact failure this module exists to prevent. Merging into the preamble already
 * there instead leaves one separator in every message, whoever wrote it. */
export const withTurnPreamble = (notes: readonly string[], prompt: string): string => {
    if (notes.length === 0) {
        return prompt;
    }
    const joined = notes.join("\n\n");
    return INJECTED.some((header) => prompt.startsWith(header)) ? `${joined}\n\n${prompt}` : `${joined}${SEPARATOR}${prompt}`;
};

// The restore-side inverse. Anchored, not fuzzy: only a message that STARTS with a known injected note is
// touched, and only up to the FIRST separator — a user who typed `---` themselves keeps their text intact.
export const stripTurnPreamble = (text: string): string => {
    if (!INJECTED.some((header) => text.startsWith(header))) {
        return text;
    }
    const separator = text.indexOf(SEPARATOR);
    return separator === -1 ? text : text.slice(separator + SEPARATOR.length);
};
