import { WORKSPACE_ROOT } from "@intentic/constants";
import { agent, type AgentApp, client, methods, type SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentCapabilities } from "@agentclientprotocol/sdk";
import { decidePermission } from "../acp-permissions.js";
import type { AcpConnection, TurnHooks } from "../acp-connection.js";

/* A scenario-driven fake ACP agent built with the SAME SDK's agent() API, composed in-process (no spawn, no
 * transport) — the QueryFn/CodexRunner pattern for ACP. The prompt text selects the behaviour; the fixture
 * exercises the adapter over a real ClientContext, so the JSON-RPC layer and update routing are the SDK's
 * own, not mocks. */

// The fixture's session/prompt behaviours, keyed by a keyword in the prompt text.
export const fakeAcpAgentApp = (): AgentApp => {
    let nextSession = 0;
    return agent({ name: "fake-acp" })
        .onRequest(methods.agent.initialize, () => ({
            protocolVersion: 1,
            agentCapabilities: { loadSession: false },
        }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: `fake-${(nextSession += 1)}` }))
        .onRequest(methods.agent.session.prompt, async ({ params, client: ctx }) => {
            const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
            const push = (update: SessionUpdate): Promise<void> => ctx.notify(methods.client.session.update, { sessionId: params.sessionId, update });
            if (text.includes("refuse")) {
                return { stopReason: "refusal" };
            }
            if (text.includes("explode")) {
                throw new Error("the agent exploded");
            }
            if (text.includes("stall")) {
                // Never answers, never streams — the adapter's inactivity watchdog must fire.
                await new Promise(() => {});
            }
            if (text.includes("tool")) {
                await push({
                    sessionUpdate: "tool_call",
                    toolCallId: "t1",
                    title: "Edit",
                    kind: "edit",
                    status: "in_progress",
                    locations: [{ path: `${WORKSPACE_ROOT}/src/app.ts`, line: 3 }],
                    content: [{ type: "diff", path: `${WORKSPACE_ROOT}/src/app.ts`, oldText: "a", newText: "b" }],
                });
                await push({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
            }
            if (text.includes("checklist")) {
                await push({ sessionUpdate: "plan", entries: [{ content: "step 1", priority: "high", status: "in_progress" }] });
            }
            if (text.includes("ask-permission")) {
                const response = await ctx.request(methods.client.session.requestPermission, {
                    sessionId: params.sessionId,
                    toolCall: { toolCallId: "p1", kind: "execute", title: "Bash" },
                    options: [
                        { optionId: "allow", name: "Allow", kind: "allow_once" },
                        { optionId: "deny", name: "Deny", kind: "reject_once" },
                    ],
                });
                const outcome = response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled";
                await push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `permission:${outcome}` } });
                return { stopReason: "end_turn" };
            }
            if (text.includes("plan the work")) {
                // A planning-phase prompt (the emulation preamble is upstream): the reply IS the plan.
                await push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "1. do the thing" } });
                return { stopReason: "end_turn" };
            }
            if (text.includes("execute it now")) {
                await push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "executed" } });
                return { stopReason: "end_turn" };
            }
            await push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi there" } });
            return { stopReason: "end_turn" };
        });
};

// A hand-built AcpConnection over the in-process composition — what acp-connection.ts produces from a spawned
// process, minus the process. Mirrors its per-session turn routing so the adapter under test is the real one.
export const fakeAcpConnection = (app: AgentApp, capabilities: AgentCapabilities = { loadSession: false }): AcpConnection => {
    const turns = new Map<string, TurnHooks>();
    let dead = false;
    const conn = client({ name: "fake-client" })
        .onRequest(methods.client.session.requestPermission, ({ params }) => {
            const hooks = turns.get(params.sessionId);
            return hooks !== undefined ? hooks.permission(params) : decidePermission(params, "execute", false);
        })
        .onNotification(methods.client.session.update, ({ params }) => {
            turns.get(params.sessionId)?.onUpdate(params);
        })
        .connect(app);
    return {
        agent: conn.agent,
        capabilities,
        alive: () => !dead,
        stderrTail: () => "",
        sessions: new Set<string>(),
        bindTurn: (sessionId, hooks) => {
            turns.set(sessionId, hooks);
            return () => turns.delete(sessionId);
        },
        kill: () => {
            dead = true;
        },
    };
};
