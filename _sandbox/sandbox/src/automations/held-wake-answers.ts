import type { AgentOrigin } from "@intentic/sandbox-contract/schemas/agent";
import type { AutomationApproval } from "@intentic/sandbox-contract/schemas/automations";
import type { PushNotification } from "@intentic/sandbox-contract/schemas/push";
import type { Services } from "../composition.js";
import { deliverToListenerChannel } from "../extensions/listener/listener-deliver.js";
import { opt } from "../opt.js";

// WHAT FOLLOWS A PERSON'S ANSWER TO A HELD WAKE, beyond running it or not. The hold pushed an ask to the owner's lock
// screen (scheduler.ts, `approval-<automation>`), and the stranger whose message was held is waiting for a reply. A
// need settles both the same way (needs/needs-slice.ts): the push is withdrawn on the devices it showed on, and the
// channel the work came from is told, through the one delivery a channel's answer takes (listener-deliver.ts).

// What replaces the ask on the lock screen once nothing of the automation waits any more: something shown rather than a
// silent close, which browsers penalise, carrying no detail the lock screen did not already have.
const approvalResolved = (automationId: string): PushNotification & { readonly tag: string } => ({
    title: "No longer waiting",
    body: "That approval is settled.",
    url: "/automations",
    tag: `approval-${automationId}`,
});

// The words the sender hears when their request is turned down: they were told a person would review it, so they are
// told the outcome rather than left waiting for an answer that never comes.
export const HELD_WAKE_DECLINED = "A person reviewed your request and declined it, so nothing more will happen with it here.";

// Withdraws the automation's approval push, once no other wake of it is still held: the push is one per automation,
// so taking it down while another waits would hide that one. Never throws: a push that stays up is a stale ask on a
// lock screen, never a reason to fail the answer the person just gave.
export const withdrawApprovalPush = async (services: Pick<Services, "heldWakes" | "pushSender" | "logger">, automationId: string): Promise<void> => {
    try {
        if ((await services.heldWakes.list()).some((held) => held.automationId === automationId)) {
            return;
        }
        await services.pushSender.withdraw(approvalResolved(automationId));
    } catch (error) {
        services.logger.warn({ err: error, automation: automationId }, "held wake: its approval push was not withdrawn");
    }
};

// A rejected hold, already taken off the queue by the caller: the ask comes off the lock screen, the run history says
// a person declined it (a hold that vanished without a trace reads like one the daemon lost), and the sender is told.
export const declineHeldWake = async (
    services: Pick<Services, "heldWakes" | "pushSender" | "automations" | "logger"> & Parameters<typeof deliverToListenerChannel>[0],
    held: AutomationApproval,
): Promise<void> => {
    await withdrawApprovalPush(services, held.automationId);
    await services.automations.recordRun(held.automationId, {
        at: Date.now(),
        outcome: "skipped",
        detail: "A person declined it while it waited for approval, so it did not run.",
        ...opt("conversationId", held.conversationId),
    });
    if (held.origin !== undefined) {
        void tellOrigin(services, held.origin, held.automationId);
    }
};

// Said where the request came from, through the delivery a channel's answer takes; a channel that cannot take it is
// logged, since the decline itself already stands.
const tellOrigin = async (services: Parameters<typeof deliverToListenerChannel>[0], origin: AgentOrigin, automationId: string): Promise<void> => {
    try {
        await deliverToListenerChannel(services, origin, HELD_WAKE_DECLINED);
    } catch (error) {
        services.logger.warn({ err: error, automation: automationId, provider: origin.provider }, "held wake: the channel did not take the answer");
    }
};
