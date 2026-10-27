import { subagentTranscriptFor } from "../../fixture/subagentTranscripts";
import { homeSandboxOf } from "../../fixture/home/sandboxes";
import { documentsFor } from "../../fixture/transcripts";
import { copyAgentIgnored, fileDiff } from "../../fixture/workspace";
import {
    archiveAgents,
    archivedAgents,
    assignAgent,
    discardAgent,
    keepWarmAgent,
    land,
    purgeArchive,
    reactToAgent,
    requestLand,
    searchAgents,
    setBreakPolicy,
    settleAgent,
    stopJob,
    stopWatching,
    unarchiveAgents,
} from "./cards";
import { conflictsOf, deleteScratch, historyOf, includeScratch, reviewOf } from "./review";
import { clearHomeHistory, editedTranscript, placeLine, startFreshHome, toolChildren } from "./transcriptEdits";
import { draftDoors } from "./drafts";
import { agentAnswer, amendAgent, boardAgents, heldApprovals, homeDoors, patchAgent, roster } from "./roster";
import { DEMO_SYSTEM_PROMPT } from "../account/settings";
import { type Doors, okAfter } from "../doors";

export const agentsDoors = {
    // `held` mirrors /automations/pending's approval queue, projected onto the board.
    list: (_input, call) => ({ agents: boardAgents(homeSandboxOf(call.url)), rev: roster.rev, held: heldApprovals() }),
    archived: () => ({ agents: archivedAgents(), rev: roster.rev, held: [] }),
    search: ({ query, caseSensitive }) => searchAgents(query, caseSensitive === true),
    seenAll: () => ({ agents: roster.agents, rev: roster.rev, held: heldApprovals() }),
    // The recorded delta with this page load's presses on it: scratch carried or deleted, settled work absorbed.
    diff: ({ id }) => reviewOf(id),
    conflicts: ({ id }) => conflictsOf(id),
    history: ({ id }) => historyOf(id),
    includeScratch: ({ id, repo, paths }) => okAfter(() => includeScratch(id, repo, paths)),
    deleteScratch: ({ id, repo, paths }) => okAfter(() => deleteScratch(id, repo, paths)),
    copyIgnored: ({ id, repo, paths }) => {
        copyAgentIgnored(id, repo, paths);
        return { ok: true as const };
    },
    // A card that is not mid-turn reads its transcript instead of attaching.
    transcript: ({ id }, call) => editedTranscript(id, homeSandboxOf(call.url)),
    toolChildren: (input, call) => toolChildren(input, homeSandboxOf(call.url)),
    place: (input, call) => placeLine(input, homeSandboxOf(call.url)),
    startFreshHome: (_input, call) => startFreshHome(homeSandboxOf(call.url)),
    clearHomeHistory: (_input, call) => clearHomeHistory(homeSandboxOf(call.url)),
    documents: ({ id }) => ({ paths: documentsFor(id) }),
    // The checkout agent's in-process subagents, read as transcripts of their own from its tray and its cards.
    subagentTranscript: ({ subagentId }) => subagentTranscriptFor(subagentId),
    systemPrompt: () => DEMO_SYSTEM_PROMPT,
    fileDiff: ({ repo, path }) => fileDiff(repo, path),
    rename: ({ id, title }) => agentAnswer(patchAgent(id, { title })),
    seen: ({ id }) => agentAnswer(patchAgent(id, { seenAt: Date.now() })),
    ...draftDoors,
    ...homeDoors,
    // As the daemon does for a client keeping its words to itself: records since when a composer held them.
    unsent: ({ id, at }) => agentAnswer(amendAgent(id, ({ unsentAt: _cleared, ...card }) => (at === null ? card : { ...card, unsentAt: at }))),
    react: reactToAgent,
    assign: assignAgent,
    // As the registry does: `null` clears the conversation's own answer back to the sandbox's.
    autoLand: ({ id, autoLand }) =>
        agentAnswer(amendAgent(id, ({ autoLand: _held, ...card }) => (autoLand === null ? card : { ...card, autoLand }))),
    breakPolicy: setBreakPolicy,
    keepWarm: keepWarmAgent,
    stopJob,
    stopWatching,
    land: ({ id }) => land(id),
    requestLand: ({ id }) => requestLand(id),
    settle: ({ id }) => settleAgent(id),
    discard: ({ id }) => discardAgent(id),
    archive: archiveAgents,
    unarchive: unarchiveAgents,
    purge: purgeArchive,
} satisfies Doors<`agents`>;
