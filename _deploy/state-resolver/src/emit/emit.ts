import { generated, makeRef } from "@intentic/graph";
import type { BackupInput, HostInput, IntentSet } from "@intentic/need-resolver";
import { controlPlaneHostId } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { adminUsername, forgejoId, gitlabRegistry, komodoId, tunnelId, tunnelName } from "../lib/ids.js";
import { IMAGES } from "../lib/images.js";
import { sshOf } from "../lib/ssh.js";
import type { AppForge } from "../resolvers/app.js";
import { forgeRegistry, resolveApp } from "../resolvers/app.js";
import { resolveBacking } from "../resolvers/backing.js";
import { defaultBackupInput, resolveBackup } from "../resolvers/backup.js";
import { resolveIdentities } from "../resolvers/identity.js";
import type { DeployRefs } from "../resolvers/platform.js";
import { resolveDeploy, resolvePlatform } from "../resolvers/platform.js";
import type { IngressPair } from "../resolvers/route.js";
import { resolveService } from "../resolvers/service.js";
import { resolveWorkspace } from "../resolvers/workspace.js";

// One concrete choice of option per need: `${capability}:${scope}` -> option id. The resolver builds it from the
// catalog; emit turns it into the support stack.
export interface Assignment {
    readonly byNeed: ReadonlyMap<string, string>;
}

// Options the emitter can build; source control varies by stack, komodo/ssh-linux/cloudflare-tunnel are shared.
const supportedOptions = new Set(["forgejo", "github", "gitlab", "komodo", "ssh-linux", "cloudflare-tunnel"]);

// The GitLab instance defaults to gitlab.com; a self-hosted instance sets its own url.
const GITLAB_DEFAULT_URL = "https://gitlab.com";

// Builds RawNodes for one assignment. One control-plane host (first host with apps) gets Komodo, plus Forgejo+runner
// absent a hosted forge; worker hosts get Periphery+Server; hosts with ingress get their own tunnel.
export const emit = (intent: IntentSet, assignment: Assignment, zone: string | undefined): ResolvedNode[] => {
    for (const optionId of assignment.byNeed.values()) {
        if (!supportedOptions.has(optionId)) {
            throw new Error(`unsupported option "${optionId}"; the emitter only implements ${[...supportedOptions].join("/")}`);
        }
    }

    if (intent.apps.length === 0 && intent.services.length === 0 && intent.workspaces.length === 0 && intent.backings.length === 0) {
        return [];
    }

    const cloudflare = intent.cloudflare;
    if (cloudflare === undefined) {
        throw new Error("intent declares apps/services/workspaces/backings but no Cloudflare; declare it with i.have.cloudflare");
    }
    if (zone === undefined) {
        throw new Error(
            "intent exposes apps/services through Cloudflare but no zone was provided; the CLI discovers it from the API token before resolving",
        );
    }

    // Identities are Forgejo-only; hosted forges (GitHub/GitLab) manage users/teams themselves.
    if ((intent.github !== undefined || intent.gitlab !== undefined) && (intent.users.length > 0 || intent.teams.length > 0)) {
        throw new Error("users/teams (i.want.user/team) are not supported on the GitHub/GitLab stacks; use the Forgejo stack");
    }

    const cpId = controlPlaneHostId(intent);
    if (cpId === undefined) {
        throw new Error("intent declares apps/services/backings but no host; declare one with i.have.host");
    }

    const apiToken = cloudflare.input.apiToken;
    const hostById = new Map(intent.hosts.map((h) => [h.id, h]));
    // Services keyed by id, so a workspace can resolve its tool ids to kind + domain for MCP wiring.
    const serviceById = new Map(intent.services.map((service) => [service.id, service]));
    // Backing instances apps may `use`, keyed by id with their host; validated here for resolveApp.
    const backingById = new Map<string, { intent: (typeof intent.backings)[number]; host: HostInput }>();
    for (const backing of intent.backings) {
        const host = hostById.get(backing.on);
        if (host === undefined) {
            throw new Error(`backing "${backing.id}" targets undeclared host "${backing.on}"; declare it with i.have.host`);
        }
        backingById.set(backing.id, { intent: backing, host: host.input });
    }
    const cpHost = hostById.get(cpId)!;
    // Restic is on-by-default; no i.have.backup() synthesizes an on-host repo + generated password instead.
    const backupInput: BackupInput = intent.backup?.input ?? defaultBackupInput();
    const nodes: ResolvedNode[] = [];

    // Emits every host inventory node.
    for (const host of intent.hosts) {
        nodes.push({
            id: host.id,
            type: "host",
            inputs: { ...sshOf(host.input) },
            explicitDependsOn: [],
        });
    }

    // The single Cloudflare inventory node.
    nodes.push({
        id: cloudflare.id,
        type: "cloudflare",
        inputs: { apiToken, zone },
        explicitDependsOn: [],
    });

    // Hosted-forge inventory node; resolves the PAT's user (or explicit owner) as the shared namespace.
    if (intent.github !== undefined) {
        nodes.push({
            id: intent.github.id,
            type: "github",
            inputs: {
                token: intent.github.input.token,
                ...(intent.github.input.owner !== undefined ? { owner: intent.github.input.owner } : {}),
            },
            explicitDependsOn: [],
        });
    }
    if (intent.gitlab !== undefined) {
        nodes.push({
            id: intent.gitlab.id,
            type: "gitlab",
            inputs: {
                token: intent.gitlab.input.token,
                url: intent.gitlab.input.url ?? GITLAB_DEFAULT_URL,
                ...(intent.gitlab.input.owner !== undefined ? { owner: intent.gitlab.input.owner } : {}),
            },
            explicitDependsOn: [],
        });
    }

    // Discord channel, emitted when i.have.discord() is declared; apps lists only those wiring notify: discord.
    if (intent.discord !== undefined) {
        const notifiedApps = intent.apps.filter((app) => app.notify === intent.discord!.id).map((app) => app.id);
        nodes.push({
            id: intent.discord.id,
            type: "discord",
            inputs: {
                botToken: intent.discord.input.botToken,
                zone,
                apps: notifiedApps,
            },
            explicitDependsOn: [],
        });
    }

    // Stripe (i.have.stripe): standalone inventory node; apiKey stays a $secret env, never an output ref.
    if (intent.stripe !== undefined) {
        nodes.push({
            id: intent.stripe.id,
            type: "stripe",
            inputs: { apiKey: intent.stripe.input.apiKey },
            explicitDependsOn: [],
        });
    }

    // Per-host ingress buckets (for tunnel aggregation).
    const ingressByHost = new Map<string, IngressPair[]>();

    // Shared control plane on the CP host.

    const serviceIds = new Set(intent.services.map((service) => service.id));

    if (intent.apps.length > 0) {
        // Guarded updates need a restic repo; enabled only when the host opts in via updatePolicy.
        const guard = cpHost.input.updatePolicy === "guarded" ? { repo: backupInput.repo, resticImage: IMAGES.backup } : undefined;

        // Forge sourcing the apps: Forgejo derives the full platform, hosted forges derive only the Komodo slice.
        let forge: AppForge;
        let deployRefs: DeployRefs;
        if (intent.github !== undefined) {
            forge = { kind: "github", githubId: intent.github.id, token: intent.github.input.token };
            const deploy = resolveDeploy(cpId, cloudflare.id, zone, apiToken, cpHost.input, guard, {
                authority: forgeRegistry(forge, zone),
                user: makeRef<string>(intent.github.id, "owner"),
                token: intent.github.input.token,
            });
            deployRefs = deploy.refs;
            nodes.push(deploy.komodo, deploy.route);
            ingressByHost.set(cpId, [deploy.ingress]);
        } else if (intent.gitlab !== undefined) {
            const url = intent.gitlab.input.url ?? GITLAB_DEFAULT_URL;
            forge = {
                kind: "gitlab",
                gitlabId: intent.gitlab.id,
                token: intent.gitlab.input.token,
                url,
                registry: gitlabRegistry(url, intent.gitlab.input.registry),
            };
            const deploy = resolveDeploy(cpId, cloudflare.id, zone, apiToken, cpHost.input, guard, {
                authority: forgeRegistry(forge, zone),
                user: makeRef<string>(intent.gitlab.id, "owner"),
                token: intent.gitlab.input.token,
            });
            deployRefs = deploy.refs;
            nodes.push(deploy.komodo, deploy.route);
            ingressByHost.set(cpId, [deploy.ingress]);
        } else {
            const platform = resolvePlatform(cpId, cloudflare.id, zone, apiToken, cpHost.input, guard);
            forge = { kind: "forgejo", platform: platform.refs };
            deployRefs = platform.refs;
            nodes.push(...platform.nodes);
            ingressByHost.set(cpId, [...platform.ingress]);
        }

        // Validate app -> service references.
        for (const app of intent.apps) {
            if (app.observe !== undefined && !serviceIds.has(app.observe)) {
                throw new Error(`app "${app.id}" observes unknown service "${app.observe}"; declare it with i.want.service`);
            }
            // Only signoz produces the otlpEndpoint output observe wires; any other kind would emit a dangling ref.
            if (app.observe !== undefined && serviceById.get(app.observe)?.kind !== "signoz") {
                throw new Error(`app "${app.id}" observes "${app.observe}", which is not a signoz service`);
            }
            // Validates app -> backing refs: target must exist and its capability must match (guards a stale id).
            for (const binding of app.use ?? []) {
                const backing = backingById.get(binding.target);
                if (backing === undefined) {
                    throw new Error(`app "${app.id}" uses unknown backing "${binding.target}"; declare it with i.want.${binding.capability}`);
                }
                if (backing.intent.capability !== binding.capability) {
                    throw new Error(`app "${app.id}" uses "${binding.target}" as ${binding.capability} but it is a ${backing.intent.capability}`);
                }
            }
        }

        // Worker hosts: Periphery + Server registration.

        const workerHostIds = new Set([...intent.apps.map((a) => a.on), ...intent.services.map((s) => s.on)].filter((id) => id !== cpId));
        for (const hostId of workerHostIds) {
            const host = hostById.get(hostId)!;
            const peripheryId = `${hostId}-periphery`;
            const serverId = `${hostId}-server`;

            nodes.push({
                id: peripheryId,
                type: "komodo-periphery",
                inputs: {
                    ...sshOf(host.input),
                    coreAddress: makeRef<string>(deployRefs.deploy, "url"),
                    serverName: hostId,
                    image: IMAGES.komodoPeriphery,
                },
                explicitDependsOn: [hostId, deployRefs.deploy, deployRefs.deployRoute],
            });

            nodes.push({
                id: serverId,
                type: "komodo-server",
                // Queries Core over the CP host's SSH; gated on the deploy route since Periphery dials Core's public
                // url.
                inputs: {
                    ...sshOf(cpHost.input),
                    adminUser: adminUsername,
                    adminPassword: generated("KOMODO_ADMIN_PASSWORD"),
                    serverName: hostId,
                },
                explicitDependsOn: [peripheryId, deployRefs.deploy, deployRefs.deployRoute],
            });

            // Initialize ingress bucket for worker host.
            if (!ingressByHost.has(hostId)) {
                ingressByHost.set(hostId, []);
            }
        }

        // Apps: all go through the shared platform.

        for (const app of intent.apps) {
            const resolved = resolveApp(app, forge, deployRefs, apiToken, zone, cpId, cpHost.input, backingById);
            nodes.push(...resolved.nodes);
            // Route ingress goes to the host the app runs on (its tunnel), not the CP host.
            const hostIngress = ingressByHost.get(app.on) ?? [];
            hostIngress.push(...resolved.ingress);
            ingressByHost.set(app.on, hostIngress);
        }

        // Declared people/teams and the grant graph; one Forgejo, one Komodo, one identity set, scoped to the CP host.
        if (forge.kind === "forgejo") {
            nodes.push(...resolveIdentities(intent, forge.platform, cpId, cpHost.input));
        }
    }

    // Services: placed on the specified host.

    for (const service of intent.services) {
        const host = hostById.get(service.on)!;
        const resolved = resolveService(service, host.input, zone, apiToken);
        nodes.push(...resolved.nodes);
        const hostIngress = ingressByHost.get(service.on) ?? [];
        hostIngress.push(...resolved.ingress);
        ingressByHost.set(service.on, hostIngress);
    }

    // Workspaces: per-host AI-agent sandbox, exposed via wildcard *.<zone>; ordered last.

    for (const workspace of intent.workspaces) {
        const host = hostById.get(workspace.on)!;
        // Tool ids are validated against declared services in resolveNeeds, so the lookup always resolves.
        const tools = (workspace.tools ?? []).map((id) => {
            const service = serviceById.get(id)!;
            return { id: service.id, kind: service.kind, domain: service.domain };
        });
        const resolved = resolveWorkspace(workspace, host.input, zone, apiToken, tools);
        nodes.push(...resolved.nodes);
        const hostIngress = ingressByHost.get(workspace.on) ?? [];
        hostIngress.push(...resolved.ingress);
        ingressByHost.set(workspace.on, hostIngress);
    }

    // Backing instances deploy onto their host; per-app binding nodes are emitted inside resolveApp, not here.
    for (const backing of intent.backings) {
        const host = hostById.get(backing.on)!;
        const resolved = resolveBacking(backing, host.input, apiToken);
        nodes.push(...resolved.nodes);
        if (resolved.ingress.length > 0) {
            const hostIngress = ingressByHost.get(backing.on) ?? [];
            hostIngress.push(...resolved.ingress);
            ingressByHost.set(backing.on, hostIngress);
        }
    }

    // Backup on the control-plane host, on-by-default, using the declared destination or synthesized default.

    if (intent.apps.length > 0) {
        const signozService = intent.services.find((service) => service.kind === "signoz");
        const controlPlane = intent.github !== undefined || intent.gitlab !== undefined ? [komodoId(cpId)] : [forgejoId(cpId), komodoId(cpId)];
        nodes.push(resolveBackup(cpId, cpHost.input, backupInput, signozService?.id, controlPlane));
    }

    // One Cloudflare Tunnel per host that has ingress.

    for (const [hostId, ingress] of ingressByHost) {
        if (ingress.length === 0) {
            continue;
        }
        const host = hostById.get(hostId)!;
        nodes.push({
            id: tunnelId(hostId),
            type: "tunnel",
            inputs: {
                name: tunnelName(hostId),
                accountId: makeRef(cloudflare.id, "accountId"),
                apiToken,
                ...sshOf(host.input),
                ingress,
                image: IMAGES.cloudflared,
            },
            explicitDependsOn: [cloudflare.id, hostId],
        });
    }

    return nodes;
};
