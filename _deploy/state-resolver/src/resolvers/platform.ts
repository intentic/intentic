import type { Input, SecretRef } from "@intentic/graph";
import { generated, httpOk, makeRef } from "@intentic/graph";
import type { HostInput } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { adminUsername, deployDomain, forgejoId, gitDomain, komodoId, registryAuthority, runnerId } from "../lib/ids.js";
import { IMAGES } from "../lib/images.js";
import { sshOf } from "../lib/ssh.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";

// Deploy-orchestrator slice every stack shares: the Komodo node + its public route; Forgejo extends it with the
// git+CI slice below.
export interface DeployRefs {
    readonly deploy: string;
    // cf-route id for deploy.<zone>; nodes calling the public URL depend on it being live (DNS + tunnel).
    readonly deployRoute: string;
}

export interface PlatformRefs extends DeployRefs {
    readonly forgejo: string;
    readonly gitRoute: string;
}

// [[docker_registry]] account Komodo pulls images with: Forgejo registry + admin packages token, ghcr.io + GitHub
// PAT, or GitLab registry + GitLab PAT.
export interface RegistryAccount {
    readonly authority: string;
    readonly user: Input<string>;
    readonly token: Input<string>;
}

// [[git_provider]] account Komodo clones private app repos with; Forgejo stack only, since hosted forges are
// registry images Komodo never clones.
export interface GitAccount {
    readonly url: Input<string>;
    readonly account: string;
    readonly token: Input<string>;
}

// Fixed host ports the platform services listen on, mirrored by their providers; the tunnel routes to these.
const FORGEJO_PORT = 3000;
const KOMODO_PORT = 9120;

// When guarded updates are on, stateful services carry the restic repo + image so a pin bump runs as a
// snapshot/rollback transaction; password/creds come from the on-host restic.env.
export interface GuardConfig {
    readonly repo: string;
    readonly resticImage: string;
}

// Deploy orchestrator every app on a host requires, shared per host: Komodo, exposed at deploy.<zone> so its UI
// and worker Peripheries are reachable. Returns the exposure's ingress pair for the caller to aggregate.
export const resolveDeploy = (
    hostId: string,
    cloudflareId: string,
    zone: string,
    apiToken: SecretRef,
    host: HostInput,
    guard: GuardConfig | undefined,
    registry: RegistryAccount,
    git?: GitAccount,
): { komodo: ResolvedNode; route: ResolvedNode; refs: DeployRefs; ingress: IngressPair } => {
    const deploy = komodoId(hostId);
    // internalUrl/readyWhen use the host-internal address, reachable before the tunnel/DNS routes exist.
    const exposure = exposeRoute(cloudflareId, hostId, deployDomain(zone), KOMODO_PORT, apiToken);
    const komodo: ResolvedNode = {
        id: deploy,
        type: "komodo",
        inputs: {
            server: makeRef(hostId),
            ...sshOf(host),
            internalIp: makeRef<string>(hostId, "internalIp"),
            domain: deployDomain(zone),
            adminUser: adminUsername,
            adminPassword: generated("KOMODO_ADMIN_PASSWORD"),
            ...(git !== undefined ? { gitUrl: git.url, gitAccount: git.account, gitToken: git.token } : {}),
            registry: registry.authority,
            registryUser: registry.user,
            registryToken: registry.token,
            coreImage: IMAGES.komodoCore,
            peripheryImage: IMAGES.komodoPeriphery,
            ferretdbImage: IMAGES.ferretdb,
            postgresImage: IMAGES.postgresDocumentdb,
            ...(guard !== undefined ? { guardRepo: guard.repo, resticImage: guard.resticImage } : {}),
        },
        explicitDependsOn: [],
        readyWhen: httpOk(makeRef<string>(deploy, "internalUrl"), { timeout: "90s" }),
    };
    return { komodo, route: exposure.route, refs: { deploy, deployRoute: exposure.route.id }, ingress: exposure.ingress };
};

// Forgejo stack's full control plane, shared per host: Forgejo, its runner, and Komodo, exposed at
// git.<zone>/deploy.<zone>. Komodo's git + registry accounts derive from Forgejo's outputs.
export const resolvePlatform = (
    hostId: string,
    cloudflareId: string,
    zone: string,
    apiToken: SecretRef,
    host: HostInput,
    guard: GuardConfig | undefined,
): { nodes: ResolvedNode[]; refs: PlatformRefs; ingress: IngressPair[] } => {
    const forgejo = forgejoId(hostId);
    const ssh = sshOf(host);
    const server = makeRef(hostId);
    const git = exposeRoute(cloudflareId, hostId, gitDomain(zone), FORGEJO_PORT, apiToken);
    const deploy = resolveDeploy(
        hostId,
        cloudflareId,
        zone,
        apiToken,
        host,
        guard,
        // Forgejo's built-in registry + the admin's packages token, so Komodo can pull the images CI pushes.
        { authority: registryAuthority(zone), user: adminUsername, token: makeRef<string>(forgejo, "packagesToken") },
        // Admin's token + account so Komodo can clone private repos; domain is Forgejo's internal http://<ip>:3000.
        { url: makeRef<string>(forgejo, "internalUrl"), account: adminUsername, token: makeRef<string>(forgejo, "gitToken") },
    );

    const nodes: ResolvedNode[] = [
        {
            id: forgejo,
            type: "forgejo",
            inputs: {
                server,
                ...ssh,
                internalIp: makeRef<string>(hostId, "internalIp"),
                domain: gitDomain(zone),
                adminUser: adminUsername,
                adminPassword: generated("FORGEJO_ADMIN_PASSWORD"),
                image: IMAGES.forgejo,
                ...(guard !== undefined ? { guardRepo: guard.repo, resticImage: guard.resticImage } : {}),
            },
            explicitDependsOn: [],
            readyWhen: httpOk(makeRef<string>(forgejo, "internalUrl"), { timeout: "120s" }),
        },
        {
            id: runnerId(hostId),
            type: "forgejo-runner",
            // Runner runs on the host; uses Forgejo's internal url, avoiding a tunnel round-trip and DNS dependency.
            inputs: {
                server,
                ...ssh,
                instanceUrl: makeRef<string>(forgejo, "internalUrl"),
                token: makeRef<string>(forgejo, "runnerToken"),
                image: IMAGES.forgejoRunner,
                jobImage: IMAGES.forgejoRunnerJob,
            },
            explicitDependsOn: [],
        },
        deploy.komodo,
        git.route,
        deploy.route,
    ];
    return {
        nodes,
        refs: { forgejo, gitRoute: git.route.id, ...deploy.refs },
        ingress: [git.ingress, deploy.ingress],
    };
};
