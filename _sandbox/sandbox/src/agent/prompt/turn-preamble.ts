import { type ResumeDisclosure, resumeDisclosure, type TurnNote, withoutResumeNote } from "@intentic/sandbox-contract";
import { REPO_SYNC_NOTE_HEADER } from "../../workspace/layout/sync-repos.js";
import { SETUP_NOTICE_HEADER, STALE_NOTICE_HEADER } from "../../workspace/layout/workspace-setup.js";
import { PERSONA_NOTE_HEADER } from "../../personas/personas.js";
import { SPAWN_NOTE_HEADER } from "../subagents/spawn-note.js";
import { TURN_ENDING_NOTE_HEADER, TURN_ENDING_NOTE_TITLE } from "../../rules/turn-ending-note.js";
import { IQ_SEARCH_INSTRUCTION_HEADER } from "./iq-search-instruction.js";
import { TURN_CONTEXT_NOTE_HEADER } from "../run/turn/turn-context.js";
import { WORKSPACE_MAP_NOTE_HEADER } from "./workspace-map.js";
import { SKILL_CATALOG_NOTE_HEADER, SKILL_CATALOG_NOTE_TITLE } from "../../settings/loaded-skills.js";
import { CONTEXT_NOTE_HEADER, CONTEXT_NOTE_TITLE } from "../context/context-note.js";

// Notes the daemon prepends to a user message before it reaches the model; TurnNote is canonical, serialized into the
// wire prompt once by composeWirePrompt. The parser half (preambleNotes, stripTurnPreamble, unwrapStoredPrompt) exists
// only to read notes back off a provider's own session store, which keeps the composed wire prompt verbatim.

const SEPARATOR = "\n\n---\n\n";

// Given when a `/`-leading prompt names no command (agent-commands.ts); its job is positional, so the CLI's slash
// parser doesn't claim the message and drop it.
const LITERAL_SLASH_NOTE_HEADER = "## Reading the message below";

export const LITERAL_SLASH_NOTE: TurnNote = {
    title: "How to read this message",
    text:
        `${LITERAL_SLASH_NOTE_HEADER}\n\n` +
        "It opens with `/` but names no slash command available here: the leading token is the user's own words " +
        "(a route, a path, a filename). Read the whole message as ordinary prose.",
};

// For runtimes with no isolation mechanism (Codex app-server, ACP: only cwd'd into their worktree), an absolute /work
// path lands in the SHARED checkout — this note is the only guard. Said in full once per session; later turns get only
// the short reminder.
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

// Deliberately no note: the model reliably over-reacted to being told about a routine rebase, re-verifying builds
// unprompted. The human still sees it in the `worktree` frame; a rebase that doesn't apply is caught at land time
// (agents/land.ts) instead of by prose.

// Every note opening a PROVIDER-STORE prompt can carry, with the title shown when read back there; the typed path
// doesn't consult this, so add an entry here only so history/search/adoption can recognize a new note too. Titles must
// match the ones at each note's own definition site.
const INJECTED: readonly { readonly header: string; readonly title: string }[] = [
    { header: SPAWN_NOTE_HEADER, title: "Spawning child agents" },
    // Reaches the user message only on a runtime with no system prompt (Pi, ACP); the one note whose absence would hide
    // WHY a turn refused to touch something.
    { header: PERSONA_NOTE_HEADER, title: "Who this turn is acting as" },
    { header: SETUP_NOTICE_HEADER, title: "Dependencies aren't installed yet" },
    // Separate opening: a stale-only notice can appear alone, without SETUP_NOTICE_HEADER ahead of it.
    { header: STALE_NOTICE_HEADER, title: "Dependencies are behind" },
    { header: IQ_SEARCH_INSTRUCTION_HEADER, title: "Using iq for workspace search" },
    // Computed off the filesystem at open, so a reader can check the map against how the project looks now.
    { header: WORKSPACE_MAP_NOTE_HEADER, title: "Map of this project" },
    // Which repos the conversation's tree holds and lacks; without it a missing directory looks deleted.
    { header: CONTEXT_NOTE_HEADER, title: CONTEXT_NOTE_TITLE },
    { header: SKILL_CATALOG_NOTE_HEADER, title: SKILL_CATALOG_NOTE_TITLE },
    { header: TURN_CONTEXT_NOTE_HEADER, title: "Workspace context found for this message" },
    { header: LITERAL_SLASH_NOTE_HEADER, title: "How to read this message" },
    { header: WORKTREE_NOTE_HEADER, title: "Where this turn's files live" },
    { header: REPO_SYNC_NOTE_HEADER, title: "Repos synced with their remotes" },
    // Keep the parser's title aligned with the typed note.
    { header: TURN_ENDING_NOTE_HEADER, title: TURN_ENDING_NOTE_TITLE },
];

// Notes go in front of the message, separated exactly once no matter how many passes add to them: merging, not nesting,
// since the parser anchors on the FIRST separator and a nested second one would leak through as the user's own words.
export const withTurnPreamble = (notes: readonly string[], prompt: string): string => {
    if (notes.length === 0) {
        return prompt;
    }
    const joined = notes.join("\n\n");
    return INJECTED.some(({ header }) => prompt.startsWith(header)) ? `${joined}\n\n${prompt}` : `${joined}${SEPARATOR}${prompt}`;
};

// The one place TurnNote[] becomes the wire string, right before a request leaves for its adapter (agent.routes.ts);
// everything upstream carries typed notes. The composed form exists only on the wire and in the provider's own session
// store.
export const composeWirePrompt = (notes: readonly TurnNote[], prompt: string): string =>
    withTurnPreamble(
        notes.map((note) => note.text),
        prompt,
    );

// Only a message starting with a known injected header has a preamble, ending at the FIRST separator; a known opening
// with no separator is left whole rather than cut at a guess.
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

// Splits on the note openings themselves — the only marker there is, found rather than assumed since assembly order is
// the caller's. A header only counts at the start of a line, so a note mentioning another's wording mid-sentence isn't
// mistaken for one.
const splitTurnNotes = (preamble: string): TurnNote[] => {
    const marks = INJECTED.flatMap(({ header, title }) => {
        const at = preamble.indexOf(header);
        return at === -1 || (at > 0 && preamble[at - 1] !== "\n") ? [] : [{ at, title }];
    }).toSorted((left, right) => left.at - right.at);
    return marks.map(({ at, title }, index) => ({ title, text: preamble.slice(at, marks[index + 1]?.at).trim() }));
};

// The same cut stripTurnPreamble makes, kept instead of discarded: what it removes, this discloses. Neither side can
// quietly stop running without breaking the other's guarantee.
export const preambleNotes = (text: string): TurnNote[] => {
    const end = preambleEnd(text);
    return end === undefined ? [] : splitTurnNotes(text.slice(0, end));
};

// Two wrapper layers nest in EITHER order: the daemon's own record has the re-run note outermost, a provider's session
// store has the preamble outermost. Assuming one order leaks the other layer back as the user's own words.
export interface StoredPrompt {
    // The user's words alone. Their attachment note (a Claude-path trailer) is the caller's to strip.
    readonly text: string;
    // The notes the daemon put in front of them, titled for the row the chat draws.
    readonly notes: readonly TurnNote[];
    // How the interruption that re-ran this turn should read, if it was one (resumeDisclosure).
    readonly resume?: ResumeDisclosure;
}

export const unwrapStoredPrompt = (stored: string): StoredPrompt => {
    // The note OUTSIDE the preamble: peel it first, or the preamble below it never finds its own anchor.
    const outer = resumeDisclosure(stored);
    const body = outer === undefined ? stored : withoutResumeNote(stored);
    const notes = preambleNotes(body);
    const inner = stripTurnPreamble(body);
    // Or inside it, once the preamble is stripped off; a no-op for either half that wasn't there.
    const resume = outer ?? resumeDisclosure(inner);
    return { text: withoutResumeNote(inner), notes, ...(resume !== undefined ? { resume } : {}) };
};
