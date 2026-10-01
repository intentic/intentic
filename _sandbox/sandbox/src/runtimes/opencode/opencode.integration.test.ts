import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { createTurnGate } from "../../guard/turn-gate.js";
import { humanizeModelId } from "@intentic/sandbox-contract";
import { SEED_XAI_MODELS } from "./xai-models.js";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { CommandGuard } from "../../guard/command-guard.js";
import { createOpenCodeService, geminiProviderConfig, type SessionJudge } from "./opencode.js";
import { mcpServersOf, openCodeMounts } from "./opencode-mcp.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../testing.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

// Captures server-spawn options instead of booting a real `opencode serve`; the client doubles also feed an event
// stream and record every permission answered, on whichever route answered it, and every MCP server mounted.
const serverSpawns = [] as { config?: unknown }[];
// The per-session route an older ask is answered on, which carries no reason.
const legacyReplies: { sessionID: string; permissionID: string; directory: string | undefined; response: string | undefined }[] = [];
// The current route, whose refusal carries the reason back to the model.
const permissionReplies: { requestID: string; directory: string | undefined; reply: string | undefined; message?: string }[] = [];
const mcpCalls: (
    | { call: "add"; name: string; directory: string | undefined; config: unknown }
    | { call: "disconnect"; name: string; directory: string | undefined }
)[] = [];
const streamEvents = [] as unknown[];
// Every event subscription asked for, by directory; `refused` makes each one fail the way a dead server's does.
const subscriptions = { refused: false, asked: [] as (string | undefined)[] };
jest.mock("@opencode-ai/sdk", () => ({
    createOpencodeServer: async (options: { config?: unknown }) => {
        serverSpawns.push(options);
        return { url: "http://127.0.0.1:0", close: (): void => {} };
    },
    createOpencodeClient: () => ({
        event: {
            subscribe: async (options?: { query?: { directory?: string } }) => {
                subscriptions.asked.push(options?.query?.directory);
                if (subscriptions.refused) {
                    throw new Error("connect ECONNREFUSED");
                }
                return {
                    stream: {
                        async *[Symbol.asyncIterator]() {
                            yield* streamEvents;
                            // Stays open like the real subscription; ending it would send the watcher round its retry
                            // ladder mid-assertion.
                            await new Promise(() => {});
                        },
                    },
                };
            },
        },
        mcp: {
            add: async (options: { body?: { name: string; config: unknown }; query?: { directory?: string } }) => {
                mcpCalls.push({ call: "add", name: options.body?.name ?? "", directory: options.query?.directory, config: options.body?.config });
                return {};
            },
            disconnect: async (options: { path: { name: string }; query?: { directory?: string } }) => {
                mcpCalls.push({ call: "disconnect", name: options.path.name, directory: options.query?.directory });
                return {};
            },
        },
    }),
}));
jest.mock("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: () => ({
        permission: {
            respond: async (parameters: { sessionID: string; permissionID: string; directory?: string; response?: string }) => {
                legacyReplies.push({
                    sessionID: parameters.sessionID,
                    permissionID: parameters.permissionID,
                    directory: parameters.directory,
                    response: parameters.response,
                });
                return {};
            },
            reply: async (parameters: { requestID: string; directory?: string; reply?: string; message?: string }) => {
                const answered: (typeof permissionReplies)[number] = {
                    requestID: parameters.requestID,
                    directory: parameters.directory,
                    reply: parameters.reply,
                };
                if (parameters.message !== undefined) {
                    answered.message = parameters.message;
                }
                permissionReplies.push(answered);
                return {};
            },
        },
    }),
}));

const roots: string[] = [];
const scratch = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "opencode-"));
    roots.push(root);
    return root;
};

// OpenCode persists provider auth at <XDG_DATA_HOME>/opencode/auth.json (the store connected()/disconnect() use).
const writeAuth = async (xdg: string, auth: unknown): Promise<void> => {
    const dir = join(xdg, "opencode");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "auth.json"), JSON.stringify(auth));
};
const modelsPath = (xdg: string): string => join(xdg, "opencode", "xai-models.json");
const fileExists = async (path: string): Promise<boolean> =>
    access(path)
        .then(() => true)
        .catch(() => false);
// Fails the test if the discovery path ever touches the network.
const forbiddenFetch = (() => {
    throw new Error("discovery must not hit the network in this case");
}) as unknown as typeof fetch;
// The catalog the seed floor produces (ids humanized), for the not-connected assertions.
const SEED_CATALOG = { models: SEED_XAI_MODELS.map((id) => ({ id, label: humanizeModelId(id) })), default: SEED_XAI_MODELS[0]! };

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    // The three doubles are module-level; reset so one test's stream/permissions don't leak into the next.
    streamEvents.length = 0;
    permissionReplies.length = 0;
    legacyReplies.length = 0;
    mcpCalls.length = 0;
    serverSpawns.length = 0;
    subscriptions.refused = false;
    subscriptions.asked.length = 0;
    jest.useRealTimers();
});

test("connected('xai') reflects a persisted OAuth token in auth.json, not OpenCode's cached snapshot", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg);
    // No auth file yet ⇒ not connected.
    expect(await service.connected("xai")).toBe(false);
    // OAuth token written by the device flow ⇒ connected, with no opencode-server restart.
    await writeAuth(xdg, { xai: { type: "oauth", access: "tok", refresh: "r", expires: 1 } });
    expect(await service.connected("xai")).toBe(true);
});

test("connected('xai') is false for a non-oauth entry or a different provider", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg);
    // An api-key entry has no OAuth access token, so "connected" must stay false to match what a turn can actually use.
    await writeAuth(xdg, { xai: { type: "api", key: "sk-xxx" } });
    expect(await service.connected("xai")).toBe(false);
    await writeAuth(xdg, { anthropic: { type: "oauth", access: "tok" } });
    expect(await service.connected("xai")).toBe(false);
});

test("disconnect clears the auth store AND the persisted catalog so connected flips back to false", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg);
    await writeAuth(xdg, { xai: { type: "oauth", access: "tok" } });
    await service.recordModels(["grok-4"]);
    expect(await service.connected("xai")).toBe(true);
    expect(await fileExists(modelsPath(xdg))).toBe(true);
    await service.disconnect("xai");
    expect(await service.connected("xai")).toBe(false);
    expect(await fileExists(modelsPath(xdg))).toBe(false);
});

test("xaiModels() returns the seed catalog (non-empty, with a default) when not connected: never blank", async () => {
    const xdg = await scratch();
    // No auth ⇒ no token ⇒ discovery is skipped entirely (forbiddenFetch proves it), and the seed floor is served.
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch });
    expect(await service.xaiModels()).toEqual(SEED_CATALOG);
});

test("xaiModels() skips REST discovery when the token is expired, serving the persisted catalog instead", async () => {
    const xdg = await scratch();
    // expires is a past ms epoch ⇒ every discovery probe would 401, so this must not even try (forbiddenFetch).
    await writeAuth(xdg, { xai: { type: "oauth", access: "tok", expires: 1 } });
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch });
    await service.recordModels(["grok-4.20-0309-reasoning"]);
    expect(await service.xaiModels()).toEqual({
        models: [{ id: "grok-4.20-0309-reasoning", label: humanizeModelId("grok-4.20-0309-reasoning") }],
        default: "grok-4.20-0309-reasoning",
    });
});

test("xaiModels() discovers live with an unexpired token, then persists the result", async () => {
    const xdg = await scratch();
    await writeAuth(xdg, { xai: { type: "oauth", access: "tok", expires: Number.MAX_SAFE_INTEGER } });
    const liveFetch = (async (url: string | URL) =>
        String(url).endsWith("/v1/models")
            ? new Response(JSON.stringify({ data: [{ id: "grok-4-latest" }] }), { status: 200 })
            : new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const service = createOpenCodeService(xdg, { fetchImpl: liveFetch });
    expect(await service.xaiModels()).toEqual({ models: [{ id: "grok-4-latest", label: "Grok 4 Latest" }], default: "grok-4-latest" });
    // The live result is persisted so a later expired-token read still serves the real catalog.
    expect(JSON.parse(await readFile(modelsPath(xdg), "utf8"))).toEqual(["grok-4-latest"]);
});

test("recordModels persists xAI's named models (chat-only) and xaiModels() serves them next", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch });
    // Media ids are dropped; the survivors are persisted and become the catalog + default.
    await service.recordModels(["grok-4", "grok-2-image", "grok-3"]);
    expect(JSON.parse(await readFile(modelsPath(xdg), "utf8"))).toEqual(["grok-4", "grok-3"]);
    expect(await service.xaiModels()).toEqual({
        models: [
            { id: "grok-4", label: "Grok 4" },
            { id: "grok-3", label: "Grok 3" },
        ],
        default: "grok-4",
    });
});

test("client() spawns the server with store:false for every known xai model (seed + persisted)", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch });
    await service.recordModels(["grok-4-latest"]);
    await service.client();

    // xAI stores conversations server-side unless each model call opts out; per-model config is the only seam OpenCode
    // forwards, so every known id must carry store:false.
    const spawn = serverSpawns.at(-1) as { config: { provider: { xai: { models: Record<string, { options: unknown }> } } } };
    const models = spawn.config.provider.xai.models;
    expect(Object.keys(models).toSorted()).toEqual([...new Set([...SEED_XAI_MODELS, "grok-4-latest"])].toSorted());
    for (const model of Object.values(models)) {
        expect(model.options).toEqual({ store: false });
    }
});

// A cloned repo's opencode.json can say `"share": "auto"`, which uploads every session to OpenCode's servers; the spawn
// config is merged after it, so its own `share` is what decides.
test("client() spawns the server with session sharing disabled", async () => {
    const xdg = await scratch();
    await createOpenCodeService(xdg, { fetchImpl: forbiddenFetch }).client();
    expect(serverSpawns.at(-1)?.config).toHaveProperty("share", "disabled");
});

// OpenCode defaults an omitted key to `ask`, which nobody on this runtime can answer, so the turn just stops;
// `external_directory` is the one that found it (attachments read from outside an isolated worktree).
test("client() spawns the server with EVERY permission answered, not merely the ones anyone thought of", async () => {
    const xdg = await scratch();
    await createOpenCodeService(xdg, { fetchImpl: forbiddenFetch }).client();
    const spawn = serverSpawns.at(-1) as { config: { permission: Record<string, unknown> } };
    const permission = spawn.config.permission;

    // Every key must be present: an omitted one defaults to `ask`, which nobody here can answer.
    expect(Object.keys(permission).toSorted()).toEqual(["bash", "doom_loop", "edit", "external_directory", "webfetch"]);
    for (const key of ["edit", "webfetch", "doom_loop", "external_directory"]) {
        expect(permission[key], key).toBe("allow");
    }

    // `bash`'s default is still allow; only shapes the rulebook might care about are pre-filtered to `ask` and answered
    // by the real classifier.
    const bash = permission["bash"] as Record<string, string>;
    expect(bash["*"]).toBe("allow");
    expect(bash["*git push*"]).toBe("ask");
    expect(bash["*rm *"]).toBe("ask");
    // Nothing in the map may be `deny`: that verdict must come from the rulebook, never from this layer alone.
    expect([...new Set(Object.values(bash))].toSorted()).toEqual(["allow", "ask"]);
});

// A future OpenCode permission key defaults to `ask` and is absent from the spawned config, same as
// `external_directory` was; answered on the spot rather than stalling.
test("a permission ask on a watched directory is answered with a standing yes", async () => {
    const xdg = await scratch();
    streamEvents.push({ type: "permission.updated", properties: { id: "per_1", sessionID: "ses_1", type: "some_future_gate" } });
    await createOpenCodeService(xdg, { fetchImpl: forbiddenFetch, workspaceRoot: WORKSPACE_ROOT }).client();
    // The watcher reads its stream detached from the boot that started it, so let its first read land.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(legacyReplies).toEqual([{ sessionID: "ses_1", permissionID: "per_1", directory: "/work", response: "always" }]);
});

// A watcher that exhausted its retries answers nothing more; a directory still marked watched would leave every later
// permission ask there unanswered until the turn's watchdog killed it.
test("a permission watcher that gave up is reopened by the next turn in its directory", async () => {
    jest.useFakeTimers();
    const xdg = await scratch();
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch });
    await service.client();
    subscriptions.refused = true;
    const worktree = `${WORKSPACE_ROOT}/worktree`;
    await service.watch(worktree);
    await advanceTimersByTimeAsync(20_000);
    expect(subscriptions.asked).toEqual([worktree, worktree, worktree]);

    subscriptions.refused = false;
    await service.watch(worktree);
    expect(subscriptions.asked).toHaveLength(4);
});

interface RecordedJudge {
    readonly judge: SessionJudge;
    readonly frames: AgentEvent[];
    readonly holds: string[];
}

// What a turn registers for its sessions: the gate its rulebook built, a sink for the frames the card raises, and a hold
// on its watchdog, recorded here so a test can see the clock held for exactly the consult.
const judgeOf = (gate: CommandGuard): RecordedJudge => {
    const frames: AgentEvent[] = [];
    const holds: string[] = [];
    return {
        frames,
        holds,
        judge: {
            gate,
            push: (frame) => void frames.push(frame),
            hold: () => {
                holds.push("held");
                return () => void holds.push("released");
            },
        },
    };
};

// What capabilitiesOf("grok", …) declares: a hold parks on a card like Codex's.
const approvalGate = (judge: () => Promise<{ decision: "allow" | "ask" | "refuse"; sentence: string }>) =>
    createTurnGate({ cards, judge, rulebook: "approval", signal: new AbortController().signal });

// A registered session's permission goes through the same pipeline every other runtime uses; unregistered keeps the
// standing yes. The judge is a stub: the channel is under test, not the model.
test("a registered session's permission is judged by the policy, and a refused command is rejected", async () => {
    const xdg = await scratch();
    const { gate, release } = approvalGate(async () => ({ decision: "refuse", sentence: "Discards commits the remote has." }));
    streamEvents.push({
        type: "permission.updated",
        properties: { id: "per_2", sessionID: "ses_gated", type: "bash", metadata: { command: "git push --force origin main" }, title: "bash" },
    });
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch, workspaceRoot: WORKSPACE_ROOT });
    service.judges.register("ses_gated", judgeOf(gate).judge);
    await service.client();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The older route has no field for the reason; OpenCode releases that serve it stop the session instead.
    expect(legacyReplies).toEqual([{ sessionID: "ses_gated", permissionID: "per_2", directory: "/work", response: "reject" }]);
    release();
});

// OpenCode 1.18 renamed the ask and reshaped it (`permission.asked`, with `permission` and `patterns`); a watcher
// listening only for the old name answered nothing, and every ask the config raises waited on the turn's watchdog.
test("OpenCode 1.18's ask is judged by the same policy, and a refusal goes back with its reason", async () => {
    const xdg = await scratch();
    const { gate, release } = approvalGate(async () => ({ decision: "refuse", sentence: "Discards commits the remote has." }));
    streamEvents.push({
        type: "permission.asked",
        properties: {
            id: "per_5",
            sessionID: "ses_asked",
            permission: "bash",
            patterns: ["git push --force*"],
            metadata: { command: "git push --force origin main" },
            always: [],
        },
    });
    streamEvents.push({
        type: "permission.asked",
        properties: { id: "per_6", sessionID: "ses_open", permission: "bash", patterns: ["rm -rf dist"], metadata: {}, always: [] },
    });
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch, workspaceRoot: WORKSPACE_ROOT });
    service.judges.register("ses_asked", judgeOf(gate).judge);
    await service.client();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Answered concurrently, so in either order; what each got is the contract. The reason is what OpenCode hands the
    // model as the call's feedback, and a reply with one keeps the session going where a bare reject would stop it.
    expect(permissionReplies.toSorted((left, right) => left.requestID.localeCompare(right.requestID))).toEqual([
        {
            requestID: "per_5",
            directory: WORKSPACE_ROOT,
            reply: "reject",
            message: "Discards commits the remote has. Refused by your owner's safety policy. Do not retry.",
        },
        { requestID: "per_6", directory: WORKSPACE_ROOT, reply: "always" },
    ]);
    release();
});

// `always` would stop OpenCode asking about that pattern for the rest of the session, and the next match could be one
// the policy would refuse.
test("a command the policy allows is approved for this call only", async () => {
    const xdg = await scratch();
    const { gate, release } = approvalGate(async () => ({ decision: "allow", sentence: "Pushes a feature branch." }));
    const { judge, holds } = judgeOf(gate);
    streamEvents.push({
        type: "permission.updated",
        properties: { id: "per_3", sessionID: "ses_ok", type: "bash", metadata: { command: "git push origin feature" }, title: "bash" },
    });
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch, workspaceRoot: WORKSPACE_ROOT });
    service.judges.register("ses_ok", judge);
    await service.client();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(legacyReplies).toEqual([{ sessionID: "ses_ok", permissionID: "per_3", directory: "/work", response: "once" }]);
    // The judge's own call is a wait on the daemon too, so the clock is held across it.
    expect(holds).toEqual(["held", "released"]);
    release();
});

// The whole reason this runtime was refuse-only: a card waits on a person far past the two-minute silence limit. The
// turn's clock is held from the ask until the answer, the card reaches the turn's stream through its judge, and the
// person's answer goes back to OpenCode.
test("a hold parks on a card: the turn's clock is held until the person answers, and their yes lets the call run once", async () => {
    const xdg = await scratch();
    const { gate, release } = approvalGate(async () => ({ decision: "ask", sentence: "Pushes straight to the shared main branch." }));
    const { judge, frames, holds } = judgeOf(gate);
    streamEvents.push({
        type: "permission.asked",
        properties: {
            id: "per_7",
            sessionID: "ses_card",
            permission: "bash",
            patterns: ["git push --force*"],
            metadata: { command: "git push --force origin main" },
            always: [],
        },
    });
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch, workspaceRoot: WORKSPACE_ROOT });
    service.judges.register("ses_card", judge);
    await service.client();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Parked: the card is out, the clock held, and OpenCode not yet answered.
    expect(frames).toMatchObject([
        { kind: "permission", toolName: "Bash", displayName: "Run command", program: { text: "git push --force origin main" } },
    ]);
    expect(holds).toEqual(["held"]);
    expect(permissionReplies).toEqual([]);

    const card = frames[0];
    if (card?.kind !== "permission") {
        throw new Error("no card was raised");
    }
    expect(cards.resolve({ kind: "permission", requestId: card.requestId, decision: "once" })).toBe("settled");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(frames.map((frame) => frame.kind)).toEqual(["permission", "resolved"]);
    expect(holds).toEqual(["held", "released"]);
    expect(permissionReplies).toEqual([{ requestID: "per_7", directory: "/work", reply: "once" }]);
    release();
});

// A person's no with words goes back as the model's feedback: the turn carries on told why, as a Claude turn's does.
test("a person's no goes back to OpenCode with their words", async () => {
    const xdg = await scratch();
    const { gate, release } = approvalGate(async () => ({ decision: "ask", sentence: "Pushes straight to the shared main branch." }));
    const { judge, frames } = judgeOf(gate);
    streamEvents.push({
        type: "permission.asked",
        properties: {
            id: "per_8",
            sessionID: "ses_no",
            permission: "bash",
            patterns: ["git push --force*"],
            metadata: { command: "git push --force origin main" },
            always: [],
        },
    });
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch, workspaceRoot: WORKSPACE_ROOT });
    service.judges.register("ses_no", judge);
    await service.client();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const card = frames[0];
    if (card?.kind !== "permission") {
        throw new Error("no card was raised");
    }
    cards.resolve({ kind: "permission", requestId: card.requestId, decision: "deny", feedback: "Open a pull request instead." });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(permissionReplies).toEqual([{ requestID: "per_8", directory: "/work", reply: "reject", message: "Open a pull request instead." }]);
    release();
});

// An ask left unanswered stalls the turn until its watchdog kills it; a consult with no verdict refuses instead.
test("a consult that fails is answered as a refusal rather than left unanswered", async () => {
    const xdg = await scratch();
    const broken = unstubbed<CommandGuard>("gate", {
        enforcing: true,
        // Fails before it has anything to say.
        consult: () => {
            throw new Error("the card store is gone");
        },
    });
    const { judge, holds } = judgeOf(broken);
    streamEvents.push({
        type: "permission.asked",
        properties: {
            id: "per_9",
            sessionID: "ses_broken",
            permission: "bash",
            patterns: ["git push*"],
            metadata: { command: "git push origin main" },
            always: [],
        },
    });
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch, workspaceRoot: WORKSPACE_ROOT });
    service.judges.register("ses_broken", judge);
    await service.client();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(permissionReplies).toEqual([
        {
            requestID: "per_9",
            directory: WORKSPACE_ROOT,
            reply: "reject",
            message:
                "This could not be checked against your owner's safety policy, so it was refused. " +
                "Do not retry: carry on with what you can do without it, and say plainly what you left undone.",
        },
    ]);
    expect(holds).toEqual(["held", "released"]);
});

// A session whose turn has settled, or a delegation nobody registered, is where it always was: the standing yes.
test("an unregistered session keeps the standing yes", async () => {
    const xdg = await scratch();
    streamEvents.push({
        type: "permission.updated",
        properties: { id: "per_4", sessionID: "ses_unknown", type: "bash", metadata: { command: "git push --force origin main" }, title: "bash" },
    });
    await createOpenCodeService(xdg, { fetchImpl: forbiddenFetch, workspaceRoot: WORKSPACE_ROOT }).client();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(legacyReplies).toEqual([{ sessionID: "ses_unknown", permissionID: "per_4", directory: "/work", response: "always" }]);
});

// Every conversation shares the one server, and OpenCode keeps MCP servers per directory: a turn's servers go on in its
// directory under its conversation's names, and come off once nothing holds them.
test("a turn's servers are added in its directory and disconnected once it lets go", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch });
    const servers = mcpServersOf(openCodeMounts("chat-1", [{ name: "web", url: "http://127.0.0.1:7000/mcp/web", token: "turn-1" }]));
    const name = servers[0]?.name ?? "";

    const unmount = await service.mount(WORKSPACE_ROOT, servers);
    expect(mcpCalls).toEqual([{ call: "add", name, directory: "/work", config: servers[0]?.config }]);

    await unmount();
    await unmount();
    expect(mcpCalls).toEqual([
        { call: "add", name, directory: "/work", config: servers[0]?.config },
        { call: "disconnect", name, directory: "/work" },
    ]);
});

// Two turns of one conversation hold the same names; the one client each name gets must carry a bearer a live turn
// still holds, whichever of them ends first.
test("a server two turns hold carries the newer turn's bearer, and the older one's again once the newer lets go", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch });
    const serversOf = (token: string) => mcpServersOf(openCodeMounts("chat-1", [{ name: "web", url: "http://127.0.0.1:7000/mcp/web", token }]));
    const older = serversOf("turn-1");
    const newer = serversOf("turn-2");
    const name = older[0]?.name ?? "";

    const releaseOlder = await service.mount(WORKSPACE_ROOT, older);
    const releaseNewer = await service.mount(WORKSPACE_ROOT, newer);
    await releaseNewer();
    await releaseOlder();

    expect(mcpCalls).toEqual([
        { call: "add", name, directory: "/work", config: older[0]?.config },
        { call: "add", name, directory: "/work", config: newer[0]?.config },
        { call: "add", name, directory: "/work", config: older[0]?.config },
        { call: "disconnect", name, directory: "/work" },
    ]);
});

test("recordModels is a no-op for an empty or media-only list (keeps the seed floor)", async () => {
    const xdg = await scratch();
    const service = createOpenCodeService(xdg, { fetchImpl: forbiddenFetch });
    await service.recordModels(["grok-2-image", "grok-imagine-video"]);
    expect(await fileExists(modelsPath(xdg))).toBe(false);
    expect(await service.xaiModels()).toEqual(SEED_CATALOG);
});

// OpenCode has no models.dev row for this loopback provider, so an omitted capability defaults to false; a model
// missing "image" input has images stripped from the request.
test("the Google provider declares each model's published modalities, so a screenshot is not stripped out", () => {
    const config = geminiProviderConfig({ baseUrl: "http://127.0.0.1:8789/", token: "local", models: async () => [] }, [
        { id: "claude-opus-4-6-thinking", inputModalities: ["text", "image"] },
        { id: "gemini-pro-agent", inputModalities: ["text", "image", "audio", "video"] },
        { id: "gpt-oss-120b-medium", inputModalities: ["text"] },
    ]);

    const provider = config["intentic-gemini"]!;
    // The trailing slash on the translator URL is normalized away, and the OpenAI surface is under /v1.
    expect(provider.options).toEqual({ baseURL: "http://127.0.0.1:8789/v1", apiKey: "local" });
    expect(provider.models).toEqual({
        "claude-opus-4-6-thinking": { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } },
        "gemini-pro-agent": { attachment: true, modalities: { input: ["text", "image", "audio", "video"], output: ["text"] } },
        // Truthful, not generous: a text-only model on the channel stays text-only.
        "gpt-oss-120b-medium": { attachment: false, modalities: { input: ["text"], output: ["text"] } },
    });
});

// A catalog read that failed must cost Google its provider, not Grok its runtime: one opencode serve is both.
test("no Google models means no Google provider at all, rather than one registered serving nothing", () => {
    expect(geminiProviderConfig({ baseUrl: "http://127.0.0.1:8789", token: "local", models: async () => [] }, [])).toEqual({});
    expect(geminiProviderConfig(undefined, [{ id: "gemini-pro-agent", inputModalities: ["text", "image"] }])).toEqual({});
});
