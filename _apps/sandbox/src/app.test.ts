import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, Capability } from "@intentic/sandbox-contract";
import { portUrl, sandboxContract } from "@intentic/sandbox-contract";
import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { DEFAULT_TEMPLATE_REF, DEFAULT_TEMPLATE_SOURCE } from "@intentic/scaffold";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { Hono } from "hono";
import { expect, test, vi } from "vitest";
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
import { mintPairing } from "./platform/sync.js";
import { createTerminalRunner } from "./terminal/terminal-run.js";
import type { AgentTool } from "./agent/agent-tools.js";
import { workspacePaths } from "./workspace/workspace.js";
import { MAX_RAW_BYTES, UploadTooLargeError } from "./workspace/workspace-files.js";

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
    sandbox: { port: 8787, host: "0.0.0.0", publicUrl: "", name: "", image: "", environmentHash: "" },
    preview: { port: 5173 },
    google: { clientId: "" },
};

const services = (overrides: Partial<Services> = {}): Services => ({
    config: baseConfig,
    logger: createLogger(baseConfig),
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
    activity: { append: async () => {}, list: async () => [] },
    sandboxSettings: {
        get: async () => ({
            searchPastChats: false,
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
    codexStore: {
        home: (id) => `/work/.intentic/codex/${id}`,
        connected: async () => false,
        read: async () => undefined,
        writeTokens: async () => {},
        write: async () => {},
        clear: async () => {},
        list: async () => [],
    },
    codexHealth: async () => undefined,
    locateCodexThread: async () => undefined,
    // Never-empty catalog fakes matching the daemon's contract, so a native turn always resolves a model.
    claudeModels: { models: async () => ({ models: [{ id: "opus", label: "Opus" }], default: "opus" }) },
    codexModels: { models: async () => ({ models: [{ id: "gpt-5.1", label: "GPT 5.1" }], default: "gpt-5.1" }), record: async () => {} },
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
        push: async () => {},
        clone: async () => {},
        changedFiles: async () => ({ changes: [] }),
        commitPaths: async () => false,
        discardPaths: async () => {},
        fileDiff: async () => ({}),
        changesAgainstBase: async () => [],
    },
    // A real registry over a memory store (cheap, and /events' roster subscription needs the real seam);
    // worktree git mechanics are stubbed — the worktree suites cover them against real git.
    agents: createAgentsRegistry({ load: async () => [], save: async () => {} }),
    agentWorktrees: {
        conversationDir: (id) => `/history/worktrees/${id}`,
        worktreeDir: (id, repo) => (repo === "root" ? `/history/worktrees/${id}` : `/history/worktrees/${id}/${repo}`),
        mainDir: (repo) => (repo === "root" ? "/work" : `/work/${repo}`),
        exists: async () => false,
        ensure: async (id) => ({ cwd: `/history/worktrees/${id}`, branch: `agent/${id}`, repos: [{ repo: "root", base: "a".repeat(40) }] }),
        remove: async () => {},
        prune: async () => {},
        withRepoLock: (_repo, task) => task(),
    },
    files: fakeFiles(),
    workspaceTree: async () => ({ root: "/work", tree: [], truncated: false }),
    sessions: { list: async () => [], read: async () => [], search: async () => [], exists: async () => true },
    platformHostTunnel: async () => ({ status: 200, json: { hostname: "ssh-abc.example.com", tunnelToken: "tok" } }),
    ensurePreviewRoute: async () => {},
    members: { list: async () => [], add: async () => {}, remove: async () => {} },
    auth: undefined,
    ...overrides,
});

// A typed oRPC client over the in-process Hono app — the same OpenAPILink the browser uses, so streams round-
// trip through the real SSE encode/decode. JSON routes resolve to their output; thrown ORPCErrors carry `.code`.
const clientFor = (app: Hono): ContractRouterClient<typeof sandboxContract> =>
    createORPCClient(new OpenAPILink(sandboxContract, { url: "http://sandbox", fetch: (request) => app.request(request) }));

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

test("GET /health reports ok", async () => {
    const res = await createApp(services()).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
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
    const facts = { deployConfig: false, desiredState: false, directoryUi: false, monorepo: false, vitest: false };
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

test("panels.list reports the content facts extensions detect on", async () => {
    const workspace = tempWorkspace([{ name: "extra" }]);
    const dir = join(workspace.root, "extra");
    writeFileSync(join(dir, "deploy.config.ts"), "export default {};");
    writeFileSync(join(dir, "desired-state.json"), "{}");
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []");
    writeFileSync(join(dir, "turbo.json"), "{}");
    mkdirSync(join(dir, ".intentic", "ui"), { recursive: true });
    writeFileSync(join(dir, ".intentic", "ui", "index.html"), "<html></html>");
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
                ensurePreviewRoute: async (panel) => {
                    ensured.push(panel);
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
                    { port: 22, host: "127.0.0.1" },
                    { port: 3000, host: "127.0.0.1", pid: 7, command: "vite", cwd: "/work/app" },
                    { port: 5173, host: "127.0.0.1" },
                    { port: 8787, host: "127.0.0.1" },
                ],
            }),
        ),
    );
    expect(await client.ports.list()).toEqual({ ports: [{ port: 3000, pid: 7, command: "vite", cwd: "/work/app", forwarded: false }] });

    await portForwards.forward(3000);
    expect(await client.ports.list()).toEqual({
        ports: [
            {
                port: 3000,
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
                scanPorts: async () => [{ port: 3000, host: "127.0.0.1", pid: 7, command: "vite" }],
                ensurePreviewRoute: async (label) => {
                    ensured.push(label);
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
    expect((await client.ports.list()).ports).toEqual([{ port: 3000, pid: 7, command: "vite", forwarded: false }]);
});

test("ports.forward on a loopback sandbox (no zone/token) still maps the slot but returns no URL", async () => {
    const client = clientFor(createApp(services({ scanPorts: async () => [{ port: 3000, host: "127.0.0.1" }] })));
    expect(await client.ports.forward({ port: 3000 })).toEqual({});
});

test("system.terminals lists every attachable web-*/panel-* tmux session (none in the test env)", async () => {
    const client = clientFor(createApp(services()));
    expect(await client.system.terminals()).toEqual({ sessions: [] });
});

test("system.killTerminal routes a panel-* session through the process manager, so `running` unmaps immediately", async () => {
    const processes = fakeProcesses();
    const client = clientFor(createApp(services({ processes: processes })));
    expect(await client.system.killTerminal({ name: "panel-app" })).toEqual({ ok: true });
    expect(processes.stopped).toEqual(["app"]);
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
            sessions: { list: async () => [], read: async () => [], search: async () => [], exists: async () => true },
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
                sessions: { list: async () => all, read: async () => [], search: async (_root, query) => (query === "auth" ? matches : []) },
            }),
        ),
    );
    expect(await client.sessions.list({})).toEqual({ sessions: all });
    expect(await client.sessions.list({ query: "auth" })).toEqual({ sessions: matches });
    // Whitespace-only query is treated as no query — the unfiltered list, not a search.
    expect(await client.sessions.list({ query: "   " })).toEqual({ sessions: all });
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
    expect((await post({ "x-intentic-pair": mintPairing().token })).status).toBe(400);
    expect((await post()).status).toBe(401);
    expect((await post({ "x-intentic-pair": "bogus" })).status).toBe(401);
});

test("POST /system/authorized-key is single-holder: a rival machine needs takeover (423), which replaces the key", async () => {
    // Enrollment writes ~/.ssh/authorized_keys — point HOME at a temp dir so it lands there, not the real home.
    process.env.HOME = mkdtempSync(join(tmpdir(), "sync-enroll-home-"));
    // connectToken + publicUrl make syncSshHostname resolve, so enrollment gets past the tunnel-configured check.
    const app = createApp(
        services({
            config: { ...baseConfig, connectToken: "token", sandbox: { ...baseConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" } },
        }),
    );
    // A fresh single-use pairing per call (the agent's real path); the key's comment is the machine label.
    const enroll = (key: string, extra: Record<string, string> = {}) =>
        app.request("/system/authorized-key", {
            method: "POST",
            headers: { "content-type": "application/json", "x-intentic-pair": mintPairing().token, ...extra },
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
    await vi.waitFor(async () => expect((await store.get("deploy"))?.runs).toHaveLength(1));
    expect((await store.get("deploy"))?.runs[0]?.outcome).toBe("completed");
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
    await vi.waitFor(async () => expect((await store.get("support"))?.runs).toHaveLength(1));
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
    expect(await collect(await client.agent.run({ prompt: "do it" }))).toEqual(events);
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
    await collect(await client.agent.run({ prompt: "do it", sessionId: "s1", model: "opus" }));
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
    await collect(await client.agent.run({ prompt: "hi", account: "b" }));
    expect(seen?.oauthToken).toBe("tok-b");
});

test("agent.run points a Codex turn at the selected account's CODEX_HOME", async () => {
    let seen: { codexHome?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                codexStore: {
                    home: (id) => `/work/.intentic/codex/${id}`,
                    connected: async () => true,
                    read: async () => undefined,
                    writeTokens: async () => {},
                    write: async () => {},
                    clear: async () => {},
                    list: async () => [{ id: "acc-1", label: "x", connectedAt: 0 }],
                },
                codexAgent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await collect(await client.agent.run({ prompt: "hi", agent: "codex", account: "acc-1" }));
    expect(seen?.codexHome).toBe("/work/.intentic/codex/acc-1");
});

test("agent.run resumes a Codex turn under the CODEX_HOME that owns the thread, not the first account", async () => {
    let seen: { codexHome?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                // A different account is "first" now, but the thread was minted under acc-1 — the resume must
                // follow the owner the locator returns, not whichever account list() puts first.
                codexStore: {
                    home: (id) => `/work/.intentic/codex/${id}`,
                    connected: async () => true,
                    read: async () => undefined,
                    writeTokens: async () => {},
                    write: async () => {},
                    clear: async () => {},
                    list: async () => [{ id: "acc-2", label: "y", connectedAt: 0 }],
                },
                locateCodexThread: async () => ({ home: "/work/.intentic/codex/acc-1", accountId: "acc-1" }),
                codexAgent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await collect(await client.agent.run({ prompt: "hi", agent: "codex", sessionId: "thr-x" }));
    expect(seen?.codexHome).toBe("/work/.intentic/codex/acc-1");
});

test("agent.run pre-flights a Codex resume with no owning home as session-not-found", async () => {
    let codexCalled = false;
    const client = clientFor(
        createApp(
            services({
                locateCodexThread: async () => undefined,
                codexAgent: async function* () {
                    codexCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const events = await collect(await client.agent.run({ prompt: "hi", agent: "codex", sessionId: "gone" }));
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
    await collect(await grokApp().agent.run({ prompt: "hi", agent: "grok", model: "grok-code-fast-1" })); // retired ⇒ live default
    await collect(await grokApp().agent.run({ prompt: "hi", agent: "grok", model: "grok-4.20-0309-reasoning" })); // still served ⇒ kept
    await collect(await grokApp().agent.run({ prompt: "hi", agent: "grok" })); // none ⇒ live default
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
    await collect(await client.agent.run({ prompt: "do it" }));
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
            ["secrets", "push"],
            ["secrets", "push"],
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
    const events = await collect(await client.agent.run({ prompt: "do it" }));
    // The turn never reaches the agent — the user gets an actionable message instead of exit-code-1.
    expect(agentCalled).toBe(false);
    expect(events.some((event) => event.kind === "error" && event.message.includes("No Claude account connected"))).toBe(true);
});

test("agent.run pre-flights a dead resume target with a coded error instead of spawning the CLI to fail", async () => {
    let agentCalled = false;
    const client = clientFor(
        createApp(
            services({
                sessions: { list: async () => [], read: async () => [], search: async () => [], exists: async () => false },
                agent: async function* () {
                    agentCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const events = await collect(await client.agent.run({ prompt: "do it", sessionId: "gone" }));
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
    await collect(
        await client.agent.run({
            prompt: "and now?",
            history: [
                { role: "user", text: "what is 2+2?" },
                { role: "assistant", text: "4" },
            ],
        }),
    );
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
    await collect(await client.agent.run({ prompt: "", attachments: [".intentic/attachments/x/shot.png"] }));
    expect(seen?.prompt).toContain("/work/.intentic/attachments/x/shot.png");
});

test("agent.run rejects an attachment path escaping the workspace with an error frame", async () => {
    const client = clientFor(createApp(services()));
    const events = await collect(await client.agent.run({ prompt: "look", attachments: ["../escape.png"] }));
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
    const events = await collect(await client.agent.run({ prompt: "fix it", conversationId: "conv1", isolated: true }));
    // The worktree identity frame precedes every provider frame; the stub composition's root base is aaaa….
    expect(events[0]).toEqual({ kind: "worktree", branch: "agent/conv1", base: "aaaaaaa" });
    // The single binding point: the turn's cwd is the worktree, not /work.
    expect(seen?.cwd).toBe("/history/worktrees/conv1");
    // Both main-tree history snapshots (attribution fence + turn end) are skipped.
    expect(snapshots).toBe(0);
    // The fleet registry recorded the conversation: idle after finish, usage flushed, session captured.
    const { agents } = await client.agents.list();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: "conv1", status: "idle", branch: "agent/conv1", costUsd: 0.5, sessionId: "sess-iso" });
});

test("a second concurrent isolated turn for the same conversation is refused with agent-busy", async () => {
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
    const first = collect(await client.agent.run({ prompt: "long task", conversationId: "conv1", isolated: true }));
    // Poll until the first turn holds the mutex (its begin ran), then the second send must bounce.
    await vi.waitFor(async () => {
        const events = await collect(await client.agent.run({ prompt: "again", conversationId: "conv1", isolated: true }));
        expect(events[0]).toMatchObject({ kind: "error", code: "agent-busy" });
    });
    release?.();
    await first;
    // The mutex released at finish — the next turn runs.
    const events = await collect(await client.agent.run({ prompt: "after", conversationId: "conv1", isolated: true }));
    expect(events[0]).toMatchObject({ kind: "worktree" });
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
    const first = await collect(await client.agent.run({ prompt: "hi", conversationId: "conv1", isolated: true }));
    expect(first.some((event) => event.kind === "error" && event.message.includes("No Claude account"))).toBe(true);
    // The gate exit must not leave the agent stuck "running" — the retry hits the same gate, NOT agent-busy.
    const second = await collect(await client.agent.run({ prompt: "hi", conversationId: "conv1", isolated: true }));
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
    await collect(await client.agent.run({ prompt: "fix the login bug", title: "My agent", conversationId: "conv1", isolated: true }));
    expect((await client.agents.list()).agents[0]?.title).toBe("My agent");
    const renamed = await client.agents.rename({ id: "conv1", title: "  Login fix  " });
    expect(renamed.title).toBe("Login fix");
    expect((await client.agents.list()).agents[0]?.title).toBe("Login fix");
    expect(await errorCode(client.agents.rename({ id: "nope", title: "x" }))).toBe("NOT_FOUND");
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
                    push: async () => {},
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
                    push: async () => {},
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

test("git.changes aggregates dirty repos across root + roles + clones, skipping clean and broken ones", async () => {
    const workspace = tempWorkspace([{ name: "intent" }, { name: "shop" }]);
    const client = clientFor(
        createApp(
            services({
                workspace,
                git: {
                    ...services().git,
                    changedFiles: async (dir) => {
                        if (dir === workspace.root) {
                            return { branch: "main", changes: [{ path: "notes.md", status: "added" as const }] };
                        }
                        if (dir === join(workspace.root, "shop")) {
                            throw new Error("broken repo");
                        }
                        return { changes: [] };
                    },
                },
            }),
        ),
    );
    expect(await client.git.changes()).toEqual({
        repos: [{ repo: "root", branch: "main", changes: [{ path: "notes.md", status: "added" }] }],
    });
});

test("git.commit routes paths to the per-path commit and no paths to commit-all", async () => {
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
                    commitPaths: async (dir, message, paths) => {
                        calls.push(`paths ${dir} ${message} ${paths.join(",")}`);
                        return true;
                    },
                },
            }),
        ),
    );
    expect(await client.git.commit({ repo: "root", message: "m1", paths: ["notes.md"] })).toEqual({ committed: true });
    expect(await client.git.commit({ repo: "intent", message: "m2" })).toEqual({ committed: true });
    expect(calls).toEqual([`paths ${workspace.root} m1 notes.md`, `all ${join(workspace.root, "intent")} m2`]);
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

test("git.fileDiff returns the working diff and BAD_REQUESTs a path escape", async () => {
    const client = clientFor(
        createApp(
            services({
                git: {
                    ...services().git,
                    fileDiff: async (_dir, path) => (path === "notes.md" ? { before: "one\n", after: "two\n" } : {}),
                },
            }),
        ),
    );
    expect(await client.git.fileDiff({ repo: "root", path: "notes.md" })).toEqual({ before: "one\n", after: "two\n" });
    expect(await errorCode(client.git.fileDiff({ repo: "root", path: "../escape" }))).toBe("BAD_REQUEST");
});

test("workspace.tree returns the full working tree from the walker", async () => {
    const tree = { root: "/work", tree: [{ name: "app", path: "app", type: "dir" as const, children: [] }], truncated: false };
    const client = clientFor(createApp(services({ workspaceTree: async () => tree })));
    expect(await client.workspace.tree()).toEqual(tree);
});

test("workspace.file reads any contained file (former-secret paths included), NOT_FOUNDs missing, BAD_REQUESTs escape", async () => {
    const client = clientFor(
        createApp(
            services({
                files: fakeFiles({
                    read: async (absPath) =>
                        absPath === "/work/app/src/index.ts" ? "console.log(1);" : absPath === "/work/desired-state/.env" ? "SECRET=1" : undefined,
                }),
            }),
        ),
    );
    expect(await client.workspace.file({ path: "app/src/index.ts" })).toEqual({ path: "app/src/index.ts", content: "console.log(1);" });
    // No security floor: a former-secret file reads through like any other contained file.
    expect(await client.workspace.file({ path: "desired-state/.env" })).toEqual({ path: "desired-state/.env", content: "SECRET=1" });
    expect(await errorCode(client.workspace.file({ path: "app/nope.ts" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.file({ path: "../../etc/passwd" }))).toBe("BAD_REQUEST");
});

// Search is backed by the iq CLI (execFile "iq" … --json). Round-trip through a PATH shim to the built CLI
// against a real tmp workspace; the min-length rejection is contract validation and never spawns anything.
test("workspace.search shells into iq --json and round-trips the WorkspaceSearchResult; rejects a too-short query", async () => {
    const root = await mkdtemp(join(tmpdir(), "iq-daemon-"));
    const bin = await mkdtemp(join(tmpdir(), "iq-bin-"));
    const cli = fileURLToPath(new URL("../../iq/dist/cli.js", import.meta.url));
    await writeFile(join(bin, "iq"), `#!/bin/sh\nexec node ${cli} "$@"\n`, { mode: 0o755 });
    await writeFile(join(root, "notes.md"), "the needle is here\n");
    const previousPath = process.env["PATH"];
    process.env["PATH"] = `${bin}:${previousPath ?? ""}`;
    try {
        const client = clientFor(createApp(services({ workspace: workspacePaths(root) })));
        const result = await client.workspace.search({ query: "needle" });
        expect(result.mode).toBe("q");
        expect(result.groups[0]?.path).toBe("notes.md");
        expect(result.truncated).toBe(false);
        const empty = await client.workspace.search({ query: "zzzqqqvvv" });
        expect(empty.total).toBe(0);
        expect(await errorCode(client.workspace.search({ query: "x" }))).toBe("BAD_REQUEST");
    } finally {
        process.env["PATH"] = previousPath;
        await rm(root, { recursive: true, force: true });
        await rm(bin, { recursive: true, force: true });
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
                    push: async () => {},
                    clone: async (parentDir, name, cloneUrl, options) => {
                        clones.push({
                            parentDir,
                            name,
                            cloneUrl,
                            ...(options?.separateGitDir !== undefined ? { separateGitDir: options.separateGitDir } : {}),
                        });
                    },
                },
                ensurePreviewRoute: async (panel) => {
                    ensured.push(panel);
                },
            }),
        ),
    );
    expect(await client.workspace.addRepo({ name: "extra", cloneUrl: "https://example.com/extra.git" })).toEqual({ name: "extra", path: "extra" });
    expect(clones).toEqual([{ parentDir: "/work", name: "extra", cloneUrl: "https://example.com/extra.git", separateGitDir: "/history/gits/extra" }]);
    // The preview route is minted at clone time, not first panel start (DNS negative-caching).
    expect(ensured).toEqual(["extra"]);
    // A reserved role (one of the three fixed repos) cannot be clobbered, and a path-escape name is rejected.
    expect(await errorCode(client.workspace.addRepo({ name: "intent", cloneUrl: "https://example.com/x.git" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.workspace.addRepo({ name: "../evil", cloneUrl: "https://example.com/x.git" }))).toBe("BAD_REQUEST");
    expect(clones).toHaveLength(1);
});

test("workspace.addApps launches `intentic add-app` as a one-shot tmux job and mints each app's preview route up front", async () => {
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
                ensurePreviewRoute: async (panel) => {
                    ensured.push(panel);
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
                command: `intentic add-app --dir '${repoDir}' --apps 'api,web:shop-web' --source '${DEFAULT_TEMPLATE_SOURCE}' --ref '${DEFAULT_TEMPLATE_REF}'`,
                cwd: repoDir,
                oneShot: true,
            },
        },
    ]);
    // Preview routes are minted before the job runs (hostnames must predate the first browser lookup).
    expect(ensured).toEqual(["shop--api", "shop--shop-web"]);
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
        await client.capabilities.add({ id: "office", kind: "vpn", config: { config: "[Interface]\nPrivateKey = P\n", enabled: "off" } }),
    );
    expect(events.some((event) => "message" in event && (event as { message: string }).message.includes("rebuild"))).toBe(true);
    const approvedFile = disk.get("/work/.intentic/environment.approved.Dockerfile");
    expect(approvedFile).toContain("wireguard-tools");
    expect(approvedFile).toContain("# intentic:runtime --device=/dev/net/tun");

    // Removing the last fragment-bearing capability recomposes the overlay away (stock container, no custom).
    await client.capabilities.remove({ id: "office" });
    expect(disk.get("/work/.intentic/environment.approved.Dockerfile")).toBeUndefined();
});
