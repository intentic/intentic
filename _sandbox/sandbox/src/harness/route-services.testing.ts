import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ROOT, STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { CredentialGate } from "@intentic/sandbox-contract";
import { capabilitiesOf, DEFAULT_SAFETY_POLICY, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { portSlotsFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { unstubbed } from "@intentic/testing";
import { createAgentsRegistry } from "../agents/registry/agents-registry.js";
import { createAuthConnections } from "../auth/connections.js";
import type { ControlScope } from "../auth/control-tokens.js";
import { memoryDoorTokens } from "../auth/door-tokens.js";
import { createMediaTickets } from "../auth/media-tickets.js";
import { createWsTickets } from "../auth/ws-tickets.js";
import type { Services } from "../composition.js";
import { createLogger } from "../logger.js";
import { createAnnouncer } from "../platform/boot/announce.js";
import { createBootTracker } from "../platform/boot/boot.js";
import { createPerfTracker } from "../platform/resources/perf.js";
import { createReachReporter } from "../platform/listeners/reach-report.js";
import { syncPairBurnPath, type SyncMode } from "../platform/sync.js";
import { createPortForwards } from "../ports/port-forwards.js";
import { rejectAuth } from "./route-client.testing.js";
import { fakeFiles, fakeHistory, fakeProcesses, fakeServiceProcesses } from "./route-fakes.testing.js";
import {
    memoryAutomationsStore,
    memoryCapabilitiesStore,
    memoryDismissalsStore,
    memoryMintedStore,
    memoryPersonasStore,
    memorySecretVault,
    memoryThreadSessionsStore,
} from "./route-stores.testing.js";
import { createCredentialGrants } from "../secrets/credential-grants.js";
import type { SecretUse } from "../secrets/secret-uses.js";
import { IN_MEMORY, openSearchIndex } from "../sessions/search-index.js";
import { windowOf } from "../sessions/transcript-record.js";
import { spokenLinesOf } from "../sessions/transcript-search.js";
import { pairings } from "../store/enrollment.js";
import { createTerminalRunner } from "../terminal/terminal-run.js";
import { noIsolation, testConfig } from "../testing.js";
import { stateRelPath } from "../workspace/layout/state-paths.js";
import { workspacePaths } from "../workspace/workspace.js";

// Composes the daemon's `Services` for route suites driving its HTTP surface, split by what a suite reaches for: stores
// (route-stores.testing.ts), recording fakes (route-fakes.testing.ts), the client and auth stubs
// (route-client.testing.ts), and the turn runner (route-turns.testing.ts). Not part of the build.

// Never-created path under tmpdir, absent everywhere; naming the real /work would vary by machine.
const ABSENT_MAIN = join(tmpdir(), "intentic-absent-main");

// Where a conversation's checkout lives, shared by the worktree fake and the scope composed from it.
const conversationDir = (id: string): string => `${HISTORY_ROOT}/worktrees/${id}`;

// Seams too big to spell out fully (`git` has 37 methods, a route touches two); declared Partial and completed by
// `unstubbed`, so a growing interface never rots this file.
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

// Never-empty catalog fakes so a native turn always resolves a model; spread this and replace one row to test a single
// provider differently. Enumerated, not derived, since a double is a claim about behaviour, not a derivation.
export const testProviderCatalogs: Services["providerCatalogs"] = {
    claude: { models: async () => ({ models: [{ id: "opus", label: "Opus" }], default: "opus" }) },
    codex: { models: async () => ({ models: [{ id: "gpt-5.1", label: "GPT 5.1" }], default: "gpt-5.1" }) },
    cursor: { models: async () => ({ models: [{ id: "auto", label: "Auto" }], default: "auto" }) },
    grok: { models: async () => ({ models: [{ id: "grok-4", label: "Grok 4" }], default: "grok-4" }) },
    kimi: { models: async () => ({ models: [{ id: "kimi-k3", label: "Kimi K3" }], default: "kimi-k3" }) },
    gemini: { models: async () => ({ models: [{ id: "gemini-pro-agent", label: "Gemini Pro Agent" }], default: "gemini-pro-agent" }) },
    meta: { models: async () => ({ models: [{ id: "muse-spark-1.2", label: "Muse Spark 1.2" }], default: "muse-spark-1.2" }) },
    zai: { models: async () => ({ models: [{ id: "glm-5.3", label: "GLM-5.3" }], default: "glm-5.3" }) },
};

// Nothing connected by default (Meta/Z.ai turns are refused); a factory, not a constant, since the store holds state
// suites must not share. Sign-in refuses; a suite needing a real handshake passes its own driver.
export const testMintedSlices = (): Services["minted"] => {
    const slice = (providerName: string, models: { id: string; label: string }[]): Services["minted"]["meta"] => {
        const catalog = { models: async () => ({ models, default: models[0]?.id ?? "" }), forget: () => {} };
        return {
            store: memoryMintedStore(providerName),
            login: async () => {
                throw new Error(`${providerName} sign-in is not available in tests: pass a driver`);
            },
            catalogOf: () => catalog,
            catalog,
        };
    };
    return {
        meta: slice("Meta", [{ id: "muse-spark-1.2", label: "Muse Spark 1.2" }]),
        zai: slice("Z.ai", [{ id: "glm-5.3", label: "GLM-5.3" }]),
    };
};

export const services = (overrides: ServiceOverrides = {}): Services => {
    const { auth, git, usage, claudeStore, cliProxy, sandboxSettings, iq, ...rest } = overrides;
    // Real registry, memory-backed; worktree git stays stubbed, hoisted so workspaceScope shares this instance.
    const agents = createAgentsRegistry(
        { load: async () => [], save: async () => {} },
        { of: () => "idle", refresh: async () => false, forget: () => {} },
        { of: () => undefined, refresh: async () => false, forget: () => {}, metrics: () => ({}) },
    );
    const workspace = workspacePaths(WORKSPACE_ROOT);
    // Real pairing table so mint and redeem share one implementation, following the test's own history root.
    const syncPairings = pairings<SyncMode>(syncPairBurnPath((rest.config ?? testConfig).historyRoot));
    // The phrase index these suites search through: production schema and SQL, over nothing.
    const testSaid = openSearchIndex(IN_MEMORY);
    // Completed by unstubbed: only what these suites rely on appears below; anything else names itself if reached.
    const merged: Services = unstubbed<Services>("services", {
        config: testConfig,
        logger: createLogger(testConfig),
        // No chain declared, so converged from birth; the gate itself is covered below with a declared chain.
        boot: createBootTracker(createLogger(testConfig)),
        // Real tracker: in-memory, unref'd summary timer, and request middleware records through it on every route.
        perf: createPerfTracker(createLogger(testConfig)),
        // Real but never started, so /health reads `off` on a daemon with nothing to announce to.
        announcer: createAnnouncer(testConfig, createLogger(testConfig)),
        // Same terms as announcer: never started, so /health reads `off` on a daemon with no public address to probe.
        reach: createReachReporter(testConfig, createLogger(testConfig)),
        workspace,
        syncPairings,
        // Empty memory shell, not the file store; a temp tree here would reclassify every suite as machine-touching.
        runtimeInstalls: {
            read: async () => ({ installs: [] }),
            record: async () => {},
            saveDrift: async () => {},
            decline: async () => {},
        },
        processes: fakeProcesses(),
        serviceProcesses: fakeServiceProcesses(),
        dependencies: unstubbed<Services["dependencies"]>("dependencies", {
            status: async () => [],
            issueAt: async () => undefined,
            requestInstall: async () => ({ projects: [], queued: [] }),
            reconcileLand: async () => undefined,
            watch: () => () => {},
            subscribe: () => () => {},
            subscribeFailures: () => () => {},
        }),
        // Real slot table with a no-dial probe; scanPorts is empty so tests opt into listeners explicitly.
        portForwards: createPortForwards(portSlotsFromToken("tok"), async () => "http"),
        scanPorts: async () => [],
        terminalRun: createTerminalRunner(),
        // Real: pure in-memory state with no side effects; a fake would only re-implement the single-use rule.
        wsTickets: createWsTickets(),
        // Real too: the path binding IS what /workspace/media checks, and a fake would only restate it.
        mediaTickets: createMediaTickets(),
        // Host simply not running, the honest default: extensions read `statusOf` per row, `/x` answers 503, no token
        // verifies. Real behaviour is covered by its own integration suite.
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
        // The /vpn-scoped secret the in-container CLI presents; fixed here, minted per boot in production.
        agentToken: "agent-secret",
        // One fixed token per scope, named for it, so a test presents the reach it means; `ict_valid` is editor.
        // Doors' credentials, in memory; a test seeds one with `ensure`, as an operator copies the URL off the row.
        doorTokens: memoryDoorTokens(),
        controlTokens: {
            mint: async (label, scope) => ({ id: "ct-1", token: `ict_minted-${scope}-${label}` }),
            resolve: async (presented) => {
                const scope = ({ ict_valid: "editor", "ict_read-token": "read", "ict_drive-token": "drive", "ict_land-token": "land" })[presented] as
                    | ControlScope
                    | undefined;
                return scope === undefined ? undefined : { id: `ct-${scope}`, label: `${scope} token`, scope };
            },
            touch: async () => undefined,
            list: async () => [{ id: "ct-1", label: "test", scope: "editor", createdAt: 0 }],
            revoke: async () => true,
        },
        info: undefined,
        tools: [],
        capabilities: memoryCapabilitiesStore(),
        // No dev platform, no TLS to terminate; a fake since compat entries read it on every capability write.
        platformTunnel: { url: () => undefined, ready: Promise.resolve(), close: () => {} },
        // Read while composing every turn's environment, not just by settings routes, so it's a fake, not unstubbed.
        extensionSecretVault: memorySecretVault(),
        // Nothing stored or spent; in-memory, not unstubbed, since the inventory route reads it every call.
        secretRegistry: async () => [],
        secretUses: (() => {
            const uses: SecretUse[] = [];
            return {
                record: async (use: SecretUse) => {
                    uses.push(use);
                },
                all: async () => uses,
            };
        })(),
        // Nothing gated, the state before an owner names an approver; a suite that wants one writes it through the
        // store. In-memory, not unstubbed, since inventory reads it every call.
        credentialGates: (() => {
            let gates: CredentialGate[] = [];
            return {
                list: async () => gates,
                set: async (gate: CredentialGate) => {
                    gates = [...gates.filter((entry) => entry.subject !== gate.subject), gate];
                },
                remove: async (subject: string) => {
                    gates = gates.filter((entry) => entry.subject !== subject);
                },
                forName: async () => undefined,
                forCapability: async () => undefined,
            };
        })(),
        credentialGrants: createCredentialGrants(),
        // Nothing gated above, so this allows everything and asks nobody; tested where the real gate lives.
        credentialGate: { check: async () => ({ allow: true as const }) },
        // Nothing declined by default: every suite wants the catalog answering as on a sandbox nobody's said no on.
        capabilityDismissals: memoryDismissalsStore(),
        // No personas by default: an unattended turn reaches no logged-in account, since an unpinned wake is denied
        // rather than waved through. A suite wanting one builds the card and its browser capability.
        personas: memoryPersonasStore(),
        automations: memoryAutomationsStore(),
        // No held wakes: agents.list projects them as `held`, and no suite here holds one.
        heldWakes: {
            list: async () => [],
            get: async () => undefined,
            add: async (approval) => ({ ...approval, id: "held-1" }),
            remove: async () => false,
        },
        // Inert: every fire path writes an in-flight entry and clears it; nothing here resumes.
        turnJournal: {
            list: async () => [],
            recordTurn: async () => {},
            recordFire: async () => {},
            clearTurn: async () => {},
            clearFire: async () => {},
        },
        // In-memory: every inbound fire resolves its conversation through this; suites only need consistent answers.
        threadSessions: memoryThreadSessionsStore(),
        activity: { append: async () => {}, list: async () => [] },
        usage: unstubbed("usage", { record: async () => {}, rollup: async () => [], turns: async () => [], ...usage }),
        // Schema's own defaults: parsing an empty object is exactly what an unwritten settings file reads as.
        sandboxSettings: unstubbed("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({}),
            set: async () => {},
            ...sandboxSettings,
        }),
        // Shipped policy: a planned turn snapshots it for the judge, so every route running a turn reads it.
        safetyPolicy: unstubbed("safetyPolicy", { text: async () => DEFAULT_SAFETY_POLICY }),
        // Connected by default so the /agent guard doesn't short-circuit turns under test; override for disconnected.
        claudeStore: unstubbed("claudeStore", {
            read: async (id) => (id === "default" ? { id: "default", label: "Claude", connectedAt: 0, accessToken: "tok-xyz" } : undefined),
            write: async () => {},
            clear: async () => {},
            list: async () => [{ id: "default", label: "Claude", connectedAt: 0 }],
            withRefreshLock: async (_id, act) => act(),
            logger: createLogger(testConfig),
            ...claudeStore,
        }),
        // Every seat is live: the picker skips only an account no org will serve; an answered turn clears its hold.
        claudeSeats: { read: async () => ({}), refuse: async () => {}, clear: async () => {} },
        // No usage measured by default, as if the window just reset.
        accountUsage: { read: async () => ({}), record: async () => {}, clear: async () => {} },
        // Nothing to sweep: reading one needs a live OAuth endpoint; writes are swallowed like the store's.
        headroom: {
            refresh: async () => {},
            record: async () => {},
            clear: async () => {},
            read: async () => ({}),
            onChange: () => () => {},
            start: () => () => {},
        },
        // Nothing refused yet; both writes sit on the turn path, so any turn-running test touches this store.
        providerRefusals: { read: async () => ({}), record: async () => {}, clear: async () => {}, onChange: () => () => {} },
        // Nothing connected in the translator by default; the Codex subscription suite overrides this.
        cliProxy: unstubbed("cliProxy", {
            accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [] }),
            connect: async () => ({ url: "", code: "", state: "", flow: "device" as const }),
            complete: async () => {},
            disconnect: async () => {},
            models: async () => [],
            headroom: { targets: async () => [] },
            sharedUsageKey: async () => undefined,
            turnLimit: async () => ({ spent: 0, withHeadroom: 0 }),
            ...cliProxy,
        }),
        codexHome: `${WORKSPACE_ROOT}/${stateRelPath(".intentic/secrets/auth/", "codex")}`,
        codexThreadExists: async () => true,
        providerCatalogs: testProviderCatalogs,
        // Held directly too: the native Codex turn's resolution and self-heal both read this, not the table above.
        codexModels: { models: async () => ({ models: [{ id: "gpt-5.1", label: "GPT 5.1" }], default: "gpt-5.1" }), record: async () => {} },
        // Per-provider catalogs the provider modules read directly; mirrors testProviderCatalogs row for row, so
        // overriding one without the other misses the seam.
        claudeModels: { models: async () => ({ models: [{ id: "opus", label: "Opus" }], default: "opus" }) },
        geminiModels: {
            models: async () => ({
                models: [{ id: "gemini-pro-agent", label: "Gemini Pro Agent", inputModalities: ["text"] }],
                default: "gemini-pro-agent",
            }),
        },
        kimiModels: { models: async () => ({ models: [{ id: "kimi-k3", label: "Kimi K3" }], default: "kimi-k3" }) },
        // Minted stores, sign-ins and catalogs: nothing connected, since no guard depends on them, unlike Claude's.
        minted: testMintedSlices(),
        // Nothing connected, unlike Claude's double: the /agent guard depends on Claude but nothing guards on Cursor,
        // so the honest default is unset up.
        cursorStore: {
            read: async () => undefined,
            write: async () => {},
            clear: async () => {},
            list: async () => [],
            credentials: async () => [],
            logger: createLogger(testConfig),
        },
        cursorModels: { models: async () => ({ models: [{ id: "auto", label: "Auto" }], default: "auto" }), item: async () => undefined },
        // Registered but never consulted: with no live turn the gate answers allow, same as an unwired hook service.
        cursorHooks: {
            start: async () => {},
            register: () => () => {},
            ready: () => false,
            paths: () => ({ socket: "", script: "", hooks: "" }),
            close: async () => {},
        },
        async *cursorAgent() {
            yield { kind: "done" };
        },
        history: fakeHistory(),
        async *agent() {
            yield { kind: "done" };
        },
        async *codexAgent() {
            yield { kind: "done" };
        },
        async *grokAgent() {
            yield { kind: "done" };
        },
        openCode: {
            client: async () => ({}) as never,
            stop: async () => {},
            events: async () => ({ stream: { async *[Symbol.asyncIterator]() {} } }),
            watch: async () => {},

            connected: async () => false,
            sessionExists: async () => true,
            xaiModels: async () => ({ models: [{ id: "grok-4", label: "Grok 4" }], default: "grok-4" }),
            recordModels: async () => {},
            disconnect: async () => {},
        },
        async *intentic() {},
        // Thirty-seven methods; routes below reach a dozen, the rest stay unstubbed and self-name if reached.
        git: unstubbed("git", {
            init: async () => {},
            status: async () => ({ branch: "main", dirty: false, files: [] }),
            listFiles: async () => [],
            commitAll: async () => false,
            clone: async () => {},
            changedFiles: async () => ({ conflicted: [], staged: [], unstaged: [], blobs: new Map() }),
            stagePaths: async () => {},
            stageAll: async () => {},
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
            // Not mid-anything, which is almost every repo almost always; a halted-repo test overrides this.
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
            stagedFileDiff: async () => ({}),
            unstagedFileDiff: async () => ({}),
            fileDiff: async () => ({}),
            ...git,
        }),
        agents,
        // Inert: archive/discard hard-stop on every press; a route suite has no tmux, processes or browsers to reap.
        reaper: { start: () => {}, stop: () => {}, sweep: async () => {}, reapConversation: async () => {}, metrics: () => ({}) },
        agentWorktrees: {
            conversationDir,
            worktreeDir: (id, repo) => (repo === "root" ? `${HISTORY_ROOT}/worktrees/${id}` : `${HISTORY_ROOT}/worktrees/${id}/${repo}`),
            mainDir: (repo) => (repo === "root" ? ABSENT_MAIN : join(ABSENT_MAIN, repo)),
            exists: async () => false,
            // Live checkout: routes read the worktree path, the steady state these fakes model.
            attached: async () => true,
            snapshot: async () => [{ repo: "root", base: "a".repeat(40) }],
            ensure: async (id) => ({
                cwd: `${HISTORY_ROOT}/worktrees/${id}`,
                branch: `agent/${id}`,
                repos: [{ repo: "root", base: "a".repeat(40) }],
            }),
            remove: async () => {},
            retire: async () => {},
            reapRepoCheckout: async () => {},
            prune: async () => {},
            withRepoLock: (_repo, task) => task(),
        },
        // Composed from the same two lookups the daemon uses, so an unscoped read is the shared tree just as in
        // production. Read through `merged`, not the locals, so redirecting `workspace` moves the file routes with it.
        workspaceScope: {
            get main() {
                return merged.workspace.root;
            },
            entry: (id) => merged.agents.entry(id),
            worktreeDir: conversationDir,
        },
        // Namespace isolation off, what a container without CAP_SYS_ADMIN gets: turns run straight in the worktree
        // path. isolation.integration.test.ts covers the plan when it IS available.
        turnIsolation: noIsolation(WORKSPACE_ROOT),
        // No agent has landed anything, so every changed file is the user's and `identify` has nobody to resolve.
        agentOrigins: { forRepo: async () => ({}), identify: () => ({}), metrics: () => ({}) },
        files: fakeFiles(),
        workspaceTree: async () => ({ root: WORKSPACE_ROOT, tree: [], hidden: 0, barren: [] }),
        // Inert resident search, no index, no rg; the search route test overrides `run` with a canned outcome.
        iq: unstubbed<Services["iq"]>("iq", {
            metrics: () => ({
                files: 0,
                generation: 0,
                dirtySequence: 0,
                appliedSequence: 0,
                revalidated: true,
                sweepAgeMs: 0,
                embedBacklog: 0,
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
            invalidateHealth: () => {},
            markDirty: () => {},
            warm: async () => ({ files: 0, symbols: 0, chunks: 0, embedded: 0, generation: 0, freshness: { state: "fresh" as const, ageMs: 0 } }),
            close: async () => {},
            ...iq,
        }),
        sessions: {
            list: async () => [],
            read: async () => [],
            // Empty is the documented fallback for no readable store: an interrupted turn recorded from its prompt
            // alone.
            readTail: async () => [],
            search: async () => [],
            exists: async () => true,
        },
        members: { list: async () => [], add: async () => {}, remove: async () => {} },
        // Loopback unless a test asks for the exposed daemon: it's the key's absence, not an override of `undefined`,
        // that means loopback. CORS is separate, emitted in every mode from config.webOrigin.
        auth:
            auth === undefined
                ? undefined
                : {
                      authorize: rejectAuth,
                      authorizeOwner: rejectAuth,
                      authorizeRetirement: rejectAuth,
                      mintSession: async () => ({ token: "sess-token", expiresAt: 0 }),
                      // Owner-only and destructive: an unstubbed call names itself rather than silently answering 200.
                      rotateSessions: async () => {
                          throw new Error("auth.rotateSessions was called, and this test did not stub it");
                      },
                      disableBrowserAccess: async () => {
                          throw new Error("auth.disableBrowserAccess was called, and this test did not stub it");
                      },
                      connections: createAuthConnections(),
                      ...auth,
                  },
        authRoot: `${WORKSPACE_ROOT}/${STATE_DIR}`,
        // Defaults to the claude-code-only shape production reads before a provider-native record exists, keyed off the
        // registry's `sessionIdOf`. Reads through `merged`, so an override of `sessions.read` or `agents` applies here
        // too.
        transcripts: {
            read: async (agent) => {
                const sessionId =
                    capabilitiesOf(agent.provider, agent.harness).runtime === "claude-code" ? merged.agents.sessionIdOf(agent.id) : undefined;
                return sessionId === undefined ? [] : merged.sessions.read(merged.workspace.root, sessionId);
            },
            // Derived from `read` via production's own window rule, so a route test can't disagree with the daemon.
            page: async (agent, window = {}) => windowOf(await merged.transcripts.read(agent), window),
            // Inert but present: a fork's first turn opens through this door, so a fake without it fails every forkOf
            // turn with a bare 500 that no type check catches.
            fork: async () => {},
            append: async () => {},
            // Derived from `read`, so the fake's answers can't disagree with each other. `count` is on the turn path
            // (each checkpoint's index), so omitting it fails every agent.run test silently.
            count: async (agent) => (await merged.transcripts.read(agent)).length,
            // Inert, but answers what a real truncate would have dropped, so a rewind test can assert on the count.
            truncate: async (agent, keep) => Math.max(0, (await merged.transcripts.read(agent)).length - keep),
        },
        // The real index, in memory: a fake here would mean no suite ever runs the actual query, folding or ordering.
        // `search` syncs from `transcripts.read` first, since `append` is inert.
        saidIndex: {
            search: async (needle, kind, caseSensitive) => {
                if (kind === "conversation") {
                    for (const id of merged.agents.ids()) {
                        const entry = merged.agents.entry(id);
                        if (entry !== undefined) {
                            testSaid.put(id, "conversation", "test", spokenLinesOf(await merged.transcripts.read(entry)));
                        }
                    }
                }
                return testSaid.search(needle, kind, caseSensitive);
            },
            backfill: async () => {},
            indexing: () => false,
        },
        purgeConversationState: async () => {},
        ...rest,
    });
    return merged;
};

// Translator config and a connected Codex proxy, the pair a subscription-path turn test needs.
export const withTranslator = { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local-bearer" } };
export const codexConnectedProxy = {
    accounts: async () => ({ codex: [{ name: "codex-user.json", label: "user@example.com" }], grok: [], kimi: [], gemini: [] }),
    connect: async () => ({ url: "", code: "", state: "", flow: "device" as const }),
    complete: async () => {},
    disconnect: async () => {},
    models: async () => [],
};
