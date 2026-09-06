import { type Automation, type AutomationSummary, automationsContract, FRONT_DESK_PERSONA } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { Cron } from "croner";
import { streamAgent } from "../agent/routes/agent.routes.js";
import type { DoorKind } from "../auth/door-tokens.js";
import { operatorHere } from "../auth/operator.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { reconcileListenerProcesses } from "../extensions/extension-processes.js";
import { ISSUES_PROVIDER } from "../issues/provider.js";
import { ensureFrontDeskPersona } from "../personas/front-desk.js";
import type { AutomationRecord } from "./automations-store.js";
import { automationCatalog, triggerSourceEvents } from "./catalog.js";
import { fireAutomation, runHeldWake } from "./scheduler.js";

// An invalid cron can only come from a hand-edited manifest (upsert rejects it), surface "no next run"
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

/* WHICH DOOR AN AUTOMATION OPENS, if any: the kind its credential is filed under in the door store
 * (auth/door-tokens.ts). An event trigger is a webhook; a bug intake takes a key from clients with no origin.
 * Everything else is reached by nothing outside the sandbox and has no credential to mint, rotate or show. */
const doorOf = (automation: Automation): DoorKind | undefined => {
    if (automation.trigger.kind === "event") {
        return "automation";
    }
    return automation.trigger.kind === "listener" && automation.trigger.provider === ISSUES_PROVIDER ? "intake" : undefined;
};

/* THE LISTED RECORD, with its door's credential attached for an OPERATOR and for nobody else. A viewer may read
 * the list (it is what the Automations view is), and so may a program holding a `read` control token, and
 * neither may walk away with the string that fires the door. The credential is minted here if the door has
 * none yet, so an automation declared before the store existed gets its URL the first time an operator looks. */
const listed = async (services: Services, automation: AutomationRecord, operator: boolean): Promise<AutomationSummary> => {
    const nextRun = nextRunOf(automation);
    const door = doorOf(automation);
    const summary: AutomationSummary = { ...automation, ...(nextRun !== undefined ? { nextRun } : {}) };
    if (!operator || door === undefined) {
        return summary;
    }
    const token = await services.doorTokens.ensure(door, automation.id);
    return door === "automation" ? { ...summary, webhookToken: token } : { ...summary, ingestKey: token };
};

// The automations manifest routes. `upsert` validates the cron with the scheduler's own parser, so what's
// accepted here is exactly what will fire.
export const createAutomationsRoutes = (services: Services) => {
    const i = implement(automationsContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async ({ context }) => {
            const operator = operatorHere(services, context);
            return { automations: await Promise.all((await services.automations.list()).map((automation) => listed(services, automation, operator))) };
        }),
        catalog: i.catalog.handler(async () => await automationCatalog(services)),
        upsert: i.upsert.handler(async ({ input }) => {
            if (input.trigger.kind === "schedule") {
                try {
                    new Cron(input.trigger.cron).nextRun();
                } catch {
                    throw new ORPCError("BAD_REQUEST", { message: "invalid cron expression" });
                }
            }
            /* A listener trigger's provider/eventType are open strings in the schema, validated here against the
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
                        message: `unknown listener provider "${provider}", install the extension that declares it`,
                    });
                }
                if (eventType !== undefined && events.size > 0 && !events.has(eventType)) {
                    throw new ORPCError("BAD_REQUEST", { message: `provider "${provider}" has no event type "${eventType}"` });
                }
            }
            const automation = input;
            await services.automations.upsert(automation);
            /* The door's credential is minted with the door, never stored in the manifest that declares it. A
             * re-post of the same record (the enabled toggle, an edit to the wording) finds it already minted and
             * keeps it, which is what stops an edit from rotating a live credential out from under a shipped
             * caller; a trigger that changed KIND drops the credential the old door held. */
            const door = doorOf(automation);
            await Promise.all(
                (["automation", "intake"] as const).map((kind) =>
                    kind === door ? services.doorTokens.ensure(kind, automation.id) : services.doorTokens.remove(kind, automation.id),
                ),
            );
            /* A FRONT DESK PINNED TO THE FRONT DESK BRINGS THAT CARD INTO BEING. Nothing seeds personas any more, so
             * the card this wake names may not exist yet, and turnPersona answers a named-but-missing card by
             * denying everything, which would make a freshly installed public chat one that cannot even read.
             * Written here rather than by the surface that installed it, so a Front Desk arriving through any
             * route, the composer, a hand-edited manifest, an extension, lands with its bound present and
             * visible on the Personas page. Awaited: the wake it bounds can fire the moment this returns. */
            if (automation.actsAs === FRONT_DESK_PERSONA) {
                await ensureFrontDeskPersona(services.personas).catch((error: unknown) =>
                    services.logger.warn(
                        { err: error, automation: automation.id },
                        "front desk persona not created: the wake it names will be denied everything",
                    ),
                );
            }
            // The first enabled listener automation is what materializes its provider's gateway process (and the
            // last one's removal below stops it), detached, the gateway's own poll handles the rest.
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
            // The door is gone; so is what opened it.
            await Promise.all([services.doorTokens.remove("automation", input.id), services.doorTokens.remove("intake", input.id)]);
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
            return { token: await services.doorTokens.rotate(door, automation.id) };
        }),
        // Run now, see the contract for why this fires the real path, runs the guard, skips only the approval
        // gate, and fires even when the automation is switched off.
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
            void fireAutomation(services, automation, streamAgent, { cleared: "approval" }).catch((error: unknown) =>
                services.logger.error({ err: error, automation: automation.id }, "by-hand automation run failed"),
            );
            return { ok: true } as const;
        }),
        pendingList: i.pendingList.handler(async () => ({ approvals: await services.heldWakes.list() })),
        // Approve a held wake: run it now with its snapshotted payload (`cleared: "both"`, its guard ran when the
        // wake was held and the owner has now approved it), then drop the queue entry. Detached like the /fire
        // webhook, the turn outlives this request.
        approve: i.approve.handler(async ({ input }) => {
            const pending = await services.heldWakes.get(input.id);
            if (pending === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no pending approval with that id" });
            }
            const automation = await services.automations.get(pending.automationId);
            await services.heldWakes.remove(input.id);
            if (automation === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "the automation for that approval no longer exists" });
            }
            // Everything the hold snapshotted, payload, provenance, thread, rides runHeldWake, the same
            // release the scheduler's countdown scan uses, so the two ways out of the queue cannot drift.
            void runHeldWake(services, automation, pending, streamAgent).catch((error: unknown) =>
                services.logger.error({ err: error, automation: automation.id }, "approved automation run failed"),
            );
            return { ok: true } as const;
        }),
        reject: i.reject.handler(async ({ input }) => {
            if (!(await services.heldWakes.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "no pending approval with that id" });
            }
            return { ok: true } as const;
        }),
    };
};
