import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ROOT, STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { CredentialGate } from "@intentic/sandbox-contract";
import { capabilitiesOf, DEFAULT_SAFETY_POLICY, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { portSlotsFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { unstubbed } from "@intentic/testing";
import { createAuthConnections } from "../auth/connections.js";
import { createPasskeyCeremonies } from "../auth/passkeys/passkey-store.js";
import type { ControlScope } from "../auth/tokens/control-tokens.js";
import { memoryDoorTokens } from "../auth/tokens/door-tokens.js";
import { createMediaTickets } from "../auth/tokens/media-tickets.js";
import { createWsTickets } from "../auth/tokens/ws-tickets.js";
import { type Services, wireReactions } from "../composition.js";
import { createLogger } from "../logger.js";
import { createAnnouncer } from "../system/boot/announce.js";
import { createBootTracker } from "../system/boot/boot.js";
import { createPerfTracker } from "../system/resources/perf.js";
import { providerReadiness } from "../agent/providers/provider-registry.js";
import { budgetOn } from "../agent/run/turn/turn-plan.testing.js";
import { PROVIDER_MODULES, RUNTIME_ADAPTERS } from "../runtimes/runtime-table.js";
import { createReachReporter } from "../system/listeners/reach-report.js";
import { enrolledFleet, syncPairBurnPath, type SyncMode } from "../hosts/desktop-sync.js";
import { outboxStreamFor } from "../webchat/webchat-outbox.js";
import { createPortForwards } from "../ports/port-forwards.js";
import { rejectAuth } from "./route-client.testing.js";
import { fakeFiles, fakeHistory, fakeProcesses, fakeServiceProcesses } from "./route-fakes.testing.js";
import {
    memoryAutomationsStore,
    memoryCapabilitiesStore,
    memoryDismissalsStore,
    memoryMintedStore,
    memoryPasskeyStore,
    memoryPersonasStore,
    memoryAreasStore,
    memorySecretVault,
    memoryThreadSessionsStore,
} from "./route-stores.testing.js";
import { createCredentialGrants } from "../secrets/credential-grants.js";
import type { SecretUse } from "../secrets/secret-uses.js";
import { deriveBytes } from "../derived/derived-blob.js";
import { deriveText, readDerivedText } from "../derived/derived-text.js";
import { sidecarStatus } from "../derived/sidecar-service.js";
import { claudeStoreOf } from "../sessions/session-store.js";
import { openSearchIndex } from "../sessions/search-index.js";
import { IN_MEMORY } from "@intentic/base/sqlite";
import { toolChildrenOf, transcriptPageOf } from "../sessions/agent-transcript.js";
import { spokenLinesOf } from "../sessions/transcript-search.js";
import { pairings } from "../peers/enrollment.js";
import { createTerminalRunner } from "../terminal/terminal-run.js";
import { fleetStoreOver, memoryFleet, noIsolation, testConfig, testTurnMounts } from "../testing.js";
import { sqliteAgentsStore } from "../conversations/registry/agents-store.js";
import { openConversationsDb } from "../store/conversations-db.js";
import { conversationUnits } from "../store/conversation-units.js";
import { stateRelPath } from "../state-paths.js";
import { workspacePaths } from "../workspace/workspace.js";
import { turnDoors } from "../agent/run/turn/turn-doors.js";
import { streamAgent } from "../agent/run/stream-agent.js";
import { createDomainEvents } from "../seams/domain-events.js";
import { parkedCards } from "../conversations/actor/parked-cards.js";

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
    const area = (providerName: string, models: { id: string; label: string }[]): Services["minted"]["meta"] => {
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
        meta: area("Meta", [{ id: "muse-spark-1.2", label: "Muse Spark 1.2" }]),
        zai: area("Z.ai", [{ id: "glm-5.3", label: "GLM-5.3" }]),
    };
};

// No project is red here, so no red streak is kept.
const noStreaks = async (): Promise<Record<string, never>> => ({});

export const services = (overrides: ServiceOverrides = {}): Services => {
    const { auth, git, usage, claudeStore, cliProxy, sandboxSettings, iq, ...rest } = overrides;
    // Real registry over an in-memory conversations database, with every conversation's directory under the suite's own
    // history root; worktree git stays stubbed, hoisted so workspaceScope shares this instance.
    const conversationsDb = openConversationsDb(IN_MEMORY);
    const units = conversationUnits((rest.config ?? testConfig).historyRoot, sqliteAgentsStore(conversationsDb).has);
    const { agents, conversations } = memoryFleet(fleetStoreOver(conversationsDb, units));
    // The cards a suite's turns park on, over the same actors, so a reply through the routes finds them.
    const cards = parkedCards(conversations);
    const workspace = workspacePaths(WORKSPACE_ROOT);
    // Real pairing table so mint and redeem share one implementation, following the test's own history root.
    const syncPairings = pairings<SyncMode>(syncPairBurnPath((rest.config ?? testConfig).historyRoot));
    // The phrase index these suites search through: production schema and SQL, over nothing.
    const testSaid = openSearchIndex(IN_MEMORY);
    // Completed by unstubbed: only what these suites rely on appears below; anything else names itself if reached.
    // Shared by the store and the ceremonies over it, so a passkey a test registers is one the same suite can sign in with.
    const passkeyStore = overrides.passkeys ?? memoryPasskeyStore();
    const merged: Services = unstubbed<Services>("services", {
        config: testConfig,
        logger: createLogger(testConfig),
        // A box with room, stated rather than measured, for the admission gate every turn route passes through. The
        // real reading is of live cgroup files, and since it counts swap (workload/resource-budget.ts) a
        // suite running on a machine that is genuinely full refuses turns these tests are asserting the shape of.
        resources: budgetOn(),
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
            isToolPath: () => false,
            verifyExtensionToken: () => undefined,
            grantFor: (extension) => `extension-token-${extension.id}`,
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
                const scope = { ict_valid: "editor", "ict_read-token": "read", "ict_drive-token": "drive", "ict_land-token": "land" }[presented] as
                    ControlScope | undefined;
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
        // No platform to ask, which is the ordinary state under test and the one an export has to survive: a bundle
        // packed here simply carries no display name or logo. A test that cares overrides this.
        presentation: async () => undefined,
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
        // No areas by default: the unfenced workspace, which is what every member row without them already means.
        areas: memoryAreasStore(),
        automations: memoryAutomationsStore(),
        // No held wakes: agents.list projects them as `held`, and no suite here holds one.
        heldWakes: {
            list: async () => [],
            get: async () => undefined,
            add: async (approval) => ({ ...approval, id: "held-1" }),
            remove: async () => false,
        },
        // Inert: every dispatched turn files what it was told, and no suite here reads it back.
        promptRecord: { record: async () => {}, of: async () => undefined },
        conversationsDb,
        conversationUnits: units,
        // Inert: every fire path writes an in-flight entry and clears it; nothing here resumes.
        turnJournal: {
            list: async () => [],
            recordTurn: async () => {},
            recordFire: async () => {},
            clearTurn: async () => {},
            clearFire: async () => {},
        },
        // In-memory: every inbound fire resolves its conversation through this; suites only need consistent answers.
        threadSessions: memoryThreadSessionsStore((conversationId) => agents.entry(conversationId)?.archivedAt !== undefined),
        activity: { append: async () => {}, list: async () => [] },
        // The main line's verdicts: nothing checked yet. Every planned turn that owes the checks-after-landing note reads
        // them, and GET /workspace/mainline serves them.
        verifyStore: unstubbed<Services["verifyStore"]>("verifyStore", { read: async () => ({ projects: {}, runs: [] }), lands: async () => ({}), streaks: noStreaks }),
        // Nothing is checked after a land here: the land check's own suite stands it up (verify-deps.integration.test.ts).
        landCheck: unstubbed<Services["landCheck"]>("landCheck", { enqueue: () => {}, current: () => undefined, ahead: async () => false }),
        // Nothing pushed yet: GET /workspace/mainline serves the pushes beside the verdicts.
        pushChecks: unstubbed<Services["pushChecks"]>("pushChecks", {
            store: unstubbed<Services["pushChecks"]["store"]>("pushChecks.store", { read: async () => ({ pushes: [], seen: [] }) }),
        }),
        usage: unstubbed("usage", { record: async () => {}, rollup: async () => [], turns: async () => [], ...usage }),
        // Schema's own defaults: parsing an empty object is exactly what an unwritten settings file reads as.
        sandboxSettings: unstubbed("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({}),
            set: async () => {},
            ...sandboxSettings,
        }),
        // Shipped policy: a planned turn snapshots it for the judge, so every route running a turn reads it.
        safetyPolicy: unstubbed("safetyPolicy", { text: async () => DEFAULT_SAFETY_POLICY }),
        // No connected device, which is what the daemon answers with no host card granted; every planned turn asks,
        // so every route running a turn needs it.
        hostReach: async () => undefined,
        // Same for the owner's own browsers: none connected, asked by every planned turn.
        webextReach: async () => undefined,
        // Leased by every planned turn: its browsers, peers and extension cards mount here.
        ...testTurnMounts(),
        // Both composed exactly as composition.ts composes them, over this harness's own history root and stores, so a
        // suite exercises the real reader and the real queue rather than a second description of them.
        syncFleet: () => enrolledFleet((rest.config ?? testConfig).historyRoot),
        outboxStreamFor: (origin) => outboxStreamFor(merged, origin),
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
        accountUsage: { read: async () => ({}), record: async () => {}, markUnread: async () => undefined, clear: async () => {} },
        // Nothing to sweep: reading one needs a live OAuth endpoint; writes are swallowed like the store's.
        headroom: {
            refresh: async () => {},
            held: () => [],
            parked: async () => false,
            park: async () => {},
            record: async () => {},
            clear: async () => {},
            read: async () => ({}),
            onChange: () => () => {},
            start: () => () => {},
        },
        // Nothing refused yet; both writes sit on the turn path, so any turn-running test touches this store.
        providerRefusals: { read: async () => ({}), record: async () => {}, clear: async () => {}, onChange: () => () => {} },
        // Nothing cooling; the write sits on the routed rate-limit path, so any refused routed turn touches this store.
        modelCooldowns: { cooling: async () => new Map(), record: async () => {} },
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
            // Nothing connected, so nothing to take out of the rotation; the account list calls this on every read.
            benchUnusable: async () => [],
            ...cliProxy,
        }),
        codexHome: `${WORKSPACE_ROOT}/${stateRelPath(".intentic/secrets/auth/", "codex")}`,
        codexThreadExists: async () => true,
        providerCatalogs: testProviderCatalogs,
        // The real tables: which runtime a pair reaches and which module answers for a provider are facts about the
        // product, not stand-ins. Readiness is swept through `merged`, so it asks this suite's stores.
        providerModules: PROVIDER_MODULES,
        adapters: RUNTIME_ADAPTERS,
        providerReadiness: () => providerReadiness(merged),
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
            live: async () => [{ id: "gemini-pro-agent", label: "Gemini Pro Agent", inputModalities: ["text"] }],
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
            scratchOf: async () => [],
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
        conversations,
        cards,
        // Inert: archive/discard hard-stop on every press; a route suite has no tmux, processes or browsers to reap.
        reaper: { start: () => {}, stop: () => {}, sweep: async () => {}, reapConversation: async () => {}, metrics: () => ({}) },
        agentWorktrees: {
            conversationDir,
            worktreeDir: (id, repo) => (repo === "root" ? `${HISTORY_ROOT}/worktrees/${id}` : `${HISTORY_ROOT}/worktrees/${id}/${repo}`),
            mainDir: (repo) => (repo === "root" ? ABSENT_MAIN : join(ABSENT_MAIN, repo)),
            exists: async () => false,
            // Live checkout standing on its own branch: routes read the worktree path, the steady state these fakes
            // model, and nothing has strayed off it.
            attached: async () => true,
            elsewhere: async () => [],
            snapshot: async () => [{ repo: "root", base: "a".repeat(40) }],
            sessionStore: (entry) => claudeStoreOf(ABSENT_MAIN, HISTORY_ROOT, entry),
            ensure: async (id) => ({
                cwd: `${HISTORY_ROOT}/worktrees/${id}`,
                branch: `agent/${id}`,
                repos: [{ repo: "root", base: "a".repeat(40) }],
                fenced: false,
                elsewhere: [],
            }),
            remove: async () => {},
            retire: async () => {},
            reapRepoCheckout: async () => {},
            prune: async () => {},
            withRepoLock: (_repo, task) => task(),
            repoBusy: () => false,
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
        // The real readers: a shadow is read off disk, so a fake here would only test the fake.
        derived: { read: readDerivedText, derive: deriveText, deriveBytes, status: sidecarStatus },
        workspaceTree: async () => ({ root: WORKSPACE_ROOT, tree: [], hidden: 0, barren: [] }),
        workspaceTreeChanged: () => undefined,
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
        // Real ceremonies over an empty memory store, every origin allowed: a suite that registers a passkey drives the
        // actual verifier, and one that only lists sees nothing.
        passkeys: passkeyStore,
        passkeyCeremonies: createPasskeyCeremonies({ store: passkeyStore, originAllowed: () => true, sandboxId: "test-sandbox", sandboxName: "test" }),
        // Loopback unless a test asks for the exposed daemon: it's the key's absence, not an override of `undefined`,
        // that means loopback. CORS is separate, emitted in every mode from config.webOrigin.
        auth:
            auth === undefined
                ? undefined
                : {
                      authorize: rejectAuth,
                      authorizeProven: rejectAuth,
                      authorizeOwner: rejectAuth,
                      authorizeRetirement: rejectAuth,
                      authorizeRecovery: rejectAuth,
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
        // actors' `sessionIdOf`. Reads through `merged`, so an override of `sessions.read` or `conversations` applies
        // here too.
        transcripts: {
            read: async (agent) => {
                const profile = merged.agents.entry(agent.id)?.profile;
                const sessionId =
                    profile !== undefined && capabilitiesOf(profile.provider, profile.harness).runtime === "claude-code"
                        ? merged.conversations.sessionIdOf(agent.id)
                        : undefined;
                return sessionId === undefined ? [] : merged.sessions.read(merged.workspace.root, sessionId);
            },
            // The fake keeps no out-of-line bytes, so what a page reads of each row is the row.
            rows: async (agent) => merged.transcripts.read(agent),
            // Derived from `read` via production's own window rule, so a route test can't disagree with the daemon.
            page: async (agent, window = {}) => transcriptPageOf(await merged.transcripts.read(agent), window),
            // Same door, same source: a route test asking for a delegation's calls gets what the record-backed route would.
            toolChildren: async (agent, toolId) => toolChildrenOf(await merged.transcripts.read(agent), toolId),
            lastSaid: async (agent) => (await merged.transcripts.read(agent)).findLast((row) => row.role === "assistant")?.text,
            // Inert but present: a fork's first turn opens through this door, so a fake without it fails every forkOf
            // turn with a bare 500 that no type check catches.
            fork: async () => {},
            append: async () => {},
            // Derived from `read`, so the fake's answers can't disagree with each other. `count` is on the turn path
            // (each checkpoint's index), so omitting it fails every agent.run test silently.
            count: async (agent) => (await merged.transcripts.read(agent)).length,
            // Inert, but answers what a real truncate would have dropped, so a rewind test can assert on the count.
            truncate: async (agent, keep) => Math.max(0, (await merged.transcripts.read(agent)).length - keep),
            migrate: async () => {},
            sweep: async () => {},
        },
        // The real index, in memory: a fake here would mean no suite ever runs the actual query, folding or ordering.
        // `search` syncs from `transcripts.read` first, since `append` is inert.
        saidIndex: {
            search: async (needle, kind, caseSensitive) => {
                if (kind === "conversation") {
                    for (const id of merged.agents.ids()) {
                        const entry = merged.agents.entry(id);
                        if (entry !== undefined) {
                            await testSaid.put(id, "conversation", "test", spokenLinesOf(await merged.transcripts.read(entry)));
                        }
                    }
                }
                return testSaid.search(needle, kind, caseSensitive);
            },
            backfill: async () => {},
            indexing: () => false,
        },
        purgeConversationState: async () => {},
        // The engine's own doors over these services, as composition binds them, and the reactions it subscribes.
        events: createDomainEvents((name, error) => merged.logger.warn({ err: error, event: name }, "domain event: a reaction failed")),
        turns: turnDoors(
            () => merged,
            (input, signal) => streamAgent(merged, input, signal),
        ),
        ...rest,
    });
    wireReactions(merged);
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

// What one turn wrote to the stores it runs and settles into, in call order per store; `recordingTurnStores` fills it.
export interface TurnWrites {
    readonly activity: Parameters<Services["activity"]["append"]>[0][];
    readonly usage: Parameters<Services["usage"]["record"]>[0][];
    readonly providerRefusals: { readonly provider: string; readonly refusal: Parameters<Services["providerRefusals"]["record"]>[1] }[];
    readonly refusalsCleared: { readonly provider: string; readonly account: string | undefined }[];
    readonly headroomRefreshes: Parameters<Services["headroom"]["refresh"]>[0][];
    readonly headroomRecords: { readonly provider: string; readonly account: string; readonly usage: Parameters<Services["headroom"]["record"]>[2] }[];
    readonly seatsRefused: { readonly account: string; readonly reason: string }[];
    readonly seatsCleared: string[];
    readonly modelRefusals: { readonly provider: string; readonly model: string; readonly refusal: Parameters<Services["modelRefusals"]["record"]>[2] }[];
    readonly modelCooldowns: { readonly provider: string; readonly model: string; readonly cooldown: Parameters<Services["modelCooldowns"]["record"]>[2] }[];
    readonly observedLimits: {
        readonly provider: string;
        readonly account: string;
        readonly model: string;
        readonly limit: Parameters<Services["observedLimits"]["record"]>[3];
    }[];
    readonly snapshots: { readonly trigger: Parameters<Services["history"]["snapshot"]>[0]; readonly label?: string }[];
    readonly checkpoints: {
        readonly conversationId: string;
        readonly index: number;
        readonly checkpoint: Parameters<Services["turnCheckpoints"]["record"]>[2];
    }[];
    readonly ruleFirings: { readonly rule: string; readonly at: number }[];
    // Every span the turn timed, by name and attributes: which mode a land ran in is only visible here.
    readonly spans: { readonly name: string; readonly attrs: unknown }[];
}

// The stores a turn writes while it runs and as it settles, each recording every write and otherwise answering like an
// empty one, and the spans it times; `snapshot` is the id every history capture answers with. Spread `overrides` into
// `services`.
export const recordingTurnStores = (options: { readonly snapshot?: string } = {}): { readonly writes: TurnWrites; readonly overrides: ServiceOverrides } => {
    const writes: TurnWrites = {
        activity: [],
        usage: [],
        providerRefusals: [],
        refusalsCleared: [],
        headroomRefreshes: [],
        headroomRecords: [],
        seatsRefused: [],
        seatsCleared: [],
        modelRefusals: [],
        modelCooldowns: [],
        observedLimits: [],
        snapshots: [],
        checkpoints: [],
        ruleFirings: [],
        spans: [],
    };
    // The real tracker, so a timed step still runs and still reports; only what was timed is noted beside it.
    const { perf } = services();
    return {
        writes,
        overrides: {
            activity: { append: async (event) => void writes.activity.push(event), list: async () => [] },
            usage: { record: async (turn) => void writes.usage.push(turn) },
            providerRefusals: {
                read: async () => ({}),
                record: async (provider, refusal) => void writes.providerRefusals.push({ provider, refusal }),
                clear: async (provider, account) => void writes.refusalsCleared.push({ provider, account }),
                onChange: () => () => {},
            },
            // Every other member answers as the inert headroom above does.
            headroom: {
                ...services().headroom,
                refresh: async (refresh) => void writes.headroomRefreshes.push(refresh),
                record: async (provider, account, usage) => void writes.headroomRecords.push({ provider, account, usage }),
            },
            claudeSeats: {
                read: async () => ({}),
                refuse: async (account, reason) => void writes.seatsRefused.push({ account, reason }),
                clear: async (account) => void writes.seatsCleared.push(account),
            },
            modelRefusals: { refused: async () => new Set(), record: async (provider, model, refusal) => void writes.modelRefusals.push({ provider, model, refusal }) },
            modelCooldowns: {
                cooling: async () => new Map(),
                record: async (provider, model, cooldown) => void writes.modelCooldowns.push({ provider, model, cooldown }),
            },
            observedLimits: {
                spent: async () => ({}),
                record: async (provider, account, model, limit) => void writes.observedLimits.push({ provider, account, model, limit }),
                clear: async () => {},
            },
            history: fakeHistory({
                snapshot: async (trigger, label) => {
                    writes.snapshots.push({ trigger, ...(label === undefined ? {} : { label }) });
                    return options.snapshot;
                },
            }),
            turnCheckpoints: {
                record: async (conversationId, index, checkpoint) => void writes.checkpoints.push({ conversationId, index, checkpoint }),
                of: async () => undefined,
                all: async () => new Map(),
                truncate: async () => {},
            },
            ruleFirings: { get: async () => ({}), stamp: async (rule, at) => void writes.ruleFirings.push({ rule, at }) },
            perf: {
                ...perf,
                track: (name, attrs, fn) => {
                    writes.spans.push({ name, attrs });
                    return perf.track(name, attrs, fn);
                },
            },
        },
    };
};
