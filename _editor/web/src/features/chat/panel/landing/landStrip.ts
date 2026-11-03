import { isHomeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";

// WHAT THE CHAT SAYS ABOUT ITS OWN UNLANDED WORK, just above its composer (ChatLandStrip): the board card's Land now,
// brought to where a reader who opened the chat instead of landing it is already looking. Only the three standings the
// card itself has a press for: work waiting to land, a land under way, and a land refused. A running turn says nothing
// here (its work is not done), nor does a home conversation (it lands by itself), an archived one, or another box's.

export type LandStrip =
    | { readonly kind: `ready`; readonly diff: { readonly files: number; readonly insertions: number; readonly deletions: number } | undefined }
    | { readonly kind: `landing` }
    | { readonly kind: `conflict` };

export interface LandStripFacts {
    // The reader may land (a maintainer) or ask for one (a collaborator); a guest gets neither, so the strip stays away.
    readonly canAct: boolean;
    // The turn is streaming in this window, which a roster frame may not have caught up with yet.
    readonly streaming: boolean;
    // The chat is another sandbox's, whose roster this tab does not land through.
    readonly elsewhere: boolean;
}

type StripAgent = Pick<FleetAgent, `id` | `status` | `archivedAt` | `diff`>;

/** The strip to draw for this chat's card, or undefined for none. */
export const landStripOf = (agent: StripAgent | undefined, facts: LandStripFacts): LandStrip | undefined => {
    if (
        agent === undefined ||
        !facts.canAct ||
        facts.streaming ||
        facts.elsewhere ||
        agent.archivedAt !== undefined ||
        isHomeConversationId(agent.id)
    ) {
        return undefined;
    }
    if (agent.status === `ready`) {
        // A diff of renames alone counts no lines, which the card's own chip leaves out too (AgentCard diffShown).
        const diff = agent.diff !== undefined && (agent.diff.insertions > 0 || agent.diff.deletions > 0) ? agent.diff : undefined;
        return { kind: `ready`, diff };
    }
    if (agent.status === `landing`) {
        return { kind: `landing` };
    }
    return agent.status === `conflict` ? { kind: `conflict` } : undefined;
};
