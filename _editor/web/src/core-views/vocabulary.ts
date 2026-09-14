import { computed, type ComputedRef } from "vue";
import { type Audience, useAudience } from "../app/useAudience";

// The words the shell says for git's mechanisms, one column per audience, read by every surface that says one of them.
// A row is the whole label rather than a substitution, so "Land while the agent is working?" and "Accept while the
// assistant is still working?" sit side by side instead of a template guessing at grammar. A word is in the table when a
// maker would have to ask what it means; a word both columns spell the same way is not.

export interface Vocabulary {
    readonly repo: string;
    readonly repos: string;
    readonly agent: string;
    readonly Agent: string;
    readonly branch: string;
    readonly land: string;
    readonly landing: string;
    readonly landAgain: string;
    readonly landRequested: string;
    readonly requestLand: string;
    readonly requestLandHint: string;
    readonly landWhileWorking: string;
    readonly landWhileWorkingBody: string;
    readonly landAnyway: string;
    readonly discard: string;
    readonly discardHeader: string;
    // The question before the count ("Its 3 changed files"), and the clause after it.
    readonly discardBodyLead: string;
    readonly discardBodyTail: string;
    readonly review: string;
    // The conflict card's one costless press, and the sentence under it.
    readonly resolveConflict: string;
    readonly resolveConflictHint: string;
    readonly restorePoints: string;
    readonly restorePointsHint: string;
    readonly restoreEmpty: string;
    readonly agentTurn: string;
    readonly restore: string;
    readonly restoreConfirm: string;
    readonly restoreHint: string;
    readonly push: string;
    readonly publish: string;
    readonly sync: string;
    readonly diff: string;
    // The file tree's own tile, and the home seat's: the same tile for a developer, two for a maker.
    readonly workspace: string;
    readonly home: string;
    readonly preview: string;
    readonly memoryChip: string;
    readonly memoryTooltip: string;
    readonly referenceChip: string;
    readonly publicChip: string;
    readonly publicTooltip: string;
}

const DEVELOPER: Vocabulary = {
    repo: `repository`,
    repos: `repositories`,
    agent: `agent`,
    Agent: `Agent`,
    branch: `branch`,
    land: `Land now`,
    landing: `Landing…`,
    landAgain: `Land again`,
    landRequested: `Land requested`,
    requestLand: `Request land`,
    requestLandHint: `Landing needs a maintainer: this puts the ask on their board`,
    landWhileWorking: `Land while the agent is working?`,
    landWhileWorkingBody: `The agent is still writing. Landing now takes its work exactly as it stands, which can mean half-finished changes: one side of a rename, a call to a function that does not exist yet.`,
    landAnyway: `Land anyway`,
    discard: `Discard`,
    discardHeader: `Discard this agent's work`,
    discardBodyLead: `Delete the agent's branch and worktree?`,
    discardBodyTail: `and the conversation's isolated history go with them.`,
    review: `Review`,
    resolveConflict: `Have the agent resolve it`,
    resolveConflictHint: `It merges in its own worktree: nothing reaches your workspace unless it succeeds.`,
    restorePoints: `Restore points`,
    restorePointsHint: `Restore points: automatic file history`,
    restoreEmpty: `No restore points yet: file history is saved automatically as you and your agents work.`,
    agentTurn: `Agent turn`,
    restore: `Restore`,
    restoreConfirm: `Rewrite all files to this restore point? Files created after it are removed; git branches and secrets are untouched. Open chats working here are told the files moved.`,
    restoreHint: `Files only: secrets and branches untouched. A safety restore point is saved first, and open chats are told.`,
    push: `Push`,
    publish: `Publish`,
    sync: `Sync`,
    diff: `Diff`,
    workspace: `Workspace`,
    home: `Workspace`,
    preview: `Preview`,
    memoryChip: `memory`,
    memoryTooltip: `Standing instructions, read into every turn that starts in this folder or deeper, whichever model runs it.`,
    referenceChip: `reference`,
    publicChip: `public`,
    publicTooltip: `Served on the open internet, to anyone with the link, with no sign-in.`,
};

const MAKER: Vocabulary = {
    repo: `project`,
    repos: `projects`,
    agent: `assistant`,
    Agent: `Assistant`,
    branch: `draft`,
    land: `Accept`,
    landing: `Accepting…`,
    landAgain: `Accept again`,
    landRequested: `Asked to accept`,
    requestLand: `Ask to accept`,
    requestLandHint: `Accepting needs a maintainer: this puts the ask on their board`,
    landWhileWorking: `Accept while the assistant is still working?`,
    landWhileWorkingBody: `The assistant is still writing. Accepting now takes its draft exactly as it stands, which can mean a half-finished change.`,
    landAnyway: `Accept anyway`,
    discard: `Throw away`,
    discardHeader: `Throw away this draft`,
    discardBodyLead: `Throw away the assistant's draft?`,
    discardBodyTail: `go with it.`,
    review: `Look`,
    resolveConflict: `Ask the assistant to redo it`,
    resolveConflictHint: `It tries again on its own copy: nothing in your project changes unless it succeeds.`,
    restorePoints: `Versions`,
    restorePointsHint: `Versions: every change, and a way back`,
    restoreEmpty: `No versions yet: one is saved automatically every time you or your assistant change something.`,
    agentTurn: `Assistant's changes`,
    restore: `Go back to this`,
    restoreConfirm: `Put every file back the way it was at this version? Anything made after it goes away; nothing else changes. Open chats working here are told the files moved.`,
    restoreHint: `Files only. A version of how things are now is saved first, and open chats are told.`,
    push: `Back up`,
    publish: `Back up`,
    sync: `Back up`,
    diff: `What changed`,
    workspace: `Files`,
    home: `Projects`,
    preview: `See it`,
    memoryChip: `instructions`,
    memoryTooltip: `Standing instructions for your assistant, read into every conversation that starts in this folder or deeper.`,
    referenceChip: `reference material`,
    publicChip: `shared`,
    publicTooltip: `Anyone with the link can open what is in here, with no sign-in.`,
};

const BY_AUDIENCE: Record<Audience, Vocabulary> = { developer: DEVELOPER, maker: MAKER };

export const vocabularyFor = (audience: Audience): Vocabulary => BY_AUDIENCE[audience];

const words: ComputedRef<Vocabulary> = computed(() => vocabularyFor(useAudience().audience.value));

// The active audience's column, reactive: a surface reads `words.value.land` and repaints when the answer changes.
export const useVocabulary = (): ComputedRef<Vocabulary> => words;
