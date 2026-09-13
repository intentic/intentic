// What the sandbox puts in front of a user's message before the model reads it — the rows the chat shows under "Sent
// with your message" — and which of them a persona card may drop. The vocabulary lives here rather than in the daemon
// because the card editor has to name the same rows the transcript does, and two lists would drift into two
// vocabularies for one thing.
import { z } from "zod";

// Ids, not titles, are what a card stores: a title is display text and gets reworded, and a reworded title must not
// silently switch a note back on. The daemon maps each id to the titles it covers (agent/prompt/turn-briefing.ts).
export const TurnBriefingNoteIdSchema = z.enum(["map", "context", "skills", "search", "delegation", "checks", "dependencies", "repoSync", "handoff"]);
export type TurnBriefingNoteId = z.infer<typeof TurnBriefingNoteIdSchema>;

export interface TurnBriefingNote {
    readonly id: TurnBriefingNoteId;
    // Verbatim the row's own title in the chat's "Sent with your message" fold, so a card turns off the line its reader
    // actually saw. A daemon-side test holds the two in step.
    readonly label: string;
    // When it rides at all. Most are once per conversation, and one whose condition never comes up costs nothing
    // whether it is switched on or off.
    readonly when: string;
    // What the turn loses without it, as the consequence rather than the feature — the only thing that makes this a
    // decision rather than a guess.
    readonly cost: string;
}

// Ordered as a turn meets them: where it is, what it holds, what it can reach, what happens at the end, then the two
// that report on state rather than teach.
export const TURN_BRIEFING_NOTES: readonly TurnBriefingNote[] = [
    {
        id: "map",
        label: "Map of this project",
        when: "First message of a conversation, when the sandbox's own map setting is on.",
        cost: "The agent finds the layout by listing directories instead, which costs tool calls on the first task.",
    },
    {
        id: "context",
        label: "Context of this session",
        when: "First message, and again after a compaction, for a card that carries only some repositories.",
        cost: "A repository this card leaves out of the checkout reads as deleted rather than absent, so the agent may try to restore it.",
    },
    {
        id: "skills",
        label: "Skills available in this workspace",
        when: "First message, on a runtime that cannot read the skills folder for itself.",
        cost: "On those runtimes the agent never learns its skills exist, so it will not load one.",
    },
    {
        id: "search",
        label: "Using iq for workspace search",
        when: "First message, when the workspace search setting is on and the runtime has no plugin seam.",
        cost: "The agent falls back to grep-style searching, which it can already do.",
    },
    {
        id: "delegation",
        label: "Spawning child agents",
        when: "First message, on a shell-only runtime, for a card that may delegate.",
        cost: "The agent does the work itself rather than handing parts of it to other conversations.",
    },
    {
        id: "checks",
        label: "Automatic end-of-turn checks",
        when: "First message, and again after a compaction, when you have rules that run at the end of a turn.",
        cost: "Your checks still run; the agent just does not know they are coming, so a failure arrives as a surprise it has to re-read the turn to understand.",
    },
    {
        id: "dependencies",
        label: "Dependencies aren't installed yet",
        when: 'Any turn where a project under the workspace has dependencies missing, or behind what it pins — the second reads "Dependencies are behind" and this covers both.',
        cost: "An unresolved import reads as broken code, and the agent may edit working source to satisfy it.",
    },
    {
        id: "repoSync",
        label: "Repos synced with their remotes",
        when: "A turn on the shared tree where a repository actually moved.",
        cost: "Files changed under the agent between turns with nothing saying so.",
    },
    {
        id: "handoff",
        label: "Where the work stands",
        when: "A turn that starts a fresh session on an existing conversation: a runtime change, or a context limit.",
        cost: "The largest of these. Without it a re-seeded session has the transcript but none of the sandbox's own readings of the tree, the proof and the checklist, so it re-derives them.",
    },
];

export interface TurnBriefingFixture {
    readonly label: string;
    // Why it cannot be switched off, in the one line the card editor shows beside it.
    readonly why: string;
}

// Deliberately not switchable, and listed so the checklist above reads as complete rather than arbitrary. Each of these
// either keeps a turn from writing outside its own branch or explains why something the agent expected is missing —
// saving a few hundred tokens is never worth either.
export const TURN_BRIEFING_FIXTURES: readonly TurnBriefingFixture[] = [
    { label: "Where this turn's files live", why: "Without it a runtime that is only cwd'd into its branch writes into the shared checkout." },
    { label: "Who this turn is acting as", why: "The card's own identity, on the runtimes that have nowhere else to put it." },
    { label: "Standing instructions for this workspace", why: "Your own AGENTS.md rules. Replace them by giving this card its own system prompt." },
    {
        label: "Some connected accounts need a person's approval",
        why: "Names who to ask; without it a withheld account reads as simply not connected.",
    },
    { label: "This turn reaches no signed-in account", why: "The other reason an account can be missing, which nothing else says out loud." },
    { label: "How to read this message", why: "Keeps a message that opens with a slash from being eaten by the runtime's own command parser." },
];
