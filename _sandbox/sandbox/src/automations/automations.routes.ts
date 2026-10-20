import { conversationReader, registryProvenance } from "../auth/scope/conversation-reader.js";
import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { automationsContract } from "@intentic/sandbox-contract/contracts/automations.contract";
import type { Zone } from "@intentic/sandbox-contract/time/zone";
import { implement, ORPCError } from "@orpc/server";
import { rm } from "node:fs/promises";
import { doorChange, listedDoorToken } from "../auth/tokens/door-tokens.js";
import { operatorHere } from "../auth/operator.js";
import { requireMaintainer } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { reconcileListenerProcesses } from "../extensions/extension-processes.js";
import { automationCatalog } from "./catalog.js";
import { doorOf, refuseInvalidAutomation, refusePastEnd, refusePastMoment, saveAutomation } from "./automation-save.js";
import type { AutomationRecord } from "./automations-store.js";
import { nextRunOf, sandboxZone } from "./schedule-zone.js";
import { declineHeldWake, withdrawApprovalPush } from "./held-wake-answers.js";
import { HeldWakeNotApproved } from "./held-wakes-store.js";
import { fireAutomation, recordHeldWake, runHeldWake } from "./scheduler.js";
import { forgetHeldWake } from "./durable/fire-admission.js";
import { ManifestUnreadableError } from "../store/json-file.js";
import { guardStateFile, sourceEnv } from "./watch/watch-condition.js";
import { checkSource, sourceProblem } from "./watch/watch-sources.js";

// The listed record, with its door's credential attached for an operator only; a viewer or a `read` control token sees
// the list but never the firing string.
// Minted here if the door has none yet, so an automation declared before the store existed gets its URL the first time
// an operator looks.
const listed = async (services: Services, automation: AutomationRecord, operator: boolean, sandbox: Zone): Promise<AutomationSummary> => {
    const nextRun = nextRunOf(automation, sandbox);
    const door = doorOf(automation);
    const summary: AutomationSummary = { ...automation, ...(nextRun !== undefined ? { nextRun } : {}) };
    if (!operator || door === undefined) {
        return summary;
    }
    // Absent when the door file cannot be read: the row lists without its URL rather than failing the whole list.
    const token = await listedDoorToken(services.doorTokens, door, automation.id);
    if (token === undefined) {
        return summary;
    }
    return door === "automation" ? { ...summary, webhookToken: token } : { ...summary, ingestKey: token };
};

// The owner's yes, then the release it lets out, journalled as a queued fire before the hold is taken out
// (held-wakes-store.ts), so a restart in between still runs it.
const approveAndRelease = async (services: Services, id: string, by: string | undefined) =>
    (await services.heldWakes.approve(id, by)) ? services.heldWakes.release(id, (wake) => recordHeldWake(services, wake)) : undefined;

// The automations manifest routes. `upsert` validates the cron with the scheduler's own parser, so what's accepted here
// is exactly what will fire.
export const createAutomationsRoutes = (services: Services) => {
    const i = implement(automationsContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async ({ context }) => {
            const operator = operatorHere(services, context);
            // One read for the whole list, so every row's countdown is measured against the same clock.
            const sandbox = await sandboxZone(services);
            return { automations: await Promise.all((await services.automations.list()).map((automation) => listed(services, automation, operator, sandbox))) };
        }),
        catalog: i.catalog.handler(async () => await automationCatalog(services)),
        check: i.check.handler(async ({ input }) => {
            const problem = sourceProblem(input.source);
            if (problem !== undefined) {
                throw new ORPCError("BAD_REQUEST", { message: problem });
            }
            const checked = await checkSource(input.source, {
                fetch: (url, init) => fetch(url, init),
                env: await sourceEnv(services, { id: "check" }),
            });
            return checked.pass ? { pass: true, saw: checked.output } : { pass: false, saw: checked.detail };
        }),
        // Who has written to a source, admitted or not; the picker offers these by name and stores the id.
        senders: i.senders.handler(async ({ input }) => ({ senders: await services.senders.list(input.provider) })),
        upsert: i.upsert.handler(async ({ input }) => {
            await refuseInvalidAutomation(services, input);
            await saveAutomation(services, input);
            return { ok: true } as const;
        }),
        setEnabled: i.setEnabled.handler(async ({ input }) => {
            const existing = await services.automations.get(input.id);
            if (existing !== undefined && input.enabled) {
                refusePastMoment(existing.trigger, Date.now());
                refusePastEnd(existing, Date.now());
            }
            if ((await services.automations.setEnabled(input.id, input.enabled)) === "missing") {
                throw new ORPCError("NOT_FOUND", { message: "no automation with that id" });
            }
            void reconcileListenerProcesses(services);
            return { ok: true } as const;
        }),
        remove: i.remove.handler(async ({ input }) => {
            if (!(await services.automations.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "no automation with that id" });
            }
            // The door is gone; so is what opened it.
            await doorChange(Promise.all([services.doorTokens.remove("automation", input.id), services.doorTokens.remove("intake", input.id)]));
            // And the guard's own memory, which nothing else would ever read again.
            await rm(guardStateFile(services.workspace.root, input.id), { force: true });
            void reconcileListenerProcesses(services);
            return { ok: true } as const;
        }),
        // A fresh credential for the door, the old one retired in the same write; the answer to a leaked URL.
        rotateToken: i.rotateToken.handler(async ({ input }) => {
            const automation = await services.automations.get(input.id);
            if (automation === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no automation with that id" });
            }
            const door = doorOf(automation);
            if (door === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "this automation opens no door: nothing outside the sandbox reaches it, so there is no token to rotate" });
            }
            return { token: await doorChange(services.doorTokens.rotate(door, automation.id)) };
        }),
        // Run now: fires the real path and runs the guard, skips only approval, and works even when switched off.
        run: i.run.handler(async ({ input }) => {
            const automation = await services.automations.get(input.id);
            if (automation === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no automation with that id" });
            }
            if (automation.trigger.kind === "listener") {
                throw new ORPCError("BAD_REQUEST", {
                    message: `A ${automation.trigger.provider} automation can only be fired by a real message, send one to test it.`,
                });
            }
            // Retired by hand exactly as the tick would retire it. "Fires once" has to hold however it was set off, or
            // pressing play on a reminder gives you the reminder now AND again at its moment.
            if (automation.trigger.kind === "once") {
                await services.automations.setEnabled(automation.id, false);
            }
            void fireAutomation(services, automation, { cleared: "approval" }).catch((error: unknown) =>
                services.logger.error({ err: error, automation: automation.id }, "by-hand automation run failed"),
            );
            return { ok: true } as const;
        }),
        // The readable holds, and the names of any file in the queue this build cannot read: reported, never dropped.
        // A held wake carries the message that woke it: listed only to those who may read the conversation it continues.
        pendingList: i.pendingList.handler(async ({ context }) => {
            const { wakes, unreadable } = await services.heldWakes.read();
            const reads = conversationReader(context.identity, registryProvenance(services.agents));
            return { approvals: wakes.filter((wake) => reads(wake.conversationId)), unreadable };
        }),
        // Approve a held wake: run it now with its snapshotted payload (the guard already ran when it was held); then
        // drop the queue entry. The owner's yes is recorded against the hold before it leaves and checked as it does
        // (held-wakes-store.ts), and only a person's session gives it: a program approving its own wake is the very thing
        // the hold exists to stop.
        // Detached like the /fire webhook: the turn outlives this request.
        approve: i.approve.handler(async ({ input, context }) => {
            await requireMaintainer(services, context.headers, "only the owner or a maintainer, signed in, can release a held wake; a program's token cannot");
            const pending = await approveAndRelease(services, input.id, context.identity?.email).catch((error: unknown) => {
                    // A hold this build cannot read is never run on a guess at what it snapshotted; the message names the file.
                    if (error instanceof ManifestUnreadableError || error instanceof HeldWakeNotApproved) {
                        throw new ORPCError("CONFLICT", { message: error.message });
                    }
                    throw error;
                });
            // Only the caller whose release took the entry runs it: a second approval, or the countdown release, already did.
            if (pending === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no pending approval with that id" });
            }
            const automation = await services.automations.get(pending.automationId);
            // The ask is answered, so it comes off the lock screen whatever happens next.
            void withdrawApprovalPush(services, pending.automationId);
            if (automation === undefined) {
                await forgetHeldWake(services, pending.id);
                throw new ORPCError("NOT_FOUND", { message: "the automation for that approval no longer exists" });
            }
            // Everything the hold snapshotted rides runHeldWake, the same release the scheduler's countdown scan uses.
            // So the two paths out of the queue cannot drift.
            void runHeldWake(services, automation, pending).catch((error: unknown) =>
                services.logger.error({ err: error, automation: automation.id }, "approved automation run failed"),
            );
            return { ok: true } as const;
        }),
        // Reject a held wake: it never runs, and everyone it was waiting on hears so (held-wake-answers.ts). Read before
        // the remove, which only says whether this caller took it, so the answer knows whose it was.
        reject: i.reject.handler(async ({ input }) => {
            const pending = await services.heldWakes.get(input.id);
            if (!(await services.heldWakes.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "no pending approval with that id" });
            }
            if (pending !== undefined) {
                await declineHeldWake(services, pending);
            }
            return { ok: true } as const;
        }),
    };
};
