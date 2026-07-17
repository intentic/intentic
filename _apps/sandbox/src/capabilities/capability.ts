import type { Capability, CapabilityKind, CapabilityStatus, IntenticLine } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { applyEventsPath, isTerminalExit, tailIntenticEvents } from "../intentic/apply-events.js";
import { INFRA_APPLY_KEY, startInfraApplyJob } from "../intentic/infra-apply.js";
import { type ConfigStore, createConfigStore } from "../inventory/config-store.js";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import { ensureIntentInstallable } from "../scaffold/ensure-intent.js";
import { scaffoldAppMonorepo, scaffoldNeutralLedger } from "../scaffold/scaffold-repos.js";
import { connectorSecretField, type ResolvedConnector } from "./cli/connector-registry.js";
import type { CapabilitiesStore } from "./capabilities-store.js";

// The narrow slice of the daemon a capability handler may touch — deliberately no agent/auth/sessions surface.
// The three scaffolder closures wrap the existing whole-Services helpers so a handler can trigger them without
// holding Services itself. Shell work goes through `terminalRun` into the handler's `job-capability-<id>`
// session (terminal-session.ts capabilityJobSession) — the handler yields {kind:"terminal", session} first,
// gated on terminalRun.visible, so the web surfaces the real commands (see system/terminal-run.ts for the
// principle). `infraApply` is the service handler's path onto the ONE panel-infra-apply job.
export interface CapabilityCtx {
    readonly logger: Services["logger"];
    readonly workspace: Services["workspace"];
    readonly git: Services["git"];
    readonly files: Services["files"];
    readonly terminalRun: Services["terminalRun"];
    // The docker capability's persistent dockerd session (panel-docker) — start/stop via the panel manager.
    readonly panels: ManagedProcesses;
    readonly infraApply: {
        // Launch `intentic resolve && intentic apply --yes && intentic adopt` (resolveFirst) as the shared
        // one-shot tmux job; false when one is already running (the caller must not tail a foreign run).
        readonly start: (options?: { readonly resolveFirst?: true }) => Promise<boolean>;
        readonly running: () => boolean;
        // Tail the job's durable events file to its terminal exit (isTerminalExit semantics).
        readonly events: () => AsyncGenerator<IntenticLine>;
    };
    readonly config: ConfigStore;
    readonly capabilities: CapabilitiesStore;
    // The image-baked extensions dir (services.config.extensionsDir) — lets the cli handler build the connector
    // registry (installedExtensions) from the narrow ctx without holding Services.
    readonly extensionsDir: string;
    readonly scaffoldNeutralLedger: (session: string) => Promise<void>;
    readonly ensureIntentInstallable: (session: string) => Promise<void>;
    readonly scaffoldMonorepo: (name: string, session: string) => Promise<void>;
}

// A capability kind's behaviour. `apply` is idempotent and streams progress (mcp/integration emit one frame;
// devops/service stream real work). `status` is a fast, non-blocking probe. A kind with no `remove` can't be
// torn down (devops). `requires` lists kinds that must already be active (checked at the route before apply).
// `fragment` is a code-versioned Dockerfile fragment (RUN/ENV + optional "# intentic:runtime <flag>" directive
// lines) this ENTRY bakes into the composed environment overlay — resolved per entry (the config decides),
// deduped by exact content at compose time. Fragments must be self-contained: install and purge their own
// build deps, never rely on another fragment's layers.
export interface CapabilityHandler {
    readonly requires?: readonly CapabilityKind[];
    readonly fragment?: (config: unknown) => string | undefined;
    readonly apply: (ctx: CapabilityCtx, id: string, config: unknown) => AsyncGenerator<IntenticLine>;
    readonly status: (ctx: CapabilityCtx, id: string, config: unknown) => Promise<CapabilityStatus>;
    readonly remove?: (ctx: CapabilityCtx, id: string, config: unknown) => Promise<void>;
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
        extensionsDir: services.config.extensionsDir,
        scaffoldNeutralLedger: (session) => scaffoldNeutralLedger(services, session),
        ensureIntentInstallable: (session) => ensureIntentInstallable(services, session),
        scaffoldMonorepo: (name, session) => scaffoldAppMonorepo(services, name, session),
    };
};

// The config key holding a capability's secret, undefined when it carries none (an unset optional token, or a
// kind with no credential — stripe's key lives in .env as a regular env secret). Drives the /secrets inventory
// (which capabilities appear, all revealable), reveal's value lookup, and setSecret's merge. `connectors` is the
// resolved connector registry (see connectorRegistry) — a cli capability's secret key is DATA in its connector.
export const secretField = (capability: Capability, connectors: Map<string, ResolvedConnector>): string | undefined => {
    switch (capability.kind) {
        case "mcp":
        case "plugin":
        case "extension":
            return capability.config.token !== undefined ? "token" : undefined;
        case "cli": {
            const spec = connectors.get(capability.config.provider)?.spec;
            return spec === undefined ? undefined : connectorSecretField(spec);
        }
        case "ssh":
            return capability.config.auth === "key" ? "privateKey" : "password";
        case "vpn":
            // The whole pasted WireGuard conf — it holds the private key.
            return "config";
        case "devops":
        case "monorepo":
        case "service":
        case "integration":
        case "docker":
        // The browser session lives in a Chromium profile (managed by the guided-login flow), not a manifest field.
        case "browser":
            return undefined;
    }
};

// Non-secret echo of a capability's config for the list summary (an mcp token becomes hasToken). `connectors`
// resolves a cli capability's secret field (which value to withhold).
export const echoConfig = (capability: Capability, connectors: Map<string, ResolvedConnector>): Record<string, string | number | boolean> => {
    switch (capability.kind) {
        case "mcp":
            return { url: capability.config.url, hasToken: capability.config.token !== undefined };
        case "service":
            return {
                service: capability.config.service,
                domain: capability.config.domain,
                on: capability.config.on,
                expose: capability.config.expose,
            };
        case "integration":
            return { provider: capability.config.provider };
        case "cli": {
            // Echo the non-secret fields (url etc.) for display; the secret one becomes hasSecret. The web
            // renders the card's label/logo from the connector manifest, not from this echo.
            const spec = connectors.get(capability.config.provider)?.spec;
            const secretKey = spec === undefined ? undefined : connectorSecretField(spec);
            const echo: Record<string, string | number | boolean> = {};
            for (const [key, value] of Object.entries(capability.config)) {
                if (key !== secretKey) {
                    echo[key] = value;
                }
            }
            return {
                ...echo,
                hasSecret: secretKey !== undefined && capability.config[secretKey] !== undefined && capability.config[secretKey] !== "",
            };
        }
        case "ssh":
            return { host: capability.config.host, port: capability.config.port, user: capability.config.user, auth: capability.config.auth };
        case "vpn":
            return { enabled: capability.config.enabled };
        case "docker":
            return { enabled: capability.config.enabled };
        case "plugin":
            return {
                url: capability.config.url,
                ...(capability.config.ref !== undefined ? { ref: capability.config.ref } : {}),
                ...(capability.config.path !== undefined ? { path: capability.config.path } : {}),
                hasToken: capability.config.token !== undefined,
            };
        case "extension":
            return {
                url: capability.config.url,
                ref: capability.config.ref,
                ...(capability.config.path !== undefined ? { path: capability.config.path } : {}),
                hasToken: capability.config.token !== undefined,
            };
        case "devops":
            return {};
        case "monorepo":
            return {};
        case "browser":
            return { platform: capability.config.platform };
    }
};
