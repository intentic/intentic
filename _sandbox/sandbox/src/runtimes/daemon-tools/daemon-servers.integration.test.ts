import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type AgentReply, AgentTurnSchema, SandboxSettingsSchema } from "@intentic/sandbox-contract";
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
import { turnWatchdog } from "../decorators/turn-watchdog.js";
import { opt } from "../../opt.js";
import type { TurnContext } from "../../agent/providers/adapter.js";
import type { ChildSupervisor } from "../../agent/subagents/children.js";
import { harnessServers, turnSecretAccess } from "../../agent/run/harness/harness-servers.js";
import { type DaemonServersDeps, daemonServersFor, type DaemonServersTurn } from "./daemon-servers.js";
import { createTurnMounts } from "../../agent/tools/turn-mounts.js";
import { createTurnMountRoute, daemonEndpoint, type MountEndpoints } from "../../agent/tools/turn-mounts.routes.js";

// The daemon's own servers as a non-Claude runtime reaches them: built for one turn, mounted on its lease, called over
// HTTP through the door with the turn's bearer, and held to the persona decisions the Claude loop's in-process servers are.

const ROOT = mkdtempSync(join(tmpdir(), "daemon-servers-"));
const SETTINGS = SandboxSettingsSchema.parse({});
const OPEN = turnPersona({ personas: [], actsAs: undefined, unattended: false });
const input = AgentTurnSchema.parse({ prompt: "do the thing", conversationId: "conv-1" });

const deps: DaemonServersDeps = unstubbed<DaemonServersDeps>("deps", {
    conversations: unstubbed<DaemonServersDeps["conversations"]>("conversations", {}),
    config: unstubbed<DaemonServersDeps["config"]>("config", { historyRoot: ROOT }),
    usage: unstubbed<DaemonServersDeps["usage"]>("usage", { turns: async () => [] }),
    dependencies: unstubbed<DaemonServersDeps["dependencies"]>("dependencies", {}),
    agents: unstubbed<DaemonServersDeps["agents"]>("agents", { entry: () => undefined }),
    logger: pino({ level: "silent" }),
});

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

const doorFor = (turn: Omit<DaemonServersTurn, "mounted">) => {
    const mounts = createTurnMounts({ baseUrl: () => "http://127.0.0.1:8787/mcp" });
    const lease = mounts.lease("conv-1");
    const built = daemonServersFor(deps, { ...turn, mounted: { browser: NO_BROWSER, lease } });
    const app = new Hono<AppEnv>().all("/mcp/:mount", createTurnMountRoute(mounts, unstubbed<MountEndpoints>("endpoints", { daemon: daemonEndpoint })));
    const token = built.tools[0]?.token ?? "";
    let id = 0;
    const rpc = async (name: string, method: string, params?: Record<string, unknown>) => {
        id += 1;
        const response = await app.request(`/mcp/${name}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, ...opt("params", params) }),
        });
        return AnswerSchema.parse(await response.json());
    };
    const toolsOf = async (name: string): Promise<string[]> => ((await rpc(name, "tools/list")).result?.tools ?? []).map((tool) => tool.name);
    const call = async (name: string, tool: string, args: Record<string, unknown>): Promise<string> =>
        ((await rpc(name, "tools/call", { name: tool, arguments: args })).result?.content ?? []).map((part) => part.text ?? "").join("\n");
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
    expect(door.names).toEqual(["ui", "subagents", "watch", "deps", "diagnostics"]);
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
            harnessServers(deps, {
                input,
                context,
                persona,
                granted: [],
                browser: NO_BROWSER,
                secrets: turnSecretAccess(deps, input, context.base.signal),
                hashlineEdits: false,
            }),
        );
        const door = doorFor({ input, context, persona, granted: [], settings: SETTINGS });
        // The door adds only what the Claude loop mounts in agent.ts itself (`ui`), never a server the persona was denied.
        expect(door.names.filter((name) => name !== "ui")).toEqual(claude);
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
