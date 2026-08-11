import { type ResumeDisclosure, resumeDisclosure, type TurnNote, withoutResumeNote } from "@intentic/sandbox-contract";
import type { RepoSync } from "../agents/sync.js";
import { REPO_SYNC_NOTE_HEADER } from "../workspace/sync-repos.js";
import { SETUP_NOTICE_HEADER, STALE_NOTICE_HEADER } from "../workspace/workspace-setup.js";
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
//
// The third reader is the CHAT, and it is the one this module was missing for most of its life. Stripping a
// note out of the user's words is only half the job: the other half is showing it somewhere, because a note
// that changes what the agent does and appears nowhere is an instruction the user is watching be followed
// without being allowed to read it. preambleNotes below is that half — the same anchored split the stripper
// makes, kept instead of discarded — and INJECTED carries a title per note so the chat has a row to draw.

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
 * `isolation: "cwd"`: the Codex app-server adapter does not consume the namespace plan, and an ACP agent talks
 * to a pooled connection that outlives the turn. They are cwd'd into their worktree and nothing else, so an absolute
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

/* Every note this module knows how to put in front of a user message — the builder's flatten check, the
 * stripper's anchor and the chat's disclosure all read this one list, which is what keeps the three from
 * drifting. A note missing from it is invisible three ways at once: it flattens wrong, it survives restore as
 * the user's own words, and the chat never mentions it.
 *
 * The TITLE is the row the reader clicks. It says what the note is about in their terms, not the daemon's — the
 * text behind it is addressed to a model and reads like it. */
const INJECTED: readonly { readonly header: string; readonly title: string }[] = [
    { header: DELEGATION_NOTE_HEADER, title: "Delegating to other coding agents" },
    { header: SETUP_NOTICE_HEADER, title: "Dependencies aren't installed yet" },
    // The dependency notice has TWO openings, and only one of them was ever listed here. A workspace whose
    // projects are installed-but-behind emits the stale half alone, which begins with neither the header above
    // nor anything else this list knew — so the anchor never matched, nothing was stripped, and the notice came
    // back out of every restore as the user's own words. It is the shape this repo's own sandbox produces.
    { header: STALE_NOTICE_HEADER, title: "Dependencies are behind" },
    { header: TURN_CONTEXT_NOTE_HEADER, title: "Workspace context found for this message" },
    { header: LITERAL_SLASH_NOTE_HEADER, title: "How to read this message" },
    { header: WORKTREE_NOTE_HEADER, title: "Where this turn's files live" },
    { header: SYNC_NOTE_HEADER, title: "Your workspace moved on underneath this agent" },
    { header: REPO_SYNC_NOTE_HEADER, title: "Repos synced with their remotes" },
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
    return INJECTED.some(({ header }) => prompt.startsWith(header)) ? `${joined}\n\n${prompt}` : `${joined}${SEPARATOR}${prompt}`;
};

/* WHERE THE NOTES END AND THE USER'S WORDS BEGIN — one answer, read by the two functions below.
 *
 * Anchored, not fuzzy: only a message that STARTS with a known injected note has a preamble at all, and it runs
 * only up to the FIRST separator, so a user who typed `---` themselves keeps their text intact. A message with a
 * known opening and no separator is the one case where the boundary cannot be located — it is left whole rather
 * than cut at a guess, which means the strip is a no-op and the chat discloses nothing rather than something
 * wrong. */
const preambleEnd = (text: string): number | undefined => {
    if (!INJECTED.some(({ header }) => text.startsWith(header))) {
        return undefined;
    }
    const separator = text.indexOf(SEPARATOR);
    return separator === -1 ? undefined : separator;
};

// The restore-side inverse of the builder: the user's own words, with the daemon's notes taken back off.
export const stripTurnPreamble = (text: string): string => {
    const end = preambleEnd(text);
    return end === undefined ? text : text.slice(end + SEPARATOR.length);
};

/* ONE BLOCK OF NOTES, TITLED — the rows the chat draws for text the daemon wrote and the user did not.
 *
 * Split on the note openings themselves, which is the only marker there is: the builder joins notes with a blank
 * line and nothing else, so a note is the run of text from its own header to the next one. Positions are found
 * rather than assumed, because the assembly order is the caller's (turn-plan.ts layers two passes of it) and a
 * list in a fixed order would mis-title every note the day someone reorders them.
 *
 * A header only counts where it OPENS A LINE. Two of these notes are prose rather than `##` headings, and a
 * model-facing paragraph is free to mention "some dependencies declared under /work are not installed" mid
 * sentence — matching that would cut a note in half and title the remainder as a note of its own. */
export const splitTurnNotes = (preamble: string): TurnNote[] => {
    const marks = INJECTED.flatMap(({ header, title }) => {
        const at = preamble.indexOf(header);
        return at === -1 || (at > 0 && preamble[at - 1] !== "\n") ? [] : [{ at, title }];
    }).toSorted((left, right) => left.at - right.at);
    return marks.map(({ at, title }, index) => ({ title, text: preamble.slice(at, marks[index + 1]?.at).trim() }));
};

// The same cut stripTurnPreamble makes, KEPT: what a built prompt put in front of the user's words, for the
// chat to disclose. The pair is the whole point — one side takes the notes out of the message, the other side
// shows them, and neither can quietly become the only one that runs.
export const preambleNotes = (text: string): TurnNote[] => {
    const end = preambleEnd(text);
    return end === undefined ? [] : splitTurnNotes(text.slice(0, end));
};

/* WHAT A STORED PROMPT ACTUALLY SAID — the user's words with every layer the daemon wrapped them in taken back
 * off, and each layer handed over instead of dropped.
 *
 * There are two layers and they nest in EITHER ORDER, which is the whole reason this is one function rather
 * than two calls at each of the three call sites. A turn the daemon re-ran carries its interruption note around
 * the prompt it re-sends (events.ts), and the preamble is then built around THAT — so the daemon's own record,
 * which stores the turn's prompt, has the note outermost, while a provider's session store keeps the prompt as
 * it was SENT and has the preamble outermost. A reader that assumes one order silently hands the other layer
 * back as the user's own words, which is the exact failure both strippers exist to prevent. */
export interface StoredPrompt {
    // The user's words alone. Their attachment note (a Claude-path trailer) is the caller's to strip.
    readonly text: string;
    // The notes the daemon put in front of them, titled for the row the chat draws.
    readonly notes: readonly TurnNote[];
    // How the interruption that re-ran this turn should read, when it was one — see resumeDisclosure.
    readonly resume?: ResumeDisclosure;
}

export const unwrapStoredPrompt = (stored: string): StoredPrompt => {
    // The note OUTSIDE the preamble: peel it first, or the preamble below it never finds its own anchor.
    const outer = resumeDisclosure(stored);
    const body = outer === undefined ? stored : withoutResumeNote(stored);
    const notes = preambleNotes(body);
    const inner = stripTurnPreamble(body);
    // …or INSIDE it, which is what is left once the preamble is off. A no-op for either half that wasn't there.
    const resume = outer ?? resumeDisclosure(inner);
    return { text: withoutResumeNote(inner), notes, ...(resume !== undefined ? { resume } : {}) };
};
