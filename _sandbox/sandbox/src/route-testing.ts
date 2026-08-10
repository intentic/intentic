import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ROOT, STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";

import type { AgentEvent, Capability, Persona } from "@intentic/sandbox-contract";
import { capabilitiesOf, SandboxSettingsSchema, sandboxContract } from "@intentic/sandbox-contract";
import { portSlotsFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { ControlScope } from "./auth/control-tokens.js";
import { createMediaTickets } from "./auth/media-tickets.js";
import { createWsTickets } from "./auth/ws-tickets.js";

import { createORPCClient } from "@orpc/client";
import type { AnyContractRouter } from "@orpc/contract";
import type { AnyRouter } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { Hono } from "hono";
import { afterEach, expect, vi } from "vitest";
import { createAgentsRegistry } from "./agents/agents-registry.js";

import { ForbiddenError } from "./auth/auth.js";
import { createAuthConnections } from "./auth/connections.js";

import type { AppEnv, OrpcContext } from "./context.js";
import type { AutomationRecord, AutomationsStore } from "./automations/automations-store.js";
import type { CapabilitiesStore } from "./capabilities/capabilities-store.js";
import type { PersonasStore } from "./personas/personas-store.js";
import type { DismissalsStore, DismissedRecommendation } from "./capabilities/dismissals-store.js";
import type { Services } from "./composition.js";
import { createLogger } from "./logger.js";
import type { ManagedProcesses } from "./processes/managed-processes.js";
import { createPortForwards } from "./ports/port-forwards.js";
import { createAnnouncer } from "./platform/announce.js";
import { createBootTracker } from "./platform/boot.js";
import { createPerfTracker } from "./platform/perf.js";

import { spokenLinesOf } from "./sessions/transcript-search.js";
import type { ThreadSession, ThreadSessionsStore } from "./sessions/thread-sessions.js";
import { createTerminalRunner } from "./terminal/terminal-run.js";

import { unstubbed } from "@intentic/testing";
import { noIsolation, testConfig } from "./testing.js";
import { workspacePaths } from "./workspace/workspace.js";

/* The route harness: the fakes and the client that every suite driving the daemon's HTTP surface builds on.
 * Lifted out of app.integration.test.ts when that file reached 3,632 lines and 116 tests — one file that 92 of
 * the last 573 commits had to touch, so two agents working on unrelated routes collided in it every time. The
 * route suites live next to the routes they drive now; this is what they share. Not part of the build
 * (tsconfig `exclude`), type-checked with the tests (tsconfig.test.json). */

/* A fire route answers 200 the moment it accepts the wake and lets the turn run DETACHED, so the run it records
 * lands some time after the response. That tail is not the fake agent (which completes instantly) — it is the
 * real turn path around it: the extension/cli env scan off disk, the worktree compose, the land pass. On a
 * loaded runner (CI runs this package's 143 files alongside the rest of the monorepo) it outruns vi.waitFor's
 * 1s default often enough to have made these the suite's flakiest tests. This budget bounds a hang; it does not
 * measure latency — so it is set against the ceiling of the suite that actually runs it.
 *
 * That ceiling is the INTEGRATION one (60s): every caller is app.integration.test.ts, which reaches the machine
 * exactly as this comment describes. 4s was chosen to stay under the 5s UNIT budget so an overrun would report
 * as the assertion that did not settle rather than as a dead test — but that ceiling never applied here, and
 * the 4s it bought went back to measuring the runner: three verify jobs building at once outran it and broke
 * main. Well clear of the tail above, still a fraction of the 60s a genuine hang reports within.
 */
export const TURN_SETTLES = { timeout: 30_000 } as const;

/* Where the agent worktrees' MAIN checkouts would be — a path under tmpdir that is never created, so on every
 * host it is definitively absent. This suite drives the ROUTES; the worktree and land git mechanics have their
 * own suites against real repos (worktrees.integration.test.ts, land.integration.test.ts). The land pass a turn runs at its end reads
 * the main checkout with real git, so naming the product's own "/work" here made the outcome depend on whether
 * the machine running the tests happens to have one: absent on CI, a LIVE repo on a developer's own intentic
 * sandbox, where the land then shelled git at a worktree that was never created and failed the turn. Absent
 * everywhere, the pass reports "main checkout vanished" and returns without spawning anything.
 */
export const ABSENT_MAIN = join(tmpdir(), "intentic-absent-main");

// Where a conversation's checkout lives, in the layout the daemon uses. Shared by the worktree fake and by the
// workspace scope composed from it, so the two cannot name different directories for the same conversation.
const conversationDir = (id: string): string => `${HISTORY_ROOT}/worktrees/${id}`;

// An in-memory capabilities store so the capability routes + turn merge are testable without the fs.
export const memoryCapabilitiesStore = (initial: Capability[] = []): CapabilitiesStore => {
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

// An in-memory personas store — the sandbox's named personas, without the fs.
export const memoryPersonasStore = (initial: Persona[] = []): PersonasStore => {
    let personas = [...initial];
    return {
        list: async () => personas,
        get: async (id) => personas.find((persona) => persona.id === id),
        upsert: async (persona) => {
            personas = [...personas.filter((existing) => existing.id !== persona.id), persona];
        },
        remove: async (id) => {
            const next = personas.filter((persona) => persona.id !== id);
            const existed = next.length !== personas.length;
            personas = next;
            return existed;
        },
    };
};

// An in-memory dismissals store — what the catalog's "not needed" writes to, without the fs.
export const memoryDismissalsStore = (initial: DismissedRecommendation[] = []): DismissalsStore => {
    let dismissed = [...initial];
    return {
        list: async () => dismissed,
        dismiss: async (entry) => {
            dismissed = [...dismissed.filter((existing) => existing.card !== entry.card), entry];
        },
    };
};

// An in-memory automations store so the fire route is testable without the fs.
export const memoryAutomationsStore = (initial: AutomationRecord[] = []): AutomationsStore => {
    let automations = [...initial];
    return {
        list: async () => automations,
        get: async (id) => automations.find((automation) => automation.id === id),
        upsert: async (automation) => {
            const runs = automations.find((existing) => existing.id === automation.id)?.runs ?? [];
            automations = [...automations.filter((existing) => existing.id !== automation.id), { ...automation, runs }];
        },
        setEnabled: async (id, enabled) => {
            const existing = automations.find((automation) => automation.id === id);
            if (existing === undefined) {
                return false;
            }
            existing.enabled = enabled;
            return true;
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

// An in-memory thread-session store, so the routes that turn an inbound message into a CONVERSATION (the
// Doorbell, a listener gateway's dispatch) are testable without the fs. Honours the TTL, because "a quiet
// thread starts over" is behaviour and not bookkeeping.
export const memoryThreadSessionsStore = (): ThreadSessionsStore => {
    const sessions = new Map<string, ThreadSession>();
    const live = (key: string, ttlMs: number, now: number): ThreadSession | undefined => {
        const record = sessions.get(key);
        return record !== undefined && now - record.lastAt <= ttlMs ? record : undefined;
    };
    return {
        get: async (key, ttlMs, now) => live(key, ttlMs, now),
        open: async (key, mintConversationId, ttlMs, now) => {
            const existing = live(key, ttlMs, now);
            const record: ThreadSession = existing
                ? { ...existing, lastAt: now, messages: existing.messages + 1 }
                : { conversationId: mintConversationId(), startedAt: now, lastAt: now, messages: 1 };
            sessions.set(key, record);
            return record;
        },
        settle: async (key, sessionId, now) => {
            const existing = sessions.get(key);
            if (existing !== undefined) {
                sessions.set(key, { ...existing, lastAt: now, ...(sessionId !== undefined ? { sessionId } : {}) });
            }
        },
    };
};

// Records starts/stops; `portOf` returns the seeded port so a repo reads as running (the list route derives
// running/healthy from portOf, not running()).
export const fakeProcesses = (
    ports: Record<string, number> = {},
): ManagedProcesses & { started: { repo: string; cwd: string }[]; stopped: string[] } => {
    const started: { repo: string; cwd: string }[] = [];
    const stopped: string[] = [];
    return Object.assign(
        unstubbed<ManagedProcesses>("processes", {
            start: async (repo, spec) => {
                started.push({ repo, cwd: spec.cwd });
            },
            stop: (repo) => {
                stopped.push(repo);
            },
            running: (repo) => repo in ports,
            portOf: (repo) => ports[repo],
            stopAll: () => {},
        }),
        { started, stopped },
    );
};

// A temp workspace on disk (repo discovery reads it): each entry names a repo — a dir owning a .git, role and
// clone alike — and whether it gets an operator/ panel (a package.json with a dev script).
export const tempWorkspace = (repos: { name: string; panel?: boolean }[]): ReturnType<typeof workspacePaths> => {
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
export const fakeHistory = (overrides: Partial<Services["history"]> = {}): Services["history"] =>
    unstubbed("history", {
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
export const fakeFiles = (overrides: Partial<Services["files"]> = {}): Services["files"] =>
    unstubbed("files", {
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

/* The seams a route test names but never exhausts. `auth` has five members and a test cares about one; `git`
 * has thirty-seven and a route touches two. Spelling the rest out per call site is what rotted: each new
 * method landed in the daemon, none landed in the fakes, and the gap only spoke as a 500 from whichever route
 * reached it first. Declared Partial here and completed by `unstubbed`, so a test still says exactly what it
 * relies on, an unstubbed call names ITSELF, and growing one of these interfaces stops touching this file.
 */
export interface WideSeamOverrides {
    readonly auth?: Partial<NonNullable<Services["auth"]>>;
    readonly git?: Partial<Services["git"]>;
    readonly usage?: Partial<Services["usage"]>;
    readonly claudeStore?: Partial<Services["claudeStore"]>;
    readonly cliProxy?: Partial<Services["cliProxy"]>;
    readonly sandboxSettings?: Partial<Services["sandboxSettings"]>;
    readonly iq?: Partial<Services["iq"]>;
}
export type ServiceOverrides = Partial<Omit<Services, keyof WideSeamOverrides>> & WideSeamOverrides;

// Never-empty catalog fakes matching the daemon's contract, so a native turn always resolves a model. Exported
// because `providerCatalogs` is one field holding five rows: a test that needs ONE provider to answer
// differently spreads this and replaces its row, rather than restating four it does not care about.
export const testProviderCatalogs: Services["providerCatalogs"] = {
    claude: { models: async () => ({ models: [{ id: "opus", label: "Opus" }], default: "opus" }) },
    codex: { models: async () => ({ models: [{ id: "gpt-5.1", label: "GPT 5.1" }], default: "gpt-5.1" }) },
    grok: { models: async () => ({ models: [{ id: "grok-4", label: "Grok 4" }], default: "grok-4" }) },
    kimi: { models: async () => ({ models: [{ id: "kimi-k3", label: "Kimi K3" }], default: "kimi-k3" }) },
    gemini: { models: async () => ({ models: [{ id: "gemini-pro-agent", label: "Gemini Pro Agent" }], default: "gemini-pro-agent" }) },
};

export const services = (overrides: ServiceOverrides = {}): Services => {
    const { auth, git, usage, claudeStore, cliProxy, sandboxSettings, iq, ...rest } = overrides;
    /* A real registry over a memory store (cheap, and /events' roster subscription needs the real seam);
     * worktree git mechanics are stubbed — the worktree suites cover them against real git. Neither derived
     * half is computed here: these suites drive the routes, and where a card's work stands — plus how much of
     * it is still in the tree — belongs to the integration suites that have real git. Every agent this harness
     * makes therefore reads at its turn lifecycle, with nothing landed missing.
     *
     * Hoisted out of the literal below because the workspace SCOPE is composed from it: whose copy of the
     * workspace a read means is answered by the registry plus the worktree layout, and a second registry
     * standing in for it there would let the two disagree. */
    const agents = createAgentsRegistry(
        { load: async () => [], save: async () => {} },
        { of: () => "idle", refresh: async () => false, forget: () => {} },
        { of: () => undefined, refresh: async () => false, forget: () => {} },
    );
    const workspace = workspacePaths(WORKSPACE_ROOT);
    /* Completed by `unstubbed`, not spelled out. What follows is only what these suites RELY on; every other
     * member of Services answers with its own name if a route reaches it. That is what takes this file off the
     * blast radius of the daemon growing a service: it used to enumerate all seventy members, so every feature
     * that added one turned this fake red — always in CI, on main, after the merge, and never in the suite that
     * cared. `komodoStore` was the last of those. */
    const merged: Services = unstubbed<Services>("services", {
        config: testConfig,
        logger: createLogger(testConfig),
        // No chain declared ⇒ converged from birth, so these tests exercise the routes and not a boot gate.
        // The gate's own behaviour is covered below by a tracker with a declared chain.
        boot: createBootTracker(createLogger(testConfig)),
        // The real tracker, like every other suite's fake services: it is in-memory, its summary timer is
        // unref'd, and the request middleware records through it on EVERY route below — a stub would be more
        // code standing in for something that already costs nothing.
        perf: createPerfTracker(createLogger(testConfig)),
        // Real too, and never started: creating one registers nothing and arms no timer, so /health reads the
        // `off` it reports on a daemon that has no platform to announce to — the loopback/test shape.
        announcer: createAnnouncer(testConfig, createLogger(testConfig)),
        workspace,
        processes: fakeProcesses(),
        dependencies: unstubbed<Services["dependencies"]>("dependencies", {
            status: async () => [],
            issueAt: async () => undefined,
            requestInstall: async () => ({ projects: [], queued: [] }),
            reconcileLand: async () => undefined,
            watch: () => () => {},
            subscribe: () => () => {},
            subscribeFailures: () => () => {},
        }),
        // The real slot table with a no-dial probe; `scanPorts` is empty so tests opt into listeners explicitly.
        portForwards: createPortForwards(portSlotsFromToken("tok"), async () => "http"),
        scanPorts: async () => [],
        terminalRun: createTerminalRunner(),
        // The real thing: pure in-memory state with no side effects, and a fake would only re-implement the
        // single-use rule the /system/ws-ticket test is there to check.
        wsTickets: createWsTickets(),
        // Real too, for the same reason: the path binding IS what /workspace/media checks, and a fake would
        // only restate it.
        mediaTickets: createMediaTickets(),
        /* A backend host that is simply not running — the honest default for route tests: the extensions list
         * reads statusOf per row (undefined ⇒ the host's own state answers), the /x proxy answers 503, and no
         * extension token verifies. The supervisor's real behaviour is covered by its own integration suite,
         * which spawns the actual host process. */
        extensionBackend: {
            start: async () => {},
            restart: () => {},
            stop: () => {},
            status: () => ({ state: "stopped", extensions: [] }),
            statusOf: () => undefined,
            proxyTarget: () => undefined,
            verifyExtensionToken: () => undefined,
        },
        panelToken: "panel-secret",
        // The /vpn-scoped secret the in-container CLI presents. A fixed value here so a route test can present
        // it; production mints one per boot.
        agentToken: "agent-secret",
        /* In-memory control-token fake: one fixed token per scope, named for it, so a middleware test can
         * present the exact reach it means to exercise without a store file. `ict_valid` is the editor scope
         * because that is the grant that existed first and the one most tests are about. */
        controlTokens: {
            mint: async (label, scope) => ({ id: "ct-1", token: `ict_minted-${scope}-${label}` }),
            scopeOf: async (presented) =>
                ({ ict_valid: "editor", "ict_read-token": "read", "ict_drive-token": "drive", "ict_land-token": "land" })[presented] as
                    ControlScope | undefined,
            list: async () => [{ id: "ct-1", label: "test", scope: "editor", createdAt: 0 }],
            revoke: async () => true,
        },
        info: undefined,
        tools: [],
        capabilities: memoryCapabilitiesStore(),
        // The creator pool's noter, defanged: these suites drive routes, and a premium day bit written into
        // the shared workspace root would leak between tests. The noter's own behaviour has its own suite.
        extensionUse: { note: () => {} },
        // Nothing declined by default: every route suite wants the catalog answering as it does on a sandbox
        // nobody has said no on yet.
        capabilityDismissals: memoryDismissalsStore(),
        /* No personas by default, which is the state of a sandbox nobody has named one in. Note what that means for
         * the suites here: an unattended turn reaches no logged-in account, because an unpinned wake is denied
         * rather than waved through (personas/personas.ts). A suite that wants a wake to act as somebody
         * builds the card AND the browser capability behind it. */
        personas: memoryPersonasStore(),
        automations: memoryAutomationsStore(),
        // Empty approvals queue: agents.list projects it as `held`, and no suite here holds a wake.
        approvals: {
            list: async () => [],
            get: async () => undefined,
            add: async (approval) => ({ ...approval, id: "held-1" }),
            remove: async () => false,
        },
        // Inert turn journal: every fire path writes an in-flight entry and clears it, and nothing here resumes.
        turnJournal: {
            list: async () => [],
            recordTurn: async () => {},
            recordFire: async () => {},
            clearTurn: async () => {},
            clearFire: async () => {},
        },
        // In-memory thread sessions: every inbound-message fire (Doorbell, listener gateway) resolves which
        // conversation it belongs to through this, and these suites only need it to answer consistently.
        threadSessions: memoryThreadSessionsStore(),
        activity: { append: async () => {}, list: async () => [] },
        usage: unstubbed("usage", { record: async () => {}, rollup: async () => [], turns: async () => [], ...usage }),
        // The schema's own defaults, not a copy of them — every flag is opt-in, so parsing an empty object is
        // exactly what the daemon reads from a workspace that has never written a settings file.
        sandboxSettings: unstubbed("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({}),
            set: async () => {},
            ...sandboxSettings,
        }),
        // A connected account by default, so the /agent guard (no token + no env creds) doesn't short-circuit
        // turns under test. Tests that exercise the disconnected path override this.
        claudeStore: unstubbed("claudeStore", {
            read: async (id) => (id === "default" ? { id: "default", label: "Claude", connectedAt: 0, accessToken: "tok-xyz" } : undefined),
            write: async () => {},
            clear: async () => {},
            list: async () => [{ id: "default", label: "Claude", connectedAt: 0 }],
            withRefreshLock: async (_id, act) => act(),
            logger: createLogger(testConfig),
            ...claudeStore,
        }),
        // Every seat is live. On the turn path for the same reason providerRefusals is: the picker reads it to
        // skip an account no organization will serve, and an answered turn clears whatever it holds.
        claudeSeats: { read: async () => ({}), refuse: async () => {}, clear: async () => {} },
        // No usage measured by default — an account that hasn't run a turn since its window reset reports none.
        accountUsage: { read: async () => ({}), record: async () => {}, clear: async () => {} },
        // …and nothing sweeps for one: the reader would need a live OAuth usage endpoint to reach.
        claudeUsage: { refresh: async () => {}, start: () => () => {} },
        // Nothing has ever been refused. Both writes are on the turn path — a refusal is filed when the plan says
        // no, and the account's standing refusal is settled the moment a turn produces content — so every test
        // that runs a turn at all touches this store whether or not it is about refusals.
        providerRefusals: { read: async () => ({}), record: async () => {}, clear: async () => {} },
        // Nothing connected in the translator by default; tests exercising the Codex subscription path override this.
        cliProxy: unstubbed("cliProxy", {
            accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [] }),
            connect: async () => ({ url: "", code: "", state: "", flow: "device" as const }),
            complete: async () => {},
            disconnect: async () => {},
            models: async () => [],
            refreshUsage: async () => {},
            turnLimit: async () => ({ spent: 0, withHeadroom: 0 }),
            ...cliProxy,
        }),
        codexHome: `${WORKSPACE_ROOT}/${STATE_DIR}/auth/codex`,
        codexThreadExists: async () => true,
        providerCatalogs: testProviderCatalogs,
        // Held directly too, exactly as in composition — the native Codex turn's model resolution and its
        // self-heal both read it, and neither goes through the table above.
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
            url: async () => "http://127.0.0.1:4096",
            connected: async () => false,
            sessionExists: async () => true,
            xaiModels: async () => ({ models: [{ id: "grok-4", label: "Grok 4" }], default: "grok-4" }),
            recordModels: async () => {},
            disconnect: async () => {},
        },
        intentic: async function* () {},
        // Thirty-seven methods, of which the routes below reach a dozen; the rest stay unstubbed and name
        // themselves if a route ever does reach one.
        git: unstubbed("git", {
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
            deleteTag: async () => {},
            pushTag: async () => ({ ok: true as const }),
            listBranches: async () => [],
            listRemoteBranches: async () => [],
            createBranch: async () => {},
            deleteBranch: async () => {},
            remoteState: async () => ({ ahead: 0, behind: 0 }),
            // Not mid-anything, which is every repo almost all of the time — a test about a halted one overrides it.
            operationInProgress: async () => undefined,
            abortOperation: async () => {},
            stashList: async () => [],
            stashChanges: async () => [],
            stashPush: async () => ({ ok: true as const }),
            stashApply: async () => ({ ok: true as const }),
            stashDrop: async () => {},
            undoableAction: async () => undefined,
            undoLastAction: async () => ({ ok: false as const, reason: "nothing to undo" }),
            fetchRemote: async () => ({ ok: true as const }),
            pullRemote: async () => ({ ok: true as const }),
            pushBranch: async () => ({ ok: true as const }),
            stagedFileDiff: async () => ({}),
            unstagedFileDiff: async () => ({}),
            fileDiff: async () => ({}),
            ...git,
        }),
        agents,
        agentWorktrees: {
            conversationDir,
            worktreeDir: (id, repo) => (repo === "root" ? `${HISTORY_ROOT}/worktrees/${id}` : `${HISTORY_ROOT}/worktrees/${id}/${repo}`),
            mainDir: (repo) => (repo === "root" ? ABSENT_MAIN : join(ABSENT_MAIN, repo)),
            exists: async () => false,
            // A live checkout, so the routes read the worktree path — the steady state these fakes model.
            attached: async () => true,
            snapshot: async () => [{ repo: "root", base: "a".repeat(40) }],
            ensure: async (id) => ({
                cwd: `${HISTORY_ROOT}/worktrees/${id}`,
                branch: `agent/${id}`,
                repos: [{ repo: "root", base: "a".repeat(40) }],
            }),
            remove: async () => {},
            retire: async () => {},
            prune: async () => {},
            withRepoLock: (_repo, task) => task(),
        },
        /* Whose copy of the workspace a read means (workspace/workspace-scope.ts). Composed from the same two
         * lookups the daemon uses — an unscoped read is the shared tree, exactly as in production, and a scoped
         * one resolves against a worktree dir that does not exist here, which is the archived-checkout case the
         * resolver's own suite covers on real disk.
         *
         * Read through `merged` rather than off the locals, like the session reader below, because a suite that
         * points `workspace` at a temp dir must move the file routes with it — a scope frozen at /work would
         * have every read answer from a tree that suite never wrote to. */
        workspaceScope: {
            get main() {
                return merged.workspace.root;
            },
            entry: (id) => merged.agents.entry(id),
            worktreeDir: conversationDir,
        },
        // Namespace isolation off, which is what a test runner (and any container without CAP_SYS_ADMIN) really
        // gets: turns then run straight in the worktree path, the behaviour every route assertion below expects.
        // The isolation.integration.test.ts suite covers the plan these routes would build when it IS available.
        // No mount capability, like a container launched without CAP_SYS_ADMIN — the plan still describes where
        // the worktree is, and the harness enforces it by redirecting tool paths instead of by mounting.
        turnIsolation: noIsolation(WORKSPACE_ROOT),
        // No agent has landed anything into these fake repos, so every changed file is the user's — and with no
        // ids to attribute, `identify` has nobody to resolve.
        agentOrigins: { forRepo: async () => ({}), identify: () => ({}) },
        files: fakeFiles(),
        workspaceTree: async () => ({ root: WORKSPACE_ROOT, tree: [], hidden: 0 }),
        // Inert resident search — no index, no rg. The search route test overrides `run` with a canned outcome.
        iq: unstubbed<Services["iq"]>("iq", {
            metrics: () => ({
                files: 0,
                generation: 0,
                dirtySequence: 0,
                appliedSequence: 0,
                revalidated: true,
                sweepAgeMs: 0,
                queryWorker: { live: false, pendingRequests: 0 },
            }),
            run: async () => ({
                result: { mode: "q", total: 0, files: 0, shown: 0, groups: [], freshness: { state: "fresh" as const }, truncated: false },
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
            close: async () => {},
            ...iq,
        }),
        sessions: {
            list: async () => [],
            read: async () => [],
            search: async () => [],
            exists: async () => true,
        },
        platformHostTunnel: async () => ({ status: 200, json: { hostname: "ssh-abc.example.com", tunnelToken: "tok" } }),
        ensurePreviewRoutes: async () => {},
        members: { list: async () => [], add: async () => {}, remove: async () => {} },
        /* Loopback mode unless a test asks for the exposed daemon — `auth: undefined` is the mode, so it is the
         * ABSENCE of the key that means loopback, not an override that happens to be undefined. Spelled out
         * rather than left to `unstubbed` because `allowOrigins` is a DATA member: a stand-in that answers every
         * unread key with a throwing function would make it read as set, and the CORS branch turn on. */
        auth:
            auth === undefined
                ? undefined
                : {
                      authorize: rejectAuth,
                      authorizeOwner: rejectAuth,
                      authorizeRetirement: rejectAuth,
                      mintSession: async () => ({ token: "sess-token", expiresAt: 0 }),
                      // Owner-only and destructive: a suite that reaches it without saying so is asserting on a
                      // rotation that never happened, so the default names itself rather than answering 200.
                      rotateSessions: async () => {
                          throw new Error("auth.rotateSessions was called, and this test did not stub it");
                      },
                      disableBrowserAccess: async () => {
                          throw new Error("auth.disableBrowserAccess was called, and this test did not stub it");
                      },
                      connections: createAuthConnections(),
                      allowOrigins: [],
                      ...auth,
                  },
        authRoot: `${WORKSPACE_ROOT}/${STATE_DIR}`,
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
            // Inert for the same reason as `open`, and present for the same one: a fork's first turn opens
            // through THIS door instead (openTurnTranscript), so a fake without it fails every forkOf turn
            // with a bare "Internal server error". There is no record behind the fake to copy a prefix out of.
            fork: async () => {},
            append: async () => {},
            // The same extraction production's cached reader applies over agentTranscript, minus the cache —
            // a test double re-reading per call is exactly the behavior the cache exists to avoid paying for.
            lines: async (agent) => spokenLinesOf(await merged.transcripts.read(agent)),
            // Both derived from `read`, so the fake's three answers cannot disagree with each other the way a
            // hand-written constant would. `count` is on the TURN path (it files each checkpoint's index), so
            // omitting it here is the failure mode this fake's comment above describes: every agent.run test in
            // the file dies on a bare "Internal server error" and no type catches it.
            count: async (agent) => (await merged.transcripts.read(agent)).length,
            // Inert: there is no store behind this fake to shorten. It still answers what a real truncate WOULD
            // have dropped, so a rewind test can assert on the count without standing up a transcript file.
            truncate: async (agent, keep) => Math.max(0, (await merged.transcripts.read(agent)).length - keep),
        },
        purgeConversationState: async () => {},
        ...rest,
    });
    return merged;
};

// A typed oRPC client over the in-process Hono app — the same OpenAPILink the browser uses, so streams round-
// trip through the real SSE encode/decode. JSON routes resolve to their output; thrown ORPCErrors carry `.code`.
export const clientFor = (app: Hono<AppEnv>): ContractRouterClient<typeof sandboxContract> =>
    createORPCClient(new OpenAPILink(sandboxContract, { url: "http://sandbox", fetch: async (request) => app.request(request) }));

// Without a vitest config there is no unstubEnvs, so a stubbed var would outlive the test that set it.
afterEach(() => vi.unstubAllEnvs());

// An auth stub that refuses every bearer as an AUTHENTICATION failure (→ 401) — proves a route's gate (or its
// exemption from the bearer middleware).
export const rejectAuth = async (): Promise<never> => {
    throw new Error("no bearer");
};

// An auth stub for a verified-but-unauthorized caller (→ 403): the bearer is valid, the identity just isn't
// allowed (wrong Google account / member hitting an owner-only route).
export const rejectForbidden = async (): Promise<never> => {
    throw new ForbiddenError("not the sandbox owner");
};

// A JSON POST against the in-process app, for the plain (non-oRPC) routes.
export const postJson = async (app: Hono<AppEnv>, path: string, body?: unknown): Promise<Response> =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

export const errorCode = async (run: Promise<unknown>): Promise<string | undefined> => {
    try {
        await run;
    } catch (error) {
        return (error as { code?: string }).code;
    }
    return undefined;
};

export const collect = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
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
export const runAgentTurn = async (
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

// A translator-backed config and a proxy with a connected Codex account — the pair every subscription-path
// turn test stands on, in the daemon's own shape.
export const withTranslator = { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local-bearer" } };
export const codexConnectedProxy = {
    accounts: async () => ({ codex: [{ name: "codex-user.json", label: "user@example.com" }], grok: [], kimi: [], gemini: [] }),
    connect: async () => ({ url: "", code: "", state: "", flow: "device" as const }),
    complete: async () => {},
    disconnect: async () => {},
    models: async () => [],
};

/* A client for ONE feature's routes, over that feature's own deps.
 *
 * `clientFor(createApp(services(...)))` builds the whole daemon to ask a question about one route: it needs a
 * hundred-and-thirty-member Services, and every service the daemon grows lands in the blast radius of a suite
 * that never mentions it. A route factory that declares what it reads (composition.ts, "WHAT A MODULE SHOULD
 * TAKE OF IT") can be stood up on exactly that — a plain object literal the compiler checks in full, with no
 * stand-in and nothing unstubbed to reach past.
 *
 * The app-level middleware is deliberately absent: auth, CORS and the boot gate belong to the app and are
 * tested there (app.integration.test.ts). What is left here is the route and its own deps. */
export const routesClient = <TContract extends AnyContractRouter>(contract: TContract, router: AnyRouter): ContractRouterClient<TContract> => {
    const handler = new OpenAPIHandler(router);
    return createORPCClient(
        new OpenAPILink(contract, {
            url: "http://sandbox",
            fetch: async (request) => {
                const url = new URL(request.url);
                const context: OrpcContext = { headers: request.headers, method: request.method, url: url.pathname + url.search };
                const { response } = await handler.handle(request, { context });
                return response ?? new Response("no matching procedure", { status: 404 });
            },
        }),
    );
};
