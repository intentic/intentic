import { computed, watch } from "vue";
import { laneOf, unregistered } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import type { Conversation } from "../session/conversation";
import { useChat } from "../run/useChat";
import { personaOfAgent, personaOfTab } from "../tabs/tabs";
import { railPersona } from "./railPersona";

// ONE LIST, SCOPED. The chat list is the same lanes whoever is picked; picking a persona in its grid narrows every lane
// to the chats that speak as them, and adds the work of theirs this window has not opened (an automation, another
// window's chat) to the lanes it stands in. Anyone scopes nothing: it is every chat this window holds.
//
// Replaced (2026-09-29) a two-cut switch, Agents by lane and Personas by who, whose cuts differed in more than their
// grouping (only one had trays, runs, a filter), so a chat looked different depending on which cut showed it.

const LANE_RANK = { attention: 0, active: 1, finished: 2 } as const;

export function usePersonaScope() {
    const { personas } = usePersonas();
    const { conversations } = useChat();
    const { fleet } = useAgents();

    const known = computed(() => new Set(personas.value.map((persona) => persona.id)));
    const labelOf = (id: string): string | undefined => {
        const persona = personas.value.find((candidate) => candidate.id === id);
        return persona === undefined ? undefined : (persona.label ?? persona.id);
    };

    // A pick naming a persona since deleted reads as Anyone rather than as nothing, and a renamed one keeps its new name.
    watch(
        [railPersona, personas],
        ([picked]) => {
            if (picked === undefined) {
                return;
            }
            const label = labelOf(picked.id);
            if (label === undefined) {
                railPersona.value = undefined;
            } else if (label !== picked.label) {
                railPersona.value = { id: picked.id, label };
            }
        },
        { immediate: true },
    );
    const pick = (id: string | undefined): void => {
        const label = id === undefined ? undefined : labelOf(id);
        railPersona.value = id === undefined || label === undefined ? undefined : { id, label };
    };

    // A persona's live conversations this window has not opened, newest first within each lane: its automations, its
    // other windows' chats. A sandboxed agent is another sandbox's to show.
    const openIds = computed(() => new Set(conversations.value.map((conversation) => conversation.conversationId)));
    const notOpenBy = computed(() => {
        const groups = new Map<string, FleetAgent[]>();
        for (const agent of fleet.value) {
            const persona = personaOfAgent(agent);
            if (persona === undefined || !known.value.has(persona) || openIds.value.has(agent.id) || agent.sandboxId !== undefined || unregistered(agent.status)) {
                continue;
            }
            groups.set(persona, [...(groups.get(persona) ?? []), agent]);
        }
        for (const [key, agents] of groups) {
            groups.set(key, agents.toSorted((a, b) => LANE_RANK[laneOf(a)] - LANE_RANK[laneOf(b)] || b.updatedAt - a.updatedAt));
        }
        return groups;
    });
    const notOpenOf = (persona: string | undefined): readonly FleetAgent[] => (persona === undefined ? [] : (notOpenBy.value.get(persona) ?? []));
    // What the lanes list of it: what waits on the reader and what works. Its finished history is the board's to show.
    const liveNotOpenOf = (persona: string | undefined): readonly FleetAgent[] => notOpenOf(persona).filter((agent) => laneOf(agent) !== `finished`);

    // Whether a chat is listed under a tile (undefined is Anyone, which lists every chat), and under the one picked.
    const listedUnder = (conversation: Conversation, persona: string | undefined): boolean =>
        persona === undefined || personaOfTab(conversation, known.value) === persona;
    const inScope = (conversation: Conversation): boolean => listedUnder(conversation, railPersona.value?.id);

    return { personas, known, scope: railPersona, pick, listedUnder, inScope, notOpenOf, liveNotOpenOf };
}
