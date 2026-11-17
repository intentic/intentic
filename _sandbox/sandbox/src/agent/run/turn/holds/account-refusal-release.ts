import type { Services } from "../../../../composition.js";
import { waitingOf } from "../../../../conversations/actor/conversation-queue.js";
import { carryingOn } from "../../../../conversations/actor/conversation-holdings.js";
import type { Ending } from "../../../../conversations/registry/agents-store.js";
import { routingFor } from "../../../../conversations/registry/routing.js";
import { offBlockedAccount } from "../../../providers/accounts/blocked-account.js";
import { handPicked } from "./spent-door.js";

/* WORDS AN ACCOUNT'S REFUSAL HANDED BACK GO AGAIN BY THEMSELVES ONCE THE PROVIDER CAN SERVE THEM. An account its
   organisation turned off (`claude-not-entitled`) refuses the turn at the door, and its words go back to the queue held
   for a press (turn-admission.ts handBack). The next turn is routed off the account (blocked-account.ts), but nothing
   sent one: 2026-11-17, the shinobi-society audit found conversations dead for hours beside a second account of the same
   provider that could have served them. The resume pass now asks the same route the turn would ask, and lets the words
   go when it has somewhere to send them: another account to move to, or this one serving again. Anything else leaves
   them for a press, so a refusal that would only repeat is never sent again by itself. */

// The ending a refusal of the account leaves: the provider's own, or the daemon's held route (turn-decision.ts).
const accountRefused = (ending: Ending | undefined): boolean => ending?.kind === "failed" && ending.code === "claude-not-entitled";

// Whether the words held for `conversationId` would now run somewhere: a move off the blocked account, or the account
// itself serving again. A turn that names another account or one a person picked goes where it says (turn-facts.ts
// accountRouteOf), so letting it go would only be refused again.
const servableNow = async (services: Services, conversationId: string, turns: readonly Parameters<typeof handPicked>[0][]): Promise<boolean> => {
    const entry = services.agents.entry(conversationId);
    const [first] = waitingOf(services.conversations.queued(conversationId));
    if (first === undefined || entry === undefined) {
        return false;
    }
    const { turn } = first;
    const { provider, account: remembered } = routingFor(entry.profile, { agent: turn.agent, harness: turn.harness });
    if (remembered === undefined || turns.some((each) => handPicked(each) || (each.account !== undefined && each.account !== remembered))) {
        return false;
    }
    const route = await offBlockedAccount(services, { provider, named: undefined, remembered, model: turn.model });
    return route.kind === "move" || (route.kind === "keep" && route.servable === true);
};

/** Lets go the words an account's refusal held, in every conversation where the provider can now serve them. */
export const releaseAccountHolds = async (services: Services, now: number): Promise<void> => {
    for (const { conversationId } of services.conversations.refused()) {
        if (!accountRefused(services.agents.entry(conversationId)?.ending)) {
            continue;
        }
        const waiting = waitingOf(services.conversations.queued(conversationId));
        if (!(await servableNow(services, conversationId, waiting.map((item) => item.turn)))) {
            continue;
        }
        const ids = waiting.map((item) => item.id);
        services.logger.info({ conversationId, messages: ids.length }, "resume pass: an account refusal's words go again, the provider can serve them now");
        // Releasing ends the hold the card stated, so the words are a turn on its way until it begins; the turn itself
        // moves off the blocked account as any turn does (turn-facts.ts accountRouteOf).
        await carryingOn(services.conversations, conversationId, "account", async () => {
            services.conversations.send(conversationId, { kind: "queue-released", ids }, now);
            await services.turns.drain(conversationId);
        });
    }
};
