import { randomBytes } from "node:crypto";
import { automationsContract, FRONT_DESK_PERSONA } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { Cron } from "croner";
import { streamAgent } from "../agent/agent.routes.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { reconcileListenerProcesses } from "../extensions/extension-processes.js";
import { ensureFrontDeskPersona } from "../personas/front-desk.js";
import type { AutomationRecord } from "./automations-store.js";
import { automationCatalog, triggerSourceEvents } from "./catalog.js";
import { fireAutomation, runHeldWake } from "./scheduler.js";

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
        catalog: i.catalog.handler(async () => await automationCatalog(services)),
        upsert: i.upsert.handler(async ({ input }) => {
            if (input.trigger.kind === "schedule") {
                try {
                    new Cron(input.trigger.cron).nextRun();
                } catch {
                    throw new ORPCError("BAD_REQUEST", { message: "invalid cron expression" });
                }
            }
            /* A listener trigger's provider/eventType are open strings in the schema — validated here against the
             * SAME catalogue the composer draws from, so what the editor can offer and what this will accept
             * cannot disagree. They used to be two hand-written lists in two packages, which is a disagreement
             * waiting for whichever one was edited second.
             *
             * A source with no event types narrows to none (webchat's single kind needs no picker), so the
             * provider is checked first and the event type only when one was named. */
            if (input.trigger.kind === "listener") {
                const { provider, eventType } = input.trigger;
                const events = triggerSourceEvents(await automationCatalog(services)).get(provider);
                if (events === undefined) {
                    throw new ORPCError("BAD_REQUEST", {
                        message: `unknown listener provider "${provider}" — install the extension that declares it`,
                    });
                }
                if (eventType !== undefined && events.size > 0 && !events.has(eventType)) {
                    throw new ORPCError("BAD_REQUEST", { message: `provider "${provider}" has no event type "${eventType}"` });
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
            /* A DOORBELL PINNED TO THE FRONT DESK BRINGS THAT CARD INTO BEING. Nothing seeds personas any more, so
             * the card this wake names may not exist yet — and turnPersona answers a named-but-missing card by
             * denying everything, which would make a freshly installed public chat one that cannot even read.
             * Written here rather than by the surface that installed it, so a Doorbell arriving through any
             * route — the composer, a hand-edited manifest, an extension — lands with its bound present and
             * visible on the Personas page. Awaited: the wake it bounds can fire the moment this returns. */
            if (automation.actsAs === FRONT_DESK_PERSONA) {
                await ensureFrontDeskPersona(services.personas).catch((error: unknown) =>
                    services.logger.warn(
                        { err: error, automation: automation.id },
                        "front desk persona not created — the wake it names will be denied everything",
                    ),
                );
            }
            // The first enabled listener automation is what materializes its provider's gateway process (and the
            // last one's removal below stops it) — detached, the gateway's own poll handles the rest.
            void reconcileListenerProcesses(services);
            return { ok: true } as const;
        }),
        setEnabled: i.setEnabled.handler(async ({ input }) => {
            if (!(await services.automations.setEnabled(input.id, input.enabled))) {
                throw new ORPCError("NOT_FOUND", { message: "no automation with that id" });
            }
            void reconcileListenerProcesses(services);
            return { ok: true } as const;
        }),
        remove: i.remove.handler(async ({ input }) => {
            if (!(await services.automations.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "no automation with that id" });
            }
            void reconcileListenerProcesses(services);
            return { ok: true } as const;
        }),
        // Run now — see the contract for why this fires the real path, runs the guard, skips only the approval
        // gate, and fires even when the automation is switched off.
        run: i.run.handler(async ({ input }) => {
            const automation = await services.automations.get(input.id);
            if (automation === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no automation with that id" });
            }
            void fireAutomation(services, automation, streamAgent, { cleared: "approval" }).catch((error: unknown) =>
                services.logger.error({ err: error, automation: automation.id }, "by-hand automation run failed"),
            );
            return { ok: true } as const;
        }),
        pendingList: i.pendingList.handler(async () => ({ approvals: await services.approvals.list() })),
        // Approve a held wake: run it now with its snapshotted payload (`cleared: "both"` — its guard ran when the
        // wake was held and the owner has now approved it), then drop the queue entry. Detached like the /fire
        // webhook — the turn outlives this request.
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
            // Everything the hold snapshotted — payload, provenance, thread — rides runHeldWake, the same
            // release the scheduler's countdown scan uses, so the two ways out of the queue cannot drift.
            void runHeldWake(services, automation, pending, streamAgent).catch((error: unknown) =>
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
