import { watchWakePrompt } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { conversationProfile } from "../../conversations/registry/agents-store.js";
import { deliverWake } from "../../agent/run/turn/wake-delivery.js";
import { automationExpired, automationFired } from "../../push/notifications.js";
import type { AutomationRecord } from "../automations-store.js";
import { conditionLabel, sinceLabel } from "./watch-condition.js";

// Where a passing check goes when it is not a new agent (AutomationTargetSchema): back into a conversation that is
// already there, or to the owner's phone with no model at all. Also what a watch says when it reaches its end date.

export type TargetOutcome =
    { readonly ok: true; readonly conversationId?: string; readonly detail?: string } | { readonly ok: false; readonly error: string };

// What a conversation-bound wake reads: the same notice a condition watch's wake is (watch-wake.ts), so the conversation
// draws it as the watch it is and the model reads it the way it reads every watch, then the automation's own words on
// what to do now. `outcome` is `met` for a fire and `timeout` for an end date reached.
const conversationWake = (automation: AutomationRecord, outcome: "met" | "timeout", observed: string | undefined, now: number): string => {
    const armedAt = automation.watch?.armedAt ?? now;
    const notice = watchWakePrompt({
        outcome,
        id: automation.id,
        note: automation.note ?? automation.id,
        elapsed: sinceLabel(now - armedAt),
        command: conditionLabel(automation) ?? "(no check: it fires on its trigger alone)",
        exitCode: outcome === "met" ? 0 : undefined,
        output: observed ?? "",
    });
    const standing =
        outcome === "timeout"
            ? `This came from the automation \`${automation.id}\`, which has reached its end date and is now switched off.`
            : automation.until === "first-fire"
              ? `This came from the automation \`${automation.id}\`, which has now switched itself off: it was waiting for this one thing.`
              : `This came from the automation \`${automation.id}\`, which stays on and will wake this conversation again the next time it fires.`;
    return `${notice}\n\n${standing}\n\nWhat you asked to be told when this happened:\n${automation.prompt}`;
};

// Continues the named conversation on its own model and routing, through the one door every sandbox-spoken wake takes:
// said into its live turn, a turn of its own when it is idle, queued behind a busy one.
export const continueConversation = async (
    services: Services,
    automation: AutomationRecord,
    conversationId: string,
    outcome: "met" | "timeout",
    observed: { readonly text?: string; readonly outside?: string },
): Promise<TargetOutcome> => {
    const entry = services.agents.entry(conversationId);
    if (entry === undefined) {
        return {
            ok: false,
            error: `The conversation ${conversationId} this automation continues no longer exists. Point it at another one, or at a new agent.`,
        };
    }
    const now = Date.now();
    const receipt = await deliverWake(
        { turns: services.turns, sessionIdOf: (id) => services.conversations.sessionIdOf(id) },
        {
            conversationId,
            prompt: conversationWake(automation, outcome, observed.text, now),
            voice: "sandbox",
            source: `automation:${automation.id}`,
            // One per fire, so a restart that delivers it again is met with the first delivery's receipt.
            messageId: `automation-${automation.id}-${outcome}-${automation.watch?.firedAt ?? now}`,
            ...(observed.outside === undefined ? {} : { outside: observed.outside }),
            profile: conversationProfile(entry),
        },
    );
    if ("invalid" in receipt) {
        return { ok: false, error: `The wake could not be delivered: ${receipt.invalid}` };
    }
    if ("why" in receipt) {
        return { ok: false, error: `The conversation took nothing: ${receipt.why}` };
    }
    return { ok: true, conversationId, detail: `Woke ${conversationId} (${receipt.delivered}).` };
};

// No model: the owner's phone hears what the check saw, and the run's history keeps it. `notify` rather than
// `notifyIfAway`, because this push is the whole of what the automation does; there is no card to see instead.
export const notifyOwner = async (services: Services, automation: AutomationRecord, value: string | undefined): Promise<TargetOutcome> => {
    const delivery = await services.pushSender.notify(automationFired(automation, value));
    const saw = value === undefined || value === "" ? "" : `Saw: ${value.split("\n")[0]?.slice(0, 300) ?? ""}. `;
    return {
        ok: true,
        detail: `${saw}${delivery.delivered === 0 ? "No device is subscribed to notifications, so nobody was told: turn them on in Settings." : `Told ${delivery.delivered} device(s).`}`,
    };
};

// Its end date reached: switched off, its history says so, and whoever it was for hears it, since a watch that stops
// without a word reads exactly like one still waiting.
export const expireAutomation = async (services: Services, automation: AutomationRecord): Promise<void> => {
    if (!(await services.automations.setEnabled(automation.id, false))) {
        return;
    }
    const fired = automation.watch?.firedAt !== undefined;
    const ended = new Date(automation.expiresAt ?? Date.now()).toISOString();
    await services.automations.recordRun(automation.id, {
        at: Date.now(),
        outcome: "skipped",
        detail: fired
            ? `Reached its end date (${ended}) and switched itself off.`
            : `Reached its end date (${ended}) without firing, and switched itself off.`,
    });
    const target = automation.target ?? { kind: "agent" as const };
    if (target.kind === "conversation") {
        const told = await continueConversation(services, automation, target.conversationId, "timeout", {});
        if (!told.ok) {
            services.logger.warn({ automation: automation.id, error: told.error }, "automation expiry could not be told to its conversation");
        }
        return;
    }
    const notice = automationExpired(automation, fired);
    void (target.kind === "notify" ? services.pushSender.notify(notice) : services.pushSender.notifyIfAway(notice));
};
