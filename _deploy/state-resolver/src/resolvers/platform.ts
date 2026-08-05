import type { Input, SecretRef } from "@intentic/graph";
import { generated, httpOk, makeRef } from "@intentic/graph";
import type { HostInput } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { adminUsername, deployDomain, forgejoId, gitDomain, komodoId, registryAuthority, runnerId } from "../lib/ids.js";
import { IMAGES } from "../lib/images.js";
import { sshOf } from "../lib/ssh.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";

// The deploy-orchestrator slice every stack shares: the Komodo node + its public route. The Forgejo stack
// extends it with the git+CI slice below.
export interface DeployRefs {
    readonly deploy: string;
    // The cf-route id for deploy.<zone>, so nodes that call the public URL can depend on the route being
    // live (DNS + tunnel) before they run.
    readonly deployRoute: string;
}

export interface PlatformRefs extends DeployRefs {
    readonly forgejo: string;
    readonly gitRoute: string;
}

// The [[docker_registry]] account Komodo pulls app images with: the Forgejo built-in registry + the admin's
// packages token, ghcr.io + the GitHub PAT, or the GitLab Container Registry + the GitLab PAT.
export interface RegistryAccount {
    readonly authority: string;
    readonly user: Input<string>;
    readonly token: Input<string>;
}

// The [[git_provider]] account Komodo clones private app repos with — Forgejo stack only (hosted-forge
// deployments are registry Images Komodo never clones).
export interface GitAccount {
    readonly url: Input<string>;
    readonly account: string;
    readonly token: Input<string>;
}

// The fixed host ports the platform services listen on (Forgejo HTTP, Komodo Core), mirrored by their
// providers; the tunnel routes git.<zone>/deploy.<zone> to these.
const FORGEJO_PORT = 3000;
const KOMODO_PORT = 9120;

// When guarded updates are on (host.updatePolicy === "guarded" + a backup is declared), the stateful
// services carry the restic repo + image so a pin bump runs as a snapshot/rollback transaction; the
// password/creds come from the on-host restic.env the backup provider writes.
export interface GuardConfig {
    readonly repo: string;
    readonly resticImage: string;
}

// The deploy orchestrator every app on a host requires, shared per host: Komodo, exposed at deploy.<zone> so
// its UI + the worker Peripheries are reachable. Terse defaults: adminUser "intentic", an intentic-generated
// admin password, a domain-derived health gate. Returns the exposure's ingress pair so the caller can
// aggregate the host's tunnel ingress.
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
    // The platform services are deployed ONTO the host over SSH (like the tunnel connector), so every
    // deploy-style node carries the host's SSH creds + its internal ip. internalUrl/readyWhen are keyed
    // to the host-internal address so they're reachable before the Cloudflare tunnel + DNS routes exist.
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

// The Forgejo stack's full control plane, shared per host: Forgejo, its runner, and Komodo, exposed at
// git.<zone>/deploy.<zone> so push/CI/UI are reachable. Komodo's git + registry accounts derive from the
// Forgejo node's outputs (internal url, git token, packages token).
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
        // The Forgejo built-in registry + the admin's packages token, so Komodo can pull the private app
        // images CI pushes.
        { authority: registryAuthority(zone), user: adminUsername, token: makeRef<string>(forgejo, "packagesToken") },
        // The admin's token + account, so Komodo can clone the private app repos. The git provider domain is
        // derived from Forgejo's internal http://<ip>:3000 authority.
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
            // The runner runs ON the host, so it reaches Forgejo at its internal url directly — using the
            // public url would force a needless round-trip through the tunnel (and depend on DNS being live).
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
