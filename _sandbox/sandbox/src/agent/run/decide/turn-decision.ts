import { type AccountRoute, heldForAccountMessage } from "../../providers/accounts/blocked-account.js";
import { routingFor } from "../../providers/accounts/routing.js";
import type {
    AgentCapabilities,
    AgentHarness,
    AgentProvider,
    AgentTurn,
    Capability,
    Rule,
    SandboxSettings,
    SystemPromptMode,
    TurnNote,
    RoutedAgentTurn,
} from "@intentic/sandbox-contract";
import { mayDelegate, personaCapabilities, personaPrompt, type TurnPersona } from "../../../personas/personas.js";
import { withRepoChecks } from "../../../rules/repo-checks.js";
import { gatedCapabilities } from "../../../secrets/credential-gating.js";
import type { TurnBriefing } from "../../prompt/turn-briefing.js";
import { composeWirePrompt } from "../../prompt/turn-preamble.js";
import { contextShortfall } from "../../prompt/window/context-budget.js";
import { applyTrim, promptTrim, trimState, type TurnTrim, type TurnTrimState, turnTrim } from "../../prompt/window/context-trim.js";
import { spawnNote } from "../../subagents/spawn-note.js";
import type { TurnBase } from "../../providers/agent-request.js";
import { opt } from "../../../opt.js";
import type { TurnContext, TurnRefusal } from "../../providers/adapter.js";
import type { TurnExperimentStamps } from "../turn/turn-plan.js";
import { experimentStamps, type TurnFieldNotes } from "./experiments.js";
import { honoured } from "./honoured.js";
import type { AdmittedTurnFacts, TurnFacts } from "./turn-facts.js";
import { type ConversationEntry, type TurnPremise, type TurnRuntime, premiseOf, turnRuntime } from "./turn-premise.js";

// Decides a turn from its facts with no I/O: who it acts as, what it may reach and is told, which arms it drew, and
// whether its window can hold what it would send. A refusal is a value; what the log owes rides beside either answer.

// A line the daemon's log owes the decision; the planner writes it, since deciding performs no I/O.
export interface TurnWarning {
    readonly fields: Readonly<Record<string, unknown>>;
    readonly message: string;
}

// What the planner owes whatever the answer: the log's lines, and whether the spawn door is open, which is decided
// before the window is measured and so is armed even for a turn the window then refuses.
interface DecidedEffects {
    readonly warnings: readonly TurnWarning[];
    readonly spawn: boolean;
}

export type DecidedRefusal = TurnRefusal & DecidedEffects;

// What a turn is let through with: which arm serves it and what that arm is called with, plus what planning carries
// past the arm to the route.
export interface TurnDecision extends DecidedEffects {
    readonly ok: true;
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    // As its arm is called with it: the conversation's latched account filled in where the turn named none.
    readonly input: RoutedAgentTurn;
    // The account the conversation is moved to because the one it ran on cannot serve; the planner records the move.
    readonly accountMove?: string;
    // What every arm builds on, the composed request as its base.
    readonly context: TurnContext;
    // The manifest after the persona's shelves and the owner's gates: the only list an arm may mount from.
    readonly granted: Capability[];
    // Where a failing command's dependencies are looked up, the start folder; the planner binds it to the live probe.
    readonly dependencyDir: string;
    readonly briefing: TurnBriefing;
    // What the window would not pay for and what it has taken so far; absent when nothing was trimmed.
    readonly contextTrim?: TurnTrimState;
    readonly experiments: TurnExperimentStamps;
}

// The owner's rules and the checks each repository declares for its own code, as the one list every reader takes.
const underRepoChecks = (settings: SandboxSettings, declared: readonly Rule[]): SandboxSettings =>
    declared.length === 0 ? settings : { ...settings, rules: withRepoChecks(settings.rules, declared) };

// The account the arm is called with, by the one routing rule (agent/providers/accounts/routing.ts): the one the turn names, else
// the one its conversation runs on for this provider, else none, which the credential resolver answers by serviceability.
// A session resumes only under the account that minted it, so a turn naming none must not wander, except off an account
// that can no longer serve it (blocked-account.ts), onto the ready one the conversation is moved to.
const routedInput = (input: RoutedAgentTurn, entry: ConversationEntry | undefined, route: AccountRoute | undefined): RoutedAgentTurn => {
    const account = route?.kind === "move" ? route.to : routingFor(entry?.profile, input).account;
    return account === undefined || account === input.account ? input : { ...input, account };
};

// What the log owes a turn moved off its conversation's account.
const routeWarnings = (route: AccountRoute | undefined, input: AgentTurn): TurnWarning[] =>
    route?.kind === "move"
        ? [
              {
                  fields: { conversationId: input.conversationId, from: route.from, to: route.to, reason: route.reason },
                  message: "account: the conversation's account cannot serve, moving the conversation to one that can",
              },
          ]
        : [];

// Taught through the `agents` CLI to runtimes with only a shell door (the Claude Code loop and Cursor carry the tools
// in-prompt), once, on the conversation's opening turn.
const spawnNoteFor = (spawn: boolean, runtime: TurnRuntime): string | undefined =>
    spawn && runtime.capabilities.runtime !== "claude-code" && runtime.capabilities.runtime !== "cursor" && runtime.conversationTurns === 0
        ? spawnNote()
        : undefined;

// Sent unless the arm withholds it or the window cannot pay for it; `?? true`, since no arm means no experiment rather
// than control. Withheld here rather than at placement, so `notesChars` never counts a brief that stayed home.
const fieldNotesOf = (facts: AdmittedTurnFacts, arm: boolean | undefined, trim: TurnTrim | undefined): TurnFieldNotes => ({
    arm,
    brief: facts.fieldNotes,
    note: (arm ?? true) && trim === undefined ? facts.fieldNotes?.text : undefined,
});

// What the SYSTEM prompt would have carried had the window paid for it. A custom prompt already dropped the guidance and
// a runtime with no system seam never had it; the field notes reach that runtime through the message instead.
const systemPieces = (capabilities: AgentCapabilities, mode: SystemPromptMode, notes: TurnFieldNotes): TurnTrimState["system"] => ({
    guidance: mode !== "custom" && capabilities.instructions !== "none",
    fieldNotes: notes.brief !== undefined && (notes.arm ?? true),
});

// The window's filter applied to what the card composed. The request carries both prompt-side decisions on, so the
// adapter sheds the same guidance; the running state goes out to the route, which adds two notes after this.
const trimmed = (
    trim: TurnTrim | undefined,
    request: TurnBase,
    system: TurnTrimState["system"],
): { readonly request: TurnBase; readonly contextTrim?: TurnTrimState } => {
    if (trim === undefined) {
        return { request };
    }
    const { notes, state } = applyTrim(trimState(trim, system), request.spec.notes ?? []);
    return {
        request: { ...request, spec: { ...request.spec, notes, ...opt("contextTrim", promptTrim(trim)) } },
        ...opt("contextTrim", state),
    };
};

// The route's context with every answer planning resolved, so each arm reads the same ones.
const sharedContext = (
    context: TurnContext,
    facts: AdmittedTurnFacts,
    settings: SandboxSettings,
    premise: TurnPremise,
    runtime: TurnRuntime,
    trim: TurnTrim | undefined,
): TurnContext => ({
    ...context,
    // The merged rule list travels with the settings, so no reader asks a second question to learn what stands.
    settings,
    conversationTurns: runtime.conversationTurns,
    iqSearchEnabled: premise.iqSearchEnabled,
    ...opt("contextTrim", trim),
    ...opt("iqSearchCohort", facts.iqTeaching?.cohort),
});

// The turn index only for a turn in a conversation; the map's size off the notes as they will be sent, trimmed. The
// guidance arm only where guidance was composed at all, so a turn that got neither form is no control turn.
const experimentsOf = (
    facts: AdmittedTurnFacts,
    input: AgentTurn,
    runtime: TurnRuntime,
    premise: TurnPremise,
    notes: TurnFieldNotes,
    sent: readonly TurnNote[] | undefined,
    guided: boolean,
): TurnExperimentStamps =>
    experimentStamps(input.conversationId === undefined ? undefined : runtime.conversationTurns, {
        iqSearch: { arm: premise.arms.search, cohort: facts.iqTeaching?.cohort },
        workspaceMap: { arm: premise.arms.map, notes: sent },
        fieldNotes: notes,
        turnContext: facts.turnContext,
        guidance: { arm: guided ? premise.arms.guidance : undefined },
    });

// A turn acting as a card this workspace lacks runs with nothing, while its prompt still reads as if it had everything.
const personaWarnings = (persona: TurnPersona, input: AgentTurn): TurnWarning[] =>
    persona.reason === "unknown-persona"
        ? [{ fields: { actsAs: input.actsAs }, message: "persona: no such card, this turn reaches no account and no tools" }]
        : [];

export const decideTurn = (facts: TurnFacts, input: RoutedAgentTurn, context: TurnContext): TurnDecision | DecidedRefusal => {
    if ("held" in facts) {
        // Spread whole: the reading rides through to the composer's notice, which can only size a raise it was told.
        return { ok: false, code: "sandbox-memory-low", ...facts.held, warnings: [], spawn: false };
    }
    // Refused before anything spawns rather than sent into a certain refusal; turned away at the door, so the words wait.
    if (facts.accountRoute?.kind === "held") {
        const { account, reason } = facts.accountRoute;
        const warning = { fields: { conversationId: input.conversationId, account, reason }, message: "account: no account of the provider can serve, turn held" };
        return { ok: false, code: "claude-not-entitled", message: heldForAccountMessage(input.agent, reason), account, warnings: [warning], spawn: false };
    }
    const runtime = turnRuntime(input, facts.entry);
    const { capabilities } = runtime;
    const premise = premiseOf(facts, input, runtime);
    const { persona } = premise;
    const warnings = [...personaWarnings(persona, input), ...routeWarnings(facts.accountRoute, input)];
    // What the declared window will not pay for; undefined for every model whose window holds a full turn.
    const trim = turnTrim(facts.declared?.window, capabilities.instructions);
    const settings = underRepoChecks(facts.settings, facts.repoChecks);
    // The owner's gates after the persona's shelves, once for every runtime; honoured notes what they withheld.
    const mounts = gatedCapabilities(personaCapabilities(facts.installed, persona), facts.gates, facts.releases, input.conversationId);
    // A child is a whole agent holding shell and write, so spawning needs the delegate shelf and full agency.
    const spawn = context.children !== undefined && input.conversationId !== undefined && mayDelegate(persona);
    const notes = fieldNotesOf(facts, premise.arms.notes, trim);
    const prompt = personaPrompt(persona.persona, facts.personaPrompt, facts.settings);
    const shared = sharedContext(context, facts, settings, premise, runtime, trim);
    // The card's briefing, then the window's filter: what a small window left out is named by building what it would send.
    const system = systemPieces(capabilities, prompt.mode, notes);
    const written = { spawn: spawnNoteFor(spawn, runtime), fieldNotes: notes.note };
    const composed = trimmed(trim, honoured(facts, shared, settings, capabilities, premise, prompt, mounts.withheld, written), system);
    const planned: TurnContext = { ...shared, base: composed.request, persona };
    // The last gate, and the only one that reads the prompt as it will be sent: notes and all, trimmed where trimmed.
    const shortfall = contextShortfall({
        runtime: capabilities.runtime,
        declared: facts.declared,
        prompt: composeWirePrompt(planned.base.spec.notes ?? [], planned.base.spec.prompt),
    });
    if (shortfall !== undefined) {
        const said = { provider: runtime.provider, model: input.model, window: shortfall.window, needed: shortfall.needed };
        const warning = { fields: said, message: "context: the model's window cannot hold a turn of this loop, refused before sending" };
        return { ok: false, code: "context-window-too-small", message: shortfall.message, warnings: [...warnings, warning], spawn };
    }
    return {
        ok: true,
        provider: runtime.provider,
        harness: runtime.harness,
        input: routedInput(input, facts.entry, facts.accountRoute),
        ...opt("accountMove", facts.accountRoute?.kind === "move" ? facts.accountRoute.to : undefined),
        context: planned,
        granted: mounts.capabilities,
        dependencyDir: premise.startIn ?? "",
        spawn,
        briefing: premise.briefing,
        ...opt("contextTrim", composed.contextTrim),
        experiments: experimentsOf(facts, input, runtime, premise, notes, planned.base.spec.notes, system.guidance && trim === undefined),
        warnings,
    };
};
