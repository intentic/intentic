import { randomBytes } from "node:crypto";
import { automationsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { Cron } from "croner";
import { streamAgent } from "../agent/agent.routes.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import type { AutomationRecord } from "./automations-store.js";
import { fireAutomation } from "./scheduler.js";

// An invalid cron can only come from a hand-edited manifest (upsert rejects it) — surface "no next run"
// rather than failing the whole list. Event automations have no next run; they fire on their webhook.
const nextRunOf = (automation: AutomationRecord): number | undefined => {
    if (!automation.enabled || automation.trigger.kind !== "schedule") {
        return undefined;
    }
    try {
        return new Cron(automation.trigger.cron).nextRun()?.getTime();
    } catch {
        return undefined;
    }
};

// The automations manifest routes. `upsert` validates the cron with the scheduler's own parser, so what's
// accepted here is exactly what will fire.
export const createAutomationsRoutes = (services: Services) => {
    const i = implement(automationsContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async () => ({
            // The records are this handler's own fresh read, so annotating them in place is safe.
            automations: (await services.automations.list()).map((automation) => {
                const nextRun = nextRunOf(automation);
                return nextRun !== undefined ? Object.assign(automation, { nextRun }) : automation;
            }),
        })),
        upsert: i.upsert.handler(async ({ input }) => {
            if (input.trigger.kind === "schedule") {
                try {
                    new Cron(input.trigger.cron).nextRun();
                } catch {
                    throw new ORPCError("BAD_REQUEST", { message: "invalid cron expression" });
                }
            }
            // Event: keep the round-tripped token (the enabled toggle re-posts the trigger) or mint the
            // webhook's auth token — /automations/{id}/fire compares against it. Listener triggers need no
            // provisioning: the listeners reconcile tick picks them up within its interval.
            const automation =
                input.trigger.kind === "event" && input.trigger.token === undefined
                    ? { ...input, trigger: { ...input.trigger, token: randomBytes(24).toString("base64url") } }
                    : input;
            await services.automations.upsert(automation);
            return { ok: true } as const;
        }),
        remove: i.remove.handler(async ({ input }) => {
            if (!(await services.automations.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "no automation with that id" });
            }
            return { ok: true } as const;
        }),
        pendingList: i.pendingList.handler(async () => ({ approvals: await services.approvals.list() })),
        // Approve a held wake: run it now with its snapshotted payload (preApproved skips the guard + gate), then
        // drop the queue entry. Detached like the /fire webhook — the turn outlives this request.
        approve: i.approve.handler(async ({ input }) => {
            const pending = await services.approvals.get(input.id);
            if (pending === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no pending approval with that id" });
            }
            const automation = await services.automations.get(pending.automationId);
            await services.approvals.remove(input.id);
            if (automation === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "the automation for that approval no longer exists" });
            }
            void fireAutomation(services, automation, pending.payload, streamAgent, true).catch((error: unknown) =>
                services.logger.error({ err: error, automation: automation.id }, "approved automation run failed"),
            );
            return { ok: true } as const;
        }),
        reject: i.reject.handler(async ({ input }) => {
            if (!(await services.approvals.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "no pending approval with that id" });
            }
            return { ok: true } as const;
        }),
    };
};
