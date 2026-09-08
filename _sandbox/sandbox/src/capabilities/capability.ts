import type { CapabilityKind, CapabilityStatus, IntenticLine } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { applyEventsPath, isTerminalExit, tailIntenticEvents } from "../intentic/apply-events.js";
import { INFRA_APPLY_KEY, startInfraApplyJob } from "../intentic/infra-apply.js";
import { type ConfigStore, createConfigStore } from "../inventory/config-store.js";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import { relayWalletEnsure } from "../wallet/wallet-signer.js";
import { ensureIntentInstallable } from "../scaffold/ensure-intent.js";
import { scaffoldAppMonorepo, scaffoldNeutralLedger } from "../scaffold/scaffold-repos.js";
import type { EndpointCatalog } from "../endpoints/endpoint-catalog.js";
import { syncEndpointCompat } from "../endpoints/endpoint-translator.js";
import type { HostHub, HostStore } from "../hosts/host-peer.js";
import type { WebExtHub, WebExtStore } from "../webext/webext-peer.js";
import type { ResolvedContribution } from "./contributions.js";
import type { CapabilitiesStore } from "./capabilities-store.js";

// Narrow slice of the daemon a handler may touch, no agent/auth/sessions; scaffolder closures wrap Services helpers.
// Shell work goes through terminalRun into job-capability-<id>; infraApply is the path onto the one panel-infra-apply
// job.
export interface CapabilityCtx {
    readonly logger: Services["logger"];
    readonly workspace: Services["workspace"];
    readonly git: Services["git"];
    readonly files: Services["files"];
    readonly terminalRun: Services["terminalRun"];
    // Tmux-riding managed processes (dockerd, local model servers), start/stop via the panel manager.
    readonly panels: ManagedProcesses;
    // Extension-declared background processes, supervised as daemon children (processes/service-processes.ts).
    readonly serviceProcesses: Services["serviceProcesses"];
    readonly infraApply: {
        // Launches the deploy resolve/apply/adopt one-shot tmux job; false if one is already running.
        readonly start: (options?: { readonly resolveFirst?: true }) => Promise<boolean>;
        readonly running: () => boolean;
        // Tails the job's durable events file to its terminal exit.
        readonly events: () => AsyncGenerator<IntenticLine>;
    };
    readonly config: ConfigStore;
    readonly capabilities: CapabilitiesStore;
    // User's own devices, passed whole: the hub is the live subject, the store's enrollment is the only status here.
    readonly hosts: HostStore;
    readonly hostHub: HostHub;
    // Same pair for the user's browsers, same reason: hub is the live subject, store enrollment is the status.
    readonly webexts: WebExtStore;
    readonly webextHub: WebExtHub;
    // What a configured model API serves; the same catalog the picker and translator read, so a card can't disagree
    // with it.
    readonly endpointModels: EndpointCatalog;
    // Rebuilds the translator's table once a local model's server serves (add time writes an empty model list).
    readonly syncEndpoints: () => Promise<void>;
    // Image-baked extensions dir; lets the cli handler build the connector registry without holding Services.
    readonly extensionsDir: string;
    // Create-or-fetch the owner's platform wallet for its address (wallet/wallet-signer.ts), the wallet
    // handler's whole platform reach, closure-wrapped so it stays testable. The caps are not this side's to send.
    readonly walletEnsure: (network: string) => Promise<{ readonly status: number; readonly body: string }>;
    readonly scaffoldNeutralLedger: (session: string) => Promise<void>;
    readonly ensureIntentInstallable: (session: string) => Promise<void>;
    readonly scaffoldMonorepo: (name: string, session: string) => Promise<void>;
}

// A capability kind's behavior: apply is idempotent and streams progress, status is a fast non-blocking probe.
// A kind with no remove can't be torn down (devops); requires lists kinds checked as already active before apply.
// fragment: a code-versioned Dockerfile fragment this entry bakes in, deduped by exact content; must be self-contained.
// Several may return so two kinds needing the same privilege (vpn, exit: /dev/net/tun) share a byte-identical block.
// A capability's id is the agent's handle for it (skill file, env suffix, ssh alias, profile dir); rename is a
// migration.
// carry moves state apply can't re-derive; apply re-runs under the new name, unless reapply:false moves it in carry.
export interface CapabilityRename {
    // Why this kind's name can't change (one-per-sandbox cards, a repo named after it): remove and add instead.
    readonly refuse?: string;
    /** Moves the state the old name keyed, before the re-apply so a moved profile is in place for it. */
    readonly carry?: (ctx: CapabilityCtx, from: string, to: string, config: unknown) => Promise<void>;
    /** Re-runs apply under the new name; default true, false only when apply installs rather than writes. */
    readonly reapply?: boolean;
}

export interface CapabilityHandler {
    readonly requires?: readonly CapabilityKind[];
    readonly fragment?: (config: unknown) => string | readonly string[] | undefined | Promise<string | readonly string[] | undefined>;
    readonly apply: (ctx: CapabilityCtx, id: string, config: unknown) => AsyncGenerator<IntenticLine>;
    readonly status: (ctx: CapabilityCtx, id: string, config: unknown) => Promise<CapabilityStatus>;
    readonly remove?: (ctx: CapabilityCtx, id: string, config: unknown) => Promise<void>;
    // Config key holding this kind's secret, absent if it has none; drives the /secrets inventory (reveal, setSecret).
    readonly secret?: (config: unknown, connectors: Map<string, ResolvedContribution>) => string | undefined;
    // Non-secret echo of a config for the list summary (e.g. an mcp token becomes hasToken); required, not optional.
    readonly echo: (config: unknown, connectors: Map<string, ResolvedContribution>) => Record<string, string | number | boolean>;
    // What a rename of this kind moves, or why not (CapabilityRename); required, the safe default differs per kind.
    readonly rename: CapabilityRename;
}

// Builds the handler context from full Services, wrapping the existing scaffolders as session-scoped closures.
export const capabilityCtx = (services: Services): CapabilityCtx => {
    const config = createConfigStore(services);
    return {
        logger: services.logger,
        workspace: services.workspace,
        git: services.git,
        files: services.files,
        terminalRun: services.terminalRun,
        panels: services.processes,
        serviceProcesses: services.serviceProcesses,
        infraApply: {
            start: (options) => startInfraApplyJob(services, options),
            running: () => services.processes.running(INFRA_APPLY_KEY),
            events: () =>
                tailIntenticEvents(
                    applyEventsPath(services.config.historyRoot),
                    isTerminalExit,
                    () => services.processes.running(INFRA_APPLY_KEY),
                    undefined,
                ),
        },
        config,
        capabilities: services.capabilities,
        hosts: services.hosts,
        hostHub: services.hostHub,
        webexts: services.webexts,
        webextHub: services.webextHub,
        endpointModels: services.endpointModels,
        syncEndpoints: () => syncEndpointCompat(services),
        extensionsDir: services.config.extensionsDir,
        walletEnsure: (network) => relayWalletEnsure(services.config, network),
        scaffoldNeutralLedger: (session) => scaffoldNeutralLedger(services, session),
        ensureIntentInstallable: (session) => ensureIntentInstallable(services, session),
        scaffoldMonorepo: (name, session) => scaffoldAppMonorepo(services, name, session),
    };
};
