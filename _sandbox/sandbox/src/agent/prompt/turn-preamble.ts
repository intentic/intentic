import { TURN_PREAMBLE_SEPARATOR } from "@intentic/constants";
import { RESUME_NOTES, type ResumeDisclosure, resumeDisclosure, type TurnNote, withoutResumeNote } from "@intentic/sandbox-contract";
import { REPO_SYNC_NOTE_HEADER } from "../../workspace/layout/sync-repos.js";
import { SETUP_NOTICE_HEADER, STALE_NOTICE_HEADER } from "../../workspace/layout/workspace-setup.js";
import { PERSONA_NOTE_HEADER } from "../../personas/personas.js";
import { LEGACY_SPAWN_NOTE_HEADER, LEGACY_SPAWN_NOTE_TITLE, SPAWN_NOTE_HEADER, SPAWN_NOTE_TITLE } from "../subagents/spawn-note.js";
import {
    LANDING_CHECKS_NOTE_HEADER,
    LANDING_CHECKS_NOTE_TITLE,
    LEGACY_TURN_ENDING_NOTE_HEADER,
    LEGACY_TURN_ENDING_NOTE_TITLE,
} from "./checks-note.js";
import { IQ_SEARCH_INSTRUCTION_HEADER } from "./iq-search-instruction.js";
import { TURN_CONTEXT_NOTE_HEADER, TURN_CONTEXT_NOTE_TITLE } from "../run/turn/turn-context.js";
import { WORKSPACE_MAP_NOTE_HEADER } from "@intentic/agent-context/workspace-map";
import { MEMORY_NOTE_HEADER, MEMORY_NOTE_TITLE } from "./workspace-memory.js";
import { SKILL_CATALOG_NOTE_HEADER, SKILL_CATALOG_NOTE_TITLE } from "../../store/loaded-skills.js";
import { CONTEXT_NOTE_HEADER, CONTEXT_NOTE_TITLE } from "../context/context-note.js";
import { basename } from "node:path";
import { parseRuntimeHistory, RUNTIME_HISTORY_HEADER, type RuntimeHistoryMessage } from "../providers/runtime-history.js";
import { opt } from "../../opt.js";
import { ATTACHMENT_NOTE_HEADER, stripAttachmentNote } from "./attachment-note.js";

// TurnNote is canonical and becomes wire text once, in composeWirePrompt; the parser half reads a stored prompt back.

// Shared with session recall, which cuts the same preamble off transcripts it indexes.
const SEPARATOR = TURN_PREAMBLE_SEPARATOR;

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
export const WORKTREE_NOTE_TITLE = "Where this turn's files live";

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

// A fenced conversation's sandbox (conversations/worktrees/turn-sandbox.ts) holds only its areas and no git history.
// Said once per session, because an agent that meets `git` failing or a folder missing spends calls looking for a way
// round both; same header as the note above, which is what this is about and what session recall already cuts at.
export const fencedNote = (root: string): TurnNote => ({
    title: WORKTREE_NOTE_TITLE,
    text:
        `${WORKTREE_NOTE_HEADER}\n\n` +
        `This conversation is limited to some areas of the workspace, and it runs in a sandbox holding only those: ` +
        `\`${root}\` is its own checkout cut to them, and nothing else of the workspace is on this filesystem. The ` +
        `checkout has no git history, so \`git\` finds no repository here: the sandbox records your changes on the ` +
        `conversation's branch by itself, so edit the files and leave committing to it. A folder that is absent is ` +
        `outside this conversation's areas; say so rather than looking for it elsewhere.`,
});

export const fencedReminder = (root: string): TurnNote => ({
    title: WORKTREE_NOTE_TITLE,
    text: `${WORKTREE_NOTE_HEADER}\n\n\`${root}\` holds only this conversation's areas, and it has no git; your changes are recorded for you.`,
});

// Deliberately no note: the model reliably over-reacted to being told about a routine rebase, re-verifying builds
// unprompted. The human still sees it in the `worktree` frame; a rebase that doesn't apply is caught at land time
// (conversations/land.ts) instead of by prose.

// Every note opening a PROVIDER-STORE prompt can carry, with the title shown when read back there; the typed path
// doesn't consult this, so add an entry here only so history/search/adoption can recognize a new note too. Titles must
// match the ones at each note's own definition site. Exported for the drift test against session recall's recogniser.
export const INJECTED: readonly { readonly header: string; readonly title: string }[] = [
    { header: SPAWN_NOTE_HEADER, title: SPAWN_NOTE_TITLE },
    // Retitled once a spawned agent became a subagent like any other; the prompts records hold still open with it.
    { header: LEGACY_SPAWN_NOTE_HEADER, title: LEGACY_SPAWN_NOTE_TITLE },
    // Reaches the user message only on a runtime with no system prompt (Pi, ACP); the one note whose absence would hide
    // WHY a turn refused to touch something.
    { header: PERSONA_NOTE_HEADER, title: "Who this turn is acting as" },
    // The same two runtimes: the owner's standing instructions have no system seam to ride there.
    { header: MEMORY_NOTE_HEADER, title: MEMORY_NOTE_TITLE },
    { header: SETUP_NOTICE_HEADER, title: "Dependencies aren't installed yet" },
    // Separate opening: a stale-only notice can appear alone, without SETUP_NOTICE_HEADER ahead of it.
    { header: STALE_NOTICE_HEADER, title: "Dependencies are behind" },
    { header: IQ_SEARCH_INSTRUCTION_HEADER, title: "Using iq for workspace search" },
    // Computed off the filesystem at open, so a reader can check the map against how the project looks now.
    { header: WORKSPACE_MAP_NOTE_HEADER, title: "Map of this project" },
    // Which repos the conversation's tree holds and lacks; without it a missing directory looks deleted.
    { header: CONTEXT_NOTE_HEADER, title: CONTEXT_NOTE_TITLE },
    { header: SKILL_CATALOG_NOTE_HEADER, title: SKILL_CATALOG_NOTE_TITLE },
    { header: TURN_CONTEXT_NOTE_HEADER, title: TURN_CONTEXT_NOTE_TITLE },
    { header: LITERAL_SLASH_NOTE_HEADER, title: "How to read this message" },
    { header: WORKTREE_NOTE_HEADER, title: "Where this turn's files live" },
    { header: REPO_SYNC_NOTE_HEADER, title: "Repos synced with their remotes" },
    // Keep the parser's title aligned with the typed note.
    { header: LANDING_CHECKS_NOTE_HEADER, title: LANDING_CHECKS_NOTE_TITLE },
    // Never sent any more; still parsed out of the prompts records already hold, so they read as notes, not as typing.
    { header: LEGACY_TURN_ENDING_NOTE_HEADER, title: LEGACY_TURN_ENDING_NOTE_TITLE },
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

// What a stored prompt says under every layer the daemon wraps round it; the transcript, history list and search all read it.
export interface PromptEnvelope {
    // The user's own words, every layer taken off.
    readonly spoken: string;
    // The words as their turn was queued: the preamble, attachment note and handoff off, a re-run note still on.
    readonly queued: string;
    // The paths a trailing attachment note named, as sent.
    readonly attachments: readonly string[];
    // The notes the daemon put in front of the words, titled for the row the chat draws.
    readonly notes: readonly TurnNote[];
    // How the interruption that re-ran this turn reads, when its note sat outside a runtime handoff.
    readonly resume?: ResumeDisclosure;
    // A runtime handoff's folded-in transcript (runtime-history.ts), and how a re-run note inside its prompt reads.
    readonly handoff?: { readonly history: readonly RuntimeHistoryMessage[]; readonly resume?: ResumeDisclosure };
}

// The re-run note a text opens with, the blank line after it included; empty when it opens with none.
const rerunNoteOf = (text: string): string => text.slice(0, text.length - withoutResumeNote(text).length);

// A prompt as its turn was queued, which never carries the preamble: a re-run note, the words, an attachment note, a handoff.
export const parseQueuedPrompt = (queued: string): PromptEnvelope => {
    const note = rerunNoteOf(queued);
    const { text, attachments } = stripAttachmentNote(queued.slice(note.length));
    const runtime = parseRuntimeHistory(text);
    return {
        spoken: runtime === undefined ? text : withoutResumeNote(runtime.prompt),
        queued: runtime === undefined ? `${note}${text}` : runtime.prompt,
        attachments,
        notes: [],
        ...opt("resume", resumeDisclosure(queued)),
        ...(runtime === undefined ? {} : { handoff: { history: runtime.history, ...opt("resume", resumeDisclosure(runtime.prompt)) } }),
    };
};

// A stored prompt is a queued one behind the preamble, its re-run note outside it (the daemon's record) or inside (a provider's).
export const parsePromptEnvelope = (stored: string): PromptEnvelope => {
    const outer = rerunNoteOf(stored);
    const body = stored.slice(outer.length);
    const inner = parseQueuedPrompt(stripTurnPreamble(body));
    return {
        ...inner,
        queued: inner.handoff === undefined ? `${outer}${inner.queued}` : inner.queued,
        notes: preambleNotes(body),
        ...opt("resume", resumeDisclosure(stored) ?? inner.resume),
    };
};

// As long as the Claude SDK's own list lets a first prompt run, so a title from the daemon's side reads like one from its.
const TITLE_LENGTH = 200;

// What names a conversation opened by this stored prompt: the user's own words on one line, every layer the daemon
// wraps round them taken off. A handoff titles by the conversation's opening words, else by its prompt as queued; an
// attachment-only opener by what was dropped in. Undefined when the prompt says nothing at all.
export const storedPromptTitle = (stored: string): string | undefined => {
    const { spoken, queued, attachments, handoff } = parsePromptEnvelope(stored);
    const words = handoff === undefined ? spoken : (handoff.history.find((message) => message.role === "user")?.text ?? queued);
    const title = words.replaceAll(/\s+/g, " ").trim() || attachments.map((path) => basename(path)).join(", ");
    return title === "" ? undefined : title.length > TITLE_LENGTH ? `${title.slice(0, TITLE_LENGTH).trim()}…` : title;
};

// The Claude SDK's session list hands a first prompt over flattened: every newline a space, trimmed, and cut at 200
// characters. The separator survives that as spaces round `---`, and a trailing attachment note as a run of text after
// two spaces, when the cut left either in at all.
const FLAT_SEPARATOR = SEPARATOR.replaceAll("\n", " ");
const FLAT_ATTACHMENT_NOTE = `  ${ATTACHMENT_NOTE_HEADER} `;

// What only the stored message, newlines intact, can still be read through (storedPromptTitle): a runtime handoff's
// carried transcript, a re-run note, an attachment note standing alone.
const LAYERED_OPENINGS = [RUNTIME_HISTORY_HEADER, ATTACHMENT_NOTE_HEADER, ...Object.values(RESUME_NOTES)];

// The user's words in a first prompt as that list hands it over. The notes in front come off when the cut left their
// separator in; undefined when it did not, or when what is left opens with another of the daemon's layers.
export const flatSpokenWords = (flat: string): string | undefined => {
    const noted = INJECTED.some(({ header }) => flat.startsWith(header));
    const at = noted ? flat.indexOf(FLAT_SEPARATOR) : 0;
    if (at === -1) {
        return undefined;
    }
    const words = noted ? flat.slice(at + FLAT_SEPARATOR.length) : flat;
    if (LAYERED_OPENINGS.some((opening) => words.startsWith(opening))) {
        return undefined;
    }
    const note = words.indexOf(FLAT_ATTACHMENT_NOTE);
    return (note === -1 ? words : words.slice(0, note)).trim() || undefined;
};
