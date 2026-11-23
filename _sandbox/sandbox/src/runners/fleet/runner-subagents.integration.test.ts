import { type ServerType, serve } from "@hono/node-server";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server,type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEnv } from "../../app-env.js";
import { STEER_HEARD } from "../../conversations/actor/conversation-holdings.js";
import { ROSTER } from "../../conversations/actor/subagent-roster.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import type { ChildSpawnSpec, ChildSupervisor } from "../../agent/subagents/children.js";
import { openSpawnedChild, settleSpawnedChild } from "../../agent/subagents/subagents.js";
import { type ServerTool, subagentTools, subagentWaitServer } from "../../agent/subagents/waiting/subagent-wait.js";
import { noteJobShell, openBackgroundJob } from "../../agent/tools/jobs/background-jobs.js";
import { callDeadlineMs, parentSubagentTools } from "../../agent/subagents/waiting/parent-forward.js";
import { parentSubagentCall } from "./parent-subagents.js";
import { runnerSubagentsDoor } from "./runner-subagents.routes.js";

/* A turn the parent placed on a runner supervises its subagents at the parent: both halves over real HTTP. The runner's
   `subagents` server (subagent-wait.ts, wrapped by agent/subagents/waiting/parent-forward.ts) hands each children tool to the parent's door
   (runner-subagents.routes.ts), which runs the very tool handlers over the parent's own registry: a child spawned from the
   runner's turn is the parent's, and a wait parks on the parent's roster. A conversation the parent did not place there,
   and a parent too old for the door, are served on the runner; a parent out of reach is said as such. */

const PLACED = "fair-sage-ey2r";
const CHILD = "sub-quiet-oak-11aa";
// A child a runner turn spawned on the runner itself, while its parent was too old for the door.
const RUNNER_CHILD = "sub-runner-own-22bb";

let parent: ServerType;
let parentUrl: string;
// Set by a test to stand the parent in for one too old to have the door: every path a bare 404.
let doorless = false;
let logsDir: string;

// The parent's own registry, and the spawns its children engine took.
let parentFleet: ReturnType<typeof memoryFleet>;
let parentSpawns: ChildSpawnSpec[];
// The children the parent was told to send words to.
let parentSends: string[];
let parentWaitsEnded: number;
const LONG_REPORT = `Done.\n${"line of the report\n".repeat(2_000)}The end.`;

const parentSupervisor = (): ChildSupervisor =>
    unstubbed<ChildSupervisor>("parent children", {
        spawn: async (spec) => {
            parentSpawns.push(spec);
            openSpawnedChild({ conversationId: PLACED, conversations: parentFleet.conversations, subagentsDir: undefined }, { id: CHILD, description: spec.description ?? "task" });
            return { ok: true, id: CHILD };
        },
        send: async (childId) => {
            parentSends.push(childId);
            return { ok: false, message: `No subagent of this conversation is \`${childId}\`.` };
        },
        pendingQuestion: () => undefined,
        report: (childId) => (childId === CHILD ? LONG_REPORT : undefined),
        landing: () => undefined,
        machine: () => undefined,
        result: () => undefined,
    });

// The tools a turn of the conversation gets at the parent, with each wait's end counted, so a test can see the runner's
// dropped link end the wait parked at the parent.
const parentTools = (conversationId: string, signal: AbortSignal): readonly ServerTool[] =>
    subagentTools({ conversationId, conversations: parentFleet.conversations, signal, children: parentSupervisor(), wholeReports: true }).map((tool) =>
        tool.name === "wait"
            ? {
                  ...tool,
                  handler: async (args, extra) => {
                      try {
                          return await tool.handler(args, extra);
                      } finally {
                          parentWaitsEnded += 1;
                      }
                  },
              }
            : tool,
    );

const parentApp = (): Hono<AppEnv> => {
    const services = {
        runners: { verify: async (token: string | undefined) => (token === "omen-token" ? { kind: "enrolled", id: "omen" } : { kind: "unknown" }) },
        agents: {
            entry: (id: string) =>
                id === PLACED ? { id, placement: { kind: "worktree", runner: "omen", repos: [] } } : { id, placement: { kind: "main" } },
        },
    };
    const app = new Hono<AppEnv>();
    app.use(async (c, next) => (doorless ? c.text("Not Found", 404) : await next()));
    // SAFETY: the door reads only the two services stubbed above.
    app.post("/system/runners/subagents/:tool", runnerSubagentsDoor(services as never, parentTools));
    return app;
};

beforeAll(async () => {
    parent = await new Promise<ServerType>((resolve) => {
        const server = serve({ fetch: parentApp().fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(server));
    });
    // SAFETY: a server listening on TCP returns an AddressInfo.
    parentUrl = `http://127.0.0.1:${(parent.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => parent.close(() => resolve()));
});

beforeEach(() => {
    doorless = false;
    parentFleet = memoryFleet();
    parentSpawns = [];
    parentSends = [];
    parentWaitsEnded = 0;
    logsDir = mkdtempSync(join(tmpdir(), "intentic-runner-logs-"));
});

afterEach(() => {
    rmSync(logsDir, { recursive: true, force: true });
});

// A tool call's answer, as the server's JSON-RPC reply carries it.
interface Reply {
    readonly id?: number;
    readonly result?: { readonly content?: readonly { readonly text: string }[] };
}

interface Transport {
    start: () => Promise<void>;
    close: () => Promise<void>;
    send: (message: Reply) => Promise<void>;
    onmessage?: (message: unknown) => void;
}

const connectable = (value: unknown): value is { connect: (transport: Transport) => Promise<void> } =>
    typeof value === "object" && value !== null && "connect" in value && typeof value.connect === "function";

// Drives the server over its public connect(), as the CLI does; answers each call with its text blocks.
const connect = async (server: McpSdkServerConfigWithInstance): Promise<(name: string, args: object) => Promise<readonly string[]>> => {
    const pending = new Map<number, (reply: Reply) => void>();
    const transport: Transport = {
        start: async () => undefined,
        close: async () => undefined,
        send: async (message) => {
            if (message.id !== undefined) {
                pending.get(message.id)?.(message);
            }
        },
    };
    const instance: unknown = server.instance;
    if (!connectable(instance)) {
        throw new Error("the SDK's server instance has no connect");
    }
    await instance.connect(transport);
    let next = 0;
    return async (name, args) => {
        next += 1;
        const id = next;
        const reply = await new Promise<Reply>((resolve) => {
            pending.set(id, resolve);
            transport.onmessage?.({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
        });
        return reply.result?.content?.map((block) => block.text) ?? [];
    };
};

// The runner: a turn of `conversationId` with its own registry and children engine, its server wrapped as runner mode
// mounts it (harness-servers.ts subagentsServerFor).
interface RunnerTurn {
    readonly call: (name: string, args: object) => Promise<readonly string[]>;
    readonly fleet: ReturnType<typeof memoryFleet>;
    readonly localSpawns: ChildSpawnSpec[];
    readonly localSends: string[];
    readonly warned: string[];
    readonly stop: () => void;
}

const runnerTurn = async (conversationId: string, url = parentUrl, toldOld = new Set<string>(), token = "omen-token"): Promise<RunnerTurn> => {
    const fleet = memoryFleet();
    const localSpawns: ChildSpawnSpec[] = [];
    const localSends: string[] = [];
    const warned: string[] = [];
    const turn = new AbortController();
    const children = unstubbed<ChildSupervisor>("runner children", {
        spawn: async (spec) => {
            localSpawns.push(spec);
            // Filed on this runner's own roster, as spawnChild files a child it spawned here.
            openSpawnedChild({ conversationId, conversations: fleet.conversations, subagentsDir: undefined }, { id: RUNNER_CHILD, description: "task" });
            return { ok: true, id: RUNNER_CHILD };
        },
        send: async (childId) => {
            localSends.push(childId);
            return { ok: true };
        },
    });
    const server = subagentWaitServer(
        { conversationId, conversations: fleet.conversations, signal: turn.signal, children, logsDir },
        parentSubagentTools({
            conversationId,
            call: parentSubagentCall({ parentUrl: url, id: "omen", token, enrolledAt: 0 }),
            conversations: fleet.conversations,
            signal: turn.signal,
            logsDir,
            cwd: logsDir,
            logger: {
                warn: (_data: object, message?: string) => {
                    warned.push(message ?? "");
                },
            },
            toldOld,
        }),
    );
    return { call: await connect(server), fleet, localSpawns, localSends, warned, stop: () => turn.abort() };
};

// Polls `ready` for up to two seconds.
const until = async (ready: () => boolean): Promise<void> => {
    for (let tries = 0; !ready() && tries < 100; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

const SPAWN = { prompt: "Fix the flaky test", provider: "claude", model: "opus", description: "flaky test" };
// SAFETY: every tool here answers one JSON text block; toMatchObject checks each field read.
const json = (text: string | undefined): Record<string, unknown> => JSON.parse(text ?? "null") as Record<string, unknown>;

test("a spawn from a turn the parent placed on the runner is the parent's child, not the runner's", async () => {
    const runner = await runnerTurn(PLACED);
    const answer = await runner.call("spawn", SPAWN);
    expect(json(answer[0])).toMatchObject({ ok: true, child: CHILD });
    expect(parentSpawns).toMatchObject([{ prompt: "Fix the flaky test", provider: "claude", model: "opus" }]);
    expect(runner.localSpawns).toEqual([]);
    // On the parent's roster, under the conversation that spawned it; none on the runner's.
    expect(parentFleet.conversations.holdings(ROSTER).get(CHILD)?.conversationId).toBe(PLACED);
    expect(runner.fleet.conversations.holdings(ROSTER).get(CHILD)).toBeUndefined();
});

test("a wait on that child parks at the parent and hands its report over, bounded on the runner where the rest is kept", async () => {
    const runner = await runnerTurn(PLACED);
    await runner.call("spawn", SPAWN);
    const waiting = runner.call("wait", { target: CHILD, timeoutSeconds: 30 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    settleSpawnedChild(parentFleet.conversations, CHILD, { status: "completed", report: "Done." });
    const answer = json((await waiting)[0]);
    expect(answer).toMatchObject({ outcome: "finished", agent: { id: CHILD, status: "completed" } });
    const report = String(answer["report"]);
    // Cut on the runner, with a handle under the runner's own logs, never the parent's.
    expect(report).toContain("The end.");
    expect(report).toContain(`retrieve-output ${logsDir}`);
    expect(report.length).toBeLessThan(LONG_REPORT.length);
});

test("words said into the runner's turn hand a forwarded wait back, and the dropped request ends the wait at the parent", async () => {
    const runner = await runnerTurn(PLACED);
    await runner.call("spawn", SPAWN);
    const waiting = runner.call("wait", { target: CHILD, timeoutSeconds: 30 });
    const steer = runner.fleet.conversations.holdings(STEER_HEARD);
    await until(() => steer.of(PLACED).length > 0);
    for (const heard of steer.of(PLACED)) {
        heard();
    }
    expect(json((await waiting)[0])).toMatchObject({ outcome: "message" });
    await until(() => parentWaitsEnded > 0);
    expect(parentWaitsEnded).toBe(1);
});

test("a stopped runner turn ends its wait parked at the parent", async () => {
    const runner = await runnerTurn(PLACED);
    await runner.call("spawn", SPAWN);
    const waiting = runner.call("wait", { target: CHILD, timeoutSeconds: 30 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    runner.stop();
    expect(json((await waiting)[0])).toMatchObject({ outcome: "aborted" });
    await until(() => parentWaitsEnded > 0);
    expect(parentWaitsEnded).toBe(1);
});

test("a wait on a background command the turn runs on the runner is waited on there", async () => {
    const runner = await runnerTurn(PLACED);
    const job = openBackgroundJob({ conversationId: PLACED, profile: {}, conversations: runner.fleet.conversations }, { command: "build", session: "agent-x", toolUseId: "build-call" });
    if (job === undefined) {
        throw new Error("job not filed");
    }
    try {
        noteJobShell(runner.fleet.conversations, "build-call", "bash-build");
        writeFileSync(join(job.dir, "status"), "0\n");
        expect(json((await runner.call("wait", { target: "bash-build", timeoutSeconds: 5 }))[0])).toMatchObject({ outcome: "finished", job: { id: "bash-build", exitCode: 0 } });
        expect(parentWaitsEnded).toBe(0);
    } finally {
        rmSync(job.dir, { recursive: true, force: true });
    }
});

test("a conversation the parent did not place on this runner keeps its subagents on the runner", async () => {
    const runner = await runnerTurn("runner-own-convo");
    expect(json((await runner.call("spawn", SPAWN))[0])).toMatchObject({ ok: true, child: RUNNER_CHILD });
    expect(runner.localSpawns).toHaveLength(1);
    expect(parentSpawns).toEqual([]);
});

test("a parent too old for the door leaves the tools on the runner, and the turn is told once", async () => {
    doorless = true;
    const toldOld = new Set<string>();
    const runner = await runnerTurn(PLACED, parentUrl, toldOld);
    const first = await runner.call("spawn", SPAWN);
    expect(json(first[0])).toMatchObject({ ok: true, child: RUNNER_CHILD });
    expect(first[1]).toContain("too old");
    const second = await runner.call("spawn", SPAWN);
    expect(second).toHaveLength(1);
    expect(runner.localSpawns).toHaveLength(2);
    expect(runner.warned).toHaveLength(2);
});

test("a token the parent refuses leaves the tools on the runner, as before the door", async () => {
    const runner = await runnerTurn(PLACED, parentUrl, new Set(), "revoked");
    expect(json((await runner.call("spawn", SPAWN))[0])).toMatchObject({ ok: true, child: RUNNER_CHILD });
    expect(parentSpawns).toEqual([]);
});

test("a parent out of reach, or a link dropped mid-call, is said as such and nothing is done on the runner in its place", async () => {
    const gone = await runnerTurn(PLACED, "http://127.0.0.1:1");
    expect(json((await gone.call("spawn", SPAWN))[0])).toMatchObject({ ok: false, outcome: "unreachable" });
    expect(gone.localSpawns).toEqual([]);
    // A parent that takes the connection and drops it.
    const dropping: Server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => dropping.listen(0, "127.0.0.1", resolve));
    try {
        // SAFETY: a server listening on TCP returns an AddressInfo.
        const dropped = await runnerTurn(PLACED, `http://127.0.0.1:${(dropping.address() as AddressInfo).port}`);
        expect(json((await dropped.call("wait", { target: CHILD, timeoutSeconds: 5 }))[0])).toMatchObject({ ok: false, outcome: "unreachable" });
    } finally {
        await new Promise<void>((resolve) => dropping.close(() => resolve()));
    }
});

test("each call gives the parent its own wait's time and a margin to answer", () => {
    expect(callDeadlineMs("wait", {})).toBe(660_000);
    expect(callDeadlineMs("wait", { timeoutSeconds: 99_999 })).toBe(1_860_000);
    expect(callDeadlineMs("workflow_status", { waitSeconds: 30 })).toBe(90_000);
    expect(callDeadlineMs("spawn", {})).toBe(300_000);
});

// A background command this runner's turn runs, by the id its Bash call returned; finish() writes its exit.
const commandOn = (runner: RunnerTurn, id: string) => {
    const job = openBackgroundJob({ conversationId: PLACED, profile: {}, conversations: runner.fleet.conversations }, { command: "build", session: "agent-x", toolUseId: `${id}-call` });
    if (job === undefined) {
        throw new Error("job not filed");
    }
    noteJobShell(runner.fleet.conversations, `${id}-call`, id);
    return { finish: () => writeFileSync(join(job.dir, "status"), "0\n"), clean: () => rmSync(job.dir, { recursive: true, force: true }) };
};

test("a wait on \"any\" with a command running here answers when the command ends, and lets the parent's wait go", async () => {
    const runner = await runnerTurn(PLACED);
    await runner.call("spawn", SPAWN);
    const build = commandOn(runner, "bash-build");
    try {
        const waiting = runner.call("wait", { target: "any", timeoutSeconds: 30 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        build.finish();
        expect(json((await waiting)[0])).toMatchObject({ outcome: "finished", job: { id: "bash-build", exitCode: 0 } });
        await until(() => parentWaitsEnded > 0);
        expect(parentWaitsEnded).toBe(1);
    } finally {
        build.clean();
    }
});

test("a wait on \"any\" with a command running here answers when the parent's child ends first", async () => {
    const runner = await runnerTurn(PLACED);
    await runner.call("spawn", SPAWN);
    const build = commandOn(runner, "bash-build");
    try {
        const waiting = runner.call("wait", { target: "any", timeoutSeconds: 30 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        settleSpawnedChild(parentFleet.conversations, CHILD, { status: "completed", report: "Done." });
        expect(json((await waiting)[0])).toMatchObject({ outcome: "finished", agent: { id: CHILD } });
    } finally {
        build.clean();
    }
});

test("a wait naming a command here and the parent's child together sends only the child to the parent", async () => {
    const runner = await runnerTurn(PLACED);
    await runner.call("spawn", SPAWN);
    const build = commandOn(runner, "bash-build");
    try {
        const waiting = runner.call("wait", { targets: ["bash-build", CHILD], timeoutSeconds: 30 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        build.finish();
        expect(json((await waiting)[0])).toMatchObject({ outcome: "finished", jobs: [{ id: "bash-build", exitCode: 0 }] });
        await until(() => parentWaitsEnded > 0);
        expect(parentWaitsEnded).toBe(1);
    } finally {
        build.clean();
    }
});

test("a child the runner spawned itself under an older parent is still sent to on the runner once the parent has the door", async () => {
    doorless = true;
    const runner = await runnerTurn(PLACED);
    expect(json((await runner.call("spawn", SPAWN))[0])).toMatchObject({ ok: true, child: RUNNER_CHILD });
    doorless = false;
    expect(json((await runner.call("send", { child: RUNNER_CHILD, message: "Also fix the lint." }))[0])).toMatchObject({ ok: true });
    expect(runner.localSends).toEqual([RUNNER_CHILD]);
    expect(parentSends).toEqual([]);
    // The parent's own child still goes to the parent.
    await runner.call("spawn", SPAWN);
    await runner.call("send", { child: CHILD, message: "And the docs." });
    expect(parentSends).toEqual([CHILD]);
});

