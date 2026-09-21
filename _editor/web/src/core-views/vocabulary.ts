import { computed, type ComputedRef } from "vue";
import { type Audience, useAudience } from "../app/useAudience";
import { t } from "@intentic/ui/i18n";

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
    // The other half of a refused land: the press for a clash only the user can clear, and the sentence under it.
    readonly clearYours: string;
    readonly clearYoursHint: string;
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
    // The workspace sidebar's second mode, and the noun its badge counts with, either side of the number
    // ("3 unsaved changes"). Two rows rather than one, since English needs the singular spelled separately.
    readonly changes: string;
    readonly pendingChange: string;
    readonly pendingChanges: string;
    // The file tree's own tile, and the home tile's: the same tile for a developer, two for a maker.
    readonly workspace: string;
    readonly home: string;
    readonly preview: string;
    readonly memoryChip: string;
    readonly memoryTooltip: string;
    readonly referenceChip: string;
    readonly publicChip: string;
    readonly publicTooltip: string;
}

const developer = (): Vocabulary => ({
    repo: t(`views.vocabulary.repository`),
    repos: t(`views.vocabulary.repositories`),
    agent: t(`views.vocabulary.agent2`),
    Agent: t(`views.vocabulary.agent`),
    branch: t(`views.vocabulary.branch`),
    land: t(`views.vocabulary.landNow`),
    landing: t(`views.vocabulary.landing`),
    landAgain: t(`views.vocabulary.landAgain`),
    landRequested: t(`views.vocabulary.landRequested`),
    requestLand: t(`views.vocabulary.requestLand`),
    requestLandHint: t(`views.vocabulary.landingNeedsMaintainerPuts`),
    landWhileWorking: t(`views.vocabulary.landWhileAgentWorking`),
    landWhileWorkingBody: t(`views.vocabulary.agentStillWritingLanding`),
    landAnyway: t(`views.vocabulary.landAnyway`),
    discard: t(`views.vocabulary.discard`),
    discardHeader: t(`views.vocabulary.discardAgentsWork`),
    discardBodyLead: t(`views.vocabulary.deleteAgentsBranchWorktree`),
    discardBodyTail: t(`views.vocabulary.conversationsIsolatedHistoryGo`),
    review: t(`views.vocabulary.review`),
    resolveConflict: t(`views.vocabulary.agentResolve`),
    resolveConflictHint: t(`views.vocabulary.mergesInOwnWorktree`),
    clearYours: t(`views.vocabulary.commitStashYours`),
    clearYoursHint: t(`views.vocabulary.ownUncommittedEditsOn`),
    restorePoints: t(`views.vocabulary.restorePoints`),
    restorePointsHint: t(`views.vocabulary.restorePointsAutomaticFile`),
    restoreEmpty: t(`views.vocabulary.noRestorePointsYet`),
    agentTurn: t(`views.vocabulary.agentTurn`),
    restore: t(`views.vocabulary.restore`),
    restoreConfirm: t(`views.vocabulary.rewriteAllFilesTo`),
    restoreHint: t(`views.vocabulary.filesOnlySecretsBranches`),
    push: t(`views.vocabulary.push`),
    publish: t(`views.vocabulary.publish`),
    sync: t(`views.vocabulary.sync`),
    diff: t(`views.vocabulary.diff`),
    changes: t(`views.vocabulary.changes`),
    pendingChange: t(`views.vocabulary.uncommittedChange`),
    pendingChanges: t(`views.vocabulary.uncommittedChanges`),
    workspace: t(`views.vocabulary.workspace`),
    home: t(`views.vocabulary.workspace`),
    preview: t(`views.vocabulary.preview`),
    memoryChip: t(`views.vocabulary.memory`),
    memoryTooltip: t(`views.vocabulary.standingInstructionsReadInto`),
    referenceChip: t(`views.vocabulary.reference`),
    publicChip: t(`views.vocabulary.public`),
    publicTooltip: t(`views.vocabulary.servedOnOpenInternet`),
});

const maker = (): Vocabulary => ({
    repo: t(`views.vocabulary.project`),
    repos: t(`views.vocabulary.projects2`),
    agent: t(`views.vocabulary.assistant2`),
    Agent: t(`views.vocabulary.assistant`),
    branch: t(`views.vocabulary.draft`),
    land: t(`views.vocabulary.accept`),
    landing: t(`views.vocabulary.accepting`),
    landAgain: t(`views.vocabulary.acceptAgain`),
    landRequested: t(`views.vocabulary.askedToAccept`),
    requestLand: t(`views.vocabulary.askToAccept`),
    requestLandHint: t(`views.vocabulary.acceptingNeedsMaintainerPuts`),
    landWhileWorking: t(`views.vocabulary.acceptWhileAssistantStill`),
    landWhileWorkingBody: t(`views.vocabulary.assistantStillWritingAccepting`),
    landAnyway: t(`views.vocabulary.acceptAnyway`),
    discard: t(`views.vocabulary.throwAway`),
    discardHeader: t(`views.vocabulary.throwAwayDraft`),
    discardBodyLead: t(`views.vocabulary.throwAwayAssistantsDraft`),
    discardBodyTail: t(`views.vocabulary.go`),
    review: t(`views.vocabulary.look`),
    resolveConflict: t(`views.vocabulary.askAssistantToRedo`),
    resolveConflictHint: t(`views.vocabulary.triesAgainOnOwn`),
    clearYours: t(`views.vocabulary.setOwnChangesAside`),
    clearYoursHint: t(`views.vocabulary.changesOwnOnFiles`),
    restorePoints: t(`views.vocabulary.versions`),
    restorePointsHint: t(`views.vocabulary.versionsEveryChangeWay`),
    restoreEmpty: t(`views.vocabulary.noVersionsYetOne`),
    agentTurn: t(`views.vocabulary.assistantsChanges`),
    restore: t(`views.vocabulary.goBackTo`),
    restoreConfirm: t(`views.vocabulary.putEveryFileBack`),
    restoreHint: t(`views.vocabulary.filesOnlyVersionHow`),
    push: t(`views.vocabulary.backUp`),
    publish: t(`views.vocabulary.backUp`),
    sync: t(`views.vocabulary.backUp`),
    diff: t(`views.vocabulary.whatChanged`),
    changes: t(`views.vocabulary.whatChanged`),
    pendingChange: t(`views.vocabulary.unsavedChange`),
    pendingChanges: t(`views.vocabulary.unsavedChanges`),
    workspace: t(`views.vocabulary.files`),
    home: t(`views.vocabulary.projects`),
    preview: t(`views.vocabulary.see`),
    memoryChip: t(`views.vocabulary.instructions`),
    memoryTooltip: t(`views.vocabulary.standingInstructionsAssistantRead`),
    referenceChip: t(`views.vocabulary.referenceMaterial`),
    publicChip: t(`views.vocabulary.shared`),
    publicTooltip: t(`views.vocabulary.anyoneLinkOpenWhat`),
});

const byAudience = (): Record<Audience, Vocabulary> => ({ developer: developer(), maker: maker() });

export const vocabularyFor = (audience: Audience): Vocabulary => byAudience()[audience];

const words: ComputedRef<Vocabulary> = computed(() => vocabularyFor(useAudience().audience.value));

// The active audience's column, reactive: a surface reads `words.value.land` and repaints when the answer changes.
export const useVocabulary = (): ComputedRef<Vocabulary> => words;
