import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { requires } from "@intentic/testing/requires";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { AgentRequest, ContainerCredential } from "../../agent/providers/agent-request.js";
import { SteeringQueue } from "../../agent/checkpoints/agent-steering.js";
import type { SecretAccess } from "../../secrets/secret-access.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../testing.js";
import { OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { opt } from "../../opt.js";
import { createOpenCodeAgent, createOpenCodeRunner } from "./opencode-agent.js";
import { createOpenCodeService, type OpenCodeService } from "./opencode.js";

// The OpenCode loop against a real `opencode serve` (the pinned 2.0.26 CLI), its Google provider pointed at a scripted
// OpenAI-compatible model served from this test: what the daemon sends OpenCode and what OpenCode makes of it, end to
// end, with no account and no network. Each scripted reply is one model call: a tool call, or text that ends the step.

const BINARY = "/usr/local/bin/opencode";
const cli = requires(existsSync(BINARY), "the OpenCode CLI at /usr/local/bin/opencode", {
    absentOnCi: "the OpenCode CLI is a feature pack of the sandbox image, which the daemon's suites do not run in",
});

type Reply =
    | { readonly text: string }
    | { readonly tool: string; readonly args: Record<string, unknown> }
    | { readonly status: number; readonly retryAfter: number };

interface ChatRequest {
    readonly reasoning_effort?: string;
    readonly tools?: readonly { readonly function: { readonly name: string } }[];
    readonly messages: readonly { readonly role: string; readonly content: unknown }[];
}

// The scripted model: answers each chat request with the next reply, recording every request it was sent.
const scriptedModel = async () => {
    const replies: Reply[] = [];
    const requests: ChatRequest[] = [];
    const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        let body = "";
        for await (const chunk of request) {
            body += String(chunk);
        }
        if (request.url?.endsWith("/chat/completions") !== true) {
            response.writeHead(404).end();
            return;
        }
        // SAFETY: OpenCode's OpenAI-compatible provider sends a chat request body; this test reads only these fields.
        const sent = JSON.parse(body) as ChatRequest & { readonly model: string };
        requests.push(sent);
        const reply = replies.shift() ?? { text: "done" };
        if ("status" in reply) {
            response.writeHead(reply.status, { "content-type": "application/json", "retry-after": String(reply.retryAfter) });
            response.end(JSON.stringify({ error: { message: "Too many requests: slow down", code: reply.status } }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, unknown>): string =>
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: sent.model, choices: [{ index: 0, delta, finish_reason: finish }], ...opt("usage", usage) })}\n\n`;
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 2 } };
        if ("tool" in reply) {
            response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${String(requests.length)}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }, null));
            response.write(chunk({}, "tool_calls", usage));
        } else {
            response.write(chunk({ role: "assistant", content: reply.text }, null));
            response.write(chunk({}, "stop", usage));
        }
        response.end("data: [DONE]\n\n");
    };
    const server: Server = createServer((request, response) => void answer(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port reports its address as an AddressInfo, never a pipe path.
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${String(port)}`, replies, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

// What the model was told by the system, joined: OpenCode sends it as one or more system messages.
const systemOf = (request: ChatRequest | undefined): string =>
    (request?.messages ?? [])
        .filter((message) => message.role === "system")
        .map((message) => String(message.content))
        .join("\n");
const said = (request: ChatRequest | undefined): string => JSON.stringify((request?.messages ?? []).filter((message) => message.role !== "system"));

let model: Awaited<ReturnType<typeof scriptedModel>>;
let dir = "";
let service: OpenCodeService;
const cards = parkedCards(memoryFleet().conversations);

beforeAll(async () => {
    if (!cli.runs) {
        return;
    }
    model = await scriptedModel();
    dir = await mkdtemp(join(tmpdir(), "opencode-live-"));
    service = createOpenCodeService(join(dir, "xdg"), {
        idleStopMs: 0,
        // Every shell command goes through the daemon's own script, as in production.
        shellDir: join(dir, "shell"),
        gemini: { baseUrl: model.url, token: "local", models: async () => [{ id: "m1", inputModalities: ["text"], efforts: ["low", "high"] }] },
    });
});

afterAll(async () => {
    if (!cli.runs) {
        return;
    }
    await service.stop();
    await model.close();
    await rm(dir, { recursive: true, force: true });
});

const request = (spec: Partial<AgentRequest<ContainerCredential>["spec"]> = {}, policy: AgentRequest["policy"] = {}): AgentRequest<ContainerCredential> => ({
    execution: unstubbed("execution", {}),
    spec: { prompt: "hi", cwd: dir, model: "m1", conversationId: "live-1", ...spec },
    policy,
    tools: {},
    credential: { kind: "container" },
    hooks: { cards },
    signal: new AbortController().signal,
});

// Runs one turn, `onFrame` seeing every frame as it comes (to answer a card, or steer).
const run = async (turn: AgentRequest<ContainerCredential>, replies: readonly Reply[], onFrame: (frame: AgentEvent) => void = () => {}): Promise<AgentEvent[]> => {
    // A reply an earlier turn never asked for is not this turn's.
    model.replies.splice(0, model.replies.length, ...replies);
    const agent = createOpenCodeAgent(createOpenCodeRunner(service, { inactivityMs: 30_000, maxTurnMs: 90_000 }), OPENCODE_GEMINI_PROVIDER);
    const frames: AgentEvent[] = [];
    for await (const frame of agent(turn)) {
        frames.push(frame);
        onFrame(frame);
    }
    return frames;
};

test.skipIf(!cli.runs)(cli.title("a Google turn sends its effort as the variant, asks its question on a card, and runs its shell with the turn's environment"), async () => {
    const replies: Reply[] = [
        { tool: "question", args: { questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }] } },
        { tool: "shell", args: { command: "echo probe=$INTENTIC_LIVE_PROBE home=$HOME", description: "probe" } },
        { text: "All done." },
    ];
    const sent = model.requests.length;
    const turn = { ...request({ effort: "high", prompt: "pick a color" }), tools: { cliEnv: { INTENTIC_LIVE_PROBE: "yes" } } };

    const frames = await run(turn, replies, (frame) => {
        if (frame.kind === "question") {
            setTimeout(() => cards.resolve({ kind: "question", requestId: frame.requestId, answers: { "Which color?": ["Blue"] } }), 0);
        }
    });

    const requests = model.requests.slice(sent);
    expect(requests[0]?.reasoning_effort).toBe("high");
    expect(frames.find((frame) => frame.kind === "question")).toMatchObject({ questions: [{ question: "Which color?", header: "Color", multiSelect: false }] });
    // The card's answer reached the model as the question tool's result.
    expect(said(requests[1])).toContain('\\"Which color?\\"=\\"Blue\\"');
    // `session.environment` replaces the shell's environment outright, so the turn's own (HOME included) went whole.
    expect(said(requests[2])).toContain(`probe=yes home=${process.env["HOME"] ?? ""}`);
    expect(frames.find((frame) => frame.kind === "usage")).toMatchObject({ inputTokens: 30, outputTokens: 15 });
    expect(frames.at(-1)).toEqual({ kind: "done" });
});

test.skipIf(!cli.runs)(cli.title("a message steered in while the turn works reaches the model in the same turn, and admission closes as it ends"), async () => {
    const sent = model.requests.length;
    const steering = new SteeringQueue();

    const frames = await run(request({ prompt: "build it", steering }), [{ tool: "shell", args: { command: "sleep 1; echo built", description: "build" } }, { text: "Built." }], (frame) => {
        if (frame.kind === "tool_call") {
            steering.push("also run the tests");
        }
    });

    // Taken in at the model's next step: the call after the shell's result carries it, in this same turn.
    const requests = model.requests.slice(sent);
    expect(said(requests[0])).not.toContain("also run the tests");
    expect(said(requests[1])).toContain("also run the tests");
    expect(frames.at(-1)).toEqual({ kind: "done" });
    // The turn is over: a message now is the next turn's, not this one's.
    expect(steering.push("too late")).toBe(false);
});

test.skipIf(!cli.runs)(cli.title("OpenCode's commands are published, and a /name prompt runs as that command"), async () => {
    const sent = model.requests.length;

    const frames = await run(request({ prompt: "/review the staged diff" }), [{ text: "Reviewed." }]);

    expect(frames.find((frame) => frame.kind === "commands")).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ name: "review" })]) });
    // The command's own template is what the model was asked, its words the template's arguments.
    expect(said(model.requests[sent])).toContain("the staged diff");
    expect(said(model.requests[sent])).toContain("code reviewer");
});

test.skipIf(!cli.runs)(cli.title("an owner's own prompt replaces OpenCode's base prompt, and the daemon's additions follow OpenCode's own"), async () => {
    const sent = model.requests.length;

    await run(request({ systemPrompt: "OWNER PROMPT: answer in haiku." }), [{ text: "Replaced." }]);
    await run(request({ systemAppend: "DAEMON ADDITIONS." }), [{ text: "Appended." }]);

    const [replaced, appended] = model.requests.slice(sent);
    expect(systemOf(replaced)).toContain("OWNER PROMPT: answer in haiku.");
    expect(systemOf(replaced)).not.toContain("You are an AI agent running in OpenCode");
    expect(systemOf(appended)).toContain("You are an AI agent running in OpenCode");
    expect(systemOf(appended)).toContain("DAEMON ADDITIONS.");
});

// OpenCode would wait out a provider's retry-after of up to 15 minutes in-turn; the daemon holds the conversation and
// resumes it at the reset instead.
test.skipIf(!cli.runs)(cli.title("a rate limit that would keep the turn waiting minutes is handed to the daemon, coded with its reset"), async () => {
    const before = Date.now();

    const frames = await run(request({ prompt: "go" }), [{ status: 429, retryAfter: 600 }]);

    const failure = frames.find((frame) => frame.kind === "error");
    expect(failure).toMatchObject({ kind: "error", code: "rate_limit" });
    expect(failure?.kind === "error" ? failure.resetsAt : undefined).toBeGreaterThan(Math.floor(before / 1_000) + 500);
    expect(frames.at(-1)).toEqual({ kind: "done" });
});

test.skipIf(!cli.runs)(cli.title("in default mode a write goes on a per-tool card first, and a no reaches the model as the call's refusal"), async () => {
    const sent = model.requests.length;

    const frames = await run(
        request({ prompt: "write it" }, { permissionMode: "default" }),
        [{ tool: "write", args: { path: join(dir, "out.txt"), content: "x" } }, { text: "Not written." }],
        (frame) => {
            if (frame.kind === "permission") {
                setTimeout(() => cards.resolve({ kind: "permission", requestId: frame.requestId, decision: "deny", feedback: "Not that file." }), 0);
            }
        },
    );

    expect(frames.find((frame) => frame.kind === "permission")).toMatchObject({ toolName: "Edit", reason: "mode" });
    expect(said(model.requests[sent + 1])).toContain("Not that file.");
    expect(existsSync(join(dir, "out.txt"))).toBe(false);
});

// What the model was offered, by name.
const offered = (sent: ChatRequest | undefined): string[] => (sent?.tools ?? []).map((tool) => tool.function.name).toSorted();

// A turn's tool list holds on OpenCode's own rules: the model is offered only the listed tools, a subagent's child session
// only those too, and a command the list's shell entry does not name is refused before it runs.
test.skipIf(!cli.runs)(cli.title("a turn's tool list is all the model is offered, its subagents included, and an unlisted command is refused"), async () => {
    const sent = model.requests.length;
    const marker = join(dir, "unlisted.txt");

    await run(request({ prompt: "look around" }, { allowedTools: ["Read", "Task", "Bash(echo hi)"] }), [
        { tool: "subagent", args: { agent: "general", description: "look", prompt: "read it" } },
        { text: "Child done." },
        { tool: "shell", args: { command: `touch ${marker}`, description: "unlisted" } },
        { tool: "shell", args: { command: "echo hi", description: "listed" } },
        { text: "Done." },
    ]);

    const requests = model.requests.slice(sent);
    // The turn's own first call, then its subagent's.
    expect(offered(requests[0])).toEqual(["read", "shell", "subagent"]);
    expect(offered(requests[1])).toEqual(["read", "shell", "subagent"]);
    expect(said(requests[3])).toContain("is not on this turn's tool list");
    expect(existsSync(marker)).toBe(false);
    expect(said(requests[4])).toContain("hi");
});

// The value a stored secret holds in the test below, and the seam a turn resolves and masks it through.
const STORED = "tok-77a1c9e05b2d48";
const storedSecrets: SecretAccess = {
    list: async () => [{ name: "LIVE_TOKEN", value: STORED, source: "env" }],
    used: () => {},
    release: async () => ({ ok: true }),
};

// OpenCode runs its shell as the daemon's script: the command runs in the conversation's terminal pane, a secret
// reference in it runs as its value, and the model reads the value back only as its reference.
test.skipIf(!cli.runs)(cli.title("a shell command runs in the turn's terminal pane, its secret resolved and its output masked"), async () => {
    const sent = model.requests.length;
    const turn = { ...request({ prompt: "use the token" }), tools: { secrets: storedSecrets } };

    const frames = await run(turn, [{ tool: "shell", args: { command: "printf 'got=%s\\n' {{secret:LIVE_TOKEN}}", description: "token" } }, { text: "Done." }]);

    const panes = frames.filter((frame) => frame.kind === "terminal");
    expect(panes).toEqual([{ kind: "terminal", session: expect.stringMatching(/^agent-/) }]);
    const result = said(model.requests[sent + 1]);
    expect(result).not.toContain(STORED);
    expect(result).toMatch(/got=(?:\{\{secret:LIVE_TOKEN\}\}|\*\*\*)/);
});

// OpenCode's own `explore` subagent allows every shell command in its own rules, which come after the server's ask; the
// session's rules come after both and its child sessions inherit them, so its commands reach the rulebook (and here, in
// `default` mode, a person's card) like the turn's own.
test.skipIf(!cli.runs)(cli.title("a shell command an explore subagent runs is asked about like the turn's own"), async () => {
    const marker = join(dir, "explored.txt");
    const asked: string[] = [];

    await run(
        request({ prompt: "look around" }, { permissionMode: "default" }),
        [
            { tool: "subagent", args: { agent: "explore", description: "look", prompt: "touch the marker" } },
            { tool: "shell", args: { command: `touch ${marker}`, description: "marker" } },
            { text: "Child done." },
            { text: "Done." },
        ],
        (frame) => {
            if (frame.kind === "permission") {
                asked.push(frame.toolName);
                setTimeout(() => cards.resolve({ kind: "permission", requestId: frame.requestId, decision: "deny", feedback: "Not that." }), 0);
            }
        },
    );

    expect(asked).toEqual(["Bash"]);
    expect(existsSync(marker)).toBe(false);
});
