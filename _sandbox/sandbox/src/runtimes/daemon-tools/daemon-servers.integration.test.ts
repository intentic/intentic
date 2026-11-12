import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentReply } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { AgentTurnSchema } from "@intentic/sandbox-contract/schemas/agent";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { pino } from "pino";
import { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { BrowserTurnTools } from "../../browser/tools/browser-tools.js";
import type { ParkedCards } from "../../conversations/actor/parked-cards.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import { NO_GATE } from "./policy-gate.js";
import { createTurnTaint } from "../../guard/turn-taint.js";
import { type TurnPersona, turnPersona } from "../../personas/personas.js";
import { DEFAULT_TURN_TIMEOUTS, turnWatchdog } from "../decorators/turn-watchdog.js";
import { opt } from "../../opt.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { conversationEntry } from "../../conversations/registry/agents-store.testing.js";
import type { Said } from "../../seams/turn-starter.js";
import { advanceTimersByTimeAsync, waitFor } from "@intentic/testing/bun";
import type { TurnContext } from "../../agent/providers/adapter.js";
import type { ChildSupervisor } from "../../agent/subagents/children.js";
import { harnessServers, turnSecretAccess } from "../../agent/run/harness/harness-servers.js";
import { type DaemonServersDeps, daemonServersFor, type DaemonServersTurn } from "./daemon-servers.js";
import { tmuxRunEnabled } from "../../agent/tools/agent-terminals.js";
import { createTurnMounts } from "../../agent/tools/turn-mounts.js";
import { createTurnMountRoute, daemonEndpoint, type MountEndpoints } from "../../agent/tools/turn-mounts.routes.js";

// The daemon's own servers as a non-Claude runtime reaches them: built for one turn, mounted on its lease, called over
// HTTP through the door with the turn's bearer, and held to the persona decisions the Claude loop's in-process servers are.

const ROOT = mkdtempSync(join(tmpdir(), "daemon-servers-"));
const SETTINGS = SandboxSettingsSchema.parse({});
const OPEN = turnPersona({ personas: [], actsAs: undefined, unattended: false });
const input = AgentTurnSchema.parse({ prompt: "do the thing", conversationId: "conv-1" });

const depsWith = (over: Partial<DaemonServersDeps> = {}): DaemonServersDeps => unstubbed<DaemonServersDeps>("deps", {
    // Holdings only, for the child-result door: this turn is no spawned child, so it is handed none.
    conversations: unstubbed<DaemonServersDeps["conversations"]>("conversations", { holdings: memoryFleet().conversations.holdings }),
    config: unstubbed<DaemonServersDeps["config"]>("config", { historyRoot: ROOT }),
    usage: unstubbed<DaemonServersDeps["usage"]>("usage", { turns: async () => [] }),
    dependencies: unstubbed<DaemonServersDeps["dependencies"]>("dependencies", {}),
    agents: unstubbed<DaemonServersDeps["agents"]>("agents", { entry: () => undefined }),
    logger: pino({ level: "silent" }),
    ...over,
});
const deps = depsWith();

// A card registry whose one card is answered when the test says.
const cardsAnswering = () => {
    let answer: (reply: Extract<AgentReply, { kind: "question" }>) => void = () => {};
    const answered = new Promise<Extract<AgentReply, { kind: "question" }>>((resolve) => {
        answer = resolve;
    });
    const cards = unstubbed<ParkedCards>("cards", {
        // SAFETY: only the question card is raised here, and its wait answers with a question reply and its frame.
        create: ((_kind: string) => ({
            id: "card-1",
            wait: async () => {
                const reply = await answered;
                return { reply, resolved: { kind: "resolved", requestId: "card-1", reply } };
            },
        })) as ParkedCards["create"],
    });
    return { cards, answer };
};

const contextOf = (cards: ParkedCards, children?: ChildSupervisor): TurnContext => ({
    base: {
        execution: unstubbed("execution", {}),
        spec: { prompt: "do the thing", cwd: ROOT, conversationId: "conv-1" },
        policy: {},
        tools: {},
        hooks: { cards },
        signal: new AbortController().signal,
    },
    attachmentPaths: [],
    localCwd: ROOT,
    effectiveCwd: ROOT,
    cliEnv: {},
    steering: undefined,
    ...opt("children", children),
});

const NO_BROWSER: BrowserTurnTools = { servers: [], accounts: {}, ports: {}, passkeys: {} };

const doorFor = (turn: Omit<DaemonServersTurn, "mounted">, served: DaemonServersDeps = deps) => {
    const mounts = createTurnMounts({ baseUrl: () => "http://127.0.0.1:8787/mcp" });
    const lease = mounts.lease("conv-1");
    const built = daemonServersFor(served, { ...turn, mounted: { browser: NO_BROWSER, desktop: false, lease } });
    const app = new Hono<AppEnv>().all("/mcp/:mount", createTurnMountRoute(mounts, unstubbed<MountEndpoints>("endpoints", { daemon: daemonEndpoint })));
    const token = built.tools[0]?.token ?? "";
    let id = 0;
    const rpc = async (name: string, method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
        id += 1;
        const response = await app.request(`/mcp/${name}`, {
            ...opt("signal", signal),
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, ...opt("params", params) }),
        });
        return AnswerSchema.parse(await response.json());
    };
    const toolsOf = async (name: string): Promise<string[]> => ((await rpc(name, "tools/list")).result?.tools ?? []).map((tool) => tool.name);
    const call = async (name: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> =>
        ((await rpc(name, "tools/call", { name: tool, arguments: args }, signal)).result?.content ?? []).map((part) => part.text ?? "").join("\n");
    return { built, lease, toolsOf, call, names: built.tools.map((tool) => tool.name) };
};

const AnswerSchema = z.object({
    result: z
        .object({
            tools: z.array(z.object({ name: z.string() })).optional(),
            content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
        })
        .optional(),
});

const restricted = (powers: Partial<TurnPersona["powers"]>): TurnPersona => ({ ...OPEN, powers: { ...OPEN.powers, ...powers } });

test("an open turn reaches the daemon's servers through the door, each answering its own tools", async () => {
    const door = doorFor({ input, context: contextOf(cardsAnswering().cards), persona: OPEN, granted: [], settings: { ...SETTINGS, chatPages: false } });
    // The terminal hand-off rides only where commands run in the panel's tmux panes (tmux-run is in the image).
    expect(door.names).toEqual(["ui", "subagents", "watch", "deps", "diagnostics", ...(tmuxRunEnabled() ? ["terminal"] : [])]);
    expect(door.built.diagnostics).toBe(true);
    expect(await door.toolsOf("ui")).toEqual(["ask"]);
    expect(await door.toolsOf("watch")).toContain("start");
    expect(await door.toolsOf("subagents")).toEqual(expect.arrayContaining(["wait", "keep"]));
    expect(await door.toolsOf("subagents")).not.toContain("spawn");
    // Each mount says how long a client should wait on it: a card, a child.
    expect(door.built.tools.find((tool) => tool.name === "ui")?.timeoutMs).toBe(24 * 3_600_000);
    door.lease.release();
});

test("a persona's powers withhold exactly what they withhold from the Claude loop's in-process servers", () => {
    const children = unstubbed<ChildSupervisor>("children", {});
    const personas = [OPEN, restricted({ files: "none" }), restricted({ shell: false }), restricted({ delegate: false })];
    for (const persona of personas) {
        const context = contextOf(cardsAnswering().cards, children);
        const claude = Object.keys(
            harnessServers(deps, { input, context, persona, browser: NO_BROWSER, desktop: false, granted: [], secrets: turnSecretAccess(deps, input, context.base.signal), hashlineEdits: false }),
        );
        const door = doorFor({ input, context, persona, granted: [], settings: SETTINGS });
        // The door adds only what the Claude loop mounts in claude-code-runner.ts itself (`ui`, `terminal`), never a server
        // the persona was denied.
        expect(door.names.filter((name) => name !== "ui" && name !== "terminal")).toEqual(claude);
        door.lease.release();
    }
});

test("spawn rides only with the delegate shelf and full agency, as it does in-process", async () => {
    const children = unstubbed<ChildSupervisor>("children", {});
    const open = doorFor({ input, context: contextOf(cardsAnswering().cards, children), persona: OPEN, granted: [], settings: SETTINGS });
    expect(await open.toolsOf("subagents")).toContain("spawn");
    const held = doorFor({ input, context: contextOf(cardsAnswering().cards, children), persona: restricted({ delegate: false }), granted: [], settings: SETTINGS });
    expect(await held.toolsOf("subagents")).not.toContain("spawn");
});

test("the page tools ride the ui server only where the owner leaves them on", async () => {
    const door = doorFor({ input, context: contextOf(cardsAnswering().cards), persona: OPEN, granted: [], settings: { ...SETTINGS, chatPages: true } });
    expect(await door.toolsOf("ui")).toEqual(["show_page", "ask_page", "ask"]);
});

test("ask parks on a card: its frame waits for the loop, the watchdog is held while a person answers, the answer comes back", async () => {
    const { cards, answer } = cardsAnswering();
    const door = doorFor({ input, context: contextOf(cards), persona: OPEN, granted: [], settings: SETTINGS });
    const asked = door.call("ui", "ask", {
        questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }],
    });
    // The loop has not started: the question waits on the relay, not lost.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const seen: AgentEvent[] = [];
    const clock = turnWatchdog({ inactivityMs: 10, maxTurnMs: 20 });
    door.built.relay.attach({ push: (event) => seen.push(event), hold: clock.hold });
    expect(seen.map((event) => event.kind)).toEqual(["question"]);
    expect(clock.remaining()).toBe(Number.POSITIVE_INFINITY);
    answer({ kind: "question", requestId: "card-1", answers: { "Which?": ["B"] } });
    expect(await asked).toContain("B");
    expect(seen.map((event) => event.kind)).toEqual(["question", "resolved"]);
    expect(clock.remaining()).toBeLessThan(Number.POSITIVE_INFINITY);
});

// 2026-11-12: a forwarded peer call took no hold, so on the loops with a silence limit (OpenCode, Pi, ACP, Muse: 120 s,
// turn-watchdog.ts) a device command or a browser's wait_for running past two minutes ended the turn mid-call. The door
// now holds the watchdog the turn's relay hands its lease, for as long as the call runs.
test("a peer call that runs three minutes holds the turn's watchdog, so the 120 s silence limit does not end the turn", async () => {
    jest.useFakeTimers();
    try {
        const mounts = createTurnMounts({ baseUrl: () => "http://127.0.0.1:8787/mcp" });
        const lease = mounts.lease("conv-1");
        // Mounted as turnToolsOf mounts it, before the daemon's servers, whose relay then hands the lease its hold.
        const { token } = lease.open({ name: "laptop", target: { kind: "device", id: "laptop" } });
        const built = daemonServersFor(deps, { input, context: contextOf(cardsAnswering().cards), persona: OPEN, granted: [], settings: SETTINGS, mounted: { browser: NO_BROWSER, desktop: false, lease } });
        // As the ACP, Pi and Muse loops attach their clock.
        const clock = turnWatchdog(DEFAULT_TURN_TIMEOUTS);
        built.relay.attach({ push: () => {}, hold: clock.hold });
        const device = async (_target: { readonly id: string }, message: { readonly id?: string | number | null }) => {
            await new Promise((resolve) => setTimeout(resolve, 180_000));
            return { jsonrpc: "2.0" as const, id: message.id ?? null, result: { content: [{ type: "text", text: "done" }] } };
        };
        const app = new Hono<AppEnv>().all("/mcp/:mount", createTurnMountRoute(mounts, unstubbed<MountEndpoints>("endpoints", { device })));
        const answered = app.request("/mcp/laptop", {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_command", arguments: { command: "sleep 180" } } }),
        });
        await advanceTimersByTimeAsync(170_000);
        // Past the silence limit, and held: neither deadline runs while the call does.
        expect(clock.remaining()).toBe(Number.POSITIVE_INFINITY);
        await advanceTimersByTimeAsync(10_000);
        expect((await answered).status).toBe(200);
        // Released with the answer, which counts as activity: a whole silence window from now.
        expect(clock.remaining()).toBe(DEFAULT_TURN_TIMEOUTS.inactivityMs);
        lease.release();
    } finally {
        jest.useRealTimers();
    }
});

// 2026-11-02 (lively-cedar-3nsa): a Codex call to ask ended a minute after it asked, the owner answered on the card half an
// hour later, and the agent never heard the answer. One that comes after its call stopped waiting is said into the turn.
test("an answer given after the asking call's client stopped waiting is said into the conversation, not lost", async () => {
    const { cards, answer } = cardsAnswering();
    const said: Said[] = [];
    const door = doorFor(
        { input, context: contextOf(cards), persona: OPEN, granted: [], settings: SETTINGS },
        depsWith({
            agents: unstubbed<DaemonServersDeps["agents"]>("agents", { entry: (id: string) => (id === "conv-1" ? conversationEntry({ id }) : undefined) }),
            turns: unstubbed<DaemonServersDeps["turns"]>("turns", {
                say: async (words: Said) => {
                    said.push(words);
                    return { delivered: "steered" as const };
                },
            }),
        }),
    );
    door.built.relay.attach({ push: () => {} });
    const client = new AbortController();
    const asked = door
        .call("ui", "ask", { questions: [{ question: "Which tests stay?", header: "Removal rule", options: [{ label: "Only recorded catches", description: "a" }, { label: "Keep reproducers", description: "b" }] }] }, client.signal)
        .catch(() => "");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The runtime gave up on the call, as Codex's code mode hands control back while the card stays open.
    client.abort();
    await asked;
    answer({ kind: "question", requestId: "card-1", answers: { "Which tests stay?": ["Only recorded catches"] } });
    await waitFor(() => expect(said).toHaveLength(1));
    expect(said[0]?.voice).toBe("sandbox");
    expect(said[0]?.turn.conversationId).toBe("conv-1");
    expect(said[0]?.turn.prompt).toContain('the question you asked earlier ("Removal rule")');
    expect(said[0]?.turn.prompt).toContain("Only recorded catches");
    door.lease.release();
});

test("an answer its call was still waiting for goes back as the call's result alone", async () => {
    const { cards, answer } = cardsAnswering();
    const said: Said[] = [];
    const door = doorFor(
        { input, context: contextOf(cards), persona: OPEN, granted: [], settings: SETTINGS },
        depsWith({
            turns: unstubbed<DaemonServersDeps["turns"]>("turns", {
                say: async (words: Said) => {
                    said.push(words);
                    return { delivered: "steered" as const };
                },
            }),
        }),
    );
    door.built.relay.attach({ push: () => {} });
    const asked = door.call("ui", "ask", { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] });
    answer({ kind: "question", requestId: "card-1", answers: { "Which?": ["A"] } });
    expect(await asked).toContain("A");
    expect(said).toEqual([]);
    door.lease.release();
});

test("the policy gate on the door refuses until the loop's gate attaches, then answers with it, marks taint and runs no checks it has none of", async () => {
    const door = doorFor({ input, context: contextOf(cardsAnswering().cards), persona: OPEN, granted: [], settings: SETTINGS, gate: true });
    expect(door.names).toContain("gate");
    const before: unknown = JSON.parse(await door.call("gate", "pre_tool_use", { tool_name: "Bash", tool_input: { command: "rm -rf build" } }));
    expect(before).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: NO_GATE } });
    const denying: CommandGuard = {
        enforcing: true,
        async *consult() {
            yield { kind: "delta", text: "card" };
            return { allow: false, reason: "Deleting files needs your approval." };
        },
    };
    const taint = createTurnTaint();
    const seen: AgentEvent[] = [];
    door.built.relay.attach({ push: (event) => seen.push(event), guard: { gate: denying, taint } });
    const after: unknown = JSON.parse(await door.call("gate", "pre_tool_use", { tool_name: "Bash", tool_input: { command: "rm -rf build" } }));
    expect(after).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Deleting files needs your approval." },
    });
    expect(seen).toEqual([{ kind: "delta", text: "card" }]);
    // A read runs no program, so nothing is asked.
    expect(JSON.parse(await door.call("gate", "pre_tool_use", { tool_name: "Read", tool_input: { file_path: "/work/x" } }))).toEqual({});
    // Codex takes no rewritten output from a hook, so a page from outside marks the turn and the answer says nothing.
    expect(
        JSON.parse(
            await door.call("gate", "post_tool_use", { tool_name: "WebFetch", tool_input: { url: "https://example.com" }, tool_response: { result: "page" } }),
        ),
    ).toEqual({});
    expect(taint.source()).toBe("web");
    expect(JSON.parse(await door.call("gate", "stop", {}))).toEqual({});
});

test("a door call answered from the daemon's own records is sealed as outside content and marks the turn", async () => {
    const door = doorFor({ input, context: contextOf(cardsAnswering().cards), persona: OPEN, granted: [], settings: SETTINGS });
    const taint = createTurnTaint();
    door.built.relay.attach({ guard: { gate: unstubbed<CommandGuard>("gate", {}), taint } });
    expect(await door.call("diagnostics", "errors", {})).toMatch(/^<untrusted-content source="diagnostics"/);
    expect(taint.source()).toBe("diagnostics");
    // A control server's answer is the daemon's own and stays as it is.
    expect(await door.call("subagents", "wait", { target: "nobody", timeoutSeconds: 5 })).not.toContain("<untrusted-content");
});
