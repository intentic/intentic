import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { AgentSearchResult } from "@intentic/sandbox-contract/schemas/agent-search";
import { isTurnBreakPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import type { SandboxHandlerInput, SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { refuse } from "@intentic/contract-serve";
import { reopen } from "../git/gitIndex";
import { discardReview, refuseWhileRunning, settleReview } from "./review";
import { landAgentDelta, landedPaths, sessions } from "../../fixture/workspace";
import { agentAnswer, broadcastRoster, listeners, OWNER, patchAgent, roster } from "./roster";
import { releaseAfter } from "./queue";

// The card verbs: the mutations the board's menu, the chat's controls and the search field make on one agent's card.

// Moves the agent's delta into the main tree on success (fixture/workspace.ts) and broadcasts
// `workspaceChanged`; on failure, flips the card to conflict with the check's report.
export const land = (id: string): ReturnType<typeof landAgentDelta> => {
    const result = landAgentDelta(id);
    if (!result.landed) {
        patchAgent(id, {
            status: `conflict`,
            updatedAt: Date.now(),
            attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: true },
        });
        return result;
    }
    // A collaborator's ask to land is answered by the land itself, as the registry clears it.
    patchAgent(id, {
        status: `landed`,
        updatedAt: Date.now(),
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
        landRequested: undefined,
    });
    const paths = landedPaths(id);
    reopen(paths);
    for (const listener of listeners) {
        listener({ kind: `workspaceChanged`, paths });
    }
    releaseAfter(id);
    return result;
};

// One answer per ending, as the daemon stores it: `null` clears the override back to the sandbox-wide policy.
// Real, not a stub, so the chat's own control and the card's menu behave here exactly as they do against a daemon.
export const setBreakPolicy = ({ id, ending, policy }: SandboxHandlerInput<`agents`, `breakPolicy`>): AgentSummary => {
    if (policy !== null && !isTurnBreakPolicy(ending, policy)) {
        return agentAnswer(undefined);
    }
    const key = { limit: `limitPolicy`, outage: `outagePolicy`, stopped: `stopPolicy`, memory: `memoryPolicy` }[ending];
    return agentAnswer(patchAgent(id, { [key]: policy ?? undefined }));
};

// Cut where the real daemon cuts a hold, so the demo never promises longer than a cache could honestly be kept.
export const keepWarmAgent = ({ id, until }: SandboxHandlerInput<`agents`, `keepWarm`>): AgentSummary => {
    if (until === null) {
        return agentAnswer(patchAgent(id, { keepWarm: undefined }));
    }
    const now = Date.now();
    const cache = roster.agents.find((agent) => agent.id === id)?.promptCache;
    if (cache?.keepableUntil === undefined || cache.at + cache.ttlMs <= now) {
        return refuse(`The cache is already cold: keeping it warm now would pay the whole re-read up front.`, 409);
    }
    return agentAnswer(patchAgent(id, { keepWarm: { since: now, until: Math.min(until, cache.keepableUntil), refreshes: 0 } }));
};

// The demo's own reader is Ada (the session this daemon mints), so a press here joins or leaves her from the chip,
// exactly as the real one attributes a mark to the verified caller rather than to anything the browser sent.
export const reactToAgent = ({ id, emoji, on }: SandboxHandlerInput<`agents`, `react`>): AgentSummary => {
    const agent = roster.agents.find((candidate) => candidate.id === id);
    if (agent === undefined) {
        return agentAnswer(undefined);
    }
    const me = { email: OWNER.email, ...(OWNER.name === undefined ? {} : { name: OWNER.name }), at: Date.now() };
    // Only the pressed emoji is rewritten: her marks on the other chips are not what this press was about.
    const held = agent.reactions ?? [];
    const opened = on && !held.some((chip) => chip.emoji === emoji) ? [...held, { emoji, by: [] }] : held;
    const marked = opened.map((chip) => {
        if (chip.emoji !== emoji) {
            return chip;
        }
        const without = chip.by.filter((who) => who.email !== OWNER.email);
        return { ...chip, by: on ? [...without, me] : without };
    });
    const reactions = marked.filter((chip) => chip.by.length > 0);
    return agentAnswer(patchAgent(id, reactions.length > 0 ? { reactions } : { reactions: undefined }));
};

// Changes hands as the real route does: a name is known only for the reader's own address; anyone else is an address
// until presence says otherwise.
export const assignAgent = ({ id, to }: SandboxHandlerInput<`agents`, `assign`>): AgentSummary => {
    const address = to.trim().toLowerCase();
    if (address === ``) {
        return refuse(`An address is required.`, 400);
    }
    const name = address === OWNER.email.toLowerCase() ? OWNER.name : undefined;
    return agentAnswer(patchAgent(id, { owner: { email: address, ...(name === undefined ? {} : { name }), since: Date.now() } }));
};

// The conversations put away this page load, newest first: the archive's whole record, as the registry keeps it.
const archived: AgentSummary[] = [];
export const archivedAgents = (): AgentSummary[] => [...archived];

// Refused for a running card, as the daemon refuses to release a copy a turn is writing to: it stays on the board with
// the reason, rather than the press reading as silence.
export const archiveAgents = ({ ids }: SandboxHandlerInput<`agents`, `archive`>): SandboxHandlerOutput<`agents`, `archive`> => {
    const archivedAt = Date.now();
    const moved: AgentSummary[] = [];
    const failed: SandboxHandlerOutput<`agents`, `archive`>[`failed`] = [];
    for (const agent of roster.agents.filter((candidate) => ids.includes(candidate.id))) {
        if (agent.status === `running`) {
            failed.push({ id: agent.id, reason: `A turn is running in it.` });
            continue;
        }
        moved.push({ ...agent, archivedAt });
    }
    const leaving = new Set(moved.map((agent) => agent.id));
    roster.agents = roster.agents.filter((agent) => !leaving.has(agent.id));
    archived.unshift(...moved);
    broadcastRoster();
    // Answers `moved`/`failed`, the daemon's own shape (AgentsArchivedSchema).
    return { moved, failed, rev: roster.rev };
};

// Back on the board without the filing date, the way the registry returns an entry; an id the archive does not hold is
// simply not moved.
export const unarchiveAgents = ({ ids }: SandboxHandlerInput<`agents`, `unarchive`>): SandboxHandlerOutput<`agents`, `unarchive`> => {
    const moved = archived.filter((agent) => ids.includes(agent.id)).map(({ archivedAt: _filed, ...agent }) => ({ ...agent, updatedAt: Date.now() }));
    for (const agent of moved) {
        archived.splice(
            archived.findIndex((held) => held.id === agent.id),
            1,
        );
    }
    roster.agents = [...moved, ...roster.agents];
    broadcastRoster();
    return { moved, rev: roster.rev };
};

// The whole archive, gone for good: copies, branches and entries.
export const purgeArchive = (): SandboxHandlerOutput<`agents`, `purge`> => {
    const removed = archived.splice(0).map((agent) => agent.id);
    for (const id of removed) {
        discardReview(id);
    }
    return { removed };
};

// Deletes the conversation's copies, branches and entry, wherever it is filed; refused while a turn is writing to it.
export const discardAgent = (id: string): SandboxHandlerOutput<`agents`, `discard`> => {
    refuseWhileRunning(id);
    const onBoard = roster.agents.some((agent) => agent.id === id);
    const filed = archived.findIndex((agent) => agent.id === id);
    if (!onBoard && filed < 0) {
        return refuse(`No such agent.`, 404);
    }
    if (filed >= 0) {
        archived.splice(filed, 1);
    }
    roster.agents = roster.agents.filter((agent) => agent.id !== id);
    discardReview(id);
    broadcastRoster();
    return { ok: true as const };
};

// The review's "Already merged": filed as landed where it was headed, its conflict report cleared, nothing written.
export const settleAgent = (id: string): AgentSummary => {
    refuseWhileRunning(id);
    const now = Date.now();
    settleReview(id, now);
    return agentAnswer(
        patchAgent(id, {
            status: `landed`,
            updatedAt: now,
            attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
            conflictCauses: undefined,
            landRequested: undefined,
        }),
    );
};

// A collaborator's ask, stamped with who asked: the reader this daemon minted the session for.
export const requestLand = (id: string): AgentSummary => {
    const asker: NonNullable<AgentSummary[`landRequested`]> = { email: OWNER.email, at: Date.now() };
    if (OWNER.name !== undefined) {
        asker.name = OWNER.name;
    }
    return agentAnswer(patchAgent(id, { landRequested: asker }));
};

// Every watch, or the one named; nothing else about the conversation changes.
export const stopWatching = ({ id, watchId }: SandboxHandlerInput<`agents`, `stopWatching`>): AgentSummary => {
    const watches = (roster.agents.find((agent) => agent.id === id)?.watches ?? []).filter((watch) => watchId !== undefined && watch.id !== watchId);
    return agentAnswer(patchAgent(id, { watches: watches.length === 0 ? undefined : watches }));
};

// Ends a job the way the daemon's answer reads once it has: stopped by the person, its wait and hand-over over.
export const stopJob = ({ id, jobId }: SandboxHandlerInput<`agents`, `stopJob`>): AgentSummary =>
    agentAnswer(
        patchAgent(id, {
            jobs: roster.agents
                .find((agent) => agent.id === id)
                ?.jobs?.map((job) => {
                    if (job.id !== jobId || job.endedAt !== undefined) {
                        return job;
                    }
                    const { watch: _watch, handed: _handed, ...ended } = job;
                    return { ...ended, endedAt: Date.now(), exitCode: 143, stoppedBy: `person` as const };
                }),
        }),
    );

// Honors the search field's case-sensitivity switch, matching the browser's own tier.
const folded = (text: string, caseSensitive: boolean): string => (caseSensitive ? text : text.toLowerCase());

export const searchAgents = (query: string, caseSensitive: boolean): AgentSearchResult => {
    const needle = folded(query.trim(), caseSensitive);
    const matches =
        needle === ``
            ? []
            : [...roster.agents, ...archived].filter((agent) => folded(agent.title ?? ``, caseSensitive).includes(needle)).map((agent) => ({ id: agent.id }));
    // No phrase index behind this; nothing is ever still being indexed. The archive is searched with the live board.
    return { matches, scanned: roster.agents.length + archived.length, indexing: false };
};

export const searchSessions = (query: string, caseSensitive: boolean): ReturnType<typeof sessions> => {
    const all = sessions(Date.now());
    const needle = folded(query.trim(), caseSensitive);
    return needle === `` ? all : all.filter((session) => folded(session.title, caseSensitive).includes(needle));
};
