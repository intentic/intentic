import { opt } from "../../opt.js";
import type { ConversationActors } from "../actor/conversation-actors.js";
import { type LandedPresences, presenceReadsFiles, removerKey } from "./landed-presence.js";
import { standingReadsFiles } from "./standing.js";
import { type IsolatedAgent, isIsolated, type PersistedAgent, type Remover } from "../registry/agents-store.js";

// What the registry's land-standing probe (registry/agents-registry.ts) reads besides git, and what it names: the inputs whose
// change re-derives a standing with no ref moving, whether a file batch can move what the last probe found, and who
// took landed work out of the main tree.

// What the feed reports moved under the standings: a ref (main's HEAD, an agent's tip, a parked shelf), which every
// standing is measured against, or files in a main checkout, which only some are (standing.ts, landed-presence.ts).
export type StandingChange = "refs" | "files";

// The live agents' own landing inputs; a change here moves a standing with no ref moving. `landedInto` too: it decides
// whether a land is counted against the main tree at all (landed-presence.ts).
export const landingInputs = (live: readonly IsolatedAgent[]): string =>
    JSON.stringify(live.map((entry) => [entry.id, entry.placement.branch, entry.placement.repos, entry.placement.landedInto ?? null, entry.landing.conflicts ?? []]));

// Whether a probe of these agents reads any main checkout's files: a stored `workspace` blocker or a land the main tree
// has not absorbed. Its readings are a function of refs, the agents' landing inputs and, only then, those files; so
// while the last probe read none, a file batch cannot move what it found, and an agent that comes to read files
// changes the landing inputs, which probes anyway.
export const readsMainFiles = (live: readonly IsolatedAgent[]): boolean => live.some((entry) => standingReadsFiles(entry) || presenceReadsFiles(entry));

// The agents that can take landed work out of the main tree by their own hand, the ones working in it: a main-tree
// conversation whose turn runs now or that did something since `since`. What the presence probe reads a removal off,
// beside the people noted as they discard (landed-presence.ts).
export const mainTreeWriters = (entries: readonly PersistedAgent[], conversations: Pick<ConversationActors, "state">, since: number): Remover[] =>
    entries
        .filter((entry) => entry.placement.kind === "main" && entry.archivedAt === undefined)
        .filter((entry) => entry.updatedAt >= since || conversations.state(entry.id)?.phase.kind === "running")
        .map((entry) => ({ kind: "agent", id: entry.id }));

// The records a probe's names move: each agent it read whose record names someone else, or no one where the probe now
// names nobody (a reading that found nothing missing). Read from the entry as it is now, since a land may have replaced
// it mid-probe.
export const renamedRemovers = (
    read: readonly IsolatedAgent[],
    entryOf: (id: string) => PersistedAgent | undefined,
    presences: Pick<LandedPresences, "of" | "measured">,
): PersistedAgent[] =>
    read.flatMap(({ id }) => {
        const entry = entryOf(id);
        const named = presences.of(id)?.removedBy;
        if (entry === undefined || !isIsolated(entry) || !presences.measured(id) || removerKey(named) === removerKey(entry.landing.removedBy)) {
            return [];
        }
        const { removedBy: _was, ...landing } = entry.landing;
        return [{ ...entry, landing: { ...landing, ...opt("removedBy", named) } }];
    });
