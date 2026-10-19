import { WORKSPACE_ROOT } from "@intentic/constants";
import {
    agent,
    type AgentApp,
    type AgentContext,
    type AgentCapabilities,
    client,
    methods,
    RequestError,
    type PromptResponse,
    type RequestPermissionRequest,
    type SessionConfigOption,
    type SessionModeState,
    type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { AcpConnection } from "../acp-connection.js";
import type { AcpSessionMeta } from "../acp-spawn.js";
import { routeSessions, type SessionRouting } from "../acp-routing.js";

/* This fixture uses the ACP SDK in-process without transport. */

// What a test reads back of a session's `_meta`: the scalar switches a launch sends (AcpSessionMeta).
const SessionMetaSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional();

// A permission request for a command the owner's rules hold (a force push), readable by the classifier.
const forcePush = (sessionId: string): RequestPermissionRequest => ({
    sessionId,
    toolCall: { toolCallId: "p2", kind: "execute", title: "Run git push", rawInput: { command: "git push --force origin main" } },
    options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
});

// An ELICITATION form the agent asks: a titled single choice (required) and a yes/no.
const SHIP_FORM = {
    type: "object",
    properties: {
        target: { type: "string", title: "Target", oneOf: [{ const: "prod", title: "Production" }, { const: "stage", title: "Staging" }] },
        notify: { type: "boolean", title: "Notify the team" },
    },
    required: ["target"],
} as const;

// The behaviours that read what the turn set up (its mode, its reasoning depth) or ask the client for more than a
// permission (a form, a terminal), keyed like the rest by a keyword in the prompt; undefined for any other prompt.
const postureBehaviour = async (
    text: string,
    sessionId: string,
    ctx: AgentContext,
    state: { readonly mode: Map<string, string>; readonly thought: Map<string, string>; readonly options: { readonly modes?: readonly { readonly id: string }[]; readonly thoughts?: readonly string[] } },
): Promise<PromptResponse | undefined> => {
    const say = (said: string): Promise<void> =>
        ctx.notify(methods.client.session.update, { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: said } } });
    if (text.includes("refuse")) {
        return { stopReason: "refusal" };
    }
    if (text.includes("spent-allowance")) {
        throw new Error("429 Too Many Requests: rate limit exceeded");
    }
    if (text.includes("which-mode")) {
        await say(`mode:${state.mode.get(sessionId) ?? state.options.modes?.[0]?.id ?? "none"}`);
        return { stopReason: "end_turn" };
    }
    if (text.includes("which-thought")) {
        await say(`thought:${state.thought.get(sessionId) ?? state.options.thoughts?.[0] ?? "none"}`);
        return { stopReason: "end_turn" };
    }
    if (text.includes("ask-form")) {
        const answer = await ctx.request(methods.client.elicitation.create, { sessionId, mode: "form", message: "How should I ship it?", requestedSchema: SHIP_FORM });
        await say(`form:${JSON.stringify(answer)}`);
        return { stopReason: "end_turn" };
    }
    if (text.includes("ask-then-run")) {
        await ctx.request(methods.client.session.requestPermission, forcePush(sessionId));
    }
    if (text.includes("run-terminal") || text.includes("ask-then-run")) {
        const created = await ctx
            .request(methods.client.terminal.create, { sessionId, command: "bash", args: ["-lc", "git push --force origin main"] })
            .then(
                (answer: { readonly terminalId: string }) => answer.terminalId,
                () => "refused",
            );
        await say(`terminal:${created}`);
        return { stopReason: "end_turn" };
    }
    return undefined;
};

// The fixture's session/prompt behaviours, keyed by a keyword in the prompt text. `answered` hears how an ask the agent
// left behind was finally answered, after its turn ended.
export const fakeAcpAgentApp = (
    options: {
        readonly answered?: (outcome: string) => void;
        readonly failure?: { readonly method: "load" | "new" | "prompt"; readonly code: number; readonly message: string };
        // A model option on every session, as Devin's CLI offers one: these values, the first current. Absent: none.
        readonly models?: readonly string[];
        // A reasoning-depth option (`thought_level`) on every session: these values, the first current. Absent: none.
        readonly thoughts?: readonly string[];
        // Modes on every session, as Devin's CLI advertises them, the first current. Absent: none.
        readonly modes?: readonly { readonly id: string; readonly name: string }[];
        // Told the `_meta` each session/new arrived with, as Grok Build reads its per-session switches there.
        readonly sessionMeta?: (meta: AcpSessionMeta | undefined) => void;
    } = {},
): AgentApp => {
    let nextSession = 0;
    // Each session's current model and reasoning depth, where the options give the sessions one.
    const current = new Map<string, string>();
    const thought = new Map<string, string>();
    const mode = new Map<string, string>();
    const modeState = (sessionId: string): SessionModeState | undefined =>
        options.modes === undefined
            ? undefined
            : { currentModeId: mode.get(sessionId) ?? options.modes[0]?.id ?? "", availableModes: options.modes.map((entry) => ({ ...entry })) };
    const configOptions = (sessionId: string): SessionConfigOption[] | undefined => {
        const offered: SessionConfigOption[] = [];
        if (options.models !== undefined) {
            offered.push(
                {
                    id: "mode",
                    name: "Session Mode",
                    category: "mode",
                    type: "select",
                    currentValue: "code",
                    options: [{ value: "code", name: "Code" }],
                },
                {
                    id: "model",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: current.get(sessionId) ?? options.models[0] ?? "",
                    options: options.models.map((value) => ({ value, name: value.toUpperCase() })),
                },
            );
        }
        if (options.thoughts !== undefined) {
            offered.push({
                id: "thought",
                name: "Thinking",
                category: "thought_level",
                type: "select",
                currentValue: thought.get(sessionId) ?? options.thoughts[0] ?? "",
                options: options.thoughts.map((value) => ({ value, name: value })),
            });
        }
        return offered.length === 0 ? undefined : offered;
    };
    // Stalled prompts by session, each answered `cancelled` once its session is cancelled, as the protocol asks.
    const stalled = new Map<string, () => void>();
    const fail = (method: "load" | "new" | "prompt"): void => {
        if (options.failure?.method === method) {
            throw new RequestError(options.failure.code, options.failure.message);
        }
    };
    return agent({ name: "fake-acp" })
        .onRequest(methods.agent.initialize, () => ({
            protocolVersion: 1,
            agentCapabilities: { loadSession: false },
        }))
        .onRequest(methods.agent.session.load, () => {
            fail("load");
            return {};
        })
        .onRequest(methods.agent.session.new, ({ params }) => {
            options.sessionMeta?.(SessionMetaSchema.parse(params["_meta"] ?? undefined));
            fail("new");
            const sessionId = `fake-${(nextSession += 1)}`;
            return { sessionId, configOptions: configOptions(sessionId) ?? null, modes: modeState(sessionId) ?? null };
        })
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
            const value = "value" in params && typeof params.value === "string" ? params.value : undefined;
            if (params.configId === "model" && value !== undefined && (options.models ?? []).includes(value)) {
                current.set(params.sessionId, value);
            } else if (params.configId === "thought" && value !== undefined && (options.thoughts ?? []).includes(value)) {
                thought.set(params.sessionId, value);
            } else {
                throw RequestError.invalidParams({ configId: params.configId });
            }
            return { configOptions: configOptions(params.sessionId) ?? [] };
        })
        .onRequest(methods.agent.session.setMode, async ({ params, client: ctx }) => {
            if (!(options.modes ?? []).some((entry) => entry.id === params.modeId)) {
                throw RequestError.invalidParams({ modeId: params.modeId });
            }
            mode.set(params.sessionId, params.modeId);
            await ctx.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId },
            });
            return {};
        })
        .onNotification(methods.agent.session.cancel, ({ params }) => {
            stalled.get(params.sessionId)?.();
            stalled.delete(params.sessionId);
        })
        .onRequest(methods.agent.session.prompt, async ({ params, client: ctx }) => {
            fail("prompt");
            const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
            const push = (update: SessionUpdate): Promise<void> => ctx.notify(methods.client.session.update, { sessionId: params.sessionId, update });
            const answered = await postureBehaviour(text, params.sessionId, ctx, { mode, thought, options });
            if (answered !== undefined) {
                return answered;
            }
            if (text.includes("explode")) {
                throw new Error("the agent exploded");
            }
            if (text.includes("stall")) {
                // Never streams, and answers only a cancel: the adapter's inactivity watchdog must fire.
                await new Promise<void>((resolve) => stalled.set(params.sessionId, resolve));
                return { stopReason: "cancelled" };
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
            if (text.includes("ask-and-report")) {
                // Asks, then says how it was answered in the stop reason, for a caller that hears no session update.
                const response = await ctx.request(methods.client.session.requestPermission, forcePush(params.sessionId));
                return { stopReason: response.outcome.outcome === "cancelled" ? "cancelled" : "end_turn" };
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
            if (text.includes("ask-to-force-push")) {
                const response = await ctx.request(methods.client.session.requestPermission, forcePush(params.sessionId));
                const outcome = response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled";
                await push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `permission:${outcome}` } });
                return { stopReason: "end_turn" };
            }
            if (text.includes("ask-and-leave")) {
                // Asks, then ends its turn without waiting for the answer, as an agent whose process died would.
                void ctx.request(methods.client.session.requestPermission, forcePush(params.sessionId)).then((response) => {
                    options.answered?.(response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled");
                });
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
            const model = current.get(params.sessionId);
            await push({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: model === undefined ? "Hi there" : `Hi there from ${model}` },
            });
            return { stopReason: "end_turn" };
        });
};

// A hand-built AcpConnection over the in-process composition, what acp-connection.ts produces from a spawned
// process, minus the process. Mirrors its per-session turn routing so the adapter under test is the real one.
export const fakeAcpConnection = (app: AgentApp, capabilities: AgentCapabilities = { loadSession: false }): AcpConnection => {
    const routing: SessionRouting = { turns: new Map(), abandoned: new Set(), models: new Map(), thoughts: new Map(), modes: new Map() };
    const { turns, abandoned } = routing;
    let dead = false;
    let terminals = 0;
    const conn = routeSessions(client({ name: "fake-client" }), routing)
        // terminal/create as the production connection admits it, minus tmux: the rulebook's word, then an id.
        .onRequest(methods.client.terminal.create, async ({ params }) => {
            const context = turns.get(params.sessionId)?.terminal;
            if (context === undefined) {
                throw new Error("no terminal is available for this session");
            }
            await context.admit(params);
            context.onCreate();
            return { terminalId: `term-${(terminals += 1)}` };
        })
        .connect(app);
    return {
        agent: conn.agent,
        capabilities,
        alive: () => !dead,
        stderrTail: () => "",
        sessions: new Set<string>(),
        models: routing.models,
        thoughts: routing.thoughts,
        modes: routing.modes,
        terminalExit: () => undefined,
        bindTurn: (sessionId, hooks) => {
            abandoned.delete(sessionId);
            turns.set(sessionId, hooks);
            return () => {
                if (turns.get(sessionId) === hooks) {
                    turns.delete(sessionId);
                }
            };
        },
        abandon: (sessionId) => {
            abandoned.add(sessionId);
            if (turns.size === 0) {
                dead = true;
            }
        },
        kill: () => {
            dead = true;
        },
    };
};
