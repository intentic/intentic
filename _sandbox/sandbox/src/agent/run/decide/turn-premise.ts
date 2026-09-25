import { type AgentCapabilities, type AgentHarness, type AgentProvider, type AgentTurn, type Area, type Persona, type SandboxSettings, capabilitiesOf, type RoutedAgentTurn } from "@intentic/sandbox-contract";
import { conversationFence } from "../../../areas/area-scope.js";
import { compactedSinceLastTurn, type PersistedAgent } from "../../../conversations/registry/agents-store.js";
import { type TurnPersona, turnPersona } from "../../../personas/personas.js";
import type { GuidanceVariant } from "../../prompt/guidance.js";
import { type TurnBriefing, briefingOf } from "../../prompt/turn-briefing.js";
import { armOf, EXPERIMENTS } from "./experiments.js";

// What the rest of a turn is premised on, settled from its first reads: who it acts as, the arms it drew, where it
// starts and which say-once notes it owes. Pure; the facts choose their later reads by it and the decision re-derives it.

// The conversation as the registry holds it, narrowed to the fields a turn is decided on.
export type ConversationEntry = Pick<PersistedAgent, "id" | "totals" | "compactedTurn" | "profile" | "identity">;

// Which runtime serves a turn and how far into its conversation it is: all that the first reads are skipped by.
export interface TurnRuntime {
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    // The same (provider, harness) row the serving arm is picked by, so the two cannot disagree.
    readonly capabilities: AgentCapabilities;
    // 0 on a conversation's opening turn, and on a turn with no conversation behind it.
    readonly conversationTurns: number;
}

// Harness is orthogonal to provider: "native" runs each provider on its own runtime, "claude-code" forces the Claude
// Code loop for any of them.
export const turnRuntime = (input: RoutedAgentTurn, entry: ConversationEntry | undefined): TurnRuntime => {
    const { agent: provider, harness } = input;
    return { provider, harness, capabilities: capabilitiesOf(provider, harness), conversationTurns: entry?.totals.turns ?? 0 };
};

// The first reads a premise is settled from, before anything it decides is read in turn.
export interface PremiseFacts {
    readonly entry: ConversationEntry | undefined;
    readonly settings: SandboxSettings;
    readonly personas: readonly Persona[];
    readonly areas: readonly Area[];
}

export interface TurnPremise {
    readonly persona: TurnPersona;
    // Which of the sandbox's own preamble notes the card still wants; all of them for a turn wearing no card.
    readonly briefing: TurnBriefing;
    // Each experiment's arm for this conversation; undefined where it is not measuring (armOf).
    readonly arms: {
        readonly search: boolean | undefined;
        readonly map: boolean | undefined;
        readonly notes: boolean | undefined;
        readonly guidance: boolean | undefined;
    };
    // The guidance the turn is composed with: the arm where one was drawn, else the owner's switch.
    readonly guidance: GuidanceVariant;
    readonly iqSearchEnabled: boolean;
    // Workspace-relative: the card's own folder, else the one the conversation latched at its first turn.
    readonly startIn: string | undefined;
    readonly send: { readonly map: boolean; readonly landingChecks: boolean; readonly iqTeaching: boolean };
}

// The opening (non-fork) message only: the map stays in the transcript, and the layout has not moved by the second
// turn. The card is asked first, since a card that dropped the map is never in the experiment `arm` measures.
const mapDue = (briefing: TurnBriefing, settings: SandboxSettings, arm: boolean | undefined, input: AgentTurn, turns: number): boolean =>
    briefing.sends("map") && (arm ?? EXPERIMENTS.workspaceMap.on(settings)) && input.forkOf === undefined && turns === 0;

// Said once on the opening message, and again after a compaction summarizes away the history that held it. `>=`
// inside compactedSinceLastTurn, since the turn after the one a compaction is filed under is the one that owes it. The
// note also goes out when the main tree's reds change (mainline-note.ts), which only a read can say.
const landingChecksDue = (input: AgentTurn, entry: ConversationEntry | undefined, turns: number): boolean =>
    (turns === 0 && input.forkOf === undefined) || compactedSinceLastTurn(entry, turns);

// The Claude Code loop loads the teaching as a plugin; every other runtime is sent it once, then carried by its session.
const iqTeachingDue = (runtime: TurnRuntime, enabled: boolean): boolean =>
    runtime.capabilities.runtime !== "claude-code" && enabled && runtime.conversationTurns === 0;

export const premiseOf = (facts: PremiseFacts, input: AgentTurn, runtime: TurnRuntime): TurnPremise => {
    const { settings, entry } = facts;
    // The fence goes through the area manifest every turn, not frozen at birth, so editing an area moves its conversations.
    const persona = turnPersona({
        personas: facts.personas,
        actsAs: input.actsAs,
        unattended: input.unattended === true,
        fence: conversationFence(facts.areas, entry?.identity),
    });
    const briefing = briefingOf(persona.persona);
    const search = armOf(EXPERIMENTS.iqSearch, settings, input.conversationId);
    const iqSearchEnabled = search ?? EXPERIMENTS.iqSearch.on(settings);
    // A card that drops the map takes its conversation out of the experiment, not into its control group.
    const map = briefing.sends("map") ? armOf(EXPERIMENTS.workspaceMap, settings, input.conversationId) : undefined;
    const guidance = armOf(EXPERIMENTS.guidance, settings, input.conversationId);
    return {
        persona,
        briefing,
        arms: { search, map, notes: armOf(EXPERIMENTS.fieldNotes, settings, input.conversationId), guidance },
        guidance: (guidance ?? EXPERIMENTS.guidance.on(settings)) ? "lean" : "full",
        iqSearchEnabled,
        startIn: persona.workspace?.startIn ?? entry?.identity.startIn ?? input.startIn,
        send: {
            map: mapDue(briefing, settings, map, input, runtime.conversationTurns),
            landingChecks: briefing.sends("checks") && landingChecksDue(input, entry, runtime.conversationTurns),
            iqTeaching: iqTeachingDue(runtime, iqSearchEnabled),
        },
    };
};
