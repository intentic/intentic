import type { AgentCapabilities } from "@intentic/sandbox-contract/models/agent-runtimes";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { ANONYMOUS_BROWSER_SERVER, ROUTED_BROWSER_SERVER } from "../../../browser/tools/browser-servers.js";
import { browserOutputDir } from "../../../browser/cast/browser-artifacts.js";
import type { Services } from "../../../composition.js";
import { DESKTOP_SERVER } from "../../../desktop/desktop-tools.js";
import type { ArmPlan } from "../../providers/adapter.js";
import type { AgentRequest } from "../../providers/agent-request.js";
import { guidanceBlock, type GuidanceFacts, otherRuntime } from "../guidance.js";
import { surroundingsNote } from "../surroundings.js";
import { withRuntimeGuidance } from "../system-prompt.js";

/* THE GUIDANCE A RUNTIME OTHER THAN THE CLAUDE CODE LOOP IS TOLD, FROM WHAT ITS ARM MOUNTED.

   The Claude Code loop composes its guidance from the request it is handed (system-prompt.ts sdkSystemPrompt). Every
   other loop's guidance was composed before its arm mounted anything, so it could only say what holds for a turn that
   mounted nothing: three browsers, the owner's computers and their own browser reached OpenCode and Codex turns with not
   a word about which is which (2026-10-25). Composed here instead, once the arm has answered, from its request: the
   server names it mounted are the facts, read the same way for every runtime, so nothing reaches one loop and is kept
   from another. */

export type RuntimeGuidanceDeps = Pick<Services, "hostReach" | "webextReach" | "phoneReach" | "workspace" | "conversations">;

// The daemon's own servers a turn may hold (runtimes/daemon-tools/daemon-servers.ts).
const UI_SERVER = "ui";
const WATCH_SERVER = "watch";
const SUBAGENTS_SERVER = "subagents";

export interface RuntimeGuidanceTurn {
    readonly capabilities: AgentCapabilities;
    readonly request: AgentRequest;
    // The persona's narrowed manifest, the one the arm mounted the owner's computers, browsers and phones from.
    readonly granted: readonly Capability[];
    // The owner's `chatPages` switch: the `ui` server offers the page tools only with it on.
    readonly chatPages: boolean;
    // The conversation the turn belongs to, whose session the "Connected right now" note is kept for.
    readonly conversationId: string | undefined;
}

/** The facts this turn's guidance reads, from the servers its arm mounted. */
const runtimeGuidanceFacts = async (deps: RuntimeGuidanceDeps, turn: RuntimeGuidanceTurn): Promise<GuidanceFacts> => {
    const { capabilities, request, granted } = turn;
    const mounted = new Set((request.tools.remote ?? []).map((tool) => tool.name));
    const browsers = mounted.has(ANONYMOUS_BROWSER_SERVER) || mounted.has(ROUTED_BROWSER_SERVER);
    const [hostDevices, ownBrowsers, ownPhones] = await Promise.all([deps.hostReach(granted), deps.webextReach(granted), deps.phoneReach(granted)]);
    return {
        // How this runtime's tool list spells an MCP tool, as its arm said (TurnTools.mcpToolPrefix); absent is `mcp__<server>__<tool>`.
        runtime: otherRuntime(capabilities.secrets, request.tools.mcpToolPrefix),
        unattended: request.policy.unattended === true,
        browserOutputDir: browsers ? browserOutputDir(deps.workspace.root) : undefined,
        anonymousBrowser: mounted.has(ANONYMOUS_BROWSER_SERVER),
        browserAccounts: mounted.has(ROUTED_BROWSER_SERVER),
        desktop: mounted.has(DESKTOP_SERVER),
        diagnostics: request.tools.diagnostics === true,
        pages: turn.chatPages && mounted.has(UI_SERVER),
        // The terminal hand-off rides the Claude Code loop's tmux wrapper alone.
        terminal: false,
        uiAsk: mounted.has(UI_SERVER),
        watch: mounted.has(WATCH_SERVER),
        subagents: mounted.has(SUBAGENTS_SERVER),
        hostDevices,
        ownBrowsers,
        ownPhones,
    };
};

/**
 * The arm's plan with this product's guidance placed in its request, for a runtime other than the Claude Code loop; the
 * plan as it came for that loop, which composes its own.
 */
export const withComposedGuidance = async (
    deps: RuntimeGuidanceDeps,
    plan: ArmPlan,
    turn: Omit<RuntimeGuidanceTurn, "request"> & { readonly compacted: boolean },
): Promise<ArmPlan> => {
    if (turn.capabilities.runtime === "claude-code") {
        return plan;
    }
    const { spec } = plan.request;
    const facts = await runtimeGuidanceFacts(deps, { ...turn, request: plan.request });
    const stable = spec.stablePrompt === true;
    const guidance = guidanceBlock(facts, spec.search ?? "rg", stable);
    // Under a stable prompt the volatile half rides the message, and only when it moved since this session was told.
    const surroundings = stable ? surroundingsNote(deps.conversations, turn.conversationId, { fresh: spec.sessionId === undefined || turn.compacted }, facts) : undefined;
    return { ...plan, request: { ...plan.request, spec: withRuntimeGuidance(spec, turn.capabilities, guidance, surroundings) } };
};
