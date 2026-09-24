import { type Automation, type AutomationCatalog, type AutomationSummary, automationsContract, cronOptions, VISITOR_CHAT_PERSONA, type Zone } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { Cron } from "croner";
import type { DoorKind } from "../auth/door-tokens.js";
import { operatorHere } from "../auth/operator.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { reconcileListenerProcesses } from "../extensions/extension-processes.js";
import { automationCatalog, ISSUES_PROVIDER, triggerSourceEvents } from "./catalog.js";
import { ensureVisitorChatPersona } from "../personas/visitor-chat.js";
import type { AutomationRecord } from "./automations-store.js";
import { sandboxZone, zoneOf } from "./schedule-zone.js";
import { fireAutomation, nextRunOf, runHeldWake } from "./scheduler.js";
import { ManifestUnreadableError } from "../store/json-file.js";

// A moment already gone cannot be waited for. Refused at both doors that could arm one — saving a new automation, and
// flipping a spent one back on — since the tick fires an overdue `once` on its next pass, so arming one dated
// yesterday would not "schedule" anything, it would fire on the spot.
const refusePastMoment = (trigger: Automation["trigger"], now: number): void => {
    if (trigger.kind === "once" && trigger.at <= now) {
        throw new ORPCError("BAD_REQUEST", { message: "that moment has already passed; pick a new one to arm this again" });
    }
};

// Which door an automation opens, if any: the kind its credential is filed under (auth/door-tokens.ts).
// An event trigger is a webhook; a bug intake takes a key from clients with no origin; everything else has no
// credential to mint.
const doorOf = (automation: Automation): DoorKind | undefined => {
    if (automation.trigger.kind === "event") {
        return "automation";
    }
    return automation.trigger.kind === "listener" && automation.trigger.provider === ISSUES_PROVIDER ? "intake" : undefined;
};

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
    const token = await services.doorTokens.ensure(door, automation.id);
    return door === "automation" ? { ...summary, webhookToken: token } : { ...summary, ingestKey: token };
};

// Sender rules match `author.id`, so they are only accepted on a listener whose source promised that id is an identity
// it vouches for (TriggerSource.sender); the Visitor chat keeps its own `access` instead, and nothing else has a sender.
const refuseMisplacedSenders = (automation: Automation, catalog: AutomationCatalog): void => {
    if (automation.senders === undefined) {
        return;
    }
    if (automation.trigger.kind !== "listener") {
        throw new ORPCError("BAD_REQUEST", { message: "sender rules only apply to an automation that listens for messages" });
    }
    const { provider } = automation.trigger;
    if (catalog.sources.find((source) => source.provider === provider)?.sender === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: `provider "${provider}" does not identify who is writing, so it cannot carry sender rules` });
    }
};

// Whether any wake of this automation would wear the stock visitor-chat card: its own persona, or a sender rule's.
const namesVisitorChat = (automation: Automation): boolean =>
    automation.actsAs === VISITOR_CHAT_PERSONA || (automation.senders?.rules.some((rule) => rule.actsAs === VISITOR_CHAT_PERSONA) ?? false);

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
        // Who has written to a source, admitted or not; the picker offers these by name and stores the id.
        senders: i.senders.handler(async ({ input }) => ({ senders: await services.senders.list(input.provider) })),
        upsert: i.upsert.handler(async ({ input }) => {
            refusePastMoment(input.trigger, Date.now());
            if (input.trigger.kind === "schedule") {
                // Both halves matter: a pattern that won't parse, and one that parses into a moment that can never
                // come (a fixed date in the past, the 30th of February). The second used to be accepted and then sit
                // there reading as armed, since "no next run" is also what a switched-off row shows.
                // Resolved BEFORE the try, which covers the cron parse and nothing else: a settings read that fails
                // means the daemon could not answer, and reporting that as "invalid cron expression" would send the
                // owner to edit a schedule that was never the problem.
                const zone = zoneOf(input.trigger, await sandboxZone(services));
                let next: Date | null;
                try {
                    // In the zone it will actually be fired in, so "never fires" is judged against the same clock the
                    // tick uses rather than the container's.
                    next = new Cron(input.trigger.cron, cronOptions(zone)).nextRun();
                } catch {
                    throw new ORPCError("BAD_REQUEST", { message: "invalid cron expression" });
                }
                if (next === null) {
                    throw new ORPCError("BAD_REQUEST", { message: "that schedule has no next run, so it would never fire" });
                }
            }
            // A listener trigger's provider/eventType are open strings in the schema, validated here against the same
            // catalogue the composer draws from.
            // A source with no event types narrows to none, so the provider is checked first and the event type only
            // when one was named.
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
            refuseMisplacedSenders(input, await automationCatalog(services));
            const automation = input;
            await services.automations.upsert(automation);
            // The door's credential is minted with the door, never stored in the manifest; a re-post of the same record
            // keeps it, so an edit can't rotate a live credential out from under a shipped caller.
            // A trigger that changed kind drops the credential the old door held.
            const door = doorOf(automation);
            await Promise.all(
                (["automation", "intake"] as const).map((kind) =>
                    kind === door ? services.doorTokens.ensure(kind, automation.id) : services.doorTokens.remove(kind, automation.id),
                ),
            );
            // A Visitor chat pinned to the Visitor chat persona brings that card into being: turnPersona denies everything
            // to a named-but-missing card, which would leave a fresh public chat unable to read.
            // Written here so a Visitor chat arriving through any route lands with its persona already present; awaited
            // since the wake it bounds can fire the moment this returns.
            if (namesVisitorChat(automation)) {
                await ensureVisitorChatPersona(services.personas).catch((error: unknown) =>
                    services.logger.warn(
                        { err: error, automation: automation.id },
                        "visitor chat persona not created: the wake it names will be denied everything",
                    ),
                );
            }
            // The first enabled listener automation materializes its gateway process; the last one's removal stops it.
            void reconcileListenerProcesses(services);
            return { ok: true } as const;
        }),
        setEnabled: i.setEnabled.handler(async ({ input }) => {
            const existing = await services.automations.get(input.id);
            if (existing !== undefined && input.enabled) {
                refusePastMoment(existing.trigger, Date.now());
            }
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
        pendingList: i.pendingList.handler(async () => ({ approvals: await services.heldWakes.list() })),
        // Approve a held wake: run it now with its snapshotted payload (the guard already ran when it was held); then
        // drop the queue entry.
        // Detached like the /fire webhook: the turn outlives this request.
        approve: i.approve.handler(async ({ input }) => {
            const pending = await services.heldWakes.get(input.id).catch((error: unknown) => {
                // A hold this build cannot read is never run on a guess at what it snapshotted; the message names the file.
                if (error instanceof ManifestUnreadableError) {
                    throw new ORPCError("CONFLICT", { message: error.message });
                }
                throw error;
            });
            if (pending === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no pending approval with that id" });
            }
            const automation = await services.automations.get(pending.automationId);
            // Only the caller whose remove took the entry runs it: a second approval, or the countdown release, already did.
            if (!(await services.heldWakes.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "that approval was already released" });
            }
            if (automation === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "the automation for that approval no longer exists" });
            }
            // Everything the hold snapshotted rides runHeldWake, the same release the scheduler's countdown scan uses.
            // So the two paths out of the queue cannot drift.
            void runHeldWake(services, automation, pending).catch((error: unknown) =>
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
