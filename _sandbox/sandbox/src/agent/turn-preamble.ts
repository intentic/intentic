import { type ResumeDisclosure, resumeDisclosure, type TurnNote, withoutResumeNote } from "@intentic/sandbox-contract";
import { REPO_SYNC_NOTE_HEADER } from "../workspace/sync-repos.js";
import { SETUP_NOTICE_HEADER, STALE_NOTICE_HEADER } from "../workspace/workspace-setup.js";
import { PERSONA_NOTE_HEADER } from "../personas/personas.js";
import { SPAWN_NOTE_HEADER } from "../children/spawn-note.js";
import { TURN_ENDING_NOTE_HEADER, TURN_ENDING_NOTE_TITLE } from "../rules/turn-ending-note.js";
import { IQ_SEARCH_INSTRUCTION_HEADER } from "./iq-search-instruction.js";
import { TURN_CONTEXT_NOTE_HEADER } from "./turn-context.js";
import { WORKSPACE_MAP_NOTE_HEADER } from "./workspace-map.js";
import { SKILL_CATALOG_NOTE_HEADER, SKILL_CATALOG_NOTE_TITLE } from "../settings/loaded-skills.js";

// Turn preambles: notes the daemon prepends to a user message before it reaches the model, the spawn
// how-to for shell-only runtimes, the dependency-readiness notice (which
// must ride the user message because it changes the moment an install finishes, while the system prefix stays
// byte-stable for the prompt cache), and the literal-slash note below. They are protocol, not something the
// user said, and the TYPED form (TurnNote, title + text) is the canonical one: each note is built as a
// TurnNote at its own definition site, rides the request as data (AgentRequest.notes), feeds the `preamble`
// frame and the transcript record as data, and is serialized into the wire prompt exactly once, by
// composeWirePrompt at the point the request leaves for its adapter.
//
// The PARSER half below (preambleNotes, stripTurnPreamble, unwrapStoredPrompt) exists for the one store the
// daemon does not write: a provider's own session file keeps the composed wire prompt verbatim, so the
// history menu, adoption, and search that read THAT store must take the notes back off the user's words or a
// reopened tab redraws "Dependencies are NOT installed" as something the user typed. That is a boundary
// parser over a foreign format, not a second representation: nothing daemon-side round-trips through it.

const SEPARATOR = "\n\n---\n\n";

/* The note a `/`-leading prompt earns when the name is no command this session has (agent-commands.ts owns
 * that call). Its job is positional before it is semantic: with anything ahead of it the user's text no longer
 * opens the message, so the CLI's slash parser never claims it and the words reach the model instead of being
 * answered with "Unknown command" and dropped. It says something true and useful while it is there, the model
 * would otherwise have to guess whether `/workspace` names a command, a route, or a path. */
const LITERAL_SLASH_NOTE_HEADER = "## Reading the message below";

export const LITERAL_SLASH_NOTE: TurnNote = {
    title: "How to read this message",
    text:
        `${LITERAL_SLASH_NOTE_HEADER}\n\n` +
        "It opens with `/` but names no slash command available here: the leading token is the user's own words " +
        "(a route, a path, a filename). Read the whole message as ordinary prose.",
};

/* WHERE A CWD-ISOLATED RUNTIME'S TREE IS, told in words because there is no seam to enforce it.
 *
 * An isolated conversation on the Claude Code loop has its worktree bind-mounted over /work, so every absolute
 * path the agent inherited from a memory, an AGENTS.md or its own earlier turn already names its own space
 * (agents/isolation.ts), and when the container can't build that namespace, the tool-input rewrite keeps the
 * same guarantee one layer up (agents/worktree-redirect.ts). Neither layer reaches the runtimes that declare
 * `isolation: "cwd"`: the Codex app-server adapter does not consume the namespace plan, and an ACP agent talks
 * to a pooled connection that outlives the turn. They are cwd'd into their worktree and nothing else, so an absolute
 * /work path lands in the SHARED checkout, which is exactly how three agents once spent a morning writing
 * into main while their worktrees stayed empty.
 *
 * A note is second-best to a mechanism and says so in its own text; it is what these runtimes can be given
 * today. The provider session gets the full explanation ONCE, naming both trees because "don't touch /work"
 * without "your tree is HERE" just costs a retry. Follow-up turns get only the invariant the model can forget
 * after compaction. Repeating the full paragraph made one safety fact consume context in proportion to the
 * conversation's length. */
const WORKTREE_NOTE_HEADER = "## Where this turn's files live";
const WORKTREE_NOTE_TITLE = "Where this turn's files live";

export const worktreeNote = (worktree: string, root: string): TurnNote => ({
    title: WORKTREE_NOTE_TITLE,
    text:
        `${WORKTREE_NOTE_HEADER}\n\n` +
        `This conversation works on its own git branch, checked out at \`${worktree}\`, and this runtime reaches ` +
        `it by working directory alone, so \`${root}\` is still the SHARED checkout every other agent is editing. ` +
        `Use relative paths, or absolute paths under \`${worktree}\`. An absolute \`${root}/…\` path (from a memory, ` +
        `an AGENTS.md, or an earlier turn) writes outside your branch, where the work is neither reviewed nor landed.`,
});

export const worktreeReminder = (root: string): TurnNote => ({
    title: WORKTREE_NOTE_TITLE,
    text: `${WORKTREE_NOTE_HEADER}\n\nUse relative paths. \`${root}\` is the shared checkout, not this branch.`,
});

/* THE REBASE IS NOT NEWS THE MODEL NEEDS, which is why there is no note here and this comment stands where one
 * used to.
 *
 * agents/sync.ts rebases a conversation's branch onto today's main line before the turn reads a line of it, and
 * for most of this module's life that came with a note telling the agent what had moved. The note was read
 * exactly as it was written, as a task. It said the rebase "does not mean the result still builds", and turn
 * after turn the model went and PROVED it: a full typecheck and test sweep, a paragraph reporting everything
 * green, and a turn's worth of tokens spent before the user's actual question was touched. Across the sessions
 * that produced it, a clean rebase never once turned out to have broken anything.
 *
 * So the rebase is silent to the model now. What it cost to say was certain and what it bought was not.
 *
 * The two audiences that remain are unchanged. The HUMAN still sees it: the `worktree` frame carries the commit
 * count and any repo that would not move, at the point in the transcript where it happened. And a rebase that
 * would not apply is still caught where it always was, the land at the end of the turn refuses and raises the
 * conflict errand (agents/land.ts, web conflictResolution.ts), which is a mechanism rather than a sentence a
 * model has to be trusted to act on. */

/* THE PARSER'S VOCABULARY: every note opening that can appear in a PROVIDER-STORE prompt, with the title the
 * chat draws when one is read back from there. The typed path does not consult this list, a TurnNote carries
 * its own title from its definition site, so a new note is visible everywhere by construction; add its header
 * here only so the provider-store readers (history menu, adoption, search) can recognize it too.
 *
 * The TITLE is the row the reader clicks. It says what the note is about in their terms, not the daemon's, the
 * text behind it is addressed to a model and reads like it. Titles here must match the ones at the definition
 * sites, so a note reads the same whether it arrived typed or was parsed back off a provider's store. */
const INJECTED: readonly { readonly header: string; readonly title: string }[] = [
    { header: SPAWN_NOTE_HEADER, title: "Spawning helper agents" },
    // The persona note reaches the user message only where the runtime has no system prompt to hold it (Pi,
    // ACP). It is listed here for the same three reasons every other note is, and for a fourth: it is the one
    // note that says what the turn may NOT touch, so a reader who cannot see it cannot tell a refusal from a
    // fault.
    { header: PERSONA_NOTE_HEADER, title: "Who this turn is acting as" },
    { header: SETUP_NOTICE_HEADER, title: "Dependencies aren't installed yet" },
    // The dependency notice has TWO openings, and only one of them was ever listed here. A workspace whose
    // projects are installed-but-behind emits the stale half alone, which begins with neither the header above
    // nor anything else this list knew, so the anchor never matched, nothing was stripped, and the notice came
    // back out of every restore as the user's own words. It is the shape this repo's own sandbox produces.
    { header: STALE_NOTICE_HEADER, title: "Dependencies are behind" },
    { header: IQ_SEARCH_INSTRUCTION_HEADER, title: "Using iq for workspace search" },
    // Computed off the filesystem when the conversation opened, so the reader can check what the agent was told
    // the project looks like against what it actually looks like, the one disclosure a generated map needs.
    { header: WORKSPACE_MAP_NOTE_HEADER, title: "Map of this project" },
    { header: SKILL_CATALOG_NOTE_HEADER, title: SKILL_CATALOG_NOTE_TITLE },
    { header: TURN_CONTEXT_NOTE_HEADER, title: "Workspace context found for this message" },
    { header: LITERAL_SLASH_NOTE_HEADER, title: "How to read this message" },
    { header: WORKTREE_NOTE_HEADER, title: "Where this turn's files live" },
    { header: REPO_SYNC_NOTE_HEADER, title: "Repos synced with their remotes" },
    // Keep the parser's title aligned with the typed note.
    { header: TURN_ENDING_NOTE_HEADER, title: TURN_ENDING_NOTE_TITLE },
];

/* Notes in front of the user's message, separated from it exactly ONCE however many passes add to them.
 *
 * The string core of the serializer below, kept for the parser's own tests (they build fixtures from raw
 * texts). Merging rather than nesting is what leaves one separator in every message, whoever wrote it: the
 * parser anchors on the FIRST separator, so a nested second one would come back out of a provider-store read
 * as the user's own words. */
export const withTurnPreamble = (notes: readonly string[], prompt: string): string => {
    if (notes.length === 0) {
        return prompt;
    }
    const joined = notes.join("\n\n");
    return INJECTED.some(({ header }) => prompt.startsWith(header)) ? `${joined}\n\n${prompt}` : `${joined}${SEPARATOR}${prompt}`;
};

/* THE ONE SERIALIZER from the typed notes to the wire prompt, at the single point a request leaves for its
 * adapter (agent.routes.ts, right before dispatch). Everything upstream of that point carries TurnNote[]:
 * turn-plan assembles them, the `preamble` frame is emitted from them, and the transcript record folds them
 * off the frame log, so none of those ever parses this string back apart. The composed form exists in exactly
 * two places, the provider wire and the provider's own session store, and the parser half below reads it back
 * out of THAT store and no other. */
export const composeWirePrompt = (notes: readonly TurnNote[], prompt: string): string =>
    withTurnPreamble(
        notes.map((note) => note.text),
        prompt,
    );

/* WHERE THE NOTES END AND THE USER'S WORDS BEGIN, one answer, read by the two functions below.
 *
 * Anchored, not fuzzy: only a message that STARTS with a known injected note has a preamble at all, and it runs
 * only up to the FIRST separator, so a user who typed `---` themselves keeps their text intact. A message with a
 * known opening and no separator is the one case where the boundary cannot be located, it is left whole rather
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

/* ONE BLOCK OF NOTES, TITLED, the rows the chat draws for text the daemon wrote and the user did not.
 *
 * Split on the note openings themselves, which is the only marker there is: the builder joins notes with a blank
 * line and nothing else, so a note is the run of text from its own header to the next one. Positions are found
 * rather than assumed, because the assembly order is the caller's (turn-plan.ts layers two passes of it) and a
 * list in a fixed order would mis-title every note the day someone reorders them.
 *
 * A header only counts where it OPENS A LINE. Two of these notes are prose rather than `##` headings, and a
 * model-facing paragraph is free to mention "some dependencies declared under /work are not installed" mid
 * sentence, matching that would cut a note in half and title the remainder as a note of its own.
 *
 * Internal: every preamble there is now arrives attached to a user message, so preambleNotes below is the only
 * way in. The mid-turn rebase used to hand a bare note straight here; it no longer says anything at all. */
const splitTurnNotes = (preamble: string): TurnNote[] => {
    const marks = INJECTED.flatMap(({ header, title }) => {
        const at = preamble.indexOf(header);
        return at === -1 || (at > 0 && preamble[at - 1] !== "\n") ? [] : [{ at, title }];
    }).toSorted((left, right) => left.at - right.at);
    return marks.map(({ at, title }, index) => ({ title, text: preamble.slice(at, marks[index + 1]?.at).trim() }));
};

// The same cut stripTurnPreamble makes, KEPT: what a built prompt put in front of the user's words, for the
// chat to disclose. The pair is the whole point, one side takes the notes out of the message, the other side
// shows them, and neither can quietly become the only one that runs.
export const preambleNotes = (text: string): TurnNote[] => {
    const end = preambleEnd(text);
    return end === undefined ? [] : splitTurnNotes(text.slice(0, end));
};

/* WHAT A STORED PROMPT ACTUALLY SAID, the user's words with every layer the daemon wrapped them in taken back
 * off, and each layer handed over instead of dropped.
 *
 * There are two layers and they nest in EITHER ORDER, which is the whole reason this is one function rather
 * than two calls at each of the three call sites. A turn the daemon re-ran carries its interruption note around
 * the prompt it re-sends (events.ts), and the preamble is then built around THAT, so the daemon's own record,
 * which stores the turn's prompt, has the note outermost, while a provider's session store keeps the prompt as
 * it was SENT and has the preamble outermost. A reader that assumes one order silently hands the other layer
 * back as the user's own words, which is the exact failure both strippers exist to prevent. */
export interface StoredPrompt {
    // The user's words alone. Their attachment note (a Claude-path trailer) is the caller's to strip.
    readonly text: string;
    // The notes the daemon put in front of them, titled for the row the chat draws.
    readonly notes: readonly TurnNote[];
    // How the interruption that re-ran this turn should read, when it was one, see resumeDisclosure.
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
