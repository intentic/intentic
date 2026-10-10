import { type AgentSearchResult, type AgentSummary, isTurnBreakPolicy, type SandboxHandlerInput } from "@intentic/sandbox-contract";
import { refuse } from "@intentic/contract-serve";
import { landAgentDelta, landedPaths, sessions } from "../fixture/workspace";
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
    patchAgent(id, {
        status: `landed`,
        updatedAt: Date.now(),
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    });
    const paths = landedPaths(id);
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

export const archiveAgents = ({ ids }: SandboxHandlerInput<`agents`, `archive`>): { moved: AgentSummary[]; failed: []; rev: number } => {
    const archivedAt = Date.now();
    const archived: AgentSummary[] = [];
    for (const agent of roster.agents) {
        if (ids.includes(agent.id)) {
            archived.push({ ...agent, archivedAt });
        }
    }
    roster.agents = roster.agents.filter((agent) => !ids.includes(agent.id));
    broadcastRoster();
    // Answers `moved`/`failed`, the daemon's own shape (AgentsArchivedSchema).
    return { moved: archived, failed: [], rev: roster.rev };
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
            : roster.agents.filter((agent) => folded(agent.title ?? ``, caseSensitive).includes(needle)).map((agent) => ({ id: agent.id }));
    // No phrase index behind this; nothing is ever still being indexed.
    return { matches, scanned: roster.agents.length, indexing: false };
};

export const searchSessions = (query: string, caseSensitive: boolean): ReturnType<typeof sessions> => {
    const all = sessions(Date.now());
    const needle = folded(query.trim(), caseSensitive);
    return needle === `` ? all : all.filter((session) => folded(session.title, caseSensitive).includes(needle));
};
