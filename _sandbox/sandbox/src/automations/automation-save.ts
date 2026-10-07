import { type Automation, type AutomationCatalog, cronOptions, VISITOR_CHAT_PERSONA } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import { Cron } from "croner";
import { type DoorKind, doorChange } from "../auth/tokens/door-tokens.js";
import type { Services } from "../composition.js";
import { reconcileListenerProcesses } from "../extensions/extension-processes.js";
import { ensureVisitorChatPersona } from "../personas/visitor-chat.js";
import { automationCatalog, ISSUES_PROVIDER, triggerSourceEvents } from "./catalog.js";
import { sandboxZone, zoneOf } from "./schedule-zone.js";
import { sourceProblem } from "./watch/watch-sources.js";

// What saving an automation refuses and what it brings into being, shared by the Automations page's upsert route and an
// agent's proposal approved on its card (needs/kinds/automation-need.ts), so the two can never hold an automation to
// different rules. Every refusal is a BAD_REQUEST naming what to change.

// A moment already gone cannot be waited for. Refused at both doors that could arm one — saving a new automation, and
// flipping a spent one back on — since the tick fires an overdue `once` on its next pass, so arming one dated
// yesterday would not "schedule" anything, it would fire on the spot.
export const refusePastMoment = (trigger: Automation["trigger"], now: number): void => {
    if (trigger.kind === "once" && trigger.at <= now) {
        throw new ORPCError("BAD_REQUEST", { message: "that moment has already passed; pick a new one to arm this again" });
    }
};

// An end date already gone ends the automation on the next tick, so saving or re-arming one would only switch it off
// again: refused at the same two doors as a past moment.
export const refusePastEnd = (automation: Pick<Automation, "expiresAt">, now: number): void => {
    if (automation.expiresAt !== undefined && automation.expiresAt <= now) {
        throw new ORPCError("BAD_REQUEST", { message: "its end date has already passed; set a later one, or none" });
    }
};

// The watch fields' rules across fields, which the schema cannot state one field at a time: one check, not two; a
// change needs something to compare; a new agent needs a model to run on; a conversation must be there to continue;
// and a listener answers whoever wrote, so it only ever starts an agent.
const refuseMisshapenWatch = (services: Services, automation: Automation): void => {
    if (automation.guard !== undefined && automation.source !== undefined) {
        throw new ORPCError("BAD_REQUEST", {
            message: "give it a guard command or a ready-made source, not both: what the check saw has to mean one thing",
        });
    }
    if (automation.fireOn === "change" && automation.guard === undefined && automation.source === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "firing only on a change needs a check to compare: give it a guard command or a source" });
    }
    const problem = automation.source === undefined ? undefined : sourceProblem(automation.source);
    if (problem !== undefined) {
        throw new ORPCError("BAD_REQUEST", { message: problem });
    }
    const target = automation.target ?? { kind: "agent" as const };
    if (target.kind === "agent" && (automation.models === undefined || automation.models.length === 0)) {
        throw new ORPCError("BAD_REQUEST", { message: "a new agent needs a model to run on: pick at least one" });
    }
    if (target.kind === "conversation" && services.agents.entry(target.conversationId) === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: `there is no conversation ${target.conversationId} to continue` });
    }
    if (target.kind !== "agent" && automation.trigger.kind === "listener") {
        throw new ORPCError("BAD_REQUEST", {
            message: "an automation that listens for messages answers whoever wrote, so it can only start an agent",
        });
    }
};

// Which door an automation opens, if any: the kind its credential is filed under (auth/tokens/door-tokens.ts).
// An event trigger is a webhook; a bug intake takes a key from clients with no origin; everything else has no
// credential to mint.
export const doorOf = (automation: Automation): DoorKind | undefined => {
    if (automation.trigger.kind === "event") {
        return "automation";
    }
    return automation.trigger.kind === "listener" && automation.trigger.provider === ISSUES_PROVIDER ? "intake" : undefined;
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

// Everything saving an automation refuses, each refusal a BAD_REQUEST naming what to change: shared by the upsert route
// and an approved automation need (needs/kinds/automation-need.ts), so an agent's proposal is held to exactly what the
// Automations page is. `upsert` validates the cron with the scheduler's own parser, so what's accepted is what will fire.
export const refuseInvalidAutomation = async (services: Services, automation: Automation): Promise<void> => {
    refusePastMoment(automation.trigger, Date.now());
    refusePastEnd(automation, Date.now());
    refuseMisshapenWatch(services, automation);
    if (automation.trigger.kind === "schedule") {
        // Both halves matter: a pattern that won't parse, and one that parses into a moment that can never
        // come (a fixed date in the past, the 30th of February). The second used to be accepted and then sit
        // there reading as armed, since "no next run" is also what a switched-off row shows.
        // Resolved BEFORE the try, which covers the cron parse and nothing else: a settings read that fails
        // means the daemon could not answer, and reporting that as "invalid cron expression" would send the
        // owner to edit a schedule that was never the problem.
        const zone = zoneOf(automation.trigger, await sandboxZone(services));
        let next: Date | null;
        try {
            // In the zone it will actually be fired in, so "never fires" is judged against the same clock the
            // tick uses rather than the container's.
            next = new Cron(automation.trigger.cron, cronOptions(zone)).nextRun();
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
    if (automation.trigger.kind === "listener") {
        const { provider, eventType } = automation.trigger;
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
    refuseMisplacedSenders(automation, await automationCatalog(services));
};

// Saves an automation already checked, and brings into being what it needs: its door's credential, the Visitor chat's
// persona, its listener's gateway process.
export const saveAutomation = async (services: Services, automation: Automation): Promise<void> => {
    await services.automations.upsert(automation);
    // The door's credential is minted with the door, never stored in the manifest; a re-post of the same record
    // keeps it, so an edit can't rotate a live credential out from under a shipped caller.
    // A trigger that changed kind drops the credential the old door held.
    // A door file this build cannot read refuses the credential (CONFLICT naming it); the record above is saved.
    const door = doorOf(automation);
    await doorChange(
        Promise.all(
            (["automation", "intake"] as const).map((kind) =>
                kind === door ? services.doorTokens.ensure(kind, automation.id) : services.doorTokens.remove(kind, automation.id),
            ),
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
};
