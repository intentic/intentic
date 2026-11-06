import { type AudienceFacts, audienceOf, type ConversationNews, hears } from "@intentic/sandbox-contract/schemas/agent-people";
import { attentionCalls, type CallerStanding } from "./agentStatus-lanes";

// WHICH OF THE FLEET'S NEWS IS THE READER'S, by the rule the daemon's pushes follow (sandbox-contract
// schemas/agent-people.ts, the daemon's push/push-audience.ts), so the tab's chime, its mark and the Agents badge
// never call somebody about a conversation their phone would rightly stay quiet about. The board still shows everything.

export interface Reader {
    // The signed-in reader's address; undefined for the owner's own tools, which hear everything, as before.
    readonly email: string | undefined;
    // Whether they run the sandbox (owner or maintainer): a card nobody took part in waits on them, as on the daemon.
    readonly operates: boolean;
}

type Heard = AudienceFacts & { readonly id: string };

/** Whether this news of a conversation is for the reader. */
export const heardBy = (agent: AudienceFacts, reader: Reader, news: ConversationNews): boolean => {
    if (reader.email === undefined) {
        return true;
    }
    if (hears(agent, reader.email, news)) {
        return true;
    }
    return news === `asks` && reader.operates && audienceOf(agent, `asks`).length === 0;
};

/**
 * The calls among the fleet's that wait on the reader: each judged by the card it rides (its family's top, or its
 * automation's latest run), as the daemon judges a card down a family by the people of the conversation at its top.
 */
export const callsFor = <A extends CallerStanding & Heard>(agents: readonly A[], reader: Reader): readonly { readonly id: string; readonly card: string }[] => {
    const byId = new Map(agents.map((agent) => [agent.id, agent] as const));
    return attentionCalls(agents).filter((call) => {
        const card = byId.get(call.card) ?? byId.get(call.id);
        return card === undefined || heardBy(card, reader, `asks`);
    });
};

/** How many cards wait on the reader: the Attention lane's count, narrowed to what is theirs. */
export const cardsFor = <A extends CallerStanding & Heard>(agents: readonly A[], reader: Reader): number => new Set(callsFor(agents, reader).map((call) => call.card)).size;
