import type { AcpAgentConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { NativeProvider } from "@intentic/sandbox-contract/models/provider-specs";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { SafetyVerdict } from "@intentic/sandbox-contract/policy/safety-policy";
import type { SetupLadder } from "@intentic/sandbox-contract/models/model-setups";
import { join } from "node:path";
import type { Services } from "../../composition.js";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import { createEndpointCatalog, type EndpointCatalog } from "../../endpoints/endpoint-catalog.js";
import { syncEndpointCompat } from "../../endpoints/endpoint-translator.js";
import type { AcpTurnOptions } from "../../runtimes/acp/acp-agent.js";
import type { PiTurnOptions } from "../../runtimes/pi/pi-agent.js";
import type { AcpConnections } from "../../runtimes/acp/acp-connection.js";
import type { AcpLaunch } from "../../runtimes/acp/acp-spawn.js";
import type { OpenCodeService } from "../../runtimes/opencode/opencode.js";
import type { ProviderDeps, RuntimeAdapters } from "../../runtimes/runtime-table.js";
import { localTolerantFetch } from "../../system/tls/local-tls.js";
import { tellPlatform, withTrialTurn } from "../../trial/trial-turn.js";
import type { AccountUsageStore } from "../../usage/account-usage.js";
import type { HeadroomService } from "../../usage/headroom.js";
import { fileModelRefusalStore, modelRefusalsDocument, type ModelRefusalStore } from "../../usage/model-refusals.js";
import type { AgentExecutionContext } from "../../workload/agent-execution.js";
import { fileProviderRefusalStore, providerRefusalsDocument, type ProviderRefusalStore } from "../../usage/provider-refusals.js";
import { fileRunOutStore, runOutsDocument, type RunOutStore } from "../../usage/run-outs.js";
import { fileUsageStore, type UsageStore, usageLedgerDocument } from "../../usage/usage-store.js";
import { type BurnRates, burnRatesDocument, createBurnRates } from "../run/spend/burn-rates.js";
import { fileReadingsLog, readingsLogDocument } from "../run/spend/readings-log.js";
import { type HarnessRequest, runAgent } from "../run/agent.js";
import { judgeCommand, type JudgeFacts } from "../tools/command-judge.js";
import type { AgentRequest, ContainerCredential } from "./agent-request.js";
import type { ProviderCatalog, ProviderModule } from "./provider-module.js";
import { providerAccountsOf, providerCatalogsOf, providerReadiness } from "./provider-registry.js";
import type { CliProxyClient } from "./translator.js";

// Model providers: their modules, catalogs and readiness, the runtimes' adapters, and what each account has left.
export interface ProvidersSlice {
    // Every native provider's live model catalog, assembled from provider modules for one lookup, not each its own.
    readonly providerCatalogs: Record<NativeProvider, ProviderCatalog>;
    // Whether each native provider holds a credential that can run a turn. Composed rather than called where it is
    // needed, since it reaches every provider module and each reads its own stores: a caller that only wants the
    // answer would otherwise have to take the whole of Services to ask for it.
    readonly providerReadiness: () => Promise<Record<NativeProvider, boolean>>;
    // One native provider's own connected accounts, through the door its module publishes, as on file (no re-measure);
    // empty for a provider with no door. Composed here for the same reason as readiness: every door reads its own stores.
    readonly providerAccounts: (provider: NativeProvider) => Promise<readonly OauthAccount[]>;
    // Every native provider's module and every runtime's adapter (runtimes/runtime-table.ts), reached through here so no
    // reader below the planner imports a runtime directory back.
    readonly providerModules: readonly ProviderModule<ProviderDeps>[];
    readonly adapters: RuntimeAdapters;
    // The three orchestrators a runtime needs but may not import, since each reaches most of the daemon: the safety judge,
    // filing a browser account, and recomposing the environment overlay.
    readonly judgeCommand: (
        execution: AgentExecutionContext,
        input: { readonly policy: string; readonly program: string; readonly facts: JudgeFacts; readonly ladder: SetupLadder },
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
    // The ACP runtime: every agent-kind capability outside NATIVE_PROVIDERS, and Devin's CLI; one warm subprocess per id.
    readonly acpAgent: (
        id: string,
        launch: AcpLaunch,
        request: AgentRequest<ContainerCredential>,
        options?: AcpTurnOptions,
    ) => AsyncGenerator<AgentEvent>;
    readonly acpConnections: AcpConnections;
    // Pi adapter for the reserved pi agent-kind capability over Pi's RPC; one process per turn, sessions as files.
    readonly piAgent: (config: AcpAgentConfig, request: AgentRequest<ContainerCredential>, options?: PiTurnOptions) => AsyncGenerator<AgentEvent>;
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
    // When each provider's allowance last ran out, and under how many of this sandbox's agents: the rate beside the
    // figure left that a parent fanning out reads (usage/run-outs.ts).
    readonly runOuts: RunOutStore;
    // What one point of each account's window costs and what each model spends an hour, learned from the live meter and
    // every reading (agent/run/spend/burn-rates.ts); what the fan-out planner projects from.
    readonly burnRates: BurnRates;
}

// What the slice is built from: the members built before it, since the provider areas and the headroom read them too;
// the one whose code this directory may not import (wakeLocalModel, above); and the runtimes themselves (the provider
// modules and adapters of runtimes/runtime-table.ts, the ACP and Pi adapters), whose directories import agent/ back, so
// naming them here would close a cycle.
export interface ProvidersDeps extends Pick<
    ProvidersSlice,
    | "cliProxy"
    | "openCode"
    | "authRoot"
    | "accountUsage"
    | "headroom"
    | "acpConnections"
    | "acpAgent"
    | "piAgent"
    | "wakeLocalModel"
    | "providerModules"
    | "adapters"
> {
    readonly historyRoot: string;
    // The actors that hold the children and background commands a Claude Code turn starts.
    readonly conversations: ConversationActors;
    // The catalogs, readiness and the safety judge each read every provider module's own stores, the provider areas
    // included, so they take the finished services per call.
    readonly whole: () => Services;
}

// Builds the providers slice.
export const createProvidersSlice = ({ historyRoot, conversations, whole, ...built }: ProvidersDeps): ProvidersSlice => {
    // One translator sync at a time: a sync reads every endpoint's list, so a change found while one runs is in it.
    let syncing: Promise<void> | undefined;
    const resyncTranslator = (): void => {
        syncing ??= syncEndpointCompat(whole()).finally(() => {
            syncing = undefined;
        });
    };
    // The refusal stores decide what a picker skips; each change they make is logged, through the finished
    // services' logger, resolved when a line is written since this slice is built before it is handed back.
    const log = (fields: Record<string, unknown>, message: string): void => whole().logger.info(fields, message);
    return {
        ...built,
        usage: fileUsageStore(join(historyRoot, usageLedgerDocument.path)),
        providerRefusals: fileProviderRefusalStore(join(historyRoot, providerRefusalsDocument.path), { log }),
        modelRefusals: fileModelRefusalStore(join(historyRoot, modelRefusalsDocument.path), { log }),
        runOuts: fileRunOutStore(join(historyRoot, runOutsDocument.path)),
        burnRates: createBurnRates({ path: join(historyRoot, burnRatesDocument.path), log: fileReadingsLog(join(historyRoot, readingsLogDocument.path)) }),
        providerCatalogs: providerCatalogsOf(built.providerModules, whole),
        providerReadiness: () => providerReadiness(whole()),
        providerAccounts: (provider) => providerAccountsOf(whole(), provider),
        judgeCommand: (execution, input, signal) => judgeCommand(whole(), execution, input, signal),
        endpointModels: createEndpointCatalog(join(built.authRoot, "endpoints"), localTolerantFetch, { onChanged: resyncTranslator }),
        // The Claude Code loop over these actors, which hold the children and background commands a turn starts. A turn
        // on the free trial tells the platform when it opens and closes, so one begun within the allowance can finish.
        agent: (request) =>
            request.credential.kind === "trial" ? withTrialTurn(tellPlatform(whole()), () => runAgent(conversations, request)) : runAgent(conversations, request),
    };
};
