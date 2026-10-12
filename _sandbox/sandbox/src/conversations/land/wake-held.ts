import type { ConversationActors } from "../actor/conversation-actors.js";
import type { Holding } from "../actor/conversation-holdings.js";

// What a turn's close left when it skipped its land because the conversation would run again by itself (turn-close.ts
// step 4): the turn that wakes finishes the work and lands it. Kept so that when the wake goes away without firing (a
// person stops the job it waited on, or the watch), the land it skipped can run after all (wake-held-land.ts). Set or
// cleared by every turn whose body reaches its land; one that threw or was stopped leaves it, and the ending it leaves
// is what wake-held-land.ts refuses to land past. Memory only: a restart forgets it, and the work then waits on its
// branch for a press, as it did before this existed.

export interface HeldLand {
    // The skipped turn's own answer to whether its work lands by itself (TurnInput.autoLand), which nothing persists;
    // undefined left it to the conversation's posture and the rules, as the close would have.
    readonly autoLand: boolean | undefined;
}

type Holders = Pick<ConversationActors, "holdings">;

const HELD: Holding<HeldLand> = { name: "lands held for a wake" };

/** Records that the conversation's last close skipped its land for a wake, or, given undefined, that it did not. */
export const noteLandHeldForWake = (actors: Holders, conversationId: string, held: HeldLand | undefined): void => {
    const holding = actors.holdings(HELD);
    if (held === undefined) {
        holding.drop(conversationId);
        return;
    }
    holding.hold(conversationId, conversationId, held);
};

/** The land the conversation's last close skipped for a wake, taken: answered once, then forgotten. */
export const takeLandHeldForWake = (actors: Holders, conversationId: string): HeldLand | undefined => {
    const holding = actors.holdings(HELD);
    const held = holding.get(conversationId);
    holding.drop(conversationId);
    return held;
};
