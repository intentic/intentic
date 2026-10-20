import type { TurnProfile } from "@intentic/sandbox-contract/schemas/agent";
import type { Logger } from "pino";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import { deliverWake, type WakeDoors } from "../../seams/wake-delivery.js";
import type { AccountReopened } from "../../usage/serviceability/state-log.js";
import { parentsWaitingOn } from "./waiting/subagent-waits.js";

/* CAPACITY BACK, SAID TO WHOEVER IS WAITING ON IT. A parent whose children failed or paused on a spent provider sat in
   its wait while the second Claude account came back at 13:29:30; the only sign was a log line, and a person told the
   parent at 13:31 (2026-10-17). An account coming back to ready is said into the turn of every parent parked in a wait
   with a child on that provider failed or paused, which hands its wait back at once (outcome `message`). Nothing is said
   to a parent that is not waiting: it reads the listing when it next spawns, and a wake of its own would cost a turn. */

export interface CapacityNoticeDeps {
    readonly conversations: Pick<ConversationActors, "holdings">;
    readonly doors: WakeDoors;
    readonly profileOf: (conversationId: string) => TurnProfile | undefined;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly now?: () => number;
}

// An account read again within this long after coming back is the same news: the lists are judged on every page load.
const SAID_FOR_MS = 10 * 60_000;

const noticeOf = (event: AccountReopened, children: readonly string[]): string =>
    `Capacity is back on ${event.provider}: the account ${event.label ?? event.account} can serve again (it was ${event.from}). ` +
    `Your ${children.length === 1 ? "child" : "children"} ${children.map((id) => `\`${id}\``).join(", ")} on ${event.provider} ` +
    `${children.length === 1 ? "is" : "are"} failed or paused: send ${children.length === 1 ? "it" : "them"} a follow-up, or ` +
    "cancel a booked re-run and spawn again, rather than waiting for the re-run's own time.";

/** Hears each account coming back and tells the parents waiting on it; one notice per account per ten minutes. */
export const capacityNoticer = (deps: CapacityNoticeDeps): ((event: AccountReopened) => void) => {
    const said = new Map<string, number>();
    const now = deps.now ?? Date.now;
    return (event) => {
        const key = `${event.provider}\u0000${event.account}`;
        const last = said.get(key);
        if (last !== undefined && now() - last < SAID_FOR_MS) {
            return;
        }
        const waiting = parentsWaitingOn(deps.conversations, event.provider);
        if (waiting.length === 0) {
            return;
        }
        said.set(key, now());
        for (const { parent, children } of waiting) {
            void tellParent(deps, parent, event, children);
        }
    };
};

// Never throws: it runs off a reading of the account lists.
const tellParent = async (deps: CapacityNoticeDeps, parent: string, event: AccountReopened, children: readonly string[]): Promise<void> => {
    const profile = deps.profileOf(parent);
    if (profile === undefined) {
        return;
    }
    try {
        const receipt = await deliverWake(deps.doors, {
            conversationId: parent,
            prompt: noticeOf(event, children),
            voice: "sandbox",
            profile,
            source: "capacity",
        });
        deps.logger.info({ parent, provider: event.provider, account: event.account, receipt }, "capacity: told a waiting parent it is back");
    } catch (error) {
        deps.logger.warn({ err: error, parent }, "capacity: could not tell a waiting parent it is back");
    }
};
