import type { AgentCapabilities } from "@intentic/sandbox-contract/models/agent-runtimes";
import type { AgentHarness, AgentProvider, AgentTurn, RoutedAgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import type { Area } from "@intentic/sandbox-contract/schemas/areas";
import type { ConversationGrant } from "@intentic/sandbox-contract/schemas/needs";
import type { Persona } from "@intentic/sandbox-contract/schemas/personas";
import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { conversationFence } from "../../../areas/area-scope.js";
import { parentOfActor } from "../../../auth/principal.js";
import { compactedSinceLastTurn, type PersistedAgent } from "../../../conversations/registry/agents-store.js";
import { type TurnPersona, turnPersona, widenPersona } from "../../../personas/personas.js";
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
    // What a person allowed this conversation beyond its persona (personas/conversation-grants.ts), if anything.
    readonly grant?: ConversationGrant | undefined;
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
        readonly toolSearch: boolean | undefined;
        readonly stablePrompt: boolean | undefined;
    };
    readonly iqSearchEnabled: boolean;
    // Whether the CLI defers connected tools' schemas behind its tool search; undefined leaves the CLI's own rule, on a
    // turn the switch does not reach.
    readonly toolSearch: boolean | undefined;
    // Whether the guidance that moves between turns rides the message instead of the system block; the Claude Code loop
    // only, the one runtime whose guidance holds such entries.
    readonly stablePrompt: boolean | undefined;
    // Workspace-relative: the card's own folder, else the one the conversation latched at its first turn.
    readonly startIn: string | undefined;
    readonly send: { readonly map: boolean; readonly landingChecks: boolean; readonly iqTeaching: boolean };
}

// Whether the conversation gets the map at all. A child another conversation spawned does not: it opens on a brief its
// parent wrote, which named file paths in 201 of 213 children (a median 4,573 characters against 254 for a person's
// opening), so the map has nothing left to orient; and drawn an arm of its own, it carried its parent's map into the
// control group in 60 of them. Asked of the latched starter, which `begin` writes before the turn is planned. A card
// that dropped the map is likewise out, and never in the experiment `arm` measures.
const mapped = (briefing: TurnBriefing, entry: ConversationEntry | undefined): boolean =>
    briefing.sends("map") && parentOfActor(entry?.identity.startedBy) === undefined;

// The opening (non-fork) message only: the map stays in the transcript, and the layout has not moved by the second
// turn.
const mapDue = (settings: SandboxSettings, arm: boolean | undefined, input: AgentTurn, turns: number): boolean =>
    (arm ?? EXPERIMENTS.workspaceMap.on(settings)) && input.forkOf === undefined && turns === 0;

// Said once on the opening message, and again after a compaction summarizes away the history that held it. `>=`
// inside compactedSinceLastTurn, since the turn after the one a compaction is filed under is the one that owes it.
const landingChecksDue = (input: AgentTurn, entry: ConversationEntry | undefined, turns: number): boolean =>
    (turns === 0 && input.forkOf === undefined) || compactedSinceLastTurn(entry, turns);

// Native Claude on the Claude Code loop: the one serving that both runs the CLI's tool search and is known to answer its
// beta. A translator or minted endpoint wears Anthropic's wire over a vendor that may not.
const toolSearchReaches = (runtime: TurnRuntime): boolean => runtime.provider === "claude" && runtime.capabilities.runtime === "claude-code";

// The Claude Code loop loads the teaching as a plugin; every other runtime is sent it once, then carried by its session.
const iqTeachingDue = (runtime: TurnRuntime, enabled: boolean): boolean =>
    runtime.capabilities.runtime !== "claude-code" && enabled && runtime.conversationTurns === 0;

export const premiseOf = (facts: PremiseFacts, input: AgentTurn, runtime: TurnRuntime): TurnPremise => {
    const { settings, entry } = facts;
    // The fence goes through the area manifest every turn, not frozen at birth, so editing an area moves its conversations.
    const persona = widenPersona(
        turnPersona({
            personas: facts.personas,
            actsAs: input.actsAs,
            unattended: input.unattended === true,
            fence: conversationFence(facts.areas, entry?.identity),
        }),
        facts.grant,
    );
    const briefing = briefingOf(persona.persona);
    const search = armOf(EXPERIMENTS.iqSearch, settings, input.conversationId);
    const iqSearchEnabled = search ?? EXPERIMENTS.iqSearch.on(settings);
    // A conversation the map never reaches is out of the experiment, not in its control group.
    const sendsMap = mapped(briefing, entry);
    const map = sendsMap ? armOf(EXPERIMENTS.workspaceMap, settings, input.conversationId) : undefined;
    // A conversation the switch never reaches is out of the experiment, not in its control group.
    const reaches = toolSearchReaches(runtime);
    const toolSearchArm = reaches ? armOf(EXPERIMENTS.toolSearch, settings, input.conversationId) : undefined;
    const loop = runtime.capabilities.runtime === "claude-code";
    const stableArm = loop ? armOf(EXPERIMENTS.stablePrompt, settings, input.conversationId) : undefined;
    return {
        persona,
        briefing,
        arms: {
            search,
            map,
            notes: armOf(EXPERIMENTS.fieldNotes, settings, input.conversationId),
            toolSearch: toolSearchArm,
            stablePrompt: stableArm,
        },
        iqSearchEnabled,
        toolSearch: reaches ? (toolSearchArm ?? EXPERIMENTS.toolSearch.on(settings)) : undefined,
        stablePrompt: loop ? (stableArm ?? EXPERIMENTS.stablePrompt.on(settings)) : undefined,
        startIn: persona.workspace?.startIn ?? entry?.identity.startIn ?? input.startIn,
        send: {
            map: sendsMap && mapDue(settings, map, input, runtime.conversationTurns),
            landingChecks: briefing.sends("checks") && landingChecksDue(input, entry, runtime.conversationTurns),
            iqTeaching: iqTeachingDue(runtime, iqSearchEnabled),
        },
    };
};
