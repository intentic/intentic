import type { Area, Capability, CredentialGate, Persona, Rule, SandboxSettings, TurnNote } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import { readPersonaPrompt } from "../../../personas/persona-kit.js";
import type { ShortMemory } from "@intentic/constants/memory-room";
import { repoCheckRules } from "../../../rules/repo-checks.js";
import { createCredentialGrants, type CredentialGrants } from "../../../secrets/credential-grants.js";
import { loadedSkillCatalogNote } from "../../../store/loaded-skills.js";
import { landingChecksNoteFor } from "../../../workspace/deps/mainline-note.js";
import { resolveWithin } from "../../../workspace/files/workspace-files-paths.js";
import type { ProjectSetupStatus } from "../../../workspace/layout/workspace-setup.js";
import { contextNoteIfDue } from "../../context/conversation-context.js";
import { type FieldNotes, fieldNotes } from "../../prompt/field-notes.js";
import { type IqSearchTeaching, iqSearchInstruction } from "../../prompt/iq-search-instruction.js";
import { type DeclaredWindow, declaredWindow } from "../../prompt/window/context-budget.js";
import { workspaceMapNote } from "../../prompt/workspace-map.js";
import { workspaceMemoryNote } from "../../prompt/workspace-memory.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import { retrieveTurnContext, type TurnContextOutcome } from "../turn/turn-context.js";
import type { TurnContext } from "../../providers/adapter.js";
import { EXPERIMENTS } from "./experiments.js";
import { type ConversationEntry, type TurnPremise, type TurnRuntime, premiseOf, turnRuntime } from "./turn-premise.js";

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
    // Everything the owner installed, before any persona or gate narrows it.
    readonly installed: readonly Capability[];
    // Dependency readiness of the main checkout; empty where the probe was skipped.
    readonly setup: readonly ProjectSetupStatus[];
    readonly personas: readonly Persona[];
    readonly areas: readonly Area[];
    readonly skillCatalogNote: string | undefined;
    readonly contextNote: TurnNote | undefined;
    // Undefined when retrieval was never attempted, which is a different fact from a lookup that skipped.
    readonly turnContext: TurnContextOutcome | undefined;
    readonly gates: readonly CredentialGate[];
    // The releases this conversation held for those gates when they were read.
    readonly releases: CredentialGrants;
    readonly iqTeaching: IqSearchTeaching | undefined;
    // Read on both arms of its experiment, so a control turn can still name the revision it was withheld from.
    readonly fieldNotes: FieldNotes | undefined;
    // The card's own PROMPT.md, read only for a card whose prompt mode is `custom`.
    readonly personaPrompt: string | undefined;
    // The owner's standing instructions, from the root down to the start folder.
    readonly memoryNote: string | undefined;
    // Read only when the map is due, so present only on a turn that sends it.
    readonly mapNote: string | undefined;
    // What runs after the work lands and which failures the main tree already has; present only on a turn that owes it.
    readonly landingChecksNote: TurnNote | undefined;
    readonly sessionStore: string;
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
        // For a runtime with no skill loader, on the opening turn, with paths as the agent sees them.
        capabilities.skillDiscovery === "prompt" && conversationTurns === 0
            ? services.perf.track("turn.plan.skills", {}, () => loadedSkillCatalogNote(context.localCwd, context.effectiveCwd))
            : Promise.resolve(undefined),
        services.perf.track("turn.plan.context", {}, () => contextNoteIfDue(services, input, entry, conversationTurns)),
        // Every turn, never cached: a check the owner switched off this morning must not keep running.
        services.perf.track("turn.plan.repo-checks", {}, () => repoCheckRules(services)),
        // Beside the rest rather than ahead of it, on its own deadline: a turn must not wait on an optimisation.
        services.config.iqTurnContext && EXPERIMENTS.turnContext.on(settings)
            ? services.perf.track("turn.plan.turn-context", {}, () => retrieveTurnContext({ iq: services.iq, logger: services.logger }, input.prompt))
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

// Read at the tree the daemon reaches (an isolated turn's worktree), where the owner's rules are read from too.
const fieldNotesFor = (deps: Pick<Services, "logger">, context: TurnContext, settings: SandboxSettings): FieldNotes | undefined =>
    EXPERIMENTS.fieldNotes.on(settings)
        ? fieldNotes({
              root: context.localCwd,
              budget: settings.fieldNotesBudget,
              onUnreadable: (why) => deps.logger.warn({ why }, "field notes: the file is there but cannot be sent"),
          })
        : undefined;

// The start folder as the daemon reaches it. One the escape guard refuses maps nothing and reads rules from the root.
const treeReads = (context: TurnContext, premise: TurnPremise): Pick<AdmittedTurnFacts, "memoryNote" | "mapNote"> => {
    const root = context.localCwd;
    const start = premise.startIn === undefined || premise.startIn === "" ? root : resolveWithin(root, premise.startIn);
    return {
        memoryNote: workspaceMemoryNote({ root, cwd: start ?? root }),
        mapNote: premise.send.map && start !== undefined ? workspaceMapNote({ root, cwd: start }) : undefined,
    };
};

// Every seam the reads above reach; nothing here writes.
export type TurnFactsDeps = Pick<
    Services,
    | "agents"
    | "agentWorktrees"
    | "areas"
    | "capabilities"
    | "config"
    | "credentialGates"
    | "credentialGrants"
    | "dependencies"
    | "endpointModels"
    | "iq"
    | "logger"
    | "resources"
    | "perf"
    | "personas"
    | "sandboxSettings"
    | "verifyStore"
    | "workspace"
>;

export const gatherTurnFacts = async (services: TurnFactsDeps, input: TurnInput, context: TurnContext): Promise<TurnFacts> => {
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
    // One read of the declared window answers both what the turn may compose and whether what it composed fits.
    const [settings, declared] = await Promise.all([
        context.settings ?? services.perf.track("turn.plan.settings", {}, () => services.sandboxSettings.get()),
        services.perf.track("turn.plan.window", { provider: runtime.provider }, () => declaredWindow(services, runtime.provider, input.model)),
    ]);
    const [installed, setup, personas, areas, skillCatalogNote, contextNote, repoChecks, turnContext] = await manifests(
        services,
        input,
        context,
        entry,
        runtime,
        settings,
    );
    const gates = await gatesOf(services);
    const premise = premiseOf({ entry, settings, personas, areas }, input, runtime);
    const [iqTeaching, landingChecksNote] = await Promise.all([
        iqTeachingFor(services, premise),
        // A card that drops the note is never read for it.
        premise.briefing.sends("checks")
            ? services.perf.track("turn.plan.mainline", {}, () => landingChecksNoteFor(services, input.conversationId, premise.send.landingChecks))
            : Promise.resolve(undefined),
    ]);
    const brief = fieldNotesFor(services, context, settings);
    const card = premise.persona.persona;
    // Only a card that asked for its own prompt is read, so an ordinary turn pays nothing for it.
    const personaPrompt = card?.systemPromptMode === "custom" ? await readPersonaPrompt(services.workspace.root, card.id) : undefined;
    return {
        root: services.workspace.root,
        entry,
        settings,
        repoChecks,
        declared,
        installed,
        setup,
        personas,
        areas,
        skillCatalogNote,
        contextNote,
        turnContext,
        gates,
        releases: releasesOf(services.credentialGrants, gates, input.conversationId),
        iqTeaching,
        fieldNotes: brief,
        personaPrompt,
        landingChecksNote,
        ...treeReads(context, premise),
        sessionStore: services.agentWorktrees.sessionStore(entry),
    };
};
