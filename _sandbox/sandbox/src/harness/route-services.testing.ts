import { DEFAULT_SAFETY_POLICY, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { portSlotsFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { unstubbed } from "@intentic/testing";
import { type ProvidersFakeOverrides, providersSliceFake } from "../agent/providers/providers-slice.testing.js";
import { type AuthFakeOverrides, authSliceFake } from "../auth/auth-slice.testing.js";
import { automationsSliceFake } from "../automations/automations-slice.testing.js";
import { capabilitiesSliceFake } from "../capabilities/capabilities-slice.testing.js";
import { type Services, wireReactions } from "../composition.js";
import { conversationsSliceFake } from "../conversations/conversations-slice.testing.js";
import { deriveBytes } from "../derived/derived-blob.js";
import { deriveText, readDerivedText } from "../derived/derived-text.js";
import { sidecarStatus } from "../derived/sidecar-service.js";
import { extensionsSliceFake } from "../extensions/extensions-slice.testing.js";
import { type GitFakeOverrides, gitSliceFake } from "../git/git-slice.testing.js";
import { hostsSliceFake } from "../hosts/hosts-slice.testing.js";
import { createLogger } from "../logger.js";
import { createPortForwards } from "../ports/port-forwards.js";
import { processesSliceFake } from "../processes/processes-slice.testing.js";
import { type ClaudeFakeOverrides, claudeSliceFake } from "../runtimes/claude/claude-provider.testing.js";
import { codexSliceFake } from "../runtimes/codex/codex-provider.testing.js";
import { cursorSliceFake } from "../runtimes/cursor/cursor-provider.testing.js";
import { geminiSliceFake } from "../runtimes/gemini/gemini-provider.testing.js";
import { grokSliceFake } from "../runtimes/grok/grok-provider.testing.js";
import { kimiSliceFake } from "../runtimes/kimi/kimi-provider.testing.js";
import { mintedSliceFake } from "../runtimes/minted/minted-provider.testing.js";
import { secretsSliceFake } from "../secrets/secrets-slice.testing.js";
import { createDomainEvents } from "../seams/domain-events.js";
import { sessionsSliceFake } from "../sessions/sessions-slice.testing.js";
import { createAnnouncer } from "../system/boot/announce.js";
import { createBootTracker } from "../system/boot/boot.js";
import { createReachReporter } from "../system/listeners/reach-report.js";
import { resourcesSliceFake } from "../system/resources/resources-slice.testing.js";
import { testConfig, testTurnMounts } from "../testing.js";
import { outboxStreamFor } from "../webchat/webchat-outbox.js";
import { webextSliceFake } from "../webext/webext-slice.testing.js";
import { mainlineSliceFake } from "../workspace/deps/mainline-slice.testing.js";
import { type WorkspaceFakeOverrides, workspaceSliceFake } from "../workspace/workspace-slice.testing.js";
import { fakeHistory } from "./route-fakes.testing.js";
import { memoryAreasStore, memoryPersonasStore } from "./route-stores.testing.js";
import type { SliceFakeContext } from "./slice-fake.testing.js";

// Composes the daemon's `Services` for route suites driving its HTTP surface: each slice's members from that slice's
// own fake (`<slice>.testing.ts`, beside the slice), the members Services declares itself here, and what a suite
// reaches for beside them: stores (route-stores.testing.ts), recording fakes (route-fakes.testing.ts), the client and
// auth stubs (route-client.testing.ts), and the turn runner (route-turns.testing.ts). Not part of the build.

// Seams too big to spell out fully (`git` has 37 methods, a route touches two), each declared by its slice's fake:
// Partial, and completed by `unstubbed`, so a growing interface never rots a fake.
export type WideSeamOverrides = AuthFakeOverrides &
    GitFakeOverrides &
    ProvidersFakeOverrides &
    ClaudeFakeOverrides &
    WorkspaceFakeOverrides & { readonly sandboxSettings?: Partial<Services["sandboxSettings"]> | undefined };
export type ServiceOverrides = Partial<Omit<Services, keyof WideSeamOverrides>> & WideSeamOverrides;

// The members Services declares itself that no route suite drives, each empty or inert: nothing installed, tunnelled,
// presented, logged or left to reap. A factory, so each suite's services hold their own.
const inertOwnMembers = () =>
    ({
        // Empty memory shell, not the file store; a temp tree here would reclassify every suite as machine-touching.
        runtimeInstalls: {
            read: async () => ({ installs: [] }),
            record: async () => {},
            saveDrift: async () => {},
            decline: async () => {},
        },
        info: undefined,
        // No dev platform, no TLS to terminate; a fake since compat entries read it on every capability write.
        platformTunnel: { url: () => undefined, ready: Promise.resolve(), close: () => {} },
        // No platform to ask, which is the ordinary state under test and the one an export has to survive: a bundle
        // packed here simply carries no display name or logo. A test that cares overrides this.
        presentation: async () => undefined,
        // Nothing on record, and an append is dropped.
        activity: { append: async () => {}, list: async () => [] },
        // Inert: archive/discard hard-stop on every press; a route suite has no tmux, processes or browsers to reap.
        reaper: { start: () => {}, stop: () => {}, sweep: async () => {}, reapConversation: async () => {}, metrics: () => ({}) },
    }) satisfies Partial<Services>;

// Where `services` leaves what it composed, for the slice fakes that answer through the finished services.
interface ComposedServices {
    current?: Services;
}

export const services = (overrides: ServiceOverrides = {}): Services => {
    const { auth, git, usage, claudeStore, cliProxy, sandboxSettings, iq, ...rest } = overrides;
    // Filled once the literal below is: every slice fake that answers through the finished services reads it per call.
    const composed: ComposedServices = {};
    const context: SliceFakeContext = {
        historyRoot: (rest.config ?? testConfig).historyRoot,
        self: () => {
            if (composed.current === undefined) {
                throw new Error("route services read before they finished composing");
            }
            return composed.current;
        },
    };
    const conversationsFake = conversationsSliceFake(context);
    // Completed by unstubbed: only what these suites rely on appears in a slice's fake (`<slice>.testing.ts`, beside the
    // slice) or below; anything else names itself if reached. From `inertOwnMembers` on: the members Services declares
    // itself.
    const merged = unstubbed<Services>("services", {
        ...authSliceFake({ auth }, rest.passkeys),
        ...automationsSliceFake((conversationId) => conversationsFake.agents.entry(conversationId)?.archivedAt !== undefined),
        ...capabilitiesSliceFake(),
        ...conversationsFake,
        ...extensionsSliceFake(),
        ...gitSliceFake({ git }),
        ...hostsSliceFake(context),
        ...mainlineSliceFake(),
        ...processesSliceFake(),
        ...providersSliceFake(context, { usage, cliProxy }),
        ...resourcesSliceFake(),
        ...secretsSliceFake(),
        ...sessionsSliceFake(context),
        ...webextSliceFake(),
        ...workspaceSliceFake({ iq }),
        ...claudeSliceFake({ claudeStore }),
        ...codexSliceFake(),
        ...cursorSliceFake(),
        ...geminiSliceFake(),
        ...grokSliceFake(),
        ...kimiSliceFake(),
        ...mintedSliceFake(),
        ...inertOwnMembers(),
        config: testConfig,
        logger: createLogger(testConfig),
        // No chain declared, so converged from birth; the gate itself is covered below with a declared chain.
        boot: createBootTracker(createLogger(testConfig)),
        // Real but never started, so /health reads `off` on a daemon with nothing to announce to.
        announcer: createAnnouncer(testConfig, createLogger(testConfig)),
        // Same terms as announcer: never started, so /health reads `off` on a daemon with no public address to probe.
        reach: createReachReporter(testConfig, createLogger(testConfig)),
        // No personas by default: an unattended turn reaches no logged-in account, since an unpinned wake is denied
        // rather than waved through. A suite wanting one builds the card and its browser capability.
        personas: memoryPersonasStore(),
        // No areas by default: the unfenced workspace, which is what every member row without them already means.
        areas: memoryAreasStore(),
        // Schema's own defaults: parsing an empty object is exactly what an unwritten settings file reads as.
        sandboxSettings: unstubbed("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({}),
            set: async () => {},
            ...sandboxSettings,
        }),
        // Shipped policy: a planned turn snapshots it for the judge, so every route running a turn reads it.
        safetyPolicy: unstubbed("safetyPolicy", { text: async () => DEFAULT_SAFETY_POLICY }),
        // Leased by every planned turn: its browsers, peers and extension cards mount here.
        ...testTurnMounts(),
        // Three slice members composed here, each because its module already reaches the slice's subsystem, so the
        // slice's own fake may not import it (daemon-boundaries).
        // The automations slice's, exactly as composition.ts composes it, over this suite's own stores, so a suite
        // exercises the real queue rather than a second description of it.
        outboxStreamFor: (origin) => outboxStreamFor(context.self(), origin),
        // The processes slice's: a real slot table with a no-dial probe.
        portForwards: createPortForwards(portSlotsFromToken("tok"), async () => "http"),
        // The workspace slice's: the real readers, since a shadow is read off disk and a fake would only test the fake.
        derived: { read: readDerivedText, derive: deriveText, deriveBytes, status: sidecarStatus },
        history: fakeHistory(),
        async *intentic() {},
        // The engine's own announcements, as composition binds them, and the reactions it subscribes.
        events: createDomainEvents((name, error) => context.self().logger.warn({ err: error, event: name }, "domain event: a reaction failed")),
        ...rest,
    });
    composed.current = merged;
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
