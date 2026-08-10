import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSummary } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { AgentsRegistry } from "../agents/agents-registry.js";
import { waitForSubagent, type SubagentWaitUntil } from "./subagents.js";

/* "WAIT UNTIL THAT AGENT NEEDS ME" — the tool a supervising turn parks on instead of polling.
 *
 * A parent that starts other agents — a backgrounded `codex exec`, an Agent-tool child, a fleet agent it was
 * asked about — used to have two ways to follow them: burn turns re-reading a tmux tail on a timer, or walk
 * away and be told only by the exit. Both miss the one state that matters most, a child sitting on a question,
 * and the polling version spends tokens to miss it. This tool is the third way: one call that returns when the
 * target needs input or finishes, fed by the same signals the roster reads (delegation hooks, the warm
 * OpenCode server's events, the SDK's task stream, the fleet registry) — so the parent sleeps for free and
 * wakes exactly once, with the child's own report in hand.
 *
 * An SDK MCP tool rather than a CLI on purpose: a blocking command under Bash would hit the shell's
 * soft-timeout detach and turn the wait into the very tail-polling it replaces, while a tool call parks
 * server-side exactly like a permission hold (guard/command-gate.ts) and settles with the turn's own abort.
 *
 * Two domains, one door. A CHILD of this conversation is named by its spawning tool call's id (the id on the
 * Bash/Agent card — the same key the Subagents area uses); the FLEET is named by conversation id, resolved
 * through the registry first so the two key spaces cannot shadow each other's misses. */

// The ceiling and default for one wait. The default is long enough for a real delegated run and short enough
// that a forgotten wait returns within the turn; the cap exists because a tool call is turn time — a parent
// that wants to wait longer calls again, which also gives steering a seam to land in.
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 1800;

// A fleet agent that stopped moving on its own: every status that is neither a turn in flight (`running`,
// `stopping`, `resuming`) nor the park this tool's `blocked` reports (`awaiting`).
const FLEET_FINISHED: ReadonlySet<AgentSummary["status"]> = new Set(["idle", "ready", "landed", "conflict", "error", "stopped", "interrupted"]);

const fleetBlocked = (agent: AgentSummary): boolean =>
    agent.status === "awaiting" || agent.attention.plan || agent.attention.question || agent.attention.permission || agent.attention.conflict;

const fleetMatch = (agent: AgentSummary, until: readonly SubagentWaitUntil[]): SubagentWaitUntil | undefined => {
    if (until.includes("blocked") && fleetBlocked(agent)) {
        return "blocked";
    }
    if (until.includes("finished") && FLEET_FINISHED.has(agent.status)) {
        return "finished";
    }
    return undefined;
};

// What the model gets back about a fleet agent — the acting-on facts, not the whole card.
const fleetSnapshot = (agent: AgentSummary): Record<string, unknown> => ({
    id: agent.id,
    status: agent.status,
    attention: agent.attention,
    ...(agent.title !== undefined ? { title: agent.title } : {}),
    ...(agent.failure !== undefined ? { failure: agent.failure } : {}),
});

/* The fleet half of the wait, over the registry's own subscription. Subscribe-first like waitForSubagent — the
 * subscription's immediate snapshot IS the first evaluation, so a state that held before the call still
 * matches, and every later broadcast re-evaluates. Fleet statuses are sticky (awaiting parks until answered),
 * so the roster's coalesced broadcasts are a safe wake source here in a way they are not for children. */
const waitForFleetAgent = (
    registry: AgentsRegistry,
    id: string,
    until: readonly SubagentWaitUntil[],
    timeoutMs: number,
    signal: AbortSignal,
): Promise<{ outcome: SubagentWaitUntil | "timeout" | "aborted"; agent?: AgentSummary }> =>
    new Promise((resolve) => {
        let unsubscribe: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (result: { outcome: SubagentWaitUntil | "timeout" | "aborted"; agent?: AgentSummary }): void => {
            unsubscribe?.();
            signal.removeEventListener("abort", onAbort);
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            resolve(result);
        };
        const onAbort = (): void => settle({ outcome: "aborted" });
        if (signal.aborted) {
            resolve({ outcome: "aborted" });
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
            const agent = registry.get(id);
            settle({ outcome: "timeout", ...(agent !== undefined ? { agent } : {}) });
        }, timeoutMs);
        timer.unref();
        unsubscribe = registry.subscribe((agents) => {
            const agent = agents.find((candidate) => candidate.id === id);
            if (agent === undefined) {
                return;
            }
            const matched = fleetMatch(agent, until);
            if (matched !== undefined) {
                settle({ outcome: matched, agent });
            }
        });
    });

export interface SubagentWaitDeps {
    // The conversation whose children this turn may wait on — a parent only ever supervises its own.
    readonly conversationId: string | undefined;
    readonly registry: AgentsRegistry;
    // The turn's own abort, so a parked wait settles when the turn is stopped under it.
    readonly signal: AbortSignal;
    /* Hand the workspace back for the length of the park (workspace/maintenance-gate.ts explains why). A turn
     * asleep on another agent is running nothing against the dependency tree, and holding it would stall the
     * repair its own sibling's work is the likeliest cause of. */
    readonly park: <T>(run: () => Promise<T>) => Promise<T>;
    /* Whether THIS turn has anything of its own still writing — a subagent or delegated CLI on the roster, a
     * command left running in its shell. The model being parked is not the same as the turn being parked
     * (agent.ts's syncOnAnswer draws the same distinction, for the same tree), and giving the workspace back
     * while a background build of ours is mid-run would hand an install exactly the live writer the gate
     * exists to keep it away from. Checked once, on the way in: the model cannot start anything new while it
     * sleeps, so what is running at that moment is all that can be. */
    readonly quiet: () => Promise<boolean>;
}

const UNTIL = z.enum(["blocked", "finished"]);

// The tool's whole answer as one JSON text block — structured enough for the model to branch on `outcome`
// without prose parsing.
const answer = (payload: Record<string, unknown>): { content: [{ type: "text"; text: string }] } => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
});

export const subagentWaitServer = (deps: SubagentWaitDeps): McpSdkServerConfigWithInstance =>
    createSdkMcpServer({
        name: "subagents",
        // In the prompt, not behind tool search: a supervising parent reaches for this mid-flight, and a tool
        // it has to go looking for is a tool it replaces with a sleep-and-poll loop.
        alwaysLoad: true,
        tools: [
            tool(
                "wait",
                "Wait until an agent you started needs you. Blocks until the target is blocked on input (a question or " +
                    "permission), or finishes, whichever comes first — then returns its status and last report. Targets: a " +
                    'delegated CLI run or Agent-tool child by its spawning tool call id, "any" for whichever of this ' +
                    "conversation's children moves first, or another fleet agent by its conversation id. Use this instead of " +
                    "sleeping or re-reading terminal output in a loop. On timeout it returns the current state — call it " +
                    "again to keep waiting.",
                {
                    target: z.string().min(1).describe('A child tool call id, a fleet agent conversation id, or "any"'),
                    until: z.array(UNTIL).min(1).optional().describe('Which states end the wait; default ["blocked","finished"]'),
                    timeoutSeconds: z.number().min(5).max(MAX_TIMEOUT_S).optional().describe(`Default ${DEFAULT_TIMEOUT_S}`),
                },
                async (args) => {
                    const until: readonly SubagentWaitUntil[] = args.until ?? ["blocked", "finished"];
                    const timeoutMs = Math.round((args.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000);
                    // Waiting on one of OUR OWN children answers `quiet` false by itself — that child is on the
                    // roster and it is running, which is the whole reason there is something to wait for. So the
                    // release lands where it is safe (a fleet sibling, which holds its own slot) without the
                    // tool having to reason about which door it came in by.
                    const parked = async <T>(run: () => Promise<T>): Promise<T> => ((await deps.quiet()) ? deps.park(run) : run());
                    // The fleet resolves first: registry ids are conversation ids the registry itself can
                    // confirm, while a child id's absence has two meanings (see unknown-target below).
                    if (args.target !== "any" && deps.registry.get(args.target) !== undefined) {
                        const result = await parked(() => waitForFleetAgent(deps.registry, args.target, until, timeoutMs, deps.signal));
                        return answer({
                            outcome: result.outcome,
                            ...(result.agent !== undefined ? { agent: fleetSnapshot(result.agent) } : {}),
                        });
                    }
                    if (deps.conversationId === undefined) {
                        return answer({ outcome: "unknown-target", note: "This turn has no conversation, so it has no children to wait on." });
                    }
                    const conversationId = deps.conversationId;
                    const result = await parked(() =>
                        waitForSubagent(conversationId, {
                            ...(args.target !== "any" ? { target: args.target } : {}),
                            until,
                            timeoutMs,
                            signal: deps.signal,
                        }),
                    );
                    return answer({
                        outcome: result.outcome,
                        ...(result.matched !== undefined ? { agent: result.matched } : {}),
                        ...(result.outcome === "unknown-target"
                            ? { note: "No such child on the roster — it never started, or it finished more than a few minutes ago." }
                            : {}),
                    });
                },
            ),
        ],
    });
