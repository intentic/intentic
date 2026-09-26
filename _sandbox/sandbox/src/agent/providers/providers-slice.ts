import type { AcpAgentConfig, AgentEvent, ModelPin, NativeProvider, SafetyVerdict } from "@intentic/sandbox-contract";
import type { EndpointCatalog } from "../../endpoints/endpoint-catalog.js";
import type { AcpConnections } from "../../runtimes/acp/acp-connection.js";
import type { OpenCodeService } from "../../runtimes/opencode/opencode.js";
import type { ProviderDeps, RuntimeAdapters } from "../../runtimes/runtime-table.js";
import type { AccountUsageStore } from "../../usage/account-usage.js";
import type { HeadroomService } from "../../usage/headroom.js";
import type { ModelCooldownStore } from "../../usage/model-cooldowns.js";
import type { ModelRefusalStore } from "../../usage/model-refusals.js";
import type { ObservedLimitStore } from "../../usage/observed-limits.js";
import type { ProviderRefusalStore } from "../../usage/provider-refusals.js";
import type { UsageStore } from "../../usage/usage-store.js";
import type { HarnessRequest } from "../run/agent.js";
import type { JudgeFacts } from "../tools/command-judge.js";
import type { AgentRequest, ContainerCredential } from "./agent-request.js";
import type { ProviderCatalog, ProviderModule } from "./provider-module.js";
import type { CliProxyClient } from "./translator.js";

// Model providers: their modules, catalogs and readiness, the runtimes' adapters, and what each account has left.
export interface ProvidersSlice {
    // Every native provider's live model catalog, assembled from provider modules for one lookup, not each its own.
    readonly providerCatalogs: Record<NativeProvider, ProviderCatalog>;
    // Whether each native provider holds a credential that can run a turn. Composed rather than called where it is
    // needed, since it reaches every provider module and each reads its own stores: a caller that only wants the
    // answer would otherwise have to take the whole of Services to ask for it.
    readonly providerReadiness: () => Promise<Record<NativeProvider, boolean>>;
    // Every native provider's module and every runtime's adapter (runtimes/runtime-table.ts), reached through here so no
    // reader below the planner imports a runtime directory back.
    readonly providerModules: readonly ProviderModule<ProviderDeps>[];
    readonly adapters: RuntimeAdapters;
    // The three orchestrators a runtime needs but may not import, since each reaches most of the daemon: the safety judge,
    // filing a browser account, and recomposing the environment overlay.
    readonly judgeCommand: (
        input: { readonly policy: string; readonly program: string; readonly facts: JudgeFacts; readonly pins: readonly ModelPin[] },
        signal: AbortSignal,
    ) => Promise<SafetyVerdict>;
    // What each endpoint capability's server publishes, keyed by id; only the server says what it serves.
    readonly endpointModels: EndpointCatalog;
    // Brings a local model back after the idle sweep unloaded it, and waits for it to serve. Lives here rather than
    // being called directly, because importing the capability handler into agent/providers put that package into the
    // capability import graph and broke type inference two files away. Resolves false when it will not come up.
    readonly wakeLocalModel: (id: string) => Promise<boolean>;
    // Bundled translator: connects/disconnects subscription OAuth; codex/kimi/gemini have no other credential.
    readonly cliProxy: CliProxyClient;
    // Shared OpenCode runtime backing Grok; OpenCode owns the xAI credential, so there is no separate GrokStore.
    readonly openCode: OpenCodeService;
    // AI-provider credential root (also OpenCode's XDG_DATA_HOME); CLIs and an absolute agent's opencode use it.
    readonly authRoot: string;
    // The Claude Code loop: serves native Claude, Kimi, every routed provider, every endpoint capability.
    readonly agent: (request: HarnessRequest) => AsyncGenerator<AgentEvent>;
    // Generic ACP adapter for every agent-kind capability outside NATIVE_PROVIDERS; one warm subprocess per agent.
    readonly acpAgent: (id: string, config: AcpAgentConfig, request: AgentRequest<ContainerCredential>) => AsyncGenerator<AgentEvent>;
    readonly acpConnections: AcpConnections;
    // Pi adapter for the reserved pi agent-kind capability over Pi's RPC; one process per turn, sessions as files.
    readonly piAgent: (config: AcpAgentConfig, request: AgentRequest<ContainerCredential>) => AsyncGenerator<AgentEvent>;
    // Durable spend ledger, outside the agent's reach, one row per attributed turn, never pruned unlike activity.
    readonly usage: UsageStore;
    // Latest plan-limit snapshot per account of any provider; every account surface merges it from one place.
    readonly accountUsage: AccountUsageStore;
    // Coalesced headroom reads across every provider behind one refresh, triggered by events, pushed on /events.
    readonly headroom: HeadroomService;
    // Last time each provider refused a turn outright; the observed counterpart to the polled headroom snapshot.
    readonly providerRefusals: ProviderRefusalStore;
    // Which models this sandbox was refused on, finer-grained than providerRefusals; the picker drops them.
    readonly modelRefusals: ModelRefusalStore;
    // Which models every credential is benched on right now, and when each reopens; the picker marks them, since
    // unlike a modelRefusal this one comes back on its own.
    readonly modelCooldowns: ModelCooldownStore;
    // What each account has run out of, per model, for a plan that publishes no allowance to poll: the refusal itself
    // is the reading, and the only one Cursor ever gives.
    readonly observedLimits: ObservedLimitStore;
}
