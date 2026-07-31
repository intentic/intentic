import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createResidentEngine, type HealthRequest, type QueryRequest } from "@intentic/iq-engine";
import type { AgentEvent, Capability } from "@intentic/sandbox-contract";
import { capabilitiesOf, HEALTH_LIMIT, portUrl, sandboxContract } from "@intentic/sandbox-contract";
import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { DEFAULT_TEMPLATE_REF, DEFAULT_TEMPLATE_SOURCE } from "@intentic/scaffold";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { Hono } from "hono";
import { afterEach, expect, test, vi } from "vitest";
import { createAgentsRegistry } from "./agents/agents-registry.js";
import { createApp } from "./app.js";
import { ForbiddenError } from "./auth/auth.js";
import type { AutomationRecord, AutomationsStore } from "./automations/automations-store.js";
import type { CapabilitiesStore } from "./capabilities/capabilities-store.js";
import type { Services } from "./composition.js";
import type { Config } from "./env.config.js";
import { createLogger } from "./logger.js";
import type { ManagedProcesses, ProcessSpec } from "./processes/managed-processes.js";
import { createPortForwards } from "./ports/port-forwards.js";
import { createBootTracker } from "./platform/boot.js";
import { createPerfTracker } from "./platform/perf.js";
import { mintPairing } from "./platform/sync.js";
import { createTerminalRunner } from "./terminal/terminal-run.js";
import type { AgentTool } from "./agent/agent-tools.js";
import { listenerProvidersOf } from "./extensions/installed-extensions.js";
import { workspacePaths } from "./workspace/workspace.js";
import { MAX_RAW_BYTES, sha256Text, UploadTooLargeError } from "./workspace/workspace-files.js";

/* A fire route answers 200 the moment it accepts the wake and lets the turn run DETACHED, so the run it records
 * lands some time after the response. That tail is not the fake agent (which completes instantly) — it is the
 * real turn path around it: the extension/cli env scan off disk, the worktree compose, the land pass. On a
 * loaded runner (CI runs this package's 143 files alongside the rest of the monorepo) it outruns vi.waitFor's
 * 1s default often enough to have made these the suite's flakiest tests. This budget bounds a hang; it does not
 * measure latency — and it stays under the 5s default test timeout so an overrun still reports as the assertion
 * that did not settle rather than as a dead test.
 */
const TURN_SETTLES = { timeout: 4_000 } as const;

/* Where the agent worktrees' MAIN checkouts would be — a path under tmpdir that is never created, so on every
 * host it is definitively absent. This suite drives the ROUTES; the worktree and land git mechanics have their
 * own suites against real repos (worktrees.test.ts, land.test.ts). The land pass a turn runs at its end reads
 * the main checkout with real git, so naming the product's own "/work" here made the outcome depend on whether
 * the machine running the tests happens to have one: absent on CI, a LIVE repo on a developer's own intentic
 * sandbox, where the land then shelled git at a worktree that was never created and failed the turn. Absent
 * everywhere, the pass reports "main checkout vanished" and returns without spawning anything.
 */
const ABSENT_MAIN = join(tmpdir(), "intentic-absent-main");

// An in-memory capabilities store so the capability routes + turn merge are testable without the fs.
const memoryCapabilitiesStore = (initial: Capability[] = []): CapabilitiesStore => {
    let capabilities = [...initial];
    return {
        list: async () => capabilities,
        get: async (id) => capabilities.find((capability) => capability.id === id),
        upsert: async (capability) => {
            capabilities = [...capabilities.filter((existing) => existing.id !== capability.id), capability];
        },
        remove: async (id) => {
            const next = capabilities.filter((capability) => capability.id !== id);
            const existed = next.length !== capabilities.length;
            capabilities = next;
            return existed;
        },
    };
};

// An in-memory automations store so the fire route is testable without the fs.
const memoryAutomationsStore = (initial: AutomationRecord[] = []): AutomationsStore => {
    let automations = [...initial];
    return {
        list: async () => automations,
        get: async (id) => automations.find((automation) => automation.id === id),
        upsert: async (automation) => {
            const runs = automations.find((existing) => existing.id === automation.id)?.runs ?? [];
            automations = [...automations.filter((existing) => existing.id !== automation.id), { ...automation, runs }];
        },
        remove: async (id) => {
            const next = automations.filter((automation) => automation.id !== id);
            const existed = next.length !== automations.length;
            automations = next;
            return existed;
        },
        recordRun: async (id, run) => {
            const record = automations.find((automation) => automation.id === id);
            if (record !== undefined) {
                record.runs = [run, ...record.runs];
            }
        },
    };
};

// Records starts/stops; `portOf` returns the seeded port so a repo reads as running (the list route derives
// running/healthy from portOf, not running()).
const fakeProcesses = (ports: Record<string, number> = {}): ManagedProcesses & { started: { repo: string; cwd: string }[]; stopped: string[] } => {
    const started: { repo: string; cwd: string }[] = [];
    const stopped: string[] = [];
    return {
        started,
        stopped,
        start: async (repo, spec) => {
            started.push({ repo, cwd: spec.cwd });
        },
        stop: (repo) => {
            stopped.push(repo);
        },
        running: (repo) => repo in ports,
        portOf: (repo) => ports[repo],
        stopAll: () => {},
    };
};

// A temp workspace on disk (repo discovery reads it): each entry names a repo — a dir owning a .git, role and
// clone alike — and whether it gets an operator/ panel (a package.json with a dev script).
const tempWorkspace = (repos: { name: string; panel?: boolean }[]): ReturnType<typeof workspacePaths> => {
    const root = mkdtempSync(join(tmpdir(), "panels-"));
    for (const repo of repos) {
        const dir = join(root, repo.name);
        mkdirSync(join(dir, ".git"), { recursive: true });
        if (repo.panel === true) {
            mkdirSync(join(dir, "operator"), { recursive: true });
            writeFileSync(join(dir, "operator", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
        }
    }
    return workspacePaths(root);
};

// Inert history — no snapshots recorded, every id unknown; a test overrides just the members it asserts on.
const fakeHistory = (overrides: Partial<Services["history"]> = {}): Services["history"] => ({
    start: () => {},
    stop: () => {},
    snapshot: async () => undefined,
    notifyUserWrite: () => {},
    list: async () => [],
    diff: async () => undefined,
    fileDiff: async () => undefined,
    restore: async () => false,
    ...overrides,
});

// The files seam with every method a no-op by default; a test overrides just the ones it asserts on.
const fakeFiles = (overrides: Partial<Services["files"]> = {}): Services["files"] => ({
    read: async () => undefined,
    readWindow: async () => undefined,
    write: async () => {},
    writeStream: async () => {},
    readBytes: async () => undefined,
    size: async () => undefined,
    mkdir: async () => {},
    remove: async () => {},
    move: async () => {},
    copy: async () => {},
    ...overrides,
});

// All config fields at their schema defaults; the routes only read claudeCodeOauthToken / anthropicApiKey
// (the agent guard) and the workspace paths (via services.workspace), so the rest are inert here.
// The real first-party connectors/discord extensions, so cli-capability tests resolve their provider data.
const EXTENSIONS_DIR = fileURLToPath(new URL("../../../_extensions", import.meta.url));

const baseConfig: Config = {
    workspaceRoot: "/work",
    historyRoot: "/history",
    extensionsDir: EXTENSIONS_DIR,
    agentAuthDir: "",
    logLevel: "silent",
    logPretty: false,
    zone: "",
    connectToken: "",
    owner: { email: "" },
    syncPairToken: "",
    webOrigin: "",
    platform: { url: "" },
    intenticAgentTools: "",
    claudeCodeOauthToken: "",
    anthropicApiKey: "",
    openaiApiKey: "",
    cloudflareApiToken: "",
    translator: { url: "", token: "" },
    sandbox: { port: 8787, host: "0.0.0.0", publicUrl: "", name: "", image: "", environmentHash: "" },
    preview: { port: 5173 },
    google: { clientId: "" },
};

const services = (overrides: Partial<Services> = {}): Services => {
    const merged: Services = {
        config: baseConfig,
        logger: createLogger(baseConfig),
        // No chain declared ⇒ converged from birth, so these tests exercise the routes and not a boot gate.
        // The gate's own behaviour is covered below by a tracker with a declared chain.
        boot: createBootTracker(createLogger(baseConfig)),
        // The real tracker, like every other suite's fake services: it is in-memory, its summary timer is
        // unref'd, and the request middleware records through it on EVERY route below — a stub would be more
        // code standing in for something that already costs nothing.
        perf: createPerfTracker(createLogger(baseConfig)),
        workspace: workspacePaths("/work"),
        processes: fakeProcesses(),
        // The real slot table with a no-dial probe; `scanPorts` is empty so tests opt into listeners explicitly.
        portForwards: createPortForwards(async () => "http"),
        scanPorts: async () => [],
        terminalRun: createTerminalRunner(),
        panelToken: "panel-secret",
        // In-memory bridge-token fake: one fixed valid token, so middleware tests need no store file.
        bridgeTokens: {
            mint: async (label) => ({ id: "bt-1", token: `ibt_minted-${label}` }),
            verify: async (presented) => presented === "ibt_valid",
            list: async () => [{ id: "bt-1", label: "test", createdAt: 0 }],
            revoke: async () => true,
        },
        info: undefined,
        tools: [],
        capabilities: memoryCapabilitiesStore(),
        automations: memoryAutomationsStore(),
        // Inert turn journal: every fire path writes an in-flight entry and clears it, and nothing here resumes.
        turnJournal: {
            list: async () => [],
            recordTurn: async () => {},
            recordFire: async () => {},
            clearTurn: async () => {},
            clearFire: async () => {},
        },
        activity: { append: async () => {}, list: async () => [] },
        usage: { record: async () => {}, rollup: async () => [] },
        sandboxSettings: {
            get: async () => ({
                stableSystemPrompt: false,
                skills: [],
                hashlineEdits: false,
                terseOutput: false,
                iqSearch: false,
                outputCleaners: "",
                outputHoldout: 0,
                filterBackend: "native" as const,
            }),
            set: async () => {},
        },
        // A connected account by default, so the /agent guard (no token + no env creds) doesn't short-circuit
        // turns under test. Tests that exercise the disconnected path override this.
        claudeStore: {
            read: async (id) => (id === "default" ? { id: "default", label: "Claude", connectedAt: 0, accessToken: "tok-xyz" } : undefined),
            write: async () => {},
            clear: async () => {},
            list: async () => [{ id: "default", label: "Claude", connectedAt: 0 }],
        },
        // No usage measured by default — an account that hasn't run a turn since its window reset reports none.
        accountUsage: { read: async () => ({}), record: async () => {}, clear: async () => {} },
        // Nothing connected in the translator by default; tests exercising the Codex subscription path override this.
        cliProxy: {
            accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [] }),
            connect: async () => ({ url: "", code: "", state: "", flow: "device" as const }),
            complete: async () => {},
            disconnect: async () => {},
            models: async () => [],
        },
        codexHome: "/work/.intentic/codex",
        codexThreadExists: async () => true,
        // Never-empty catalog fakes matching the daemon's contract, so a native turn always resolves a model.
        claudeModels: { models: async () => ({ models: [{ id: "opus", label: "Opus" }], default: "opus" }) },
        codexModels: { models: async () => ({ models: [{ id: "gpt-5.1", label: "GPT 5.1" }], default: "gpt-5.1" }), record: async () => {} },
        kimiModels: { models: async () => ({ models: [{ id: "kimi-k3", label: "Kimi K3" }], default: "kimi-k3" }) },
        geminiModels: { models: async () => ({ models: [{ id: "gemini-pro-agent", label: "Gemini Pro Agent" }], default: "gemini-pro-agent" }) },
        history: fakeHistory(),
        agent: async function* () {
            yield { kind: "done" };
        },
        codexAgent: async function* () {
            yield { kind: "done" };
        },
        grokAgent: async function* () {
            yield { kind: "done" };
        },
        openCode: {
            client: async () => ({}) as never,
            connected: async () => false,
            sessionExists: async () => true,
            xaiModels: async () => ({ models: [{ id: "grok-4", label: "Grok 4" }], default: "grok-4" }),
            recordModels: async () => {},
            disconnect: async () => {},
        },
        intentic: async function* () {},
        git: {
            init: async () => {},
            status: async () => ({ branch: "main", dirty: false, files: [] }),
            listFiles: async () => [],
            commitAll: async () => false,
            clone: async () => {},
            changedFiles: async () => ({ conflicted: [], staged: [], unstaged: [] }),
            stagePaths: async () => {},
            unstagePaths: async () => {},
            commitIndex: async () => false,
            discardPaths: async () => {},
            listBranches: async () => [],
            createBranch: async () => {},
            deleteBranch: async () => {},
            remoteState: async () => ({ ahead: 0, behind: 0 }),
            fetchRemote: async () => ({ ok: true as const }),
            pullRemote: async () => ({ ok: true as const }),
            pushBranch: async () => ({ ok: true as const }),
            stagedFileDiff: async () => ({}),
            unstagedFileDiff: async () => ({}),
            fileDiff: async () => ({}),
        },
        // A real registry over a memory store (cheap, and /events' roster subscription needs the real seam);
        // worktree git mechanics are stubbed — the worktree suites cover them against real git.
        // No land standings to derive here: these suites drive the routes, and where a card's work stands is
        // standing.test.ts's subject. Every agent this harness makes therefore reads at its turn lifecycle.
        agents: createAgentsRegistry(
            { load: async () => [], save: async () => {} },
            { of: () => "idle", refresh: async () => false, forget: () => {} },
        ),
        agentWorktrees: {
            conversationDir: (id) => `/history/worktrees/${id}`,
            worktreeDir: (id, repo) => (repo === "root" ? `/history/worktrees/${id}` : `/history/worktrees/${id}/${repo}`),
            mainDir: (repo) => (repo === "root" ? ABSENT_MAIN : join(ABSENT_MAIN, repo)),
            exists: async () => false,
            // A live checkout, so the routes read the worktree path — the steady state these fakes model.
            attached: async () => true,
            ensure: async (id) => ({ cwd: `/history/worktrees/${id}`, branch: `agent/${id}`, repos: [{ repo: "root", base: "a".repeat(40) }] }),
            remove: async () => {},
            retire: async () => {},
            prune: async () => {},
            withRepoLock: (_repo, task) => task(),
        },
        // Namespace isolation off, which is what a test runner (and any container without CAP_SYS_ADMIN) really
        // gets: turns then run straight in the worktree path, the behaviour every route assertion below expects.
        // The isolation.test.ts suite covers the plan these routes would build when it IS available.
        // No mount capability, like a container launched without CAP_SYS_ADMIN — the plan still describes where
        // the worktree is, and the harness enforces it by redirecting tool paths instead of by mounting.
        turnIsolation: { available: async () => false, planFor: async (worktree: string) => ({ worktree, root: "/work", modules: [] }) },
        // No agent has landed anything into these fake repos, so every changed file is the user's — and with no
        // ids to attribute, `identify` has nobody to resolve.
        agentOrigins: { forRepo: async () => ({}), identify: () => ({}) },
        files: fakeFiles(),
        workspaceTree: async () => ({ root: "/work", tree: [], hidden: 0 }),
        // Inert resident search — no index, no rg. The search route test overrides `run` with a canned outcome.
        iq: {
            run: async () => ({
                result: { mode: "q", total: 0, shown: 0, groups: [], freshness: { state: "fresh" as const }, truncated: false },
                text: "",
                exitCode: 1 as const,
            }),
            health: async () => ({
                totals: { files: 0, symbols: 0, complexity: 0, hotspots: 0 },
                hotspots: [],
                modules: [],
                freshness: { state: "fresh" as const },
            }),
            markDirty: () => {},
            warm: async () => ({ files: 0, symbols: 0, chunks: 0, embedded: 0, generation: 0, freshness: { state: "fresh" as const, ageMs: 0 } }),
            close: () => {},
        },
        sessions: {
            list: async () => [],
            read: async () => [],
            search: async () => [],
            prompts: async () => [],
            exists: async () => true,
        },
        platformHostTunnel: async () => ({ status: 200, json: { hostname: "ssh-abc.example.com", tunnelToken: "tok" } }),
        ensurePreviewRoutes: async () => {},
        members: { list: async () => [], add: async () => {}, remove: async () => {} },
        auth: undefined,
        // A conversation's transcript defaults to the same claude-code-only shape production reads before a
        // provider-native record exists: the SDK session `sessions.read` already stands in for (agent-transcript.ts),
        // keyed off the same registry `sessionIdOf` the route asks. Reads through `merged` (not the pre-override
        // fakes above) so a test overriding `sessions.read` or `agents` is exactly what a transcript() call sees.
        transcripts: {
            read: async (agent) => {
                const sessionId =
                    capabilitiesOf(agent.provider, agent.harness).runtime === "claude-code" ? merged.agents.sessionIdOf(agent.id) : undefined;
                return sessionId === undefined ? [] : merged.sessions.read(merged.workspace.root, sessionId);
            },
            // Inert: `read` above already synthesizes from the SDK session that production's adoption would have
            // copied in, so there is nothing for an open to carry over here. Present all the same, because it is
            // on the turn path — leaving it off this fake made every agent.run test in this file fail with a bare
            // "Internal server error", and nothing catches that from the types: tsconfig excludes *.test.ts, so
            // the fake rots in silence.
            open: async () => {},
            append: async () => {},
        },
        ...overrides,
    };
    return merged;
};

// A typed oRPC client over the in-process Hono app — the same OpenAPILink the browser uses, so streams round-
// trip through the real SSE encode/decode. JSON routes resolve to their output; thrown ORPCErrors carry `.code`.
const clientFor = (app: Hono): ContractRouterClient<typeof sandboxContract> =>
    createORPCClient(new OpenAPILink(sandboxContract, { url: "http://sandbox", fetch: (request) => app.request(request) }));

// Without a vitest config there is no unstubEnvs, so a stubbed var would outlive the test that set it.
afterEach(() => vi.unstubAllEnvs());

// An auth stub that refuses every bearer as an AUTHENTICATION failure (→ 401) — proves a route's gate (or its
// exemption from the bearer middleware).
const rejectAuth = async (): Promise<never> => {
    throw new Error("no bearer");
};

// An auth stub for a verified-but-unauthorized caller (→ 403): the bearer is valid, the identity just isn't
// allowed (wrong Google account / member hitting an owner-only route).
const rejectForbidden = async (): Promise<never> => {
    throw new ForbiddenError("not the sandbox owner");
};

// A JSON POST against the in-process app, for the plain (non-oRPC) routes.
const postJson = (app: Hono, path: string, body?: unknown): Promise<Response> =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

const errorCode = async (run: Promise<unknown>): Promise<string | undefined> => {
    try {
        await run;
    } catch (error) {
        return (error as { code?: string }).code;
    }
    return undefined;
};

const collect = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
    const events: T[] = [];
    for await (const event of stream) {
        events.push(event);
    }
    return events;
};

// Drive a chat turn over the detached-run protocol exactly as the browser does: start (acked with the run
// id), attach, unwrap the envelope frames back to raw AgentEvents. Awaiting the attach to its `end` is also
// the settle barrier the old in-request stream gave these tests. Ids are minted per turn unless the test
// pins one (the run registry is keyed by conversationId across the whole test process).
let turnCounter = 0;
const runAgentTurn = async (
    client: ContractRouterClient<typeof sandboxContract>,
    input: Record<string, unknown> & { prompt: string; conversationId?: string },
): Promise<AgentEvent[]> => {
    const conversationId = input.conversationId ?? `turn-${(turnCounter += 1)}`;
    const { run } = await client.agent.run({ ...input, conversationId });
    const frames = await collect(await client.agent.attach({ conversationId }));
    expect(frames[0]).toMatchObject({ kind: "attached", run, prompt: input.prompt });
    expect(frames.at(-1)).toEqual({ kind: "end" });
    return frames.flatMap((frame) => (frame.kind === "frame" ? [frame.event] : []));
};

test("GET /health reports ok, and names the sandbox so a loopback probe can tell WHICH daemon answered", async () => {
    const res = await createApp(services()).request("/health");
    expect(res.status).toBe(200);
    // No connect token (the loopback/test shape) ⇒ no id to claim, and no loopback shortcut to publish either.
    expect(await res.json()).toMatchObject({ ok: true });
    expect(await (await createApp(services()).request("/health")).json()).not.toHaveProperty("sandboxId");

    // With one, the id is the SAME digest the tunnel hostname and the published port derive from — that
    // agreement is what makes the browser's "did I reach the right daemon" check meaningful.
    const named = await createApp(services({ config: { ...baseConfig, connectToken: "tok" } })).request("/health");
    expect(await named.json()).toMatchObject({ ok: true, sandboxId: sandboxIdFromToken("tok") });
});

test("GET /health carries the boot progress, so a poller can tell 'starting' from 'serving'", async () => {
    const boot = createBootTracker(createLogger(baseConfig));
    boot.declare([{ key: "registry", label: "Loading conversations" }]);
    const app = createApp(services({ boot }));

    expect(await (await app.request("/health")).json()).toMatchObject({
        ok: true,
        boot: { ready: false, steps: [{ key: "registry", label: "Loading conversations", state: "pending" }] },
    });

    boot.finish();
    expect(await (await app.request("/health")).json()).toMatchObject({ boot: { ready: true } });
});

test("the boot gate holds data routes and lets the probe and the session exchange through", async () => {
    const boot = createBootTracker(createLogger(baseConfig));
    boot.declare([{ key: "registry", label: "Loading conversations" }]);
    const app = createApp(services({ boot }));

    // A data route parks until the chain converges — an early request WAITS instead of reading half-built state.
    let settled = false;
    const held = app.request("/settings").then((response) => {
        settled = true;
        return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    // The exempt ones answer straight through. /system/session especially: it is the credential a browser needs
    // before it can open /events at all, so parking it left a cold browser unable to watch the very boot it
    // was waiting on. Its 4xx/5xx here is the auth-less shape refusing to mint — what matters is that it
    // ANSWERS rather than joining the queue.
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/system/session", { method: "POST" })).status).not.toBe(200);

    boot.finish();
    expect((await held).status).toBe(200);
});

test("panels.list enumerates every repo with its operator panel + runtime status", async () => {
    const workspace = tempWorkspace([{ name: "app", panel: true }, { name: "desired-state" }]);
    const client = clientFor(
        createApp(
            services({
                workspace,
                // The zone comes from the public URL, the hostname's sandbox id from the connect token
                // (sha256("token")[0:12] = 3c469e9d6c58) — both are needed for a previewUrl to be advertised.
                config: { ...baseConfig, connectToken: "token", sandbox: { ...baseConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" } },
                // "app" is running on a dead port (probe fails ⇒ healthy false); "desired-state" isn't running.
                processes: fakeProcesses({ app: 1 }),
            }),
        ),
    );
    const facts = { deployConfig: false, desiredState: false, directoryUi: false, monorepo: false, vitest: false, userStories: false };
    expect(await client.panels.list()).toEqual({
        panels: [
            {
                repo: "app",
                hasPanel: true,
                running: true,
                healthy: false,
                port: 1,
                role: "app",
                ...facts,
                previewUrl: "https://preview-app-3c469e9d6c58.example.com",
            },
            {
                repo: "desired-state",
                hasPanel: false,
                running: false,
                healthy: false,
                role: "desired-state",
                ...facts,
                previewUrl: "https://preview-desired-state-3c469e9d6c58.example.com",
            },
        ],
    });
});

test("workspace.search runs the resident engine in-process, mapping the wire query to a QueryRequest", async () => {
    const requests: QueryRequest[] = [];
    const groups = [{ path: "alpha/src/widget.ts", score: 1, hits: [{ line: 3, text: "export const createWidget", tags: [] }] }];
    const client = clientFor(
        createApp(
            services({
                iq: {
                    run: async (request) => {
                        requests.push(request);
                        return {
                            result: { mode: request.verb, total: 1, shown: 1, groups, freshness: { state: "fresh" }, truncated: false },
                            text: "",
                            exitCode: 0,
                        };
                    },
                    health: async () => ({
                        totals: { files: 0, symbols: 0, complexity: 0, hotspots: 0 },
                        hotspots: [],
                        modules: [],
                        freshness: { state: "fresh" },
                    }),
                    markDirty: () => {},
                    warm: async () => ({ files: 0, symbols: 0, chunks: 0, embedded: 0, generation: 0, freshness: { state: "fresh", ageMs: 0 } }),
                    close: () => {},
                },
            }),
        ),
    );
    const result = await client.workspace.search({ query: "createWidget", mode: "find", includeIgnored: true, limit: 3 });
    expect(result.groups).toEqual(groups);
    expect(requests).toEqual([
        {
            verb: "find",
            query: "createWidget",
            scope: { ignored: true },
            render: { budget: 1500, limit: 3 },
            options: {},
            echo: 'find "createWidget" --ignored',
        },
    ]);
});

test("workspace.health scopes the resident engine to one repo — 'root' is the workspace repo's empty scope", async () => {
    const requests: HealthRequest[] = [];
    const report = {
        totals: { files: 12, symbols: 40, complexity: 88, hotspots: 3 },
        hotspots: [{ path: "app/src/gate.ts", commits: 7, adds: 120, dels: 40, complexity: 19, score: 133, latestMs: 1_700_000_000_000 }],
        modules: [{ path: "app/src/widget.ts", exports: 4 }],
        freshness: { state: "fresh" as const },
    };
    const client = clientFor(
        createApp(
            services({
                workspace: tempWorkspace([{ name: "app" }]),
                iq: {
                    ...services().iq,
                    health: async (request) => {
                        requests.push(request);
                        return report;
                    },
                },
            }),
        ),
    );
    expect(await client.workspace.health({ repo: "root" })).toEqual({ repo: "root", ...report });
    await client.workspace.health({ repo: "app", since: "30d", limit: 5 });
    expect(requests).toEqual([
        // The sweep tags a workspace-root file with the empty repo id, so "root" narrows to exactly those files
        // — not to everything, which would fold every nested repo's churn into the root repo's report.
        { scope: { repo: "" }, limit: HEALTH_LIMIT },
        { scope: { repo: "app" }, since: "30d", limit: 5 },
    ]);
    // A report for a repo that isn't there would read as a healthy repo, so it is an error instead.
    expect(await errorCode(client.workspace.health({ repo: "ghost" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.health({ repo: "../escape" }))).toBe("BAD_REQUEST");
});

test("panels.list reports the content facts extensions detect on", async () => {
    const workspace = tempWorkspace([{ name: "extra" }]);
    const dir = join(workspace.root, "extra");
    writeFileSync(join(dir, "deploy.config.ts"), "export default {};");
    writeFileSync(join(dir, "desired-state.json"), "{}");
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []");
    writeFileSync(join(dir, "turbo.json"), "{}");
    mkdirSync(join(dir, ".intentic", "ui"), { recursive: true });
    writeFileSync(join(dir, ".intentic", "ui", "index.html"), "<html></html>");
    mkdirSync(join(dir, "docs", "user-stories"), { recursive: true });
    const client = clientFor(createApp(services({ workspace })));
    expect(await client.panels.list()).toEqual({
        panels: [
            {
                repo: "extra",
                hasPanel: false,
                running: false,
                healthy: false,
                deployConfig: true,
                desiredState: true,
                directoryUi: true,
                monorepo: true,
                vitest: false,
                userStories: true,
            },
        ],
    });
});

test("panels.list advertises no previewUrl without a connect token (loopback — nothing would resolve)", async () => {
    const workspace = tempWorkspace([{ name: "app", panel: true }]);
    const client = clientFor(
        createApp(
            services({ workspace, config: { ...baseConfig, sandbox: { ...baseConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" } } }),
        ),
    );
    expect(await client.panels.list()).toEqual({
        panels: [
            {
                repo: "app",
                hasPanel: true,
                running: false,
                healthy: false,
                role: "app",
                deployConfig: false,
                desiredState: false,
                directoryUi: false,
                monorepo: false,
                vitest: false,
                userStories: false,
            },
        ],
    });
});

test("panels.start runs the repo's operator dir, rejects unknown repos + repos with no panel; stop is idempotent", async () => {
    const workspace = tempWorkspace([{ name: "app", panel: true }, { name: "desired-state" }]);
    const processes = fakeProcesses();
    const ensured: string[] = [];
    const client = clientFor(
        createApp(
            services({
                workspace,
                processes: processes,
                ensurePreviewRoutes: async (labels) => {
                    ensured.push(...labels);
                },
            }),
        ),
    );

    expect(await client.panels.start({ repo: "app" })).toEqual({ ok: true });
    expect(processes.started).toEqual([{ repo: "app", cwd: join(workspace.root, "app", "operator") }]);
    // The preview route is minted (as its label) before the panel is observable as running.
    expect(ensured).toEqual(["preview-app"]);
    // A repo with no operator/ can't start; an unknown repo is NOT_FOUND.
    expect(await errorCode(client.panels.start({ repo: "desired-state" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.panels.start({ repo: "ghost" }))).toBe("NOT_FOUND");
    expect(await client.panels.stop({ repo: "app" })).toEqual({ ok: true });
    expect(processes.stopped).toEqual(["app"]);
    expect(await errorCode(client.panels.stop({ repo: "ghost" }))).toBe("NOT_FOUND");
});

test("ports.list scans on demand, hides the daemon's own listeners, and marks forwards with their URLs", async () => {
    const config = { ...baseConfig, zone: "example.com", connectToken: "tok" };
    const portForwards = createPortForwards(async () => "http");
    const client = clientFor(
        createApp(
            services({
                config,
                portForwards,
                scanPorts: async () => [
                    { port: 22, host: "127.0.0.1", forwardable: true },
                    { port: 3000, host: "127.0.0.1", forwardable: true, pid: 7, command: "vite", cwd: "/work/app" },
                    { port: 5173, host: "127.0.0.1", forwardable: true },
                    { port: 8787, host: "127.0.0.1", forwardable: true },
                ],
            }),
        ),
    );
    expect(await client.ports.list()).toEqual({
        ports: [{ port: 3000, host: "127.0.0.1", forwardable: true, kind: "workspace", pid: 7, command: "vite", cwd: "/work/app", forwarded: false }],
    });

    await portForwards.forward(3000, "127.0.0.1");
    expect(await client.ports.list()).toEqual({
        ports: [
            {
                port: 3000,
                host: "127.0.0.1",
                forwardable: true,
                kind: "workspace",
                pid: 7,
                command: "vite",
                cwd: "/work/app",
                forwarded: true,
                previewUrl: portUrl("a", "example.com", sandboxIdFromToken("tok")),
            },
        ],
    });
});

test("ports.forward maps a listener onto a slot, mints its route label, and refuses reserved/dead ports", async () => {
    const config = { ...baseConfig, zone: "example.com", connectToken: "tok" };
    const ensured: string[] = [];
    const portForwards = createPortForwards(async () => "http");
    const client = clientFor(
        createApp(
            services({
                config,
                portForwards,
                scanPorts: async () => [{ port: 3000, host: "127.0.0.1", forwardable: true, pid: 7, command: "vite" }],
                ensurePreviewRoutes: async (labels) => {
                    ensured.push(...labels);
                },
            }),
        ),
    );
    expect(await client.ports.forward({ port: 3000 })).toEqual({ previewUrl: portUrl("a", "example.com", sandboxIdFromToken("tok")) });
    expect(ensured).toEqual(["port-a"]);
    // The daemon's own surfaces are never forwardable; a port nothing listens on is NOT_FOUND.
    expect(await errorCode(client.ports.forward({ port: 8787 }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.ports.forward({ port: 4000 }))).toBe("NOT_FOUND");
    // Unforward frees the slot; the port reads unforwarded again.
    expect(await client.ports.unforward({ port: 3000 })).toEqual({ ok: true });
    // No cwd and not a known sandbox binary -> unattributable, filed under system.
    expect((await client.ports.list()).ports).toEqual([
        { port: 3000, host: "127.0.0.1", forwardable: true, kind: "system", pid: 7, command: "vite", forwarded: false },
    ]);
});

test("ports.forward on a loopback sandbox (no zone/token) still maps the slot but returns no URL", async () => {
    const client = clientFor(createApp(services({ scanPorts: async () => [{ port: 3000, host: "127.0.0.1", forwardable: true }] })));
    expect(await client.ports.forward({ port: 3000 })).toEqual({});
});

test("system.terminals reports an empty list, not an error, when there is no tmux server to ask", async () => {
    // Pointed at a socket directory that holds no server: `list-panes` exits non-zero and that is an empty list.
    // Both vars matter — TMUX_TMPDIR picks the socket, and $TMUX (set whenever the suite itself runs inside tmux)
    // would otherwise send the query to the REAL server, where this machine's own agent-* sessions live.
    vi.stubEnv("TMUX_TMPDIR", mkdtempSync(join(tmpdir(), "terminals-empty-")));
    vi.stubEnv("TMUX", undefined);
    const client = clientFor(createApp(services()));
    expect(await client.system.terminals()).toEqual({ sessions: [] });
});

test("usage.rollup round-trips the ledger's rows and forwards the day bounds to the store", async () => {
    const asked: { from?: string | undefined; to?: string | undefined }[] = [];
    const client = clientFor(
        createApp(
            services({
                usage: {
                    record: async () => {},
                    rollup: async (query) => {
                        asked.push(query);
                        return [
                            {
                                day: "2026-07-20",
                                provider: "claude",
                                account: "work",
                                model: "opus-5",
                                harness: "native",
                                turns: 2,
                                inputTokens: 200,
                                outputTokens: 100,
                                cacheReadTokens: 20,
                                cacheCreationTokens: 10,
                                costUsd: 0.5,
                                durationMs: 2_000,
                            },
                        ];
                    },
                },
            }),
        ),
    );

    const result = await client.usage.rollup({ from: "2026-07-01", to: "2026-07-31" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ day: "2026-07-20", model: "opus-5", costUsd: 0.5, turns: 2 });
    // The query reaches the store as day strings, so the store owns the range semantics (inclusive bounds).
    expect(asked).toEqual([{ from: "2026-07-01", to: "2026-07-31" }]);
});

test("system.usage folds the LEDGER (all-time, never pruned) per provider+account and skips unattributed turns", async () => {
    const client = clientFor(
        createApp(
            services({
                usage: {
                    record: async () => {},
                    // Two days on one account plus an unattributed env-token turn, which belongs to no account.
                    rollup: async () => [
                        {
                            day: "2026-07-20",
                            provider: "claude",
                            account: "work",
                            harness: "native",
                            turns: 1,
                            inputTokens: 100,
                            outputTokens: 50,
                            cacheReadTokens: 10,
                            cacheCreationTokens: 5,
                            costUsd: 0.25,
                            durationMs: 1_000,
                        },
                        {
                            day: "2026-07-21",
                            provider: "claude",
                            account: "work",
                            harness: "native",
                            turns: 3,
                            inputTokens: 300,
                            outputTokens: 150,
                            cacheReadTokens: 30,
                            cacheCreationTokens: 15,
                            costUsd: 0.75,
                            durationMs: 3_000,
                        },
                        {
                            day: "2026-07-21",
                            provider: "claude",
                            harness: "native",
                            turns: 9,
                            inputTokens: 900,
                            outputTokens: 900,
                            cacheReadTokens: 0,
                            cacheCreationTokens: 0,
                            costUsd: 9,
                            durationMs: 9_000,
                        },
                    ],
                },
            }),
        ),
    );

    // Both of the account's days summed into one row; the unattributed turn's $9 is excluded, not pooled.
    expect(await client.system.usage()).toEqual({
        accounts: [
            {
                provider: "claude",
                account: "work",
                turns: 4,
                inputTokens: 400,
                outputTokens: 200,
                cacheReadTokens: 40,
                cacheCreationTokens: 20,
                costUsd: 1,
            },
        ],
    });
});

test("system.killTerminal routes a panel-* session through the process manager, so `running` unmaps immediately", async () => {
    const processes = fakeProcesses();
    const client = clientFor(createApp(services({ processes: processes })));
    expect(await client.system.killTerminal({ name: "panel-app" })).toEqual({ ok: true });
    expect(processes.stopped).toEqual(["app"]);
});

test("system.session exchanges the verified bearer for a daemon-minted session", async () => {
    const client = clientFor(
        createApp(
            services({
                auth: {
                    authorize: async () => ({ email: "o@x.com" }),
                    authorizeOwner: rejectForbidden,
                    mintSession: async (identity: { email: string }) => ({ token: `sess-${identity.email}`, expiresAt: 42 }),
                },
            }),
        ),
    );
    expect(await client.system.session()).toEqual({ token: "sess-o@x.com", expiresAt: 42, email: "o@x.com" });
});

test("system.session in loopback mode (no auth, no identity) answers 401 — there is no session to mint", async () => {
    expect((await postJson(createApp(services({})), "/system/session")).status).toBe(401);
});

test("the panel token is accepted in place of a Google bearer (server-side panel → daemon calls)", async () => {
    // Auth rejects every bearer, so a 200 proves the x-intentic-panel token is the only thing admitting the call.
    const app = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    expect((await app.request("/panels", { headers: { "x-intentic-panel": "panel-secret" } })).status).toBe(200);
    expect((await app.request("/panels", { headers: { "x-intentic-panel": "wrong" } })).status).toBe(401);
    expect((await app.request("/panels")).status).toBe(401);
});

test("a bridge token reaches the agent-conversation surface and NOTHING else", async () => {
    // Auth rejects every bearer, so any 2xx below proves the x-intentic-bridge path admitted the call.
    const app = createApp(
        services({
            auth: { authorize: rejectAuth, authorizeOwner: rejectAuth },
            sessions: {
                list: async () => [],
                read: async () => [],
                search: async () => [],
                prompts: async () => [],
                exists: async () => true,
            },
        }),
    );
    const bridge = { "x-intentic-bridge": "ibt_valid" };
    expect((await app.request("/sessions", { headers: bridge })).status).toBe(200);
    // In scope, bad token → 401; out of scope, even a VALID token → an explicit 403 (clear DX, not a
    // baffling missing-bearer 401).
    expect((await app.request("/sessions", { headers: { "x-intentic-bridge": "ibt_wrong" } })).status).toBe(401);
    expect((await app.request("/capabilities", { headers: bridge })).status).toBe(403);
    expect((await app.request("/history/restore", { method: "POST", headers: bridge })).status).toBe(403);
    expect((await app.request("/panels", { headers: bridge })).status).toBe(403);
});

test("bridge-token mint/list/revoke are owner-gated plain routes; mint returns the raw token once", async () => {
    const minted: string[] = [];
    const app = createApp(
        services({
            auth: { authorize: async () => ({ email: "o@x.com" }), authorizeOwner: async () => {} },
            bridgeTokens: {
                mint: async (label) => {
                    minted.push(label);
                    return { id: "bt-9", token: "ibt_raw-once" };
                },
                verify: async () => false,
                list: async () => [{ id: "bt-9", label: "zed", createdAt: 1 }],
                revoke: async (id) => id === "bt-9",
            },
        }),
    );
    const mint = await app.request("/system/bridge/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "zed" }),
    });
    expect(mint.status).toBe(200);
    expect(await mint.json()).toEqual({ id: "bt-9", token: "ibt_raw-once" });
    expect(minted).toEqual(["zed"]);
    expect(await (await app.request("/system/bridge/tokens")).json()).toEqual({ tokens: [{ id: "bt-9", label: "zed", createdAt: 1 }] });
    expect((await app.request("/system/bridge/tokens/bt-9", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/system/bridge/tokens/nope", { method: "DELETE" })).status).toBe(404);
    // Not the owner → the gate closes the whole surface.
    const denied = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    expect((await denied.request("/system/bridge/tokens", { method: "POST" })).status).toBe(401);
});

test("sessions.list returns the full list, and routes to search when a query is given", async () => {
    const all = [{ id: "a", title: "Deploy pipeline", updatedAt: 2 }];
    const matches = [{ id: "b", title: "Auth bug", updatedAt: 1 }];
    const client = clientFor(
        createApp(
            services({
                sessions: {
                    list: async () => all,
                    read: async () => [],
                    search: async (_root, query) => (query === "auth" ? matches : []),
                    prompts: async () => [],
                    exists: async () => true,
                },
            }),
        ),
    );
    expect(await client.sessions.list({})).toEqual({ sessions: all });
    expect(await client.sessions.list({ query: "auth" })).toEqual({ sessions: matches });
    // Whitespace-only query is treated as no query — the unfiltered list, not a search.
    expect(await client.sessions.list({ query: "   " })).toEqual({ sessions: all });
});

// Every restore reads from the workspace root — which reaches an isolated conversation's transcript too, since
// its turns ran in a linked worktree of this repo and the SDK's store spans a repo's worktrees.
test("sessions.get restores a transcript, and a session the store cannot read is NOT_FOUND", async () => {
    const read = vi.fn(async (dir: string, id: string) => {
        if (id !== "s1") {
            throw new Error("no such session");
        }
        return [
            { role: "assistant" as const, text: dir, tools: [{ id: "t1", name: "Read", category: "read" as const, status: "completed" as const }] },
        ];
    });
    const client = clientFor(
        createApp(
            services({
                sessions: {
                    list: async () => [],
                    read,
                    search: async () => [],
                    prompts: async () => [],
                    exists: async () => true,
                },
            }),
        ),
    );

    // The tool cards ride along, which is what lets a reopened tab show the run and not just the prose.
    expect(await client.sessions.get({ id: "s1" })).toEqual({
        messages: [{ role: "assistant", text: "/work", tools: [{ id: "t1", name: "Read", category: "read", status: "completed" }] }],
    });
    await expect(client.sessions.get({ id: "gone" })).rejects.toThrow();
});

test("system.info reports the sandbox image tag and exact bundled version", async () => {
    const client = clientFor(
        createApp(services({ info: { name: "intentic-sandbox", image: "registry.gitlab.com/radarsu/intentic/sandbox:stable", version: "1.52.0" } })),
    );
    expect(await client.system.info()).toEqual({
        name: "intentic-sandbox",
        image: "registry.gitlab.com/radarsu/intentic/sandbox:stable",
        version: "1.52.0",
    });
});

test("system.hostTunnel returns the platform's tunnel and translates its failure statuses", async () => {
    const ok = clientFor(
        createApp(services({ platformHostTunnel: async () => ({ status: 200, json: { hostname: "ssh-xyz.example.com", tunnelToken: "ct" } }) })),
    );
    expect(await ok.system.hostTunnel({ hostName: "prod" })).toEqual({ hostname: "ssh-xyz.example.com", tunnelToken: "ct" });

    const disabled = clientFor(
        createApp(services({ platformHostTunnel: async () => ({ status: 404, json: { error: "intentic-provided tunnels are not enabled" } }) })),
    );
    expect(await errorCode(disabled.system.hostTunnel({ hostName: "prod" }))).toBe("NOT_FOUND");
    const badToken = clientFor(createApp(services({ platformHostTunnel: async () => ({ status: 400, json: { error: "bad token" } }) })));
    expect(await errorCode(badToken.system.hostTunnel({ hostName: "prod" }))).toBe("BAD_REQUEST");
    const upstream = clientFor(createApp(services({ platformHostTunnel: async () => ({ status: 502, json: undefined }) })));
    expect(await errorCode(upstream.system.hostTunnel({ hostName: "prod" }))).toBe("BAD_GATEWAY");
});

test("POST /enroll rejects a wrong connect token and 412s until DevOps (when auth is enforced)", async () => {
    const app = createApp(
        services({
            auth: { authorize: async () => ({ email: "a@x.com" }), authorizeOwner: async () => {} },
            config: { ...baseConfig, connectToken: "ct" },
        }),
    );
    const enroll = (token: string) =>
        app.request("/enroll", {
            method: "POST",
            headers: { "content-type": "application/json", "x-intentic-connect": token },
            body: JSON.stringify({ name: "prod", user: "deploy", address: "ssh-x.zone", sshKey: "KEY" }),
        });
    expect((await enroll("wrong")).status).toBe(401);
    // Right token, but the desired-state repo is absent under test → 412 (DevOps not active).
    expect((await enroll("ct")).status).toBe(412);
});

test("bearer middleware maps a ForbiddenError to 403 (wrong account) and any other auth failure to 401", async () => {
    // A verified-but-unauthorized identity → 403 with the daemon's message verbatim (the browser renders its
    // "no access" gate off the status, and surfaces the message).
    const forbiddenApp = createApp(services({ auth: { authorize: rejectForbidden, authorizeOwner: rejectForbidden } }));
    const forbidden = await forbiddenApp.request("/environment");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "not the sandbox owner" });

    // A missing/invalid token → 401, indistinguishable from an unreachable daemon on purpose.
    const unauthApp = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    const unauth = await unauthApp.request("/environment");
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ error: "unauthorized" });
});

test("presence: an /events connection joins the roster and a /system/presence report fans back out", async () => {
    // Fake auth resolving a full identity — exercises the whole seam: middleware → context → handler →
    // registry → stream.
    const app = createApp(
        services({
            auth: { authorize: async () => ({ email: "a@x.com", name: "Ada", picture: "https://p/a.png" }), authorizeOwner: rejectForbidden },
        }),
    );
    const client = clientFor(app);
    const controller = new AbortController();
    const stream = await client.system.events({ clientId: "seam-1" }, { signal: controller.signal });
    // Manual iterator: a for-await break would close the stream between the two phases.
    const iterator = stream[Symbol.asyncIterator]();
    const nextPresence = async () => {
        for (;;) {
            const { value, done } = await iterator.next();
            if (done === true) {
                throw new Error("stream ended before a presence frame");
            }
            if (value.kind === "presence") {
                return value.users;
            }
        }
    };
    // The subscribe-time snapshot: this connection's own entry, identity from the verified token.
    expect(await nextPresence()).toEqual([{ clientId: "seam-1", email: "a@x.com", name: "Ada", picture: "https://p/a.png", idle: false }]);
    await client.system.presence({ clientId: "seam-1", idle: true, view: "workspace", path: "src/app.ts" });
    expect(await nextPresence()).toEqual([
        { clientId: "seam-1", email: "a@x.com", name: "Ada", picture: "https://p/a.png", idle: true, view: "workspace", path: "src/app.ts" },
    ]);
    controller.abort();
});

test("events: the first frame is the workspace-identity hello, stable across connections", async () => {
    // An in-memory files seam so the id minted by the first connection persists to the second (the default
    // fake forgets writes) — the browser relies on this stability to tell a surviving workspace from a wiped one.
    const disk = new Map<string, string>();
    const app = createApp(
        services({
            files: fakeFiles({
                read: async (path) => disk.get(path),
                write: async (path, content) => {
                    disk.set(path, content);
                },
            }),
        }),
    );
    const client = clientFor(app);
    const firstFrame = async () => {
        const controller = new AbortController();
        const stream = await client.system.events({}, { signal: controller.signal });
        const { value, done } = await stream[Symbol.asyncIterator]().next();
        controller.abort();
        if (done === true || value.kind !== "hello") {
            throw new Error(`expected a hello frame first, got ${done === true ? "stream end" : value.kind}`);
        }
        return value.workspaceId;
    };
    const minted = await firstFrame();
    expect(minted).not.toBe("");
    expect(await firstFrame()).toBe(minted);
});

test("events: the hello names the daemon's build and where its boot is, then streams every step", async () => {
    const boot = createBootTracker(createLogger(baseConfig));
    boot.declare([{ key: "registry", label: "Loading conversations" }]);
    const client = clientFor(createApp(services({ boot })));
    const controller = new AbortController();
    const frames = (await client.system.events({}, { signal: controller.signal }))[Symbol.asyncIterator]();

    // /events answers BEFORE the gate on purpose: this frame is the only thing telling a browser that a daemon
    // it can reach is not a daemon it can read yet.
    const hello = (await frames.next()).value;
    expect(hello).toMatchObject({
        kind: "hello",
        // A build identity the browser compares against what it last cached from this sandbox.
        build: expect.stringContaining(":"),
        boot: { ready: false, steps: [{ key: "registry", state: "pending" }] },
    });

    // …and each transition re-frames it, so a browser connected mid-boot follows along rather than guessing.
    // The presence + fleet subscriptions push their own immediate snapshots onto this stream, so pull past
    // whatever the connect produced rather than assuming an order the contract never promised.
    const nextBoot = async () => {
        for (;;) {
            const { value, done } = await frames.next();
            if (done === true) {
                throw new Error("the stream ended before a boot frame arrived");
            }
            if (value.kind === "boot") {
                return value;
            }
        }
    };
    const step = boot.step("registry", async () => undefined);
    expect(await nextBoot()).toMatchObject({ ready: false, steps: [{ key: "registry", state: "running" }] });
    await step;
    expect(await nextBoot()).toMatchObject({ ready: false, steps: [{ key: "registry", state: "done" }] });
    boot.finish();
    expect(await nextBoot()).toMatchObject({ ready: true });
    controller.abort();
});

test("POST /system/authorized-key authorizes via the pairing token alone (no bearer)", async () => {
    const app = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    // Empty body: a valid pairing must get past auth and fail on key validation (400), never on auth (401) —
    // the regression was the global bearer middleware 401ing before the route's own pairing check ran.
    const post = (headers: Record<string, string> = {}) =>
        app.request("/system/authorized-key", {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({}),
        });
    expect((await post({ "x-intentic-pair": mintPairing("sync").token })).status).toBe(400);
    expect((await post()).status).toBe(401);
    expect((await post({ "x-intentic-pair": "bogus" })).status).toBe(401);
});

test("POST /system/authorized-key is single-holder: a rival machine needs takeover (423), which replaces the key", async () => {
    // Enrollment writes the store under historyRoot and derives ~/.ssh/authorized_keys from it — point both at
    // temp dirs so neither lands on the real /history nor in the real home.
    process.env.HOME = mkdtempSync(join(tmpdir(), "sync-enroll-home-"));
    // connectToken + publicUrl make syncSshHostname resolve, so enrollment gets past the tunnel-configured check.
    const app = createApp(
        services({
            config: {
                ...baseConfig,
                connectToken: "token",
                historyRoot: mkdtempSync(join(tmpdir(), "sync-history-")),
                sandbox: { ...baseConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" },
            },
        }),
    );
    // A fresh single-use SYNC pairing per call (the owner's file-sync path); the key's comment is the machine label.
    const enroll = (key: string, extra: Record<string, string> = {}) =>
        app.request("/system/authorized-key", {
            method: "POST",
            headers: { "content-type": "application/json", "x-intentic-pair": mintPairing("sync").token, ...extra },
            body: JSON.stringify({ key }),
        });
    const KEY_A = "ssh-ed25519 AAAAA machine-a";
    const KEY_B = "ssh-ed25519 BBBBB machine-b";

    expect((await enroll(KEY_A)).status).toBe(200);
    // The same machine re-enrolling (its cached key) is idempotent — no takeover needed.
    expect((await enroll(KEY_A)).status).toBe(200);
    // A different machine is refused and told who currently holds sync.
    const blocked = await enroll(KEY_B);
    expect(blocked.status).toBe(423);
    expect(await blocked.json()).toEqual({ error: "sync already active", machine: "machine-a" });
    // An explicit takeover replaces the key; the status route now reports the new holder.
    expect((await enroll(KEY_B, { "x-intentic-sync-takeover": "1" })).status).toBe(200);
    expect(await (await app.request("/system/sync")).json()).toMatchObject({ enrolled: true, syncingFrom: "machine-b" });
});

test("POST /system/authorized-key: a MIRROR pairing lets many machines enroll — no single-holder lock", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sync-mirror-multi-"));
    const app = createApp(
        services({
            config: {
                ...baseConfig,
                connectToken: "token",
                historyRoot: mkdtempSync(join(tmpdir(), "sync-history-")),
                sandbox: { ...baseConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" },
            },
        }),
    );
    const enrollMirror = (key: string) =>
        app.request("/system/authorized-key", {
            method: "POST",
            headers: { "content-type": "application/json", "x-intentic-pair": mintPairing("mirror").token },
            body: JSON.stringify({ key }),
        });
    // Three collaborators mirror the same sandbox concurrently — every enroll succeeds, none locks.
    expect((await enrollMirror("ssh-ed25519 AAA laptop-a")).status).toBe(200);
    expect((await enrollMirror("ssh-ed25519 BBB laptop-b")).status).toBe(200);
    const c = await enrollMirror("ssh-ed25519 CCC laptop-c");
    expect(c.status).toBe(200);
    expect(await c.json()).toMatchObject({ ok: true, mode: "mirror" });
    // /system/sync shows all three mirroring and no file-sync holder.
    const sync = await (await app.request("/system/sync")).json();
    expect(sync).toMatchObject({ enrolled: true, mirroredBy: ["laptop-a", "laptop-b", "laptop-c"] });
    expect(sync).not.toHaveProperty("syncingFrom");
});

test("POST /system/sync/pair: the owner may mint a sync pairing, a member is capped to mirror", async () => {
    // Owner (loopback = owner): default sync, or mirror on request.
    const owner = createApp(services());
    expect(await (await owner.request("/system/sync/pair", { method: "POST" })).json()).toMatchObject({ mode: "sync" });
    expect(await (await owner.request("/system/sync/pair?mode=mirror", { method: "POST" })).json()).toMatchObject({ mode: "mirror" });
    // Member (authorized but not owner): forced to mirror even when asking for sync.
    const member = createApp(services({ auth: { authorize: async () => ({ email: "m@x.com" }), authorizeOwner: rejectForbidden } }));
    const asMember = (query = "") => member.request(`/system/sync/pair${query}`, { method: "POST", headers: { authorization: "Bearer m" } });
    expect(await (await asMember()).json()).toMatchObject({ mode: "mirror" });
    expect(await (await asMember("?mode=sync")).json()).toMatchObject({ mode: "mirror" });
});

test("DELETE /system/authorized-key: a sync token self-revokes just its own enrollment", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sync-revoke-"));
    const app = createApp(
        services({
            config: {
                ...baseConfig,
                connectToken: "token",
                historyRoot: mkdtempSync(join(tmpdir(), "sync-history-")),
                sandbox: { ...baseConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" },
            },
        }),
    );
    const enroll = (key: string) =>
        app.request("/system/authorized-key", {
            method: "POST",
            headers: { "content-type": "application/json", "x-intentic-pair": mintPairing("mirror").token },
            body: JSON.stringify({ key }),
        });
    const tokenA = ((await (await enroll("ssh-ed25519 AAA laptop-a")).json()) as { syncToken: string }).syncToken;
    await enroll("ssh-ed25519 BBB laptop-b");
    // Self-revoke with A's token removes only A; B keeps mirroring.
    expect((await app.request("/system/authorized-key", { method: "DELETE", headers: { "x-intentic-sync": tokenA } })).status).toBe(200);
    expect(await (await app.request("/system/sync")).json()).toMatchObject({ mirroredBy: ["laptop-b"] });
    // A stale token that matches nothing is a 404.
    expect((await app.request("/system/authorized-key", { method: "DELETE", headers: { "x-intentic-sync": tokenA } })).status).toBe(404);
});

test("the enrollment-minted sync token reads /ports and nothing else", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sync-token-home-"));
    // Bearer auth rejects everything, so a 200 proves the sync-token branch authorized the read.
    const app = createApp(
        services({
            auth: { authorize: rejectAuth, authorizeOwner: rejectAuth },
            config: {
                ...baseConfig,
                connectToken: "token",
                historyRoot: mkdtempSync(join(tmpdir(), "sync-history-")),
                sandbox: { ...baseConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" },
            },
            scanPorts: async () => [{ port: 3000, host: "127.0.0.1", forwardable: true }],
        }),
    );
    const enrolled = await app.request("/system/authorized-key", {
        method: "POST",
        headers: { "content-type": "application/json", "x-intentic-pair": mintPairing("mirror").token },
        body: JSON.stringify({ key: "ssh-ed25519 AAAAA laptop" }),
    });
    expect(enrolled.status).toBe(200);
    const { syncToken } = (await enrolled.json()) as { syncToken: string };
    expect(syncToken).toMatch(/^ist_/);

    const withToken = (path: string, method = "GET") => app.request(path, { method, headers: { "x-intentic-sync": syncToken } });
    const list = await withToken("/ports");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ ports: [{ port: 3000, host: "127.0.0.1", forwardable: true, kind: "system", forwarded: false }] });
    // Out of scope (403): any other route, and even the ports MUTATIONS — the token is read-only by design.
    expect((await withToken("/panels")).status).toBe(403);
    expect((await withToken("/ports/forward", "POST")).status).toBe(403);
    // A bogus token on the in-scope route is plain unauthorized.
    expect((await app.request("/ports", { headers: { "x-intentic-sync": "ist_bogus" } })).status).toBe(401);
});

test("POST /automations/:id/fire skips bearer auth, enforces the automation token, and records a run", async () => {
    const store = memoryAutomationsStore([
        { id: "deploy", trigger: { kind: "event", token: "tok-1" }, prompt: "handle the event", enabled: true, runs: [] },
        { id: "paused", trigger: { kind: "event", token: "tok-2" }, prompt: "x", enabled: false, runs: [] },
        { id: "cron", trigger: { kind: "schedule", cron: "* * * * *" }, prompt: "x", enabled: true, runs: [] },
    ]);
    // Bearer auth rejects everything, so a 200 proves the route's exemption; the token is the only gate.
    const app = createApp(services({ automations: store, auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    const fire = (path: string) => app.request(path, { method: "POST", body: "payload" });

    expect((await fire("/automations/ghost/fire?token=tok-1")).status).toBe(404);
    // Schedule automations can't be fired externally.
    expect((await fire("/automations/cron/fire?token=anything")).status).toBe(404);
    expect((await fire("/automations/deploy/fire?token=wrong")).status).toBe(401);
    expect((await fire("/automations/deploy/fire")).status).toBe(401);
    expect((await fire("/automations/paused/fire?token=tok-2")).status).toBe(409);

    const ok = await fire("/automations/deploy/fire?token=tok-1");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    // The turn runs detached (the fake agent completes instantly) and lands in the run history.
    await vi.waitFor(async () => expect((await store.get("deploy"))?.runs).toHaveLength(1), TURN_SETTLES);
    expect((await store.get("deploy"))?.runs[0]?.outcome).toBe("completed");
});

test("automations.run fires by hand on the real path — a disabled automation too, and past the approval gate", async () => {
    const store = memoryAutomationsStore([
        { id: "cron", trigger: { kind: "schedule", cron: "0 3 * * *" }, prompt: "sweep the logs", enabled: true, runs: [] },
        // Trying a prompt BEFORE switching the automation on is the main reason to press Run now, so — unlike the
        // webhook, which fails closed at 409 against an outside sender — an off automation still fires by hand.
        { id: "paused", trigger: { kind: "schedule", cron: "0 3 * * *" }, prompt: "x", enabled: false, runs: [] },
        // requireApproval would hold a scheduled fire in the owner's queue. Their own click is the approval.
        { id: "gated", trigger: { kind: "schedule", cron: "0 3 * * *" }, prompt: "x", requireApproval: true, enabled: true, runs: [] },
    ]);
    const client = clientFor(createApp(services({ automations: store })));

    await expect(client.automations.run({ id: "ghost" })).rejects.toThrow();

    // The turn runs detached — the ack does not wait on it, because the guard alone may take a minute.
    expect(await client.automations.run({ id: "cron" })).toEqual({ ok: true });
    await vi.waitFor(async () => expect((await store.get("cron"))?.runs).toHaveLength(1), TURN_SETTLES);
    expect((await store.get("cron"))?.runs[0]?.outcome).toBe("completed");

    expect(await client.automations.run({ id: "paused" })).toEqual({ ok: true });
    await vi.waitFor(async () => expect((await store.get("paused"))?.runs).toHaveLength(1), TURN_SETTLES);

    expect(await client.automations.run({ id: "gated" })).toEqual({ ok: true });
    await vi.waitFor(async () => expect((await store.get("gated"))?.runs).toHaveLength(1), TURN_SETTLES);
    expect((await store.get("gated"))?.runs[0]?.outcome).toBe("completed");
});

test("POST /webchat/:id/message skips bearer auth, gates on the origin allowlist, reflects CORS, and records a run", async () => {
    const store = memoryAutomationsStore([
        {
            id: "support",
            trigger: { kind: "listener", provider: "webchat", allowedOrigins: ["https://site.example"] },
            prompt: "help the visitor",
            enabled: true,
            runs: [],
        },
    ]);
    // Bearer auth rejects everything, so reaching the route at all (not a 401) proves the exemption; the origin
    // allowlist is the real gate. allowOrigin defaults to "*" here, so CORS reflection is what scopes the widget.
    const app = createApp(
        services({ automations: store, auth: { authorize: rejectAuth, authorizeOwner: rejectAuth, allowOrigin: "https://app.intentic" } }),
    );
    const send = (origin: string | undefined, body: unknown = { conversationId: "c1", content: "fix the header" }) =>
        app.request("/webchat/support/message", {
            method: "POST",
            headers: { "content-type": "application/json", ...(origin !== undefined ? { origin } : {}) },
            body: JSON.stringify(body),
        });

    // A disallowed / missing origin is refused by the route's own 403 — NOT the bearer middleware's 401.
    expect((await send("https://evil.example")).status).toBe(403);
    expect((await send(undefined)).status).toBe(403);

    // An allowed origin streams back (text/event-stream) with CORS reflecting exactly that origin (not the daemon's
    // own app origin), and the wake runs to a recorded run through the real streamAgent + fake agent.
    const ok = await send("https://site.example");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/event-stream");
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://site.example");
    await ok.text();
    await vi.waitFor(async () => expect((await store.get("support"))?.runs).toHaveLength(1), TURN_SETTLES);
    expect((await store.get("support"))?.runs[0]?.outcome).toBe("completed");

    // The preflight is answered with the reflected origin too, so the browser lets the cross-site POST through.
    const preflight = await app.request("/webchat/support/message", { method: "OPTIONS", headers: { origin: "https://site.example" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://site.example");
});

test("agent.run streams the agent events, fenced by a user snapshot before and a turn snapshot after", async () => {
    const events: AgentEvent[] = [{ kind: "session", sessionId: "s1" }, { kind: "delta", text: "hi" }, { kind: "done" }];
    const triggers: string[] = [];
    const client = clientFor(
        createApp(
            services({
                history: fakeHistory({
                    snapshot: async (trigger) => {
                        triggers.push(trigger);
                        return undefined;
                    },
                }),
                agent: async function* () {
                    yield* events;
                },
            }),
        ),
    );
    expect(await runAgentTurn(client, { prompt: "do it" })).toEqual(events);
    // Attribution: pending user changes are captured BEFORE the agent runs, so the turn snapshot is agent-only.
    expect(triggers).toEqual(["user", "turn"]);
});

test("user file mutations ping history for a user-authored snapshot", async () => {
    let pings = 0;
    const app = createApp(services({ history: fakeHistory({ notifyUserWrite: () => pings++ }) }));
    const client = clientFor(app);
    await client.workspace.mkdir({ path: "notes" });
    expect(pings).toBe(1);
    const uploaded = await app.request("/workspace/upload?path=notes/todo.txt", { method: "POST", body: "hi" });
    expect(uploaded.status).toBe(200);
    expect(pings).toBe(2);
});

test("agent.run resolves the oauth token from the sandbox store (not the body) and forwards model/session", async () => {
    let seen: { oauthToken?: string; model?: string; sessionId?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                claudeStore: {
                    read: async (id) => (id === "default" ? { id: "default", label: "Claude", connectedAt: 0, accessToken: "tok-xyz" } : undefined),
                    write: async () => {},
                    clear: async () => {},
                    list: async () => [{ id: "default", label: "Claude", connectedAt: 0 }],
                },
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "do it", sessionId: "s1", model: "opus" });
    expect(seen?.oauthToken).toBe("tok-xyz");
    expect(seen?.model).toBe("opus");
    expect(seen?.sessionId).toBe("s1");
});

test("agent.run selects the Claude account named on the turn and forwards its token", async () => {
    let seen: { oauthToken?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                claudeStore: {
                    read: async (id) => ({ id, label: id, connectedAt: 0, accessToken: `tok-${id}` }),
                    write: async () => {},
                    clear: async () => {},
                    list: async () => [
                        { id: "a", label: "work", connectedAt: 1 },
                        { id: "b", label: "personal", connectedAt: 2 },
                    ],
                },
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "hi", account: "b" });
    expect(seen?.oauthToken).toBe("tok-b");
});

const withTranslator = { ...baseConfig, translator: { url: "http://127.0.0.1:8788", token: "local-bearer" } };
const codexConnectedProxy = {
    accounts: async () => ({ codex: [{ name: "codex-user.json", label: "user@example.com" }], grok: [], kimi: [], gemini: [] }),
    connect: async () => ({ url: "", code: "", state: "", flow: "device" as const }),
    complete: async () => {},
    disconnect: async () => {},
    models: async () => [],
};

test("agent.run serves a Codex turn on the translator subscription over the local bearer, no per-turn home", async () => {
    let seen: { codexEndpoint?: { baseUrl: string; authToken: string }; codexHome?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                cliProxy: codexConnectedProxy,
                codexAgent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const events = await runAgentTurn(client, { prompt: "hi", agent: "codex" });
    expect(events.some((event) => event.kind === "error")).toBe(false);
    // Served over the translator's OpenAI endpoint on the fixed local bearer; the adapter's default home serves.
    expect(seen?.codexEndpoint).toEqual({ baseUrl: "http://127.0.0.1:8788", authToken: "local-bearer" });
    expect(seen?.codexHome).toBeUndefined();
});

test("agent.run gates a Codex turn with no subscription and no api key as subscription-required", async () => {
    let codexCalled = false;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                codexAgent: async function* () {
                    codexCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const events = await runAgentTurn(client, { prompt: "hi", agent: "codex" });
    expect(codexCalled).toBe(false);
    expect(events.some((event) => event.kind === "error" && event.code === "subscription-required")).toBe(true);
});

// Gemini is routed-only: Google publishes no Anthropic-protocol endpoint and no Gemini runtime is baked, so a
// Gemini turn is ALWAYS the Claude Code harness pointed at the translator — with no harness on the turn at all.
test("agent.run serves a Gemini turn on the translator subscription, withholding the Claude OAuth token", async () => {
    let seen: { baseUrl?: string; authToken?: string; model?: string; oauthToken?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                cliProxy: {
                    accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [{ name: "antigravity-user.json", label: "user@gmail.com" }] }),
                    connect: async () => ({ url: "", code: "", state: "", flow: "redirect" as const }),
                    complete: async () => {},
                    disconnect: async () => {},
                    models: async () => [],
                },
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const events = await runAgentTurn(client, { prompt: "hi", agent: "gemini" });
    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(seen?.baseUrl).toBe("http://127.0.0.1:8788");
    expect(seen?.authToken).toBe("local-bearer");
    // No model on the turn ⇒ the live Gemini catalog's own default, never an empty id.
    expect(seen?.model).toBe("gemini-pro-agent");
    // Setting the endpoint is what structurally withholds the user's Anthropic subscription token.
    expect(seen?.oauthToken).toBeUndefined();
});

test("agent.run serves Kimi K3 on the Kimi Code subscription through the translator", async () => {
    let seen: { baseUrl?: string; authToken?: string; model?: string; oauthToken?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                cliProxy: {
                    accounts: async () => ({ codex: [], grok: [], kimi: [{ name: "kimi-user.json", label: "Kimi User" }], gemini: [] }),
                    connect: async () => ({ url: "", code: "", state: "", flow: "device" as const }),
                    complete: async () => {},
                    disconnect: async () => {},
                    models: async () => [{ id: "kimi-k3", label: "Kimi K3" }],
                },
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const events = await runAgentTurn(client, { prompt: "hi", agent: "kimi" });

    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(seen?.baseUrl).toBe("http://127.0.0.1:8788");
    expect(seen?.authToken).toBe("local-bearer");
    expect(seen?.model).toBe("kimi-k3");
    expect(seen?.oauthToken).toBeUndefined();
});

test("agent.run keeps a pinned Gemini model the catalog still offers, and drops one it doesn't", async () => {
    const models = ["gemini-pro-agent", "gemini-3-flash"];
    const geminiConnected = {
        accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [{ name: "antigravity-user.json", label: "user@gmail.com" }] }),
        connect: async () => ({ url: "", code: "", state: "", flow: "redirect" as const }),
        complete: async () => {},
        disconnect: async () => {},
        models: async () => [],
    };
    const run = async (model: string): Promise<string | undefined> => {
        let seen: { model?: string } | undefined;
        const client = clientFor(
            createApp(
                services({
                    config: withTranslator,
                    cliProxy: geminiConnected,
                    geminiModels: { models: async () => ({ models: models.map((id) => ({ id, label: id })), default: models[0]! }) },
                    agent: async function* (request) {
                        seen = request;
                        yield { kind: "done" };
                    },
                }),
            ),
        );
        await runAgentTurn(client, { prompt: "hi", agent: "gemini", model });
        return seen?.model;
    };
    expect(await run("gemini-3-flash")).toBe("gemini-3-flash");
    // A retired pick fails catalog membership and falls to the live default rather than 400ing upstream.
    expect(await run("gemini-2.5-pro")).toBe("gemini-pro-agent");
});

test("agent.run gates a Gemini turn with no Google account connected as subscription-required", async () => {
    let agentCalled = false;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                agent: async function* () {
                    agentCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const events = await runAgentTurn(client, { prompt: "hi", agent: "gemini" });
    expect(agentCalled).toBe(false);
    expect(events.some((event) => event.kind === "error" && event.code === "subscription-required")).toBe(true);
});

test("agent.run pre-flights a Codex resume whose thread no longer exists as session-not-found", async () => {
    let codexCalled = false;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                cliProxy: codexConnectedProxy,
                codexThreadExists: async () => false,
                codexAgent: async function* () {
                    codexCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const events = await runAgentTurn(client, { prompt: "hi", agent: "codex", sessionId: "gone" });
    expect(codexCalled).toBe(false);
    expect(events.some((event) => event.kind === "error" && event.code === "session-not-found")).toBe(true);
});

test("agent.run sends a Grok turn an explicit live-valid model, replacing an invalid or absent pinned id", async () => {
    const seen: (string | undefined)[] = [];
    const grokApp = () =>
        clientFor(
            createApp(
                services({
                    openCode: {
                        client: async () => ({}) as never,
                        connected: async () => true,
                        sessionExists: async () => true,
                        xaiModels: async () => ({
                            models: [{ id: "grok-4.20-0309-reasoning", label: "grok-4.20-0309-reasoning" }],
                            default: "grok-4.20-0309-reasoning",
                        }),
                        recordModels: async () => {},
                        disconnect: async () => {},
                    },
                    grokAgent: async function* (request) {
                        seen.push(request.model);
                        yield { kind: "done" };
                    },
                }),
            ),
        );
    await runAgentTurn(grokApp(), { prompt: "hi", agent: "grok", model: "grok-code-fast-1" }); // retired ⇒ live default
    await runAgentTurn(grokApp(), { prompt: "hi", agent: "grok", model: "grok-4.20-0309-reasoning" }); // still served ⇒ kept
    await runAgentTurn(grokApp(), { prompt: "hi", agent: "grok" }); // none ⇒ live default
    expect(seen).toEqual(["grok-4.20-0309-reasoning", "grok-4.20-0309-reasoning", "grok-4.20-0309-reasoning"]);
});

// (The old "empty catalog ⇒ pre-flight grok-model-invalid bounce" test is gone: the daemon's catalog is now
// never empty — live discovery with a persisted/seed floor — so the route always resolves a model and the turn
// runs. A stale/renamed id self-heals mid-turn in the runner instead; see grok-agent.test.ts.)

test("agent.run merges internal (env) tools with the mcp-kind capabilities for the turn", async () => {
    let seen: { tools?: readonly AgentTool[] } | undefined;
    const client = clientFor(
        createApp(
            services({
                tools: [{ name: "obs", url: "https://signoz.example.com/mcp", token: "internal" }],
                capabilities: memoryCapabilitiesStore([
                    { id: "linear", kind: "mcp", config: { url: "https://mcp.linear.app/sse", token: "external" } },
                ]),
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "do it" });
    // Internal first, then external mcp capabilities (last-wins on name collisions).
    expect(seen?.tools).toEqual([
        { name: "obs", url: "https://signoz.example.com/mcp", token: "internal" },
        { name: "linear", url: "https://mcp.linear.app/sse", token: "external" },
    ]);
});

test("capabilities.list reports each capability with its status; devops can't be removed, unknown is NOT_FOUND", async () => {
    const client = clientFor(createApp(services({ capabilities: memoryCapabilitiesStore([{ id: "devops", kind: "devops", config: {} }]) })));
    // devops status is derived from the repos on disk — absent under test, so it reads inactive.
    expect(await client.capabilities.list()).toEqual({
        capabilities: [{ id: "devops", kind: "devops", status: { state: "inactive" }, config: {} }],
    });
    // DevOps has no teardown (deleting the repos is data loss) → CONFLICT; an unknown id is NOT_FOUND.
    expect(await errorCode(client.capabilities.remove({ id: "devops" }))).toBe("CONFLICT");
    expect(await errorCode(client.capabilities.remove({ id: "ghost" }))).toBe("NOT_FOUND");
});

test("secrets.set / list / remove / reveal refuse until DevOps is active (the desired-state repo is absent under test)", async () => {
    const client = clientFor(createApp(services()));
    expect(await errorCode(client.secrets.set({ key: "CLOUDFLARE_API_TOKEN", value: "x" }))).toBe("PRECONDITION_FAILED");
    expect(await errorCode(client.secrets.list())).toBe("PRECONDITION_FAILED");
    expect(await errorCode(client.secrets.remove({ key: "CLOUDFLARE_API_TOKEN" }))).toBe("PRECONDITION_FAILED");
    expect(await errorCode(client.secrets.reveal({ key: "CLOUDFLARE_API_TOKEN" }))).toBe("PRECONDITION_FAILED");
});

// A scaffolded desired-state checkout on disk: an artifact requiring HOST_SSH_KEY, an .env holding it plus an
// undeclared EXTRA_TOKEN, and a generated admin password in .secrets.json.
const secretsWorkspace = (): ReturnType<typeof workspacePaths> => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-secrets-"));
    const workspace = workspacePaths(root);
    mkdirSync(workspace.repos["desired-state"], { recursive: true });
    const artifact = {
        version: 1,
        resources: {
            host: { id: "host", type: "host", inputs: { sshKey: { $secret: { source: "env", key: "HOST_SSH_KEY" } } }, dependsOn: [] },
            forgejo: {
                id: "forgejo",
                type: "forgejo",
                inputs: { adminPassword: { $secret: { source: "generated", key: "FORGEJO_ADMIN_PASSWORD" } } },
                dependsOn: [],
            },
        },
    };
    writeFileSync(join(workspace.repos["desired-state"], "desired-state.json"), JSON.stringify(artifact));
    writeFileSync(join(workspace.repos["desired-state"], ".env"), 'HOST_SSH_KEY="pem"\nEXTRA_TOKEN="abc"\n');
    writeFileSync(join(workspace.repos["desired-state"], ".secrets.json"), JSON.stringify({ FORGEJO_ADMIN_PASSWORD: "pw1" }));
    return workspace;
};

test("secrets.inventory merges artifact requirements, .env keys, credentialed capabilities, and provider accounts", async () => {
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "gh-token" } };
    const client = clientFor(createApp(services({ workspace: secretsWorkspace(), capabilities: memoryCapabilitiesStore([github]) })));
    const { entries } = await client.secrets.inventory();
    expect(entries).toEqual([
        {
            key: "FORGEJO_ADMIN_PASSWORD",
            kind: "generated",
            status: "set",
            requiredBy: [{ resourceId: "forgejo", type: "forgejo" }],
            storedAt: "desired-state/.secrets.json",
            revealable: true,
        },
        {
            key: "HOST_SSH_KEY",
            kind: "env",
            status: "set",
            requiredBy: [{ resourceId: "host", type: "host" }],
            storedAt: "desired-state/.env",
            revealable: true,
        },
        { key: "EXTRA_TOKEN", kind: "env", status: "set", requiredBy: [], storedAt: "desired-state/.env", revealable: true },
        { key: "github", kind: "capability", status: "connected", requiredBy: [], storedAt: ".intentic/capabilities.json", revealable: true },
        {
            key: "claude:default",
            kind: "provider",
            label: "Claude · Claude",
            status: "connected",
            requiredBy: [],
            storedAt: ".intentic/claude/default.json",
            revealable: false,
        },
    ]);
});

test("secrets.inventory answers pre-scaffold with capability/provider entries only", async () => {
    const client = clientFor(createApp(services()));
    const { entries } = await client.secrets.inventory();
    // One entry per connected account: the default fake has a single Claude account, no Codex, no Grok.
    expect(entries.map((entry) => entry.key)).toEqual(["claude:default"]);
});

test("secrets.reveal returns env and generated values, 404s unknown keys, and is owner-gated", async () => {
    const workspace = secretsWorkspace();
    const client = clientFor(createApp(services({ workspace })));
    expect(await client.secrets.reveal({ key: "HOST_SSH_KEY" })).toEqual({ value: "pem" });
    expect(await client.secrets.reveal({ key: "FORGEJO_ADMIN_PASSWORD" })).toEqual({ value: "pw1" });
    expect(await errorCode(client.secrets.reveal({ key: "GHOST" }))).toBe("NOT_FOUND");

    // A verified member who is not the owner is refused the value (the rest of the secrets surface stays open).
    const memberClient = clientFor(
        createApp(services({ workspace, auth: { authorize: async () => ({ email: "m@example.com" }), authorizeOwner: rejectForbidden } })),
    );
    expect(await errorCode(memberClient.secrets.reveal({ key: "HOST_SSH_KEY" }))).toBe("FORBIDDEN");
});

test("capabilities.setSecret replaces just the secret, and reveal returns it — even pre-scaffold", async () => {
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "gh-1" } };
    const reddit: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit" } };
    const client = clientFor(createApp(services({ capabilities: memoryCapabilitiesStore([github, reddit]) })));
    await client.capabilities.setSecret({ id: "github", value: "gh-2" });
    // No desired-state repo under test — capability reveal works before DevOps scaffolds it.
    expect(await client.secrets.reveal({ key: "github" })).toEqual({ value: "gh-2" });
    // A secretless capability is CONFLICT; an unknown id is NOT_FOUND.
    expect(await errorCode(client.capabilities.setSecret({ id: "reddit", value: "x" }))).toBe("CONFLICT");
    expect(await errorCode(client.capabilities.setSecret({ id: "ghost", value: "x" }))).toBe("NOT_FOUND");
});

test("secrets.set / remove rewrite .env and fire a best-effort `secrets push` for the CI copy", async () => {
    const pushes: string[][] = [];
    const client = clientFor(
        createApp(
            services({
                workspace: secretsWorkspace(),
                intentic: async function* (run) {
                    pushes.push([...run.args]);
                    yield { kind: `log`, message: `pushed` };
                },
            }),
        ),
    );
    await client.secrets.set({ key: "MyMixed_Key", value: "v1" });
    expect((await client.secrets.list()).keys.toSorted()).toEqual(["EXTRA_TOKEN", "HOST_SSH_KEY", "MyMixed_Key"]);
    await client.secrets.remove({ key: "EXTRA_TOKEN" });
    expect((await client.secrets.list()).keys.toSorted()).toEqual(["HOST_SSH_KEY", "MyMixed_Key"]);
    await vi.waitFor(() =>
        expect(pushes).toEqual([
            ["deploy", "secrets", "push"],
            ["deploy", "secrets", "push"],
        ]),
    );
});

test("agent.run surfaces a connect-your-account error (not an opaque CLI failure) when no account and no env creds", async () => {
    let agentCalled = false;
    const client = clientFor(
        createApp(
            services({
                claudeStore: { read: async () => undefined, write: async () => {}, clear: async () => {}, list: async () => [] },
                agent: async function* () {
                    agentCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const events = await runAgentTurn(client, { prompt: "do it" });
    // The turn never reaches the agent — the user gets an actionable message instead of exit-code-1.
    expect(agentCalled).toBe(false);
    expect(events.some((event) => event.kind === "error" && event.message.includes("No Claude account connected"))).toBe(true);
});

test("agent.run pre-flights a dead resume target with a coded error instead of spawning the CLI to fail", async () => {
    let agentCalled = false;
    const client = clientFor(
        createApp(
            services({
                sessions: {
                    list: async () => [],
                    read: async () => [],
                    search: async () => [],
                    prompts: async () => [],
                    exists: async () => false,
                },
                agent: async function* () {
                    agentCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const events = await runAgentTurn(client, { prompt: "do it", sessionId: "gone" });
    expect(agentCalled).toBe(false);
    // The `code` field must survive the oRPC eventIterator round-trip — the UI keys its self-heal on it.
    expect(events.some((event) => event.kind === "error" && event.code === "session-not-found")).toBe(true);
});

test("Claude OAuth: accounts reflect the store, disconnect clears the named one", async () => {
    const accounts = new Map<string, { id: string; label: string; connectedAt: number; accessToken: string; scope?: string }>();
    const client = clientFor(
        createApp(
            services({
                claudeStore: {
                    read: async (id) => accounts.get(id),
                    write: async (account) => {
                        accounts.set(account.id, account);
                    },
                    clear: async (id) => {
                        accounts.delete(id);
                    },
                    list: async () =>
                        [...accounts.values()].map((account) =>
                            account.scope !== undefined
                                ? { id: account.id, label: account.label, connectedAt: account.connectedAt, scope: account.scope }
                                : { id: account.id, label: account.label, connectedAt: account.connectedAt },
                        ),
                },
            }),
        ),
    );
    expect(await client.claude.accounts()).toEqual({ accounts: [] });
    // The start route hands the browser an authorize URL + PKCE material.
    const challenge = await client.claude.start();
    expect(typeof challenge.authorizeUrl).toBe("string");
    expect(typeof challenge.verifier).toBe("string");

    // Directly store two accounts (exchange itself hits Anthropic; the store wiring is what we assert here).
    accounts.set("a", { id: "a", label: "work", connectedAt: 1, accessToken: "tok", scope: "user:inference" });
    accounts.set("b", { id: "b", label: "personal", connectedAt: 2, accessToken: "tok2" });
    expect(await client.claude.accounts()).toEqual({
        accounts: [
            { id: "a", label: "work", connectedAt: 1, scope: "user:inference" },
            { id: "b", label: "personal", connectedAt: 2 },
        ],
    });
    expect(await client.claude.disconnect({ id: "a" })).toEqual({ ok: true });
    expect(accounts.has("a")).toBe(false);
    expect(accounts.has("b")).toBe(true);
});

// The account list is the one place a user can tell two connections of the same provider apart, so it has to be
// able to name them: an identity the provider never reported (or one the user calls something else) leaves
// renaming as the only answer.
test("Claude OAuth: rename writes the label through, and 404s on an account that is gone", async () => {
    const accounts = new Map<string, { id: string; label: string; connectedAt: number; accessToken: string; email?: string }>([
        ["a", { id: "a", label: "Claude", connectedAt: 1, accessToken: "tok", email: "a@example.com" }],
    ]);
    const client = clientFor(
        createApp(
            services({
                claudeStore: {
                    read: async (id) => accounts.get(id),
                    write: async (account) => {
                        accounts.set(account.id, account);
                    },
                    clear: async (id) => {
                        accounts.delete(id);
                    },
                    list: async () => [...accounts.values()].map(({ accessToken: _token, ...account }) => account),
                },
            }),
        ),
    );
    expect(await client.claude.rename({ id: "a", label: " Work " })).toEqual({
        id: "a",
        label: "Work",
        connectedAt: 1,
        email: "a@example.com",
    });
    // The credential is untouched — a rename writes the display name and nothing else.
    expect(accounts.get("a")?.accessToken).toBe("tok");
    // Blank means "back to the derived name", not a nameless row.
    expect((await client.claude.rename({ id: "a", label: "" })).label).toBe("a@example.com");
    expect(await errorCode(client.claude.rename({ id: "gone", label: "Work" }))).toBe("NOT_FOUND");
});

test("agent.run rejects an empty prompt", async () => {
    const client = clientFor(createApp(services()));
    expect(await errorCode(client.agent.run({ prompt: "" }))).toBe("BAD_REQUEST");
});

test("agent.run folds a switched conversation's history into the prompt as a role-attributed preamble", async () => {
    let seen: { prompt?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await runAgentTurn(client, {
        prompt: "and now?",
        history: [
            { role: "user", text: "what is 2+2?" },
            { role: "assistant", text: "4" },
        ],
    });
    expect(seen?.prompt).toContain("continues from another AI runtime");
    expect(seen?.prompt).toContain("User: what is 2+2?");
    expect(seen?.prompt).toContain("Assistant: 4");
    // The user's actual message closes the prompt, after the preamble.
    expect(seen?.prompt?.endsWith("and now?")).toBe(true);
});

test("agent.run rejects a turn carrying both history and a sessionId — a resumed session has its context", async () => {
    const client = clientFor(createApp(services()));
    expect(await errorCode(client.agent.run({ prompt: "hi", sessionId: "s1", history: [{ role: "user", text: "x" }] }))).toBe("BAD_REQUEST");
});

test("agent.run folds attachments into the claude prompt as absolute paths, allowing an attachment-only turn", async () => {
    let seen: { prompt?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "", attachments: [".intentic/attachments/x/shot.png"] });
    expect(seen?.prompt).toContain("/work/.intentic/attachments/x/shot.png");
});

test("agent.run rejects an attachment path escaping the workspace with an error frame", async () => {
    const client = clientFor(createApp(services()));
    const events = await runAgentTurn(client, { prompt: "look", attachments: ["../escape.png"] });
    expect(events).toEqual([{ kind: "error", message: "invalid attachment path: ../escape.png" }, { kind: "done" }]);
});

test("an isolated turn runs in the conversation worktree, leads with the worktree frame, skips the main-tree snapshots, and registers the agent", async () => {
    let seen: { cwd?: string } | undefined;
    let snapshots = 0;
    const client = clientFor(
        createApp(
            services({
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "session", sessionId: "sess-iso" };
                    yield { kind: "usage", costUsd: 0.5, inputTokens: 10, outputTokens: 5 };
                    yield { kind: "done" };
                },
                history: fakeHistory({
                    snapshot: async () => {
                        snapshots++;
                        return undefined;
                    },
                }),
            }),
        ),
    );
    const events = await runAgentTurn(client, { prompt: "fix it", conversationId: "conv1", isolated: true });
    // The worktree identity frame precedes every provider frame; the stub composition's root base is aaaa….
    // `unenforced` because this sandbox cannot build the namespace: the turn still works in its worktree, but
    // the guarantee comes from the path redirect rather than from mounts, and the operator is told so.
    expect(events[0]).toEqual({ kind: "worktree", branch: "agent/conv1", base: "aaaaaaa", unenforced: true });
    // The single binding point: the turn's cwd is the worktree, not /work.
    expect(seen?.cwd).toBe("/history/worktrees/conv1");
    // Both main-tree history snapshots (attribution fence + turn end) are skipped.
    expect(snapshots).toBe(0);
    // The fleet registry recorded the conversation: idle after finish, usage flushed, session captured.
    const { agents } = await client.agents.list();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: "conv1", status: "idle", branch: "agent/conv1", costUsd: 0.5, sessionId: "sess-iso" });
});

test("a workspace turn follows the same registry lifecycle without inventing a branch", async () => {
    let cwd: string | undefined;
    const snapshots: string[] = [];
    const spend: { conversationId?: string }[] = [];
    const client = clientFor(
        createApp(
            services({
                agent: async function* (request) {
                    cwd = request.cwd;
                    yield { kind: "session", sessionId: "sess-workspace" };
                    yield { kind: "usage", costUsd: 0.25, inputTokens: 8, outputTokens: 3 };
                    yield { kind: "done" };
                },
                history: fakeHistory({
                    snapshot: async (trigger) => {
                        snapshots.push(trigger);
                        return undefined;
                    },
                }),
                usage: { record: async (entry) => void spend.push(entry), rollup: async () => [] },
            }),
        ),
    );

    const events = await runAgentTurn(client, { prompt: "fix tests in intentic", conversationId: "workspace-conv" });
    expect(events.some((event) => event.kind === "worktree")).toBe(false);
    expect(cwd).toBe("/work");
    expect(snapshots).toEqual(["user", "turn"]);
    expect((await client.agents.list()).agents).toMatchObject([{ id: "workspace-conv", status: "idle", sessionId: "sess-workspace", costUsd: 0.25 }]);
    expect((await client.agents.list()).agents[0]).not.toHaveProperty("branch");
    await vi.waitFor(() => expect(spend).toMatchObject([{ conversationId: "workspace-conv" }]));
    // Registry actions remain unified; branch actions are placement-specific and fail explicitly.
    expect(await errorCode(client.agents.diff({ id: "workspace-conv" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.agents.autoLand({ id: "workspace-conv", autoLand: false }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.agents.land({ id: "workspace-conv" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.agents.discard({ id: "workspace-conv" }))).toBe("BAD_REQUEST");
});

test("a thrown workspace turn settles its surfaced card as an error", async () => {
    const client = clientFor(
        createApp(
            services({
                // The adapter dies on the first pull, before any frame — a provider outage, a missing binary.
                agent: async function* () {
                    yield await Promise.reject(new Error("adapter crashed"));
                },
            }),
        ),
    );

    expect(await runAgentTurn(client, { prompt: "do it", conversationId: "workspace-error" })).toEqual([
        { kind: "error", message: "adapter crashed" },
        { kind: "done" },
    ]);
    expect((await client.agents.list()).agents[0]).toMatchObject({ id: "workspace-error", status: "error" });
    expect((await client.agents.list()).agents[0]).not.toHaveProperty("branch");
});

test("an existing conversation keeps its registered placement when a later client sends stale isolation", async () => {
    const cwds: string[] = [];
    const client = clientFor(
        createApp(
            services({
                agent: async function* (request) {
                    cwds.push(request.cwd);
                    yield { kind: "done" };
                },
            }),
        ),
    );

    await runAgentTurn(client, { prompt: "first", conversationId: "placed" });
    const second = await runAgentTurn(client, { prompt: "second", conversationId: "placed", isolated: true });
    expect(second.some((event) => event.kind === "worktree")).toBe(false);
    expect(cwds).toEqual(["/work", "/work"]);
    expect((await client.agents.list()).agents[0]).not.toHaveProperty("branch");
});

test("a second concurrent turn for the same conversation is refused with CONFLICT until the run settles", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = clientFor(
        createApp(
            services({
                agent: async function* () {
                    await gate;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const { run: first } = await client.agent.run({ prompt: "long task", conversationId: "conv1", isolated: true });
    // The run is live (parked on the gate) — a second start bounces at the door, before any registry work.
    expect(await errorCode(client.agent.run({ prompt: "again", conversationId: "conv1", isolated: true }))).toBe("CONFLICT");
    release?.();
    // Attaching to its end is the settle barrier: the run finished and the registry mutex released.
    const frames = await collect(await client.agent.attach({ conversationId: "conv1" }));
    expect(frames[0]).toMatchObject({ kind: "attached", run: first });
    // The next turn starts — and runs the full isolated path again.
    const events = await runAgentTurn(client, { prompt: "after", conversationId: "conv1", isolated: true });
    expect(events[0]).toMatchObject({ kind: "worktree" });
});

test("a chat turn without a conversationId is refused — the run registry has nothing to key it on", async () => {
    const client = clientFor(createApp(services()));
    expect(await errorCode(client.agent.run({ prompt: "hi" }))).toBe("BAD_REQUEST");
});

/* STOPPING A TURN IS NOT A FAILURE — end to end, because the failure was assembled from three files agreeing
 * with each other. Every provider adapter reports the unwind of a hard-cancel as an error frame (from inside
 * one, an abort is indistinguishable from the provider dying), the registry reads any error frame as how the
 * turn ended, and the card draws that as `error` in the Attention lane. So the user pressed Stop and watched
 * their own deliberate press come back accusing them of a crash — after a wait, since the roster went on
 * saying `running` for the whole unwind. The fake agent below is that adapter behaviour, exactly. */
test("a stopped turn settles as stopped, with no error frame reaching the client, the log, or the card", async () => {
    let started: (() => void) | undefined;
    let abort: (() => void) | undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const aborted = new Promise<void>((resolve) => (abort = resolve));
    const client = clientFor(
        createApp(
            services({
                agent: async function* (request) {
                    request.signal.addEventListener("abort", () => abort?.(), { once: true });
                    started?.();
                    await aborted;
                    yield { kind: "error", message: "Claude Code process exited with code 143" };
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await client.agent.run({ prompt: "long task", conversationId: "conv1", isolated: true });
    // The run is DETACHED — the route acks the id and the pump walks the generator chain after it. The
    // adapter's first line is the barrier that says the chain got as far as registering the turn's abort
    // handle; stopping before that finds nothing to cancel, and the turn would sit here forever.
    await running;
    // Resolves only once the run has unwound, which is the same barrier the browser's Stop waits on.
    expect(await client.agent.stop({ conversationId: "conv1" })).toEqual({ ok: true });

    const { agents } = await client.agents.list();
    expect(agents[0]).toMatchObject({ id: "conv1", status: "stopped" });
    // And nothing in the transcript a window replaying this run would draw as a failure.
    const frames = await collect(await client.agent.attach({ conversationId: "conv1" }));
    const events = frames.flatMap((frame) => (frame.kind === "frame" ? [frame.event] : []));
    expect(events.filter((event) => event.kind === "error")).toEqual([]);

    // A stop with nothing running is still NOT_FOUND: the client retires its own control on that answer.
    expect(await errorCode(client.agent.stop({ conversationId: "conv1" }))).toBe("NOT_FOUND");
});

test("an isolated turn that dies on a provider gate still releases the conversation mutex", async () => {
    // No Claude account and no env fallback → the gate yields an error before the adapter ever runs.
    const client = clientFor(
        createApp(
            services({
                claudeStore: { read: async () => undefined, write: async () => {}, clear: async () => {}, list: async () => [] },
            }),
        ),
    );
    const first = await runAgentTurn(client, { prompt: "hi", conversationId: "conv1", isolated: true });
    expect(first.some((event) => event.kind === "error" && event.message.includes("No Claude account"))).toBe(true);
    // The gate exit must not leave the agent stuck "running" — the retry hits the same gate, NOT agent-busy.
    const second = await runAgentTurn(client, { prompt: "hi", conversationId: "conv1", isolated: true });
    expect(second.some((event) => event.kind === "error" && event.code === "agent-busy")).toBe(false);
    const { agents } = await client.agents.list();
    expect(agents[0]?.status).not.toBe("running");
});

test("isolated requires conversationId at the contract gate", async () => {
    const client = clientFor(createApp(services()));
    expect(await errorCode(client.agent.run({ prompt: "hi", isolated: true }))).toBe("BAD_REQUEST");
});

test("a turn's title seeds a fresh entry and agents.rename overwrites it", async () => {
    const client = clientFor(
        createApp(
            services({
                agent: async function* () {
                    yield { kind: "done" };
                },
            }),
        ),
    );
    // A renamed draft's first turn carries the user-chosen title — it wins over the prompt derivation.
    await runAgentTurn(client, { prompt: "fix the login bug", title: "My agent", conversationId: "conv1", isolated: true });
    expect((await client.agents.list()).agents[0]?.title).toBe("My agent");
    const renamed = await client.agents.rename({ id: "conv1", title: "  Login fix  " });
    expect(renamed.title).toBe("Login fix");
    expect((await client.agents.list()).agents[0]?.title).toBe("Login fix");
    expect(await errorCode(client.agents.rename({ id: "nope", title: "x" }))).toBe("NOT_FOUND");
});

/* The fleet filter. Matches the title (which IS the sanitized first prompt) or any later prompt the user
 * wrote, and — the part the board depends on and no session-level search can give it — it answers over the
 * ARCHIVE too. A board whose filter stopped at the live roster would report "no matches" for an agent sitting
 * one click away behind the archive button. */
test("agents.search matches titles and later prompts, across the archive, and never the agent's own words", async () => {
    // Prompts keyed by session id, standing in for the transcripts the daemon would read.
    const prompts: Record<string, string[]> = {
        "sess-1": ["fix the login bug", "actually make it use landAgent instead"],
        "sess-2": ["tidy the readme"],
    };
    // Every store read the fleet makes, with the dir it scoped to — an isolated turn's session is filed under
    // the workspace ROOT (its namespace makes the worktree /work), so a read scoped to the worktree path finds
    // nothing and the card redraws as a conversation that never happened.
    const scopedTo: string[] = [];
    const app = createApp(
        services({
            // One SDK session per conversation, told apart by the prompt each turn carries.
            agent: async function* (request) {
                yield { kind: "session", sessionId: request.prompt.includes("login") ? "sess-1" : "sess-2" };
                yield { kind: "done" };
            },
            sessions: {
                list: async () => [],
                read: async (dir, id) => {
                    scopedTo.push(dir);
                    return id === "sess-1" ? [{ role: "user" as const, text: "restored words" }] : [];
                },
                search: async () => [],
                prompts: async (dir, id) => {
                    scopedTo.push(dir);
                    return prompts[id] ?? [];
                },
                exists: async () => true,
            },
        }),
    );
    const client = clientFor(app);
    await runAgentTurn(client, { prompt: "fix the login bug", conversationId: "conv1", isolated: true });
    await runAgentTurn(client, { prompt: "tidy the readme", conversationId: "conv2", isolated: true });

    // The session the REGISTRY recorded from the turn's own frame, never re-derived from where the turn ran.
    expect(await client.agents.transcript({ id: "conv1" })).toEqual({
        sessionId: "sess-1",
        messages: [{ role: "user", text: "restored words" }],
    });
    expect(scopedTo).toEqual(["/work"]);
    // An id the registry has never heard of is a 404 ON THE WIRE, not merely a rejected call: the browser reads
    // that exact status as "this conversation has no entry any more" and stops a tab claiming a fleet card
    // nothing on the board can render (see useChat's replayStoredSession). Anything else — a 500, an
    // unreachable daemon — must stay a retryable read, so the status is the contract, not the message.
    await expect(client.agents.transcript({ id: "nope" })).rejects.toThrow();
    expect((await app.request("/agents/nope/transcript")).status).toBe(404);

    // Under two characters the contract refuses: below that everything matches and the scan is pure cost.
    expect(await errorCode(client.agents.search({ query: "a" }))).toBe("BAD_REQUEST");

    // A title hit needs no transcript, so it reports no snippet — the card already shows what it matched on.
    expect(await client.agents.search({ query: "login" })).toEqual({ matches: [{ id: "conv1" }], scanned: 2 });
    // …and a hit in a LATER prompt reports the line, which is the whole reason a filtered card is believable.
    expect(await client.agents.search({ query: "readme" })).toMatchObject({ matches: [{ id: "conv2" }] });

    // Archiving takes conv1 off the roster; the filter must still find it.
    await client.agents.archive({ ids: ["conv1"] });
    expect((await client.agents.list()).agents.map((agent) => agent.id)).toEqual(["conv2"]);
    expect(await client.agents.search({ query: "login" })).toEqual({ matches: [{ id: "conv1" }], scanned: 2 });

    expect(await client.agents.search({ query: "nothing here" })).toEqual({ matches: [], scanned: 2 });
});

test("agents.search reads the daemon transcript for a provider with no SDK prompt store", async () => {
    const app = createApp(
        services({
            config: withTranslator,
            cliProxy: codexConnectedProxy,
            codexAgent: async function* () {
                yield { kind: "done" };
            },
            // Native Codex has no Claude SDK session to search. The daemon transcript is the provider-neutral
            // source, and includes a later prompt that is deliberately absent from the card title.
            transcripts: {
                read: async (agent) =>
                    agent.id === "codex-search"
                        ? [
                              { role: "user" as const, text: "open the codex task" },
                              { role: "assistant" as const, text: "I mentioned forbidden-assistant-needle" },
                              { role: "user" as const, text: "find durable-transcript-needle" },
                          ]
                        : [],
                open: async () => {},
                append: async () => {},
            },
            sessions: {
                list: async () => [],
                read: async () => [],
                search: async () => [],
                prompts: async () => {
                    throw new Error("provider store must not be consulted");
                },
                exists: async () => true,
            },
        }),
    );
    const client = clientFor(app);
    await runAgentTurn(client, { prompt: "open the codex task", title: "Codex task", agent: "codex", conversationId: "codex-search" });

    expect(await client.agents.search({ query: "durable-transcript-needle" })).toMatchObject({
        matches: [{ id: "codex-search", snippet: "find durable-transcript-needle" }],
    });
    expect(await client.agents.search({ query: "forbidden-assistant-needle" })).toMatchObject({ matches: [] });
});

test("git.status resolves the repo dir, and rejects an unknown repo", async () => {
    const workspace = tempWorkspace([{ name: "app" }]);
    const seen: string[] = [];
    const client = clientFor(
        createApp(
            services({
                workspace,
                git: {
                    init: async () => {},
                    status: async (dir) => {
                        seen.push(dir);
                        return { branch: "main", dirty: false, files: [] };
                    },
                    listFiles: async () => [],
                    commitAll: async () => false,
                    clone: async () => {},
                },
            }),
        ),
    );
    expect(await client.git.status({ repo: "app" })).toEqual({ branch: "main", dirty: false, files: [] });
    expect(seen).toEqual([join(workspace.root, "app")]);
    expect(await errorCode(client.git.status({ repo: "nope" }))).toBe("NOT_FOUND");
});

test("git.files lists the repo's tracked files", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    const client = clientFor(
        createApp(
            services({
                workspace,
                git: {
                    init: async () => {},
                    status: async () => ({ branch: "main", dirty: false, files: [] }),
                    listFiles: async (dir) => (dir === join(workspace.root, "intent") ? ["deploy.config.ts", "package.json"] : []),
                    commitAll: async () => false,
                    clone: async () => {},
                },
            }),
        ),
    );
    expect(await client.git.files({ repo: "intent" })).toEqual({ files: ["deploy.config.ts", "package.json"] });
});

test("git.readFile reads a contained file, NOT_FOUNDs a missing one, and BAD_REQUESTs a path escape", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    const client = clientFor(
        createApp(
            services({
                workspace,
                files: fakeFiles({
                    read: async (absPath) =>
                        absPath === join(workspace.root, "intent", "deploy.config.ts") ? "export const intent = 1;" : undefined,
                }),
            }),
        ),
    );
    expect(await client.git.readFile({ repo: "intent", path: "deploy.config.ts" })).toEqual({
        path: "deploy.config.ts",
        content: "export const intent = 1;",
    });
    expect(await errorCode(client.git.readFile({ repo: "intent", path: "nope.ts" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.git.readFile({ repo: "intent", path: "../../etc/passwd" }))).toBe("BAD_REQUEST");
});

test("git.writeFile writes a contained file and rejects a path escape", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    const writes: { path: string; content: string | Uint8Array }[] = [];
    const client = clientFor(
        createApp(
            services({
                workspace,
                files: fakeFiles({
                    write: async (absPath, content) => {
                        writes.push({ path: absPath, content });
                    },
                }),
            }),
        ),
    );
    expect(await client.git.writeFile({ repo: "intent", path: "deploy.config.ts", content: "next" })).toEqual({ ok: true });
    expect(writes).toEqual([{ path: join(workspace.root, "intent", "deploy.config.ts"), content: "next" }]);
    expect(await errorCode(client.git.writeFile({ repo: "intent", path: "../escape", content: "x" }))).toBe("BAD_REQUEST");
    expect(writes).toHaveLength(1);
});

test("git.changes aggregates dirty repos across root + roles + clones, skipping clean ones and reporting broken ones", async () => {
    const workspace = tempWorkspace([{ name: "intent" }, { name: "shop" }]);
    const client = clientFor(
        createApp(
            services({
                workspace,
                git: {
                    ...services().git,
                    changedFiles: async (dir) => {
                        if (dir === workspace.root) {
                            return { branch: "main", conflicted: [], staged: [], unstaged: [{ path: "notes.md", status: "added" as const }] };
                        }
                        if (dir === join(workspace.root, "shop")) {
                            throw new Error("broken repo");
                        }
                        return { conflicted: [], staged: [], unstaged: [] };
                    },
                },
            }),
        ),
    );
    // A clean repo drops out; a broken one stays in the response carrying git's reason, so a repo left torn by a
    // canceled upload is something the panel can show rather than a repo that silently vanished.
    expect(await client.git.changes()).toEqual({
        repos: [
            {
                repo: "root",
                branch: "main",
                conflicted: [],
                staged: [],
                unstaged: [{ path: "notes.md", status: "added" }],
                remote: { ahead: 0, behind: 0 },
            },
            { repo: "shop", conflicted: [], staged: [], unstaged: [], error: "broken repo" },
        ],
    });
});

// The graph's own routes, over the scope that has no directory of its own: "root" IS the /work repo, so every
// verb the graph offers has to resolve it to the workspace root rather than to a dir named "root" — which is
// exactly what the explorer's root git-history icon and the Changes header both open.
test("the git-history graph resolves the 'root' scope to /work — reads, and a HEAD-mover that checkpoints first", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    const calls: string[] = [];
    const snapshots: string[] = [];
    const client = clientFor(
        createApp(
            services({
                workspace,
                history: fakeHistory({
                    snapshot: async (trigger, label) => {
                        snapshots.push(`${trigger} ${label}`);
                        return undefined;
                    },
                }),
                git: {
                    ...services().git,
                    commitLog: async (dir, limit) => {
                        calls.push(`log ${dir} ${limit}`);
                        return { branch: "main", commits: [] };
                    },
                    commitChanges: async (dir, sha) => {
                        calls.push(`commit-diff ${dir} ${sha}`);
                        return [];
                    },
                    checkoutRef: async (dir, ref) => {
                        calls.push(`checkout ${dir} ${ref}`);
                    },
                },
            }),
        ),
    );
    expect(await client.git.log({ repo: "root" })).toEqual({ repo: "root", branch: "main", commits: [] });
    expect(await client.git.commitDiff({ repo: "root", sha: "abcdef1" })).toEqual({ files: [] });
    expect(await client.git.checkout({ repo: "root", ref: "abcdef1" })).toEqual({ ok: true });
    expect(await client.git.log({ repo: "intent" })).toEqual({ repo: "intent", branch: "main", commits: [] });
    expect(calls).toEqual([
        `log ${workspace.root} 300`,
        `commit-diff ${workspace.root} abcdef1`,
        `checkout ${workspace.root} abcdef1`,
        `log ${join(workspace.root, "intent")} 300`,
    ]);
    // A HEAD-mover checkpoints BEFORE it runs for root too, so a checkout off the workspace repo stays
    // reversible from the Checkpoints timeline.
    expect(snapshots).toEqual(["user before checkout abcdef1"]);
    expect(await errorCode(client.git.log({ repo: "nope" }))).toBe("NOT_FOUND");
});

test("git.commit records the index by default and stages everything first for `all`", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    const calls: string[] = [];
    const client = clientFor(
        createApp(
            services({
                workspace,
                git: {
                    ...services().git,
                    commitAll: async (dir, message) => {
                        calls.push(`all ${dir} ${message}`);
                        return true;
                    },
                    commitIndex: async (dir, message) => {
                        calls.push(`index ${dir} ${message}`);
                        return true;
                    },
                },
            }),
        ),
    );
    // A bare message commits exactly the index — the only thing the panel ever asks for, because staging IS
    // how the user chose. There is no path-scoped shape to route to any more.
    expect(await client.git.commit({ repo: "root", message: "m1" })).toEqual({ committed: true });
    expect(await client.git.commit({ repo: "intent", message: "m2", all: true })).toEqual({ committed: true });
    expect(calls).toEqual([`index ${workspace.root} m1`, `all ${join(workspace.root, "intent")} m2`]);
});

// The reason the browser no longer refuses to commit while an agent runs: the ONE thing that was genuinely
// unsafe about it — a commit interleaving with the `git apply` an agent's land performs on the same tree — is
// prevented here instead, on the same per-repo chain `land` already takes. A UI gate could only guess at this
// race; the terminal commits straight past one anyway.
test("git writes serialize per repo, so a commit cannot interleave with an agent's land", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    // The real chain from worktrees.ts rather than the pass-through the other tests use, so this exercises the
    // actual serialization.
    const chains = new Map<string, Promise<unknown>>();
    const withRepoLock = <T>(repo: string, task: () => Promise<T>): Promise<T> => {
        const chain = chains.get(repo) ?? Promise.resolve();
        const next = chain.then(task, task);
        chains.set(
            repo,
            next.catch(() => undefined),
        );
        return next;
    };
    const order: string[] = [];
    const client = clientFor(
        createApp(
            services({
                workspace,
                agentWorktrees: { ...services().agentWorktrees, withRepoLock },
                git: {
                    ...services().git,
                    commitIndex: async (_dir, message) => {
                        order.push(`enter ${message}`);
                        await new Promise((resolve) => setTimeout(resolve, 10));
                        order.push(`exit ${message}`);
                        return true;
                    },
                },
            }),
        ),
    );
    await Promise.all([client.git.commit({ repo: "root", message: "a" }), client.git.commit({ repo: "root", message: "b" })]);
    // One repo, one at a time — whichever won the race ran to completion before the other started.
    expect(order).toEqual([`enter a`, `exit a`, `enter b`, `exit b`]);

    order.length = 0;
    await Promise.all([client.git.commit({ repo: "root", message: "r" }), client.git.commit({ repo: "intent", message: "i" })]);
    // Different repos still overlap. Per-repo is the whole point: a lock that spanned the workspace would be
    // the daemon reinventing the workspace-wide block this design removed.
    expect(order).toEqual([`enter r`, `enter i`, `exit r`, `exit i`]);
});

test("git.discard forwards paths and records the worktree change as a user write", async () => {
    const discards: (readonly string[] | undefined)[] = [];
    let notified = 0;
    const client = clientFor(
        createApp(
            services({
                history: fakeHistory({ notifyUserWrite: () => void notified++ }),
                git: {
                    ...services().git,
                    discardPaths: async (_dir, paths) => {
                        discards.push(paths);
                    },
                },
            }),
        ),
    );
    expect(await client.git.discard({ repo: "root", paths: ["junk.txt"] })).toEqual({ ok: true });
    expect(await client.git.discard({ repo: "root" })).toEqual({ ok: true });
    expect(discards).toEqual([["junk.txt"], undefined]);
    expect(notified).toBe(2);
});

test("git.fileDiff routes each side to its own diff and BAD_REQUESTs a path escape", async () => {
    const client = clientFor(
        createApp(
            services({
                git: {
                    ...services().git,
                    // Two distinct comparisons, not one HEAD↔worktree diff dressed up twice: for a partially
                    // staged file the row the user clicked is the only thing that says which one they meant.
                    stagedFileDiff: async (_dir, path) => (path === "notes.md" ? { before: "one\n", after: "two\n" } : {}),
                    unstagedFileDiff: async (_dir, path) => (path === "notes.md" ? { before: "two\n", after: "three\n" } : {}),
                },
            }),
        ),
    );
    expect(await client.git.fileDiff({ repo: "root", path: "notes.md", side: "staged" })).toEqual({ before: "one\n", after: "two\n" });
    expect(await client.git.fileDiff({ repo: "root", path: "notes.md", side: "unstaged" })).toEqual({ before: "two\n", after: "three\n" });
    expect(await errorCode(client.git.fileDiff({ repo: "root", path: "../escape", side: "staged" }))).toBe("BAD_REQUEST");
});

test("workspace.tree returns the full working tree from the walker", async () => {
    const tree = { root: "/work", tree: [{ name: "app", path: "app", type: "dir" as const, children: [] }], hidden: 0 };
    const client = clientFor(createApp(services({ workspaceTree: async () => tree })));
    expect(await client.workspace.tree()).toEqual(tree);
});

test("workspace.file reads any contained file (former-secret paths included), NOT_FOUNDs missing, BAD_REQUESTs escape", async () => {
    const client = clientFor(
        createApp(
            services({
                files: fakeFiles({
                    readWindow: async (absPath) => {
                        const content =
                            absPath === "/work/app/src/index.ts"
                                ? "console.log(1);"
                                : absPath === "/work/desired-state/.env"
                                  ? "SECRET=1"
                                  : undefined;
                        return content === undefined ? undefined : { content, size: content.length, offset: 0, bytes: content.length };
                    },
                }),
            }),
        ),
    );
    expect(await client.workspace.file({ path: "app/src/index.ts" })).toEqual({
        path: "app/src/index.ts",
        content: "console.log(1);",
        size: 15,
        offset: 0,
        bytes: 15,
    });
    // No security floor: a former-secret file reads through like any other contained file.
    expect(await client.workspace.file({ path: "desired-state/.env" })).toEqual({
        path: "desired-state/.env",
        content: "SECRET=1",
        size: 8,
        offset: 0,
        bytes: 8,
    });
    expect(await errorCode(client.workspace.file({ path: "app/nope.ts" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.file({ path: "../../etc/passwd" }))).toBe("BAD_REQUEST");
});

// The window arguments reach the reader as numbers (they arrive as query strings), and the reader's answer —
// including where it actually landed — is what the response carries.
test("workspace.file passes the requested window through and reports the range it served", async () => {
    const asked: { offset?: number; limit?: number }[] = [];
    const client = clientFor(
        createApp(
            services({
                files: fakeFiles({
                    readWindow: async (_absPath, offset, limit) => {
                        asked.push({ offset, limit });
                        return { content: "tail\n", size: 4096, offset: 4091, bytes: 5 };
                    },
                }),
            }),
        ),
    );
    expect(await client.workspace.file({ path: "big.log", offset: -8, limit: 64 })).toEqual({
        path: "big.log",
        content: "tail\n",
        size: 4096,
        offset: 4091,
        bytes: 5,
    });
    expect(asked).toEqual([{ offset: -8, limit: 64 }]);
});

// Search is backed by the resident in-process iq engine. Round-trip against a REAL engine over a real tmp
// workspace (rg on PATH); the min-length rejection is contract validation and never reaches the engine.
test("workspace.search round-trips the WorkspaceSearchResult from the resident engine; rejects a too-short query", async () => {
    const root = await mkdtemp(join(tmpdir(), "iq-daemon-"));
    await writeFile(join(root, "notes.md"), "the needle is here\n");
    const iq = createResidentEngine({ root });
    try {
        const client = clientFor(createApp(services({ workspace: workspacePaths(root), iq })));
        const result = await client.workspace.search({ query: "needle" });
        expect(result.mode).toBe("q");
        expect(result.groups[0]?.path).toBe("notes.md");
        expect(result.truncated).toBe(false);
        const empty = await client.workspace.search({ query: "zzzqqqvvv" });
        expect(empty.total).toBe(0);
        expect(await errorCode(client.workspace.search({ query: "x" }))).toBe("BAD_REQUEST");
    } finally {
        await iq.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("GET /workspace/raw streams bytes with a content-type, 404s missing, 400s escape, 413s oversize", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const env = Buffer.from("SECRET=1");
    const app = createApp(
        services({
            files: fakeFiles({
                readBytes: async (absPath) => (absPath === "/work/app/logo.png" ? png : absPath === "/work/desired-state/.env" ? env : undefined),
                size: async (absPath) =>
                    absPath === "/work/app/logo.png"
                        ? png.byteLength
                        : absPath === "/work/app/huge.png"
                          ? MAX_RAW_BYTES + 1
                          : absPath === "/work/desired-state/.env"
                            ? env.byteLength
                            : undefined,
            }),
        }),
    );
    const ok = await app.request("/workspace/raw?path=app/logo.png");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array(png));
    // No security floor: a former-secret file now streams through like any other contained file.
    expect((await app.request("/workspace/raw?path=desired-state/.env")).status).toBe(200);
    // Oversize is refused on the size check, before the bytes are loaded.
    expect((await app.request("/workspace/raw?path=app/huge.png")).status).toBe(413);
    expect((await app.request("/workspace/raw?path=app/missing.png")).status).toBe(404);
    expect((await app.request("/workspace/raw?path=../../etc/passwd")).status).toBe(400);
});

test("POST /workspace/upload streams any contained path to disk, 400s escape, 413s oversize", async () => {
    const writes: { path: string; content: Uint8Array }[] = [];
    const app = createApp(
        services({
            files: fakeFiles({
                writeStream: async (absPath, body) => {
                    writes.push({ path: absPath, content: new Uint8Array(await new Response(body).arrayBuffer()) });
                },
            }),
        }),
    );
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const ok = await app.request("/workspace/upload?path=app/assets/logo.png", { method: "POST", body });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/work/app/assets/logo.png");
    expect(writes[0]?.content).toEqual(body);

    // No WRITE floor: former-secret paths write through; only a climb-out is refused (400, no write).
    expect((await app.request("/workspace/upload?path=desired-state/.env", { method: "POST", body })).status).toBe(200);
    expect(writes.at(-1)?.path).toBe("/work/desired-state/.env");
    expect((await app.request("/workspace/upload?path=../../etc/passwd", { method: "POST", body })).status).toBe(400);
    expect(writes).toHaveLength(2);

    // `.git` writes through as well (a dropped repo keeps its remote).
    const git = await app.request("/workspace/upload?path=app/.git/config", { method: "POST", body });
    expect(git.status).toBe(200);
    expect(writes).toHaveLength(3);
    expect(writes[2]?.path).toBe("/work/app/.git/config");

    // A body past the cap surfaces as UploadTooLargeError from the streaming write → 413 (the write itself deletes
    // the partial; here the fake just throws). The declared-length short-circuit + real cap are unit-tested in
    // workspace-files.test.ts / workspace-archive.test.ts.
    const capped = createApp(
        services({
            files: fakeFiles({
                writeStream: async () => {
                    throw new UploadTooLargeError();
                },
            }),
        }),
    );
    expect((await capped.request("/workspace/upload?path=app/huge.bin", { method: "POST", body })).status).toBe(413);
});

test("the daemon's control plane is unreachable through the generic file API; its feature subtrees are not", async () => {
    const writes: string[] = [];
    const app = createApp(
        services({
            files: fakeFiles({
                writeStream: async (absPath) => {
                    writes.push(absPath);
                },
                size: async () => 4,
                readBytes: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
            }),
        }),
    );
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    // owner.json/members.json ARE the answer to "who may drive this sandbox" (re-read from disk per request), and
    // the rest hold the agent providers' tokens — so a member could otherwise upload a new owner and take the
    // sandbox, or read the owner's token back out. Answered as if nothing were there, and nothing is written.
    // The root's own .git joins them: it is the --separate-git-dir pointer to the shadow history repo on /history,
    // and a FILE, so a drop of a repo's CONTENTS at the root would aim a directory at it and 500 the whole upload.
    const controlPlane = [
        ".intentic/owner.json",
        ".intentic/members.json",
        ".intentic/capabilities.json",
        ".intentic/claude.json",
        ".intentic/claude/acc.json",
        ".intentic/codex/acc/auth.json",
        ".intentic/kimi/acc.json",
        ".intentic/opencode/auth.json",
        ".intentic/cliproxy/kimi-user.json",
        ".git",
        ".git/config",
        ".git/objects/ab/cdef",
    ];
    for (const path of controlPlane) {
        expect([path, (await app.request(`/workspace/upload?path=${path}`, { method: "POST", body })).status]).toEqual([path, 404]);
        expect([path, (await app.request(`/workspace/raw?path=${path}`)).status]).toEqual([path, 404]);
    }
    expect(writes).toHaveLength(0);

    // The root .intentic's other subtrees are ordinary workspace content driven through this very API — chat
    // attachments and a directory's own UI — and a repo's nested .intentic is not the control plane at all. Nor is
    // a NESTED .git: a dropped repo keeps its own and stays connected to its remote.
    const open = [".intentic/attachments/u1/pic.png", ".intentic/ui/index.html", "app/.intentic/owner.json", "app/.git/config"];
    for (const path of open) {
        expect([path, (await app.request(`/workspace/upload?path=${path}`, { method: "POST", body })).status]).toEqual([path, 200]);
        expect([path, (await app.request(`/workspace/raw?path=${path}`)).status]).toEqual([path, 200]);
    }
    expect(writes).toEqual(open.map((path) => `/work/${path}`));
});

test("POST /workspace/upload with x-intentic-base-hash refuses a stale write and passes a matching one", async () => {
    const writes: string[] = [];
    const app = createApp(
        services({
            files: fakeFiles({
                read: async (absPath) => (absPath === "/work/app/index.ts" ? "hello" : undefined),
                writeStream: async (absPath) => {
                    writes.push(absPath);
                },
            }),
        }),
    );
    // sha256 of "hello", hardcoded to pin the wire algorithm (utf8 text → sha256 hex) the browser must speak.
    const match = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const ok = await app.request("/workspace/upload?path=app/index.ts", {
        method: "POST",
        body: "edited",
        headers: { "x-intentic-base-hash": match },
    });
    expect(ok.status).toBe(200);
    expect(writes).toEqual(["/work/app/index.ts"]);

    // The file changed since the browser read it (hash mismatch) → 409, nothing written — the guarded save must
    // never clobber a concurrent agent/terminal write.
    const stale = await app.request("/workspace/upload?path=app/index.ts", {
        method: "POST",
        body: "edited",
        headers: { "x-intentic-base-hash": sha256Text("agent rewrote this") },
    });
    expect(stale.status).toBe(409);
    // Deleted since it was read reads as the same conflict.
    const gone = await app.request("/workspace/upload?path=app/gone.ts", {
        method: "POST",
        body: "edited",
        headers: { "x-intentic-base-hash": match },
    });
    expect(gone.status).toBe(409);
    expect(writes).toHaveLength(1);

    // No hash = the unguarded path (drag-drop upload, new-file create): overwrites like before.
    expect((await app.request("/workspace/upload?path=app/index.ts", { method: "POST", body: "edited" })).status).toBe(200);
    expect(writes).toHaveLength(2);
});

test("POST /workspace/upload threads ?offset to the streaming write and rejects a bad offset", async () => {
    const writes: { path: string; offset: number | undefined }[] = [];
    const app = createApp(
        services({
            files: fakeFiles({
                writeStream: async (absPath, _body, _limit, offset) => {
                    writes.push({ path: absPath, offset });
                },
            }),
        }),
    );
    const body = new Uint8Array([1, 2, 3]);
    expect((await app.request("/workspace/upload?path=app/big.bin&offset=3", { method: "POST", body })).status).toBe(200);
    expect(writes).toEqual([{ path: "/work/app/big.bin", offset: 3 }]);
    expect((await app.request("/workspace/upload?path=app/big.bin&offset=-1", { method: "POST", body })).status).toBe(400);
    expect((await app.request("/workspace/upload?path=app/big.bin&offset=nope", { method: "POST", body })).status).toBe(400);
    expect(writes).toHaveLength(1);
});

test("workspace.mkdir/delete/move/copy resolve within /work and reject escapes", async () => {
    const calls: [string, ...string[]][] = [];
    const client = clientFor(
        createApp(
            services({
                files: fakeFiles({
                    mkdir: async (p) => {
                        calls.push(["mkdir", p]);
                    },
                    remove: async (p) => {
                        calls.push(["remove", p]);
                    },
                    move: async (a, b) => {
                        calls.push(["move", a, b]);
                    },
                    copy: async (a, b) => {
                        calls.push(["copy", a, b]);
                    },
                }),
            }),
        ),
    );

    expect(await client.workspace.mkdir({ path: "app/new-dir" })).toEqual({ ok: true });
    expect(await client.workspace.delete({ path: "app/old.ts" })).toEqual({ ok: true });
    expect(await client.workspace.move({ from: "app/a.ts", to: "app/b.ts" })).toEqual({ ok: true });
    expect(await client.workspace.copy({ from: "app/a.ts", to: "app/nested/c.ts" })).toEqual({ ok: true });
    expect(calls).toEqual([
        ["mkdir", "/work/app/new-dir"],
        ["remove", "/work/app/old.ts"],
        ["move", "/work/app/a.ts", "/work/app/b.ts"],
        ["copy", "/work/app/a.ts", "/work/app/nested/c.ts"],
    ]);

    // No security floor: former-secret paths now resolve and act like any other contained path.
    expect(await client.workspace.delete({ path: "desired-state/.env" })).toEqual({ ok: true });
    expect(calls.at(-1)).toEqual(["remove", "/work/desired-state/.env"]);

    // Only a climb-out of /work is refused now (BAD_REQUEST), on either endpoint, before the fs is touched.
    expect(await errorCode(client.workspace.mkdir({ path: "../evil" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.workspace.move({ from: "app/a.ts", to: "../escape" }))).toBe("BAD_REQUEST");
    expect(calls).toHaveLength(5);
});

test("workspace.addRepo clones a repo with a protected git dir, rejects reserved names + a bad body", async () => {
    const clones: { parentDir: string; name: string; cloneUrl: string; separateGitDir?: string }[] = [];
    const ensured: string[] = [];
    const client = clientFor(
        createApp(
            services({
                git: {
                    status: async () => ({ branch: "main", dirty: false, files: [] }),
                    listFiles: async () => [],
                    commitAll: async () => false,
                    clone: async (parentDir, name, cloneUrl, options) => {
                        clones.push({
                            parentDir,
                            name,
                            cloneUrl,
                            ...(options?.separateGitDir !== undefined ? { separateGitDir: options.separateGitDir } : {}),
                        });
                    },
                },
                ensurePreviewRoutes: async (labels) => {
                    ensured.push(...labels);
                },
            }),
        ),
    );
    expect(await client.workspace.addRepo({ name: "extra", cloneUrl: "https://example.com/extra.git" })).toEqual({ name: "extra", path: "extra" });
    expect(clones).toEqual([{ parentDir: "/work", name: "extra", cloneUrl: "https://example.com/extra.git", separateGitDir: "/history/gits/extra" }]);
    // The preview route is minted at clone time, not first panel start (DNS negative-caching).
    expect(ensured).toEqual(["preview-extra"]);
    // A reserved role (one of the three fixed repos) cannot be clobbered, and a path-escape name is rejected.
    expect(await errorCode(client.workspace.addRepo({ name: "intent", cloneUrl: "https://example.com/x.git" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.workspace.addRepo({ name: "../evil", cloneUrl: "https://example.com/x.git" }))).toBe("BAD_REQUEST");
    expect(clones).toHaveLength(1);
});

test("workspace.addApps launches `intentic scaffold add-app` as a one-shot tmux job and mints each app's preview route up front", async () => {
    const workspace = tempWorkspace([{ name: "shop" }]);
    const repoDir = join(workspace.root, "shop");
    const jobs: { key: string; spec: ProcessSpec }[] = [];
    const ensured: string[] = [];
    const processes: ManagedProcesses = {
        start: async (key, spec) => {
            jobs.push({ key, spec });
        },
        stop: () => {},
        running: () => false,
        portOf: () => undefined,
        stopAll: () => {},
    };
    const client = clientFor(
        createApp(
            services({
                workspace,
                processes,
                ensurePreviewRoutes: async (labels) => {
                    ensured.push(...labels);
                },
            }),
        ),
    );

    expect(
        await client.workspace.addApps({
            repo: "shop",
            apps: [
                { template: "api", name: "api" },
                { template: "web", name: "shop-web" },
            ],
        }),
    ).toEqual({ ok: true });
    // One detached one-shot job, keyed <repo>--add_apps (underscore ⇒ never collides with an app panel key
    // <repo>--<app>), running the CLI over the same @intentic/scaffold path — each arg single-quoted, and the
    // template-key entry (api) collapses to a bare key while the renamed one (shop-web) keeps template:name.
    expect(jobs).toEqual([
        {
            key: "shop--add_apps",
            spec: {
                command: `intentic scaffold add-app --dir '${repoDir}' --apps 'api,web:shop-web' --source '${DEFAULT_TEMPLATE_SOURCE}' --ref '${DEFAULT_TEMPLATE_REF}'`,
                cwd: repoDir,
                oneShot: true,
            },
        },
    ]);
    // Preview routes are minted before the job runs (hostnames must predate the first browser lookup).
    expect(ensured).toEqual(["preview-shop--api", "preview-shop--shop-web"]);
    // An unknown monorepo is NOT_FOUND (before any job is launched).
    expect(await errorCode(client.workspace.addApps({ repo: "ghost", apps: [{ template: "api", name: "api" }] }))).toBe("NOT_FOUND");
    expect(jobs).toHaveLength(1);
});

test("environment: members read the state, approve/reject are owner-gated, approve maps failures to statuses", async () => {
    const disk = new Map<string, string>();
    const memoryFiles = fakeFiles({
        read: async (path) => disk.get(path),
        write: async (path, content) => {
            disk.set(path, content as string);
        },
        remove: async (path) => {
            disk.delete(path);
        },
    });
    // A proposal is custom-section content only (the daemon owns the FROM).
    const proposal = "RUN apt-get install -y cowsay\n";
    const hash = sha256Hex(proposal);
    disk.set("/work/.intentic/environment.Dockerfile", proposal);

    // A member (bearer passes, owner check refuses as Forbidden) sees the state but can't approve or reject —
    // a verified non-owner is 403, not 401.
    const memberApp = createApp(services({ files: memoryFiles, auth: { authorize: async () => {}, authorizeOwner: rejectForbidden } }));
    const seen = await memberApp.request("/environment");
    expect(seen.status).toBe(200);
    expect(await seen.json()).toEqual({ proposal: { content: proposal, hash } });
    const approveDenied = await postJson(memberApp, "/environment/approve", { hash });
    expect(approveDenied.status).toBe(403);
    expect(await approveDenied.json()).toEqual({ error: "not the sandbox owner" });
    expect((await postJson(memberApp, "/environment/reject")).status).toBe(403);

    // Loopback (no auth) is the owner, like every other route.
    const ownerApp = createApp(services({ files: memoryFiles }));
    expect((await postJson(ownerApp, "/environment/approve")).status).toBe(400);
    expect((await postJson(ownerApp, "/environment/approve", { hash: "stale" })).status).toBe(409);
    const approved = await postJson(ownerApp, "/environment/approve", { hash });
    expect(approved.status).toBe(200);
    // Approve stores the custom section verbatim and returns the daemon-composed approved artifact.
    const state = (await approved.json()) as { proposal: unknown; custom: unknown; approved?: { content: string; hash: string } };
    expect(state.proposal).toEqual({ content: proposal, hash });
    expect(state.custom).toEqual({ content: proposal, hash });
    expect(state.approved?.content).toContain("FROM registry.gitlab.com/radarsu/intentic/sandbox:stable");
    expect(state.approved?.content).toContain(proposal.trim());
    expect(state.approved?.hash).toBe(sha256Hex(state.approved?.content ?? ""));

    // Reject deletes the proposal; approving with nothing proposed is a 404.
    expect((await postJson(ownerApp, "/environment/reject")).status).toBe(200);
    expect((await postJson(ownerApp, "/environment/approve", { hash })).status).toBe(404);

    // A proposal carrying its own FROM is invalid — the daemon owns the base image.
    disk.set("/work/.intentic/environment.Dockerfile", "FROM alpine:latest\n");
    expect((await postJson(ownerApp, "/environment/approve", { hash: sha256Hex("FROM alpine:latest\n") })).status).toBe(400);
});

test("capabilities.add composes the entry's image fragment into the overlay and nags for the rebuild; remove drops it", async () => {
    const disk = new Map<string, string>();
    const memoryFiles = fakeFiles({
        read: async (path) => disk.get(path),
        write: async (path, content) => {
            disk.set(path, content as string);
        },
        remove: async (path) => {
            disk.delete(path);
        },
    });
    // The vpn handler writes ~/.wireguard on the real fs — point HOME at a temp dir like vpn.test.ts.
    process.env.HOME = mkdtempSync(join(tmpdir(), "app-vpn-home-"));
    const client = clientFor(createApp(services({ files: memoryFiles, capabilities: memoryCapabilitiesStore() })));

    const events = await collect(
        // auto-connect on: with no VPN tooling installed yet, the apply must still land in the manifest and say
        // a rebuild is what installs the client — the pre-rebuild bootstrap this whole flow depends on.
        await client.capabilities.add({
            id: "office",
            kind: "vpn",
            config: { provider: "wireguard", config: "[Interface]\nPrivateKey = P\n", autoConnect: "on" },
        }),
    );
    expect(events.some((event) => "message" in event && (event as { message: string }).message.includes("rebuild"))).toBe(true);
    const approvedFile = disk.get("/work/.intentic/environment.approved.Dockerfile");
    expect(approvedFile).toContain("wireguard-tools");
    expect(approvedFile).toContain("# intentic:runtime --device=/dev/net/tun");

    // Removing the last fragment-bearing capability recomposes the overlay away (stock container, no custom).
    await client.capabilities.remove({ id: "office" });
    expect(disk.get("/work/.intentic/environment.approved.Dockerfile")).toBeUndefined();
});

// The binary side of a diff, which the JSON file-diff routes can only FLAG. Two things are load-bearing and
// neither is visible from the JSON side: the blob comes back as BYTES (a utf8 decode would replace every byte
// above 0x7f, which is most of a PNG), and the rev-spec pair matches the row the reviewer clicked.
test("GET /diff/raw streams a diff side's bytes: blob for the index side, disk for the worktree side", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentic-diff-raw-"));
    const git = (...args: string[]): Promise<unknown> =>
        promisify(execFile)("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", root, ...args]);
    // Bytes git cannot round-trip as text: a NUL, a lone 0x80 (invalid utf8 on its own), and 0xff.
    const committed = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x80, 0xff]);
    const edited = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x81, 0xfe, 0x01]);
    try {
        await git("init", "-q");
        await writeFile(join(root, "logo.png"), committed);
        await git("add", "-A");
        await git("commit", "-q", "-m", "init");
        await writeFile(join(root, "logo.png"), edited);

        const app = createApp(
            services({
                workspace: workspacePaths(root),
                // The worktree side reads through the same file service /workspace/raw uses.
                files: fakeFiles({
                    readBytes: async (absPath) => (absPath === join(root, "logo.png") ? edited : undefined),
                    size: async (absPath) => (absPath === join(root, "logo.png") ? edited.byteLength : undefined),
                }),
            }),
        );
        const raw = (query: string): Promise<Response> => app.request(`/diff/raw?source=working&repo=root&path=logo.png&${query}`);

        // Unstaged: before is the index blob, after is the file on disk — the same pair unstagedFileDiff reads.
        const before = await raw("side=unstaged&which=before");
        expect(before.status).toBe(200);
        expect(before.headers.get("content-type")).toBe("image/png");
        expect(new Uint8Array(await before.arrayBuffer())).toEqual(new Uint8Array(committed));
        expect(new Uint8Array(await (await raw("side=unstaged&which=after")).arrayBuffer())).toEqual(new Uint8Array(edited));

        // Staged: nothing has been staged, so the index still holds the committed blob on BOTH sides — which is
        // exactly what a staged row would diff (HEAD↔index), and not what the unstaged row above showed.
        expect(new Uint8Array(await (await raw("side=staged&which=after")).arrayBuffer())).toEqual(new Uint8Array(committed));

        // A side the file never had (this path is in no commit) is a 404, not an empty body a browser would
        // render as a corrupt image.
        expect((await app.request("/diff/raw?source=working&repo=root&path=fresh.png&side=unstaged&which=before")).status).toBe(404);
        // The guards every file surface here applies, plus the two this route adds of its own.
        expect((await raw("side=unstaged&which=sideways")).status).toBe(400);
        expect((await raw("side=nonsense&which=before")).status).toBe(400);
        expect((await app.request("/diff/raw?source=nonsense&repo=root&path=logo.png&which=before")).status).toBe(400);
        expect((await app.request("/diff/raw?source=working&repo=root&path=../../etc/passwd&side=unstaged&which=after")).status).toBe(400);
        expect((await app.request("/diff/raw?source=working&repo=nope&path=logo.png&side=unstaged&which=before")).status).toBe(404);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// A commit's own two sides, from the graph. The sha is the one identifier that reaches git's rev-spec parser
// from the wire, so it is held to the contract's sha shape before it gets there.
test("GET /diff/raw serves a commit's before/after blobs and refuses a sha that isn't one", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentic-diff-raw-commit-"));
    const git = (...args: string[]): Promise<{ stdout: string }> =>
        promisify(execFile)("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", root, ...args]);
    const first = Buffer.from([0x00, 0x80, 0x01]);
    const second = Buffer.from([0x00, 0xff, 0x02, 0x03]);
    try {
        await git("init", "-q");
        await writeFile(join(root, "icon.png"), first);
        await git("add", "-A");
        await git("commit", "-q", "-m", "one");
        await writeFile(join(root, "icon.png"), second);
        await git("add", "-A");
        await git("commit", "-q", "-m", "two");
        const sha = (await git("rev-parse", "HEAD")).stdout.trim();

        const app = createApp(services({ workspace: workspacePaths(root) }));
        const raw = (which: string): Promise<Response> => app.request(`/diff/raw?source=commit&repo=root&sha=${sha}&path=icon.png&which=${which}`);
        expect(new Uint8Array(await (await raw("before")).arrayBuffer())).toEqual(new Uint8Array(first));
        expect(new Uint8Array(await (await raw("after")).arrayBuffer())).toEqual(new Uint8Array(second));
        expect((await app.request(`/diff/raw?source=commit&repo=root&sha=HEAD~1&path=icon.png&which=after`)).status).toBe(400);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("extensions.setEnabled keeps the extension listed, switches it off, and unwires it daemon-side", async () => {
    // A real workspace root, because the switch persists to <root>/.intentic/extension-enablement.json. The
    // extensions dir is the repo's own _extensions, so this runs against the shipped first-party manifests.
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-toggle-")));
    const svc = services({ workspace });
    const client = clientFor(createApp(svc));

    const listed = async (): Promise<Record<string, boolean>> =>
        Object.fromEntries((await client.extensions.list()).extensions.map((extension) => [extension.id, extension.enabled]));

    expect((await listed())["intentic.discord"]).toBe(true);
    expect((await listenerProvidersOf(svc)).get("discord")).toEqual(new Set(["message", "voice_utterance", "voice_transcript"]));

    await client.extensions.setEnabled({ id: "intentic.discord", enabled: false });

    // Still listed — that is what keeps the switch reachable — and off.
    expect((await listed())["intentic.discord"]).toBe(false);
    // The listener provider an automations trigger validates against is gone with it, and its declared gateway
    // can no longer be started by hand.
    expect((await listenerProvidersOf(svc)).has("discord")).toBe(false);
    expect(await errorCode(client.extensions.processStart({ id: "intentic.discord", name: "gateway" }))).toBe("PRECONDITION_FAILED");

    // And back on, from the same list the tab renders.
    await client.extensions.setEnabled({ id: "intentic.discord", enabled: true });
    expect((await listed())["intentic.discord"]).toBe(true);
});

test("the extension list carries every first-party extension, compiled-in UI ones included", async () => {
    // The Extensions tab is only a complete list if the daemon enumerates the web-builtin extensions too —
    // their manifests ride the image beside the daemon-side ones (Dockerfile), so a bake that drops one shows
    // up here rather than as a silently missing row.
    const client = clientFor(createApp(services({ workspace: workspacePaths(mkdtempSync(join(tmpdir(), "ext-list-"))) })));
    const ids = (await client.extensions.list()).extensions.map((extension) => extension.id).toSorted();
    expect(ids).toEqual([
        "intentic.acceptance",
        "intentic.activity",
        "intentic.automations",
        "intentic.connectors",
        "intentic.discord",
        "intentic.imap",
        "intentic.logs",
        "intentic.memory",
        "intentic.pipelines",
        "intentic.preview",
        "intentic.repo-apps",
        "intentic.viewers",
    ]);
});
