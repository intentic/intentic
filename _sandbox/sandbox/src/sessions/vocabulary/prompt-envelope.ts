import { basename } from "node:path";
import { TURN_PREAMBLE_SEPARATOR } from "@intentic/constants";
import { RESUME_NOTES, type ResumeDisclosure, resumeDisclosure, withoutResumeNote } from "@intentic/sandbox-contract/events/resume";
import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import { WORKSPACE_MAP_NOTE_HEADER } from "@intentic/agent-context/workspace-map";
import { REPO_SYNC_NOTE_HEADER } from "../../workspace/layout/sync-repos.js";
import { SETUP_NOTICE_HEADER, STALE_NOTICE_HEADER } from "../../workspace/layout/workspace-setup.js";
import { PERSONA_NOTE_HEADER } from "../../personas/personas.js";
import { SKILL_CATALOG_NOTE_HEADER, SKILL_CATALOG_NOTE_TITLE } from "../../store/loaded-skills.js";
import { opt } from "../../opt.js";
import { parseRuntimeHistory, RUNTIME_HISTORY_HEADER, type RuntimeHistoryMessage } from "./runtime-history.js";
import { ATTACHMENT_NOTE_HEADER, stripAttachmentNote } from "./attachment-note.js";

// What a stored prompt carries round the user's words, read back: the notes the turn engine puts in front
// (agent/prompt/turn-preamble.ts builds them), a re-run note, an attachment note and a runtime handoff.

// Shared with session recall, which cuts the same preamble off transcripts it indexes.
const SEPARATOR = TURN_PREAMBLE_SEPARATOR;

// The openings of the engine's own notes, here so the reader below knows them without importing the engine.
export const SPAWN_NOTE_HEADER = "## Spawning subagents";
// Chat-row title; kept in sync with SPAWN_NOTE_HEADER.
export const SPAWN_NOTE_TITLE = "Spawning subagents";
// What the note opened with before a spawned agent was called a subagent like every other; still read out of the
// prompts records already hold.
export const LEGACY_SPAWN_NOTE_HEADER = "## Spawning child agents";
const LEGACY_SPAWN_NOTE_TITLE = "Spawning child agents";
export const LANDING_CHECKS_NOTE_TITLE = "Checks after landing";
export const LANDING_CHECKS_NOTE_HEADER = "## Checks after landing";
// The note the checks note replaced, still parsed out of prompts records hold, never sent.
const LEGACY_TURN_ENDING_NOTE_TITLE = "Automatic end-of-turn checks";
const LEGACY_TURN_ENDING_NOTE_HEADER = "## Automatic end-of-turn checks";
export const IQ_SEARCH_INSTRUCTION_HEADER = "## iq workspace search";
export const TURN_CONTEXT_NOTE_TITLE = "Workspace context found for this message";
export const TURN_CONTEXT_NOTE_HEADER = "## Retrieved workspace context";
export const MEMORY_NOTE_TITLE = "Standing instructions for this workspace";
export const MEMORY_NOTE_HEADER = `## ${MEMORY_NOTE_TITLE}`;
export const CONTEXT_NOTE_HEADER = "## Context of this session";
export const CONTEXT_NOTE_TITLE = "Context of this session";
export const FRESH_NOTE_TITLE = "The work this session started from";
export const FRESH_NOTE_HEADER = `## ${FRESH_NOTE_TITLE}`;
export const CHECKPOINT_NOTE_HEADER = "## Your uncommitted work was committed";
export const CHECKPOINT_NOTE_TITLE = "Uncommitted work committed";
// Given when a `/`-leading prompt names no command (agent-commands.ts); its job is positional, so the CLI's slash
// parser doesn't claim the message and drop it.
export const LITERAL_SLASH_NOTE_HEADER = "## Reading the message below";
export const WORKTREE_NOTE_HEADER = "## Where this turn's files live";

// Every note opening a PROVIDER-STORE prompt can carry, with the title shown when read back there; the typed path
// doesn't consult this, so add an entry here only so history/search/adoption can recognize a new note too. Titles must
// match the ones at each note's own definition site. Exported for the drift test against session recall's recogniser.
export const INJECTED: readonly { readonly header: string; readonly title: string }[] = [
    { header: SPAWN_NOTE_HEADER, title: SPAWN_NOTE_TITLE },
    // Retitled once a spawned agent became a subagent like any other; the prompts records hold still open with it.
    { header: LEGACY_SPAWN_NOTE_HEADER, title: LEGACY_SPAWN_NOTE_TITLE },
    // Reaches the user message only on a runtime with no system prompt (ACP); the one note whose absence would hide
    // WHY a turn refused to touch something.
    { header: PERSONA_NOTE_HEADER, title: "Who this turn is acting as" },
    // The same runtime: the owner's standing instructions have no system seam to ride there.
    { header: MEMORY_NOTE_HEADER, title: MEMORY_NOTE_TITLE },
    { header: SETUP_NOTICE_HEADER, title: "Dependencies aren't installed yet" },
    // Separate opening: a stale-only notice can appear alone, without SETUP_NOTICE_HEADER ahead of it.
    { header: STALE_NOTICE_HEADER, title: "Dependencies are behind" },
    { header: IQ_SEARCH_INSTRUCTION_HEADER, title: "Using iq for workspace search" },
    // Computed off the filesystem at open, so a reader can check the map against how the project looks now.
    { header: WORKSPACE_MAP_NOTE_HEADER, title: "Map of this project" },
    // Which repos the conversation's tree holds and lacks; without it a missing directory looks deleted.
    { header: CONTEXT_NOTE_HEADER, title: CONTEXT_NOTE_TITLE },
    // A fresh session's origin and the exact ranges its work is (agent/context/fresh-session.ts).
    { header: FRESH_NOTE_HEADER, title: FRESH_NOTE_TITLE },
    { header: SKILL_CATALOG_NOTE_HEADER, title: SKILL_CATALOG_NOTE_TITLE },
    { header: TURN_CONTEXT_NOTE_HEADER, title: TURN_CONTEXT_NOTE_TITLE },
    { header: LITERAL_SLASH_NOTE_HEADER, title: "How to read this message" },
    { header: WORKTREE_NOTE_HEADER, title: "Where this turn's files live" },
    { header: REPO_SYNC_NOTE_HEADER, title: "Repos synced with their remotes" },
    // Says where a checkpoint commit put the agent's uncommitted work, so a clean `git status` doesn't read as lost work.
    { header: CHECKPOINT_NOTE_HEADER, title: CHECKPOINT_NOTE_TITLE },
    // Keep the parser's title aligned with the typed note.
    { header: LANDING_CHECKS_NOTE_HEADER, title: LANDING_CHECKS_NOTE_TITLE },
    // Never sent any more; still parsed out of the prompts records already hold, so they read as notes, not as typing.
    { header: LEGACY_TURN_ENDING_NOTE_HEADER, title: LEGACY_TURN_ENDING_NOTE_TITLE },
];

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
export const stripTurnPreamble = (text: string): string => splitTurnPreamble(text).words;

// The same cut, both halves kept: the notes as one block (empty when there are none) and the user's words after the
// separator. For a runtime that must send the words on their own, a slash command which only parses at the very start.
export const splitTurnPreamble = (text: string): { readonly notes: string; readonly words: string } => {
    const end = preambleEnd(text);
    return end === undefined ? { notes: "", words: text } : { notes: text.slice(0, end), words: text.slice(end + SEPARATOR.length) };
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
        ...opt("handoff", runtime === undefined ? undefined : { history: runtime.history, ...opt("resume", resumeDisclosure(runtime.prompt)) }),
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
    // Cut the way the SDK's own session list cuts a prompt (its length, then the ellipsis past it), not with oneLine:
    // a title read from either side must read alike.
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
