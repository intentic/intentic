import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeModel, type ScriptedStep, startFakeModel } from "@intentic/fake-model";
import { z } from "zod";
import { type JsonValue, type ResponsesRequest, userMessages } from "@intentic/fake-model/responses";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { e2eTier } from "@intentic/testing/e2e";
import type { AgentRequest, TurnSpec } from "../agent/providers/agent-request.js";
import type { AgentTool } from "../agent/tools/agent-tools.js";
import { onPath } from "../system/boot/on-path.js";
import { createOpenCodeAgent, createOpenCodeRunner } from "../runtimes/opencode/opencode-agent.js";
import { mcpServersOf, openCodeMounts } from "../runtimes/opencode/opencode-mcp.js";
import { DEFAULT_TURN_TIMEOUTS } from "../runtimes/decorators/turn-watchdog.js";
import { OPENCODE_GEMINI_PROVIDER } from "../runtimes/gemini/gemini-models.js";
import { createOpenCodeService, type OpenCodeService } from "../runtimes/opencode/opencode.js";
import { parkedCards } from "../conversations/actor/parked-cards.js";
import { memoryFleet } from "../testing.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

// Real `opencode serve` and the real adapter against a scripted model, closing a gap two other suites leave (spawn
// untested, or events canned). Uses Gemini since it looks like an ordinary OpenAI-compatible provider to fake-model.

const tier = e2eTier("opencode wire conformance", { enabledBy: "INTENTIC_E2E_PROVIDERS" });

const MODEL_ID = "conformance-model";
const AUTH_TOKEN = "intentic-opencode-conformance";

// Not the SDK's default (4096); a real sandbox's warm server listens there, tying the result to the host.
const TIER_PORT = 45096;

// What the person says when they refuse the held command, and the words the MCP tool answers with: each is how the
// scripted model knows the tool's result reached it.
const REFUSAL_FEEDBACK = "Open a pull request instead of pushing.";
const MCP_ECHO = "mcp says hello";
// The MCP scenario's conversation, and the one whose servers it must not be shown.
const MCP_CONVERSATION = "opencode-wire-mcp";
const OTHER_CONVERSATION = "opencode-wire-someone-else";
const ECHO_TOOL = "say";

// One prompt's marker and the model's answer to it: a fixed step, or one read off what the request already holds.
interface Scenario {
    readonly marker: string;
    readonly step?: ScriptedStep;
    readonly answer?: (asked: string) => ScriptedStep;
}

// A table pairs each prompt's marker with its answer, so a shared server can't read another test's reply. A scenario
// with a tool call answers by what the request already holds: the call first, then prose once its result is back.
const SCENARIOS = {
    plain: { marker: "MARKER-PLAIN", step: { text: "the answer is 42" } },
    model: { marker: "MARKER-MODEL", step: { text: "ok" } },
    appendOff: { marker: "MARKER-APPEND-OFF", step: { text: "ok" } },
    appendOn: { marker: "MARKER-APPEND-ON", step: { text: "ok" } },
    // 400, not 429: a 429 costs ~70s of OpenCode's own retry backoff; this scenario targets the error path only.
    refusal: { marker: "MARKER-REFUSAL", step: { failWith: { status: 400, body: { error: { message: "conformance refusal" } } } } },
    // `git push --force` is one of the shapes the spawned config asks about, and the owner's rules hold it for a person.
    approval: {
        marker: "MARKER-APPROVAL",
        answer: (asked: string): ScriptedStep => (asked.includes(REFUSAL_FEEDBACK) ? { text: "understood, no push" } : { shell: "git push --force origin main" }),
    },
    mcp: {
        marker: "MARKER-MCP",
        answer: (asked: string): ScriptedStep =>
            asked.includes(MCP_ECHO)
                ? { text: "the tool answered" }
                : { call: { name: `${openCodeMounts(MCP_CONVERSATION, []).prefix}echo_${ECHO_TOOL}`, args: { text: "hello" } } },
    },
} as const satisfies Record<string, Scenario>;

const APPEND_SENTINEL = "OPENCODE-APPEND-SENTINEL";

let service: OpenCodeService | undefined;
let model: FakeModel | undefined;
let echo: EchoMcp | undefined;
let workspace = "";

// A minimal MCP server over Streamable HTTP, answered as plain JSON the way the daemon's own MCP door answers: one tool,
// `say`, that repeats its text, and a record of every call and the bearer it came with.
interface EchoMcp {
    readonly url: string;
    readonly calls: readonly { readonly bearer: string | undefined; readonly name: string; readonly args: unknown }[];
    readonly close: () => Promise<void>;
}

const bodyOf = async (request: IncomingMessage): Promise<string> => {
    let text = "";
    for await (const chunk of request) {
        text += String(chunk);
    }
    return text;
};

// One JSON-RPC message as the echo server reads it; whatever else OpenCode's MCP client sends is left behind.
const RpcMessageSchema = z.object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z
        .object({ protocolVersion: z.string().optional(), name: z.string().optional(), arguments: z.object({ text: z.string().optional() }).optional() })
        .optional(),
});
type RpcMessage = z.infer<typeof RpcMessageSchema>;

// The echo server's answer to a request, or undefined for a method it does not serve.
const echoAnswer = (message: RpcMessage): JsonValue | undefined => {
    if (message.method === "initialize") {
        return { protocolVersion: message.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } };
    }
    if (message.method === "tools/list") {
        return {
            tools: [{ name: ECHO_TOOL, description: "Says the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
        };
    }
    return message.method === "tools/call" ? { content: [{ type: "text", text: `mcp says ${message.params?.arguments?.text ?? ""}` }] } : undefined;
};

const startEchoMcp = async (): Promise<EchoMcp> => {
    const calls: { bearer: string | undefined; name: string; args: unknown }[] = [];
    const server = createServer((request, response) => {
        void (async () => {
            // No server-initiated stream to open: nothing here says anything unasked.
            if (request.method !== "POST") {
                response.writeHead(405).end();
                return;
            }
            const message = RpcMessageSchema.parse(JSON.parse(await bodyOf(request)));
            if (message.id === undefined) {
                response.writeHead(202).end();
                return;
            }
            if (message.method === "tools/call") {
                calls.push({ bearer: request.headers.authorization, name: message.params?.name ?? "", args: message.params?.arguments });
            }
            const result = echoAnswer(message);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify(
                    result === undefined
                        ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no ${String(message.method)}` } }
                        : { jsonrpc: "2.0", id: message.id, result },
                ),
            );
        })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name or null.
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${String(port)}/mcp/echo`,
        calls,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
};

interface TurnResult {
    readonly events: readonly AgentEvent[];
    /** Only the requests this scenario's marker provoked; a shared model records every scenario's calls. */
    readonly requests: readonly ResponsesRequest[];
}

// What a scenario changes about the turn beyond its prompt: the spec's own fields, its policy, tools and hooks, how short
// its silence limit is, and what it does with each frame as it arrives (answering a card).
interface TurnOverrides {
    readonly spec?: Pick<TurnSpec, "systemAppend" | "conversationId">;
    readonly policy?: AgentRequest["policy"];
    readonly tools?: AgentRequest["tools"];
    readonly hooks?: Omit<AgentRequest["hooks"], "cards">;
    readonly inactivityMs?: number;
    readonly onFrame?: (event: AgentEvent) => Promise<void>;
}

const runTurn = async (scenario: { marker: string }, overrides: TurnOverrides = {}): Promise<TurnResult> => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const timeouts = overrides.inactivityMs === undefined ? DEFAULT_TURN_TIMEOUTS : { ...DEFAULT_TURN_TIMEOUTS, inactivityMs: overrides.inactivityMs };
    const agent = createOpenCodeAgent(createOpenCodeRunner(service!, timeouts), OPENCODE_GEMINI_PROVIDER);
    try {
        for await (const event of agent({
            spec: { prompt: `${scenario.marker}: do the thing`, cwd: workspace, model: MODEL_ID, ...overrides.spec },
            policy: overrides.policy ?? {},
            tools: overrides.tools ?? {},
            credential: { kind: "container" },
            hooks: { cards, ...overrides.hooks },
            signal: controller.signal,
        })) {
            events.push(event);
            await overrides.onFrame?.(event);
        }
    } finally {
        controller.abort();
    }
    const mine = model!.requests.filter((request) => JSON.stringify(request).includes(scenario.marker));
    return { events, requests: mine };
};

const errorsIn = (events: readonly AgentEvent[]): readonly string[] =>
    events.filter((event) => event.kind === "error").map((event) => (event as Extract<AgentEvent, { kind: "error" }>).message);

const proseIn = (events: readonly AgentEvent[]): string =>
    events
        .filter((event) => event.kind === "delta")
        .map((event) => (event as Extract<AgentEvent, { kind: "delta" }>).text)
        .join("");

describe.skipIf(!tier.runs)(tier.title, () => {
    beforeAll(async () => {
        if (!(await onPath("opencode"))) {
            throw new Error(
                "the opencode conformance tier was asked for but no opencode binary is on PATH: install the opencode pack (image-packs/opencode.Dockerfile), or unset INTENTIC_E2E_PROVIDERS to stand the tier down deliberately",
            );
        }

        workspace = await mkdtemp(join(tmpdir(), "opencode-wire-"));
        model = await startFakeModel({
            requireKey: AUTH_TOKEN,
            respond: (request) => {
                const asked = `${userMessages(request).join(" ")} ${JSON.stringify(request)}`;
                const hit: Scenario | undefined = Object.values(SCENARIOS).find((scenario) => asked.includes(scenario.marker));
                return hit?.answer?.(asked) ?? hit?.step;
            },
        });
        service = createOpenCodeService(join(workspace, "xdg"), {
            // Gemini wiring pointed at loopback; text-only inputModalities, since these scenarios send no images.
            gemini: { baseUrl: model.baseUrl, token: AUTH_TOKEN, models: async () => [{ id: MODEL_ID, inputModalities: ["text"] }] },
            workspaceRoot: workspace,
            // Off the daemon's own port: the default is already bound by a running sandbox, failing this boot opaquely.
            port: TIER_PORT,
        });
        // Booted here, not in the first test, so a failing server fails as setup, not as whichever scenario ran first.
        await service.client();
    }, 120_000);

    // Stops the server this tier started; otherwise every run leaks an opencode serve until the box is loaded enough to
    // flake unrelated tests.
    afterAll(async () => {
        await service?.stop();
        await model?.close();
        await echo?.close();
    });

    // The whole span this runtime had no coverage of: the server boots, the provider registers, the prompt reaches the
    // model, and the reply returns as normalized frames.
    test("a plain turn boots the server, reaches the model, and streams prose back", async () => {
        const { events, requests } = await runTurn(SCENARIOS.plain);

        expect(requests.length, "the prompt must have reached the scripted model").toBeGreaterThan(0);
        expect(userMessages(requests[0]!).join("\n")).toContain(SCENARIOS.plain.marker);
        expect(errorsIn(events)).toEqual([]);
        expect(proseIn(events)).toContain("the answer is 42");
        expect(events.at(-1)?.kind).toBe("done");
    });

    // OpenCode resolves providerID/modelID against config fixed at spawn; a mismatch fails outright rather than falling
    // back.
    test("the selected model reaches the backend", async () => {
        const { requests } = await runTurn(SCENARIOS.model);
        expect(requests[0]?.model).toBe(MODEL_ID);
    });

    // OpenCode has no seam to replace its base prompt, so this runtime only appends via systemAppend; both on/off
    // halves are checked so presence alone doesn't prove the setting worked.
    test("an appended system prompt reaches the backend", async () => {
        const off = await runTurn(SCENARIOS.appendOff);
        expect(JSON.stringify(off.requests), "the sentinel must be absent without the setting, or this proves nothing").not.toContain(
            APPEND_SENTINEL,
        );

        const on = await runTurn(SCENARIOS.appendOn, { spec: { systemAppend: APPEND_SENTINEL } });
        expect(JSON.stringify(on.requests), "the owner's instructions must reach the model").toContain(APPEND_SENTINEL);
    });

    // A silent failure here would burn the two-minute inactivity watchdog; the 90s budget is a hang bound, not a timing
    // target.
    test("a model-side refusal ends the turn with an error frame rather than the inactivity watchdog", async () => {
        const { events } = await runTurn(SCENARIOS.refusal);
        expect(errorsIn(events).length, "a refused call must surface as a frame").toBeGreaterThan(0);
        expect(events.at(-1)?.kind).toBe("done");
    }, 90_000);

    // The held command parks on a card the way Codex's does: OpenCode waits on the ask, the turn's silence limit is held
    // for as long as the person takes (here far past it), and their no goes back as the call's feedback, which the model
    // reads and answers, so the turn ends on its own words rather than on the watchdog. The short silence limit is what
    // makes the wait prove the hold; the budget is a hang bound.
    test("a held command parks on a card past the silence limit, and the person's no reaches the model", async () => {
        const answered: string[] = [];
        const { events, requests } = await runTurn(SCENARIOS.approval, {
            policy: { judging: "on", rulebook: "approval" },
            hooks: { judge: async () => ({ decision: "ask", sentence: "Rewrites the shared history of main." }) },
            inactivityMs: 4_000,
            onFrame: async (event) => {
                if (event.kind !== "permission") {
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 7_000));
                answered.push(event.requestId);
                expect(cards.resolve({ kind: "permission", requestId: event.requestId, decision: "deny", feedback: REFUSAL_FEEDBACK })).toBe("settled");
            },
        });

        expect(errorsIn(events)).toEqual([]);
        expect(answered).toHaveLength(1);
        expect(events.filter((event) => event.kind === "permission" || event.kind === "resolved").map((event) => event.kind)).toEqual(["permission", "resolved"]);
        // The refusal's reason is in what the model was sent next, and the turn carried on to its answer.
        expect(JSON.stringify(requests.at(-1))).toContain(REFUSAL_FEEDBACK);
        expect(proseIn(events)).toContain("understood, no push");
        expect(events.at(-1)?.kind).toBe("done");
    }, 120_000);

    // The turn's remote MCP servers reach OpenCode as they reach Codex: mounted in the turn's directory under its
    // conversation's names, offered to the model, called with the turn's bearer, and the result read back. Another
    // conversation's server mounted in the same directory at the same time is not offered to this one.
    test("a turn's MCP server is offered to the model and called with its bearer, and another conversation's is not", async () => {
        echo = await startEchoMcp();
        const tool: AgentTool = { name: "echo", url: echo.url, token: "turn-bearer" };
        const mine = openCodeMounts(MCP_CONVERSATION, [tool]).prefix;
        const theirs = openCodeMounts(OTHER_CONVERSATION, [{ ...tool, token: "their-bearer" }]);
        const releaseTheirs = await service!.mount(workspace, mcpServersOf(theirs));
        try {
            const { events, requests } = await runTurn(SCENARIOS.mcp, { spec: { conversationId: MCP_CONVERSATION }, tools: { remote: [tool] } });

            const offered = JSON.stringify(requests[0]?.["tools"] ?? []);
            expect(offered).toContain(`${mine}echo_${ECHO_TOOL}`);
            expect(offered).not.toContain(`${theirs.prefix}echo_${ECHO_TOOL}`);
            expect(echo.calls).toEqual([{ bearer: "Bearer turn-bearer", name: ECHO_TOOL, args: { text: "hello" } }]);
            expect(events.find((event) => event.kind === "tool_call")).toMatchObject({ name: `mcp__echo__${ECHO_TOOL}` });
            expect(JSON.stringify(requests.at(-1))).toContain(MCP_ECHO);
            expect(errorsIn(events)).toEqual([]);
            expect(events.at(-1)?.kind).toBe("done");
        } finally {
            await releaseTheirs();
        }
    }, 120_000);
});
