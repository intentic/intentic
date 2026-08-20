import type { CapabilityKind, CapabilityStatus, IntenticLine } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { applyEventsPath, isTerminalExit, tailIntenticEvents } from "../intentic/apply-events.js";
import { INFRA_APPLY_KEY, startInfraApplyJob } from "../intentic/infra-apply.js";
import { type ConfigStore, createConfigStore } from "../inventory/config-store.js";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import { donateForExtension, type DonationOutcome } from "../platform/pool-donate.js";
import { relayWalletEnsure, type WalletPolicyMirror } from "../wallet/wallet-signer.js";
import { ensureIntentInstallable } from "../scaffold/ensure-intent.js";
import { scaffoldAppMonorepo, scaffoldNeutralLedger } from "../scaffold/scaffold-repos.js";
import type { EndpointCatalog } from "../endpoints/endpoint-catalog.js";
import type { HostHub } from "../hosts/host-hub.js";
import type { HostsStore } from "../hosts/hosts-store.js";
import type { ResolvedContribution } from "./contributions.js";
import type { CapabilitiesStore } from "./capabilities-store.js";

// The narrow slice of the daemon a capability handler may touch, deliberately no agent/auth/sessions surface.
// The three scaffolder closures wrap the existing whole-Services helpers so a handler can trigger them without
// holding Services itself. Shell work goes through `terminalRun` into the handler's `job-capability-<id>`
// session (terminal-session.ts capabilityJobSession), the handler yields {kind:"terminal", session} first,
// gated on terminalRun.visible, so the web surfaces the real commands (see system/terminal-run.ts for the
// principle). `infraApply` is the service handler's path onto the ONE panel-infra-apply job.
export interface CapabilityCtx {
    readonly logger: Services["logger"];
    readonly workspace: Services["workspace"];
    readonly git: Services["git"];
    readonly files: Services["files"];
    readonly terminalRun: Services["terminalRun"];
    // Extension-declared background processes ride panel sessions, start/stop via the panel manager.
    readonly panels: ManagedProcesses;
    readonly infraApply: {
        // Launch `intentic deploy resolve && intentic deploy apply --yes && intentic deploy adopt` (resolveFirst) as the shared
        // one-shot tmux job; false when one is already running (the caller must not tail a foreign run).
        readonly start: (options?: { readonly resolveFirst?: true }) => Promise<boolean>;
        readonly running: () => boolean;
        // Tail the job's durable events file to its terminal exit (isTerminalExit semantics).
        readonly events: () => AsyncGenerator<IntenticLine>;
    };
    readonly config: ConfigStore;
    readonly capabilities: CapabilitiesStore;
    // The user's own connected computers. Both are passed whole rather than narrowed: the hub IS the handler's
    // subject (a scope edit has to reach a live machine while the user is still looking at the card), and the
    // store's enrollment state is the difference between "added" and "actually connected", which is the only
    // thing this kind's status can usefully say.
    readonly hosts: HostsStore;
    readonly hostHub: HostHub;
    // What a configured model API actually serves, the endpoint kind's apply AND status are both this probe, and
    // it is the same catalog the picker and the translator reconciler read, so a card can never claim a model
    // list the turn path would disagree with.
    readonly endpointModels: EndpointCatalog;
    // The image-baked extensions dir (services.config.extensionsDir), lets the cli handler build the connector
    // registry (installedExtensions) from the narrow ctx without holding Services.
    readonly extensionsDir: string;
    // Support a premium extension's creator with the owner's credits (platform/pool-donate.ts), the gate a
    // `tier: "premium"` install passes through, and the only money moment a non-service extension has.
    readonly donatePremium: (extensionId: string) => Promise<DonationOutcome>;
    // Create-or-fetch the owner's platform wallet and mirror its policy caps (wallet/wallet-signer.ts), the
    // wallet handler's whole platform reach, closure-wrapped like donatePremium so it stays testable.
    readonly walletEnsure: (network: string, policy: WalletPolicyMirror) => Promise<{ readonly status: number; readonly body: string }>;
    readonly scaffoldNeutralLedger: (session: string) => Promise<void>;
    readonly ensureIntentInstallable: (session: string) => Promise<void>;
    readonly scaffoldMonorepo: (name: string, session: string) => Promise<void>;
}

// A capability kind's behaviour. `apply` is idempotent and streams progress (mcp/integration emit one frame;
// devops/service stream real work). `status` is a fast, non-blocking probe. A kind with no `remove` can't be
// torn down (devops). `requires` lists kinds that must already be active (checked at the route before apply).
// `fragment` is a code-versioned Dockerfile fragment (RUN/ENV + optional "# intentic:runtime <flag>" directive
// lines) this ENTRY bakes into the composed environment overlay, resolved per entry (the config decides),
// deduped by exact content at compose time. Fragments must be self-contained: install and purge their own
// build deps, never rely on another fragment's layers. A handler whose payload is a feature pack resolves it
// through environment/packs.ts (async, the pack file and the base image's stamp are both reads), which
// returns nothing when the running base already bakes the pack.
/* WHAT RENAMING A CONNECTION OF THIS KIND TAKES.
 *
 * A capability's id is not a label, it is the agent's HANDLE for the thing: the name of its skill file, the
 * suffix on its env vars, the alias `ssh <name>` resolves, the directory its browser profile lives in. So a
 * rename is a migration, and every kind has to say what its own costs. Required for the same reason `echo` is:
 * the answer differs per kind and a forgotten default is the kind of thing nobody notices until a rename has
 * quietly signed somebody out of every account in a browser profile.
 *
 * `carry` moves what the old name keyed and `apply` cannot re-derive; the route then re-runs `apply` under the
 * new name, which is how everything DERIVED (a skill file, an ssh config block, a tunnel's conf) gets rewritten.
 * A kind whose apply would re-FETCH rather than re-derive, the git checkouts, sets `reapply: false` and moves
 * its directory in `carry` instead. */
export interface CapabilityRename {
    /* Why this kind's name cannot change, the route stops and says exactly this. For the capabilities whose
     * name is part of what they ARE: the scaffolders named their repos after it, the one-per-sandbox cards
     * never had a name to choose. Their equivalent of a rename is removing and adding. */
    readonly refuse?: string;
    /** Move the state the old name keyed. Runs before the re-apply, so a moved profile is in place for it. */
    readonly carry?: (ctx: CapabilityCtx, from: string, to: string, config: unknown) => Promise<void>;
    /** Re-run `apply` under the new name. Default true, false only where apply is an install, not a write. */
    readonly reapply?: boolean;
}

export interface CapabilityHandler {
    readonly requires?: readonly CapabilityKind[];
    readonly fragment?: (config: unknown) => string | undefined | Promise<string | undefined>;
    readonly apply: (ctx: CapabilityCtx, id: string, config: unknown) => AsyncGenerator<IntenticLine>;
    readonly status: (ctx: CapabilityCtx, id: string, config: unknown) => Promise<CapabilityStatus>;
    readonly remove?: (ctx: CapabilityCtx, id: string, config: unknown) => Promise<void>;
    /* The config key holding this kind's secret, absent when it carries none (a kind with no credential, or one
     * whose credential lives outside the manifest entirely). Drives the /secrets inventory, which capabilities
     * appear there, what reveal reads, what setSecret merges. `connectors` is the resolved connector registry: a
     * cli capability's secret key is DATA in its connector, not a fact this daemon knows.
     *
     * Here rather than in a central switch because it is a fact ABOUT ONE KIND, and the switch was the third
     * place a new kind had to be remembered, the two before it (apply, status) are right here. */
    readonly secret?: (config: unknown, connectors: Map<string, ResolvedContribution>) => string | undefined;
    // The non-secret echo of a config for the list summary (an mcp token becomes hasToken). Required, not
    // optional: "what of this may the browser see" is a question every kind has to answer out loud, and a
    // forgotten default is how a credential reaches a browser by omission.
    readonly echo: (config: unknown, connectors: Map<string, ResolvedContribution>) => Record<string, string | number | boolean>;
    // What a rename of this kind moves, or why it can't happen, see CapabilityRename. Required, not optional:
    // the safe default differs per kind, and the unsafe ones fail silently.
    readonly rename: CapabilityRename;
}

// Build the handler context from the full Services, wrapping the existing scaffolders as session-scoped closures.
export const capabilityCtx = (services: Services): CapabilityCtx => {
    const config = createConfigStore(services);
    return {
        logger: services.logger,
        workspace: services.workspace,
        git: services.git,
        files: services.files,
        terminalRun: services.terminalRun,
        panels: services.processes,
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
        endpointModels: services.endpointModels,
        extensionsDir: services.config.extensionsDir,
        donatePremium: (extensionId) => donateForExtension(services.config, extensionId),
        walletEnsure: (network, policy) => relayWalletEnsure(services.config, network, policy),
        scaffoldNeutralLedger: (session) => scaffoldNeutralLedger(services, session),
        ensureIntentInstallable: (session) => ensureIntentInstallable(services, session),
        scaffoldMonorepo: (name, session) => scaffoldAppMonorepo(services, name, session),
    };
};
