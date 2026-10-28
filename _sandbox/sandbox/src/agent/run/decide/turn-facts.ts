import { join } from "node:path";
import { FIELD_NOTES_FILE } from "@intentic/constants";
import type { Area } from "@intentic/sandbox-contract/schemas/areas";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { ConversationGrant } from "@intentic/sandbox-contract/schemas/needs";
import type { CredentialGate } from "@intentic/sandbox-contract/schemas/secrets";
import type { HelperOnly } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { Persona } from "@intentic/sandbox-contract/schemas/personas";
import type { Rule, SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import type { Services } from "../../../composition.js";
import { readPersonaPrompt } from "../../../personas/persona-kit.js";
import type { ShortMemory } from "@intentic/constants/memory-room";
import type { ServiceabilityDeps } from "../../../usage/serviceability/serviceability.js";
import { repoCheckRules } from "../../../rules/repo-checks.js";
import { createCredentialGrants, type CredentialGrants } from "../../../secrets/credential-grants.js";
import type { ConversationReach } from "../../../secrets/credential-reach.js";
import type { ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import { LANDING_CHECKS_NOTE } from "../../prompt/checks-note.js";
import { resolveWithin } from "../../../workspace/files/workspace-files-paths.js";
import type { ProjectSetupStatus } from "../../../workspace/layout/workspace-setup.js";
import { contextNoteIfDue } from "../../context/conversation-context.js";
import { type FreshFacts, freshFactsIfAny } from "../../context/fresh-session.js";
import { homeNoteIfDue } from "../../../conversations/home/home-policy.js";
import { type AccountRoute, offBlockedAccount } from "../../providers/accounts/blocked-account.js";
import { cacheCold, placeCold } from "../../providers/accounts/account-placement.js";
import { type ReachedRoute, routeWithinReach } from "./account-reach.js";
import { endpointIdOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { routingFor } from "../../../conversations/registry/routing.js";
import { type FieldNotes, fieldNotes } from "@intentic/agent-context/field-notes";
import { type IqSearchTeaching, iqSearchInstruction } from "../../prompt/iq-search-instruction.js";
import { type DeclaredWindow, servedEndpointModel, windowOf } from "../../prompt/window/context-budget.js";
import { workspaceMapNote } from "@intentic/agent-context/workspace-map";
import { workspaceMemoryNote } from "../../prompt/workspace-memory.js";
import { fieldNotesPinsAt } from "../../prompt/field-notes-pins.js";
import { compactedSinceLastTurn, pinnedAccount } from "../../../conversations/registry/agents-store.js";
import type { RoutedTurn, TurnInput } from "../../../seams/turn-starter.js";
import { retrieveTurnContext, type TurnContextOutcome } from "../turn/turn-context.js";
import type { TurnContext } from "../../providers/adapter.js";
import type { PrivacyRefusal } from "@intentic/sandbox-contract/schemas/privacy-egress";
import { opt } from "../../../opt.js";
import { EXPERIMENTS } from "./experiments.js";
import { type ConversationEntry, notesDue, type TurnPremise, type TurnRuntime, premiseOf, turnRuntime } from "./turn-premise.js";
import { skillsUnseen, type TurnSkillCatalog, turnSkillCatalog } from "./turn-skills.js";
import { runtimeRoute } from "../../../privacy/privacy-trust.js";

// Every read a turn is planned on, each timed under the `turn.plan.*` span diagnostics read and run beside the others
// wherever nothing orders them, so the decision after it is pure. A read that hinges on a decision waits for the premise.

// The resource budget held the turn (a person once per spell, background work once it waited out its deadline):
// nothing else is read.
export interface HeldTurnFacts {
    readonly held: { readonly message: string; readonly memory?: ShortMemory };
}

export interface AdmittedTurnFacts {
    // The workspace root as the daemon reaches it; a turn whose tree is anywhere else is isolated.
    readonly root: string;
    readonly entry: ConversationEntry | undefined;
    // The owner's own, before the checks the repositories declare join their rules.
    readonly settings: SandboxSettings;
    readonly repoChecks: readonly Rule[];
    // What the model publishes as its window; undefined for every native provider and an unknown endpoint model.
    readonly declared: DeclaredWindow | undefined;
    // Set where the endpoint's catalog marks the model as able to run one-shot jobs only, never a turn; absent for
    // every native provider and every model nothing has said that of.
    readonly helperOnly?: { readonly label: string; readonly reason: HelperOnly };
    // Why the privacy shield refuses this turn: it is on, the provider is untrusted, and the runtime is one the gateway
    // cannot stand in front of. Absent: it may run.
    readonly privacyRefusal?: PrivacyRefusal;
    // Everything the owner installed, before any persona or gate narrows it.
    readonly installed: readonly Capability[];
    // Dependency readiness of the main checkout; empty where the probe was skipped.
    readonly setup: readonly ProjectSetupStatus[];
    readonly personas: readonly Persona[];
    readonly areas: readonly Area[];
    // What a person allowed this conversation beyond its persona, if anything.
    readonly grant: ConversationGrant | undefined;
    // The skills the runtime's loader does not read, on a turn whose session holds no note of them; rendered once the
    // persona is known, so a skill this turn may not use is never offered (honoured.ts).
    readonly skillCatalog: TurnSkillCatalog | undefined;
    readonly contextNote: TurnNote | undefined;
    // A fresh session's account of the work it started from (context/fresh-session.ts); absent for any other conversation.
    readonly fresh?: FreshFacts;
    // A home conversation's policy (conversations/home/home-policy.ts), on the turns that owe it; absent for any other.
    readonly homeNote?: TurnNote;
    // Undefined when retrieval was never attempted, which is a different fact from a lookup that skipped.
    readonly turnContext: TurnContextOutcome | undefined;
    readonly gates: readonly CredentialGate[];
    // The releases this conversation held for those gates when they were read.
    readonly releases: CredentialGrants;
    // What the people this conversation works for may spend; outside it, nothing is mounted and nothing is released.
    readonly reach: ConversationReach;
    // The most its tools may be, from the same principals; the premise caps the persona with it (turn-premise.ts).
    readonly ceiling: ToolCeiling | undefined;
    readonly iqTeaching: IqSearchTeaching | undefined;
    // Read on both arms of its experiment, so a control turn can still name the revision it was withheld from.
    readonly fieldNotes: FieldNotes | undefined;
    // The card's own PROMPT.md, read only for a card whose prompt mode is `custom`.
    readonly personaPrompt: string | undefined;
    // The owner's standing instructions, from the root down to the start folder.
    readonly memoryNote: string | undefined;
    // Read only when the map is due, so present only on a turn that sends it.
    readonly mapNote: string | undefined;
    // What checks the work (nothing here, CI after a push); present only on a turn that owes it.
    readonly landingChecksNote: TurnNote | undefined;
    readonly sessionStore: string;
    // Where a turn goes when the account its conversation remembers is blocked, or when the people it works for may not
    // run it where it was routed (account-reach.ts); absent is `keep`.
    readonly accountRoute?: ReachedRoute;
}

export type TurnFacts = HeldTurnFacts | AdmittedTurnFacts;

// What the manifests hold, read together: nothing in here waits on another, and a read skipped is skipped for a fact
// the turn already carries.
const manifests = (
    services: TurnFactsDeps,
    input: TurnInput,
    context: TurnContext,
    entry: ConversationEntry | undefined,
    runtime: TurnRuntime,
    settings: SandboxSettings,
) => {
    const { capabilities, conversationTurns } = runtime;
    // A home's session opened fresh (home-rollover.ts), seeded from the record rather than resumed: the notes its old
    // session carried are not in this one, so they ride again.
    const homeFresh = entry?.identity.home === true && context.base.spec.sessionId === undefined;
    return Promise.all([
        // What the owner installed, not the persona-filtered record, which answers what a runtime can do instead.
        services.perf.track("turn.plan.capabilities", {}, () => services.capabilities.list()),
        // Of the main checkout, which an isolated worktree only mounts; not for a runtime with its own deps server or a resumed session.
        capabilities.mcp === "full" || context.base.spec.sessionId !== undefined
            ? Promise.resolve([])
            : services.perf.track("turn.plan.deps", {}, () => services.dependencies.status()),
        // Unconditionally: an unattended wake naming nobody must still resolve to "no accounts".
        services.perf.track("turn.plan.personas", {}, () => services.personas.list()),
        // Both halves of the turn's fence, the conversation's and its persona's, resolve through this.
        services.perf.track("turn.plan.areas", {}, () => services.areas.list()),
        // The skills the runtime's loader does not read (turn-skills.ts), with paths as the agent sees them, whenever its
        // session holds no earlier note of them.
        skillsUnseen(capabilities.skillDiscovery) && notesDue(conversationTurns, context.base.spec.sessionId, entry)
            ? services.perf.track("turn.plan.skills", {}, async () =>
                  turnSkillCatalog(
                      capabilities.skillDiscovery,
                      { localCwd: context.localCwd, effectiveCwd: context.effectiveCwd, builtIn: services.config.builtInSkillsDir },
                      await services.personas.list(),
                  ),
              )
            : Promise.resolve(undefined),
        services.perf.track("turn.plan.context", {}, () => contextNoteIfDue(services, input, entry, conversationTurns, homeFresh)),
        // Every turn, never cached: a check the owner switched off this morning must not keep running.
        services.perf.track("turn.plan.repo-checks", {}, () => repoCheckRules(services)),
        // Beside the rest rather than ahead of it, on its own deadline: a turn must not wait on an optimisation.
        services.config.iqTurnContext && EXPERIMENTS.turnContext.on(settings)
            ? services.perf.track("turn.plan.turn-context", {}, () => retrieveTurnContext({ iq: services.iq, logger: services.logger }, input.prompt))
            : Promise.resolve(undefined),
        // After the checkout is composed, which is what says whether a fresh session was cut from its origin's work.
        entry?.identity.fresh === undefined
            ? Promise.resolve(undefined)
            : services.perf.track("turn.plan.fresh", {}, () => freshFactsIfAny(services, input.conversationId, entry, conversationTurns)),
        entry?.identity.home === true
            ? services.perf.track("turn.plan.home", {}, () => homeNoteIfDue(services, entry, conversationTurns, homeFresh))
            : Promise.resolve(undefined),
    ]);
};

// An unreadable policy withholds nothing here: anything that actually spends a credential refuses on its own read.
const gatesOf = (deps: Pick<Services, "credentialGates" | "logger">): Promise<readonly CredentialGate[]> =>
    deps.credentialGates.list().catch((error: unknown) => {
        deps.logger.warn({ err: error }, "credential gates: the approval policy could not be read, no capability is withheld this turn");
        return [];
    });

// A copy of the releases this conversation holds for the gated subjects, so the decision reads a value.
const releasesOf = (grants: CredentialGrants, gates: readonly CredentialGate[], conversationId: string | undefined): CredentialGrants => {
    const held = createCredentialGrants();
    if (conversationId === undefined) {
        return held;
    }
    for (const { subject } of gates) {
        const grant = grants.has(conversationId, subject);
        if (grant !== undefined) {
            held.grant(conversationId, subject, grant);
        }
    }
    return held;
};

// Loaded to be sent, or only to stamp its cohort on a measured conversation's turns that are not sent it.
const iqTeachingFor = (deps: Pick<Services, "config" | "logger">, premise: TurnPremise): Promise<IqSearchTeaching | undefined> =>
    deps.config.iqPluginDir !== "" && (premise.arms.search !== undefined || premise.send.iqTeaching)
        ? iqSearchInstruction(deps.config.iqPluginDir).catch((error: unknown) => {
              deps.logger.warn({ err: error }, "iq search: could not load the cross-harness instruction");
              return undefined;
          })
        : Promise.resolve(undefined);

// Read at the shared workspace root, never the turn's tree: the brief is daemon-kept config that git does not track, so
// an isolated turn's worktree has no copy of it, and the settings row reads the same file to say what is sent.
const freshFieldNotes = (deps: Pick<Services, "logger" | "workspace">, settings: SandboxSettings): FieldNotes | undefined =>
    fieldNotes({
        file: join(deps.workspace.root, FIELD_NOTES_FILE),
        budget: settings.fieldNotesBudget,
        onUnreadable: (why) => deps.logger.warn({ why }, "field notes: the file is there but cannot be sent"),
    });

// The brief rides the front of the cached prefix, so a conversation keeps the one it was first sent (field-notes-pins.ts)
// and re-reads the file only where its cache is gone anyway: a compaction. The switch is still read every turn, since
// turning the notes off is the owner's call and outranks the cache. A pin that cannot be read or written costs only the
// cache, never the turn.
const fieldNotesFor = async (
    deps: Pick<Services, "logger" | "workspace">,
    settings: SandboxSettings,
    turn: { readonly conversationId: string | undefined; readonly forkOf: string | undefined; readonly refresh: boolean },
): Promise<FieldNotes | undefined> => {
    if (!EXPERIMENTS.fieldNotes.on(settings)) {
        return undefined;
    }
    const { conversationId } = turn;
    if (conversationId === undefined) {
        return freshFieldNotes(deps, settings);
    }
    const pins = fieldNotesPinsAt(deps.workspace.root);
    try {
        const pinned = turn.refresh ? undefined : await pins.pinned(conversationId, turn.forkOf);
        if (pinned !== undefined) {
            return pinned;
        }
        const brief = freshFieldNotes(deps, settings);
        if (brief !== undefined) {
            await pins.pin(conversationId, brief);
        }
        return brief;
    } catch (error) {
        deps.logger.warn({ err: error }, "field notes: the pin could not be kept, so this turn reads the file as it is");
        return freshFieldNotes(deps, settings);
    }
};

// The start folder as the daemon reaches it. One the escape guard refuses maps nothing and reads rules from the root.
const treeReads = (context: TurnContext, premise: TurnPremise): Pick<AdmittedTurnFacts, "memoryNote" | "mapNote"> => {
    const root = context.localCwd;
    const start = premise.startIn === undefined || premise.startIn === "" ? root : resolveWithin(root, premise.startIn);
    return {
        memoryNote: workspaceMemoryNote({ root, cwd: start ?? root }),
        mapNote: premise.send.map && start !== undefined ? workspaceMapNote({ root, cwd: start }) : undefined,
    };
};

// Whether the cache the conversation's next turn would read has expired (account-placement.ts cacheCold), as its actor
// last heard: undefined state (a conversation this daemon has not run since it started) counts as cold.
const conversationCold = (services: Pick<TurnFactsDeps, "conversations">, conversationId: string | undefined): boolean => {
    const turn = conversationId === undefined ? undefined : services.conversations.state(conversationId)?.turn;
    return cacheCold(turn?.promptCache, turn?.lastAt, Date.now());
};

// Asked only for a turn on a conversation remembering an account, naming none or that one, so every other turn pays no
// read. An unreadable verdict routes as before: the credential then refuses on its own read if the account cannot serve.
// First off an account that cannot serve (blocked-account.ts), pinned or not; then, where the cache is cold and nobody
// pinned the account, onto one with clearly more room (account-placement.ts).
//
// A turn naming the account its conversation already runs on names nothing new (a re-run of a held turn, a Continue, a
// composer still holding the pick it made), so it is moved off that account where another can serve, as the remembered
// one is. Treated as a fresh attempt, a Continue after a refusal went back to the refused account and was refused again
// (2026-10-28). With nowhere else to go it is still the attempt it was, made with the one-token re-test rather than a
// whole turn (claude-seat-check.ts, forced): an answer lifts the mark and the turn runs there; the refusal again holds it
// before anything spawns, in the provider's own words. Only a turn naming ANOTHER account skips this.
const accountRouteOf = async (services: TurnFactsDeps, input: RoutedTurn, entry: ConversationEntry | undefined): Promise<AccountRoute> => {
    const remembered = routingFor(entry?.profile, { agent: input.agent, harness: input.harness }).account;
    if ((input.account !== undefined && input.account !== remembered) || remembered === undefined) {
        return { kind: "keep" };
    }
    try {
        return await services.perf.track("turn.plan.account", { provider: input.agent }, async () => {
            const blocked = await offBlockedAccount(services, { provider: input.agent, named: undefined, remembered, model: input.model });
            if (blocked.kind === "held" && input.account === remembered && (await services.claudeSeatCheck.recheck(remembered, { force: true }))) {
                return { kind: "keep" };
            }
            if (blocked.kind !== "keep") {
                return blocked;
            }
            const pinned = entry !== undefined && pinnedAccount(entry.profile) === remembered;
            return placeCold(services, {
                provider: input.agent,
                named: undefined,
                remembered,
                pinned,
                cold: pinned ? false : conversationCold(services, input.conversationId),
                model: input.model,
            });
        });
    } catch (error) {
        services.logger.warn({ err: error, account: remembered }, "account route: the account's state could not be read, the turn runs where it was routed");
        return { kind: "keep" };
    }
};

// Who a turn acts for before its conversation has recorded it: the person asking, the service it runs as. Begin records
// both, and planning must not lean on its order.
const principalsOfTurn = (input: RoutedTurn): [string | undefined, readonly string[], readonly string[]] => [
    input.conversationId,
    input.owner === undefined ? [] : [input.owner.email],
    input.runAs === undefined ? [] : [input.runAs],
];

// The route a turn takes once the people it works for have their say over the account (account-reach.ts): asked after
// the blocked-account route, which it can only narrow. Unreadable verdicts route as before, as above: the account the
// turn runs on is still one the reach was asked about, since the reach refuses rather than guesses when it cannot read.
const reachedRouteOf = async (
    services: TurnFactsDeps,
    input: RoutedTurn,
    entry: ConversationEntry | undefined,
    installed: readonly Capability[],
): Promise<ReachedRoute> => {
    const [route, reach] = await Promise.all([
        accountRouteOf(services, input, entry),
        services.accountReach(...principalsOfTurn(input)),
    ]);
    if (reach.kind === "all") {
        return route;
    }
    const turn = {
        provider: input.agent,
        named: input.account,
        remembered: routingFor(entry?.profile, input).account,
        model: input.model,
        // A local model rides the endpoint kind (`endpoint/<capability id>`); its weights spend nobody's allowance.
        free: installed.some((capability) => capability.kind === "localmodel" && capability.id === endpointIdOf(input.agent)),
    };
    return services.perf.track("turn.plan.account-reach", { provider: input.agent }, () => routeWithinReach(services, reach, turn, route));
};

// Every seam the reads above reach. The one write is the field-notes pin, which records what a conversation read.
export type TurnFactsDeps = ServiceabilityDeps &
    Pick<
    Services,
    | "agents"
    | "agentWorktrees"
    | "claudeSeatCheck"
    | "areas"
    | "capabilities"
    | "config"
    | "conversationGrants"
    | "credentialGates"
    | "credentialGrants"
    | "credentialReach"
    | "accountReach"
    | "conversations"
    | "toolCeiling"
    | "cursorStore"
    | "dependencies"
    | "endpointModels"
    | "iq"
    | "logger"
    | "resources"
    | "perf"
    | "personas"
    | "privacyShield"
    | "sandboxSettings"
    | "workspace"
>;

// Asked of every turn, since a policy can change between two of them: the shield's verdict on the route the turn's runtime
// reaches its provider by (privacy-trust.ts runtimeRoute).
const privacyRefusalOf = (services: Pick<Services, "privacyShield" | "perf">, runtime: TurnRuntime, conversationId: string | undefined): Promise<PrivacyRefusal | undefined> =>
    services.perf.track("turn.plan.privacy", { provider: runtime.provider }, () =>
        services.privacyShield.refusal({ provider: runtime.provider, conversationId, route: runtimeRoute(runtime.provider, runtime.harness) }),
    );

export const gatherTurnFacts = async (services: TurnFactsDeps, input: RoutedTurn, context: TurnContext): Promise<TurnFacts> => {
    // First, so a held turn costs no settings read, capability list, dependency probe or persona load.
    // Work nobody is waiting on is held here until there is room; a child the budget already admitted is not judged again.
    const admission = await services.resources.admit({
        workload: "agentRuntime",
        attended: input.unattended !== true,
        owner: input.conversationId,
        actor: input.actor,
        ...(input.unattended === true ? { wait: { signal: context.base.signal } } : {}),
    });
    if (admission.verdict !== "run") {
        return { held: { message: admission.message, ...(admission.verdict === "refuse" && admission.memory !== undefined ? { memory: admission.memory } : {}) } };
    }
    const entry = input.conversationId === undefined ? undefined : services.agents.entry(input.conversationId);
    const runtime = turnRuntime(input, entry);
    // One read of the served model answers what the turn may compose, whether what it composed fits, and whether the
    // model may run a turn at all.
    const [settings, served, privacyRefusal] = await Promise.all([
        context.settings ?? services.perf.track("turn.plan.settings", {}, () => services.sandboxSettings.get()),
        services.perf.track("turn.plan.window", { provider: runtime.provider }, () => servedEndpointModel(services, runtime.provider, input.model)),
        privacyRefusalOf(services, runtime, input.conversationId),
    ]);
    const declared = windowOf(served);
    const helperOnly = served?.row.helperOnly;
    const [installed, setup, personas, areas, skillCatalog, contextNote, repoChecks, turnContext, fresh, homeNote] = await manifests(
        services,
        input,
        context,
        entry,
        runtime,
        settings,
    );
    // The stored releases are in before they are copied, so a yes from before a restart reaches this turn. The reach
    // names this turn's person beside the conversation's own: begin records them, and this must not lean on its order.
    const [gates, accountRoute, reach, ceiling] = await Promise.all([
        gatesOf(services),
        reachedRouteOf(services, input, entry, installed),
        services.credentialReach(...principalsOfTurn(input)),
        services.toolCeiling(...principalsOfTurn(input)),
        services.credentialGrants.ready,
    ]);
    // A conversation's own grants (personas/conversation-grants.ts) widen its persona from the turn after they are given.
    const grant = input.conversationId === undefined ? undefined : await services.conversationGrants.of(input.conversationId);
    const premise = premiseOf({ entry, settings, personas, areas, grant, ceiling }, input, runtime);
    const iqTeaching = await iqTeachingFor(services, premise);
    // What checks the work, on the turns that owe it to a card that did not drop it (turn-premise.ts).
    const landingChecksNote = premise.send.landingChecks ? LANDING_CHECKS_NOTE : undefined;
    const brief = await fieldNotesFor(services, settings, {
        conversationId: input.conversationId,
        forkOf: input.forkOf?.conversationId,
        refresh: compactedSinceLastTurn(entry, runtime.conversationTurns),
    });
    const card = premise.persona.persona;
    // Only a card that asked for its own prompt is read, so an ordinary turn pays nothing for it.
    const personaPrompt = card?.systemPromptMode === "custom" ? await readPersonaPrompt(services.workspace.root, card.id) : undefined;
    return {
        root: services.workspace.root,
        entry,
        settings,
        repoChecks,
        declared,
        ...opt("helperOnly", helperOnly === undefined || served === undefined ? undefined : { label: served.row.label, reason: helperOnly }),
        ...opt("privacyRefusal", privacyRefusal),
        installed,
        setup,
        personas,
        areas,
        grant,
        skillCatalog,
        contextNote,
        ...opt("fresh", fresh),
        ...opt("homeNote", homeNote),
        turnContext,
        gates,
        releases: releasesOf(services.credentialGrants, gates, input.conversationId),
        reach,
        ceiling,
        iqTeaching,
        fieldNotes: brief,
        personaPrompt,
        landingChecksNote,
        ...treeReads(context, premise),
        sessionStore: services.agentWorktrees.sessionStore(entry),
        ...opt("accountRoute", accountRoute.kind === "keep" ? undefined : accountRoute),
    };
};
