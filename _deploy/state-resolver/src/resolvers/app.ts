import type { Input, Ref, SecretRef } from "@intentic/graph";
import { generated, makeRef } from "@intentic/graph";
import type { AppIntent, BackingIntent, HostInput } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import {
    adminUsername,
    ciId,
    deploymentId,
    deploymentPort,
    forgejoNotifyId,
    forgejoOrgId,
    ghCiId,
    gitDomain,
    glCiId,
    komodoNotifyId,
    orgName,
    registryAuthority,
    repoId,
} from "../lib/ids.js";
import { sshOf } from "../lib/ssh.js";
import { bindingEnv, resolveBinding } from "./backing.js";
import type { DeployRefs, PlatformRefs } from "./platform.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";

// Which forge sources the app. The Forgejo stack carries its platform refs (self-hosted git + CI); the
// hosted forges carry their inventory node + PAT. The forge selects the repo/CI node types and the registry
// the image lives in; the Komodo deployment + route emission below is identical across all three. CI only
// builds and pushes, Komodo rolls out.
export type AppForge =
    | { readonly kind: "forgejo"; readonly platform: PlatformRefs }
    | { readonly kind: "github"; readonly githubId: string; readonly token: SecretRef }
    | { readonly kind: "gitlab"; readonly gitlabId: string; readonly token: SecretRef; readonly url: string; readonly registry: string };

// The registry authority the forge's CI pushes app images to (and Komodo pulls from).
export const forgeRegistry = (forge: AppForge, zone: string): string => {
    switch (forge.kind) {
        case "forgejo":
            return registryAuthority(zone);
        case "github":
            return "ghcr.io";
        case "gitlab":
            return forge.registry;
    }
};

// The app resolver: everything shipping an app beyond the shared deploy orchestrator, a repo, and per
// environment a CI node (commits the build-and-push workflow + repo secrets), a Komodo deployment pointed at
// the registry image, and its Cloudflare route. intentic does NOT build or deploy: the CI workflow builds +
// pushes the image on a developer push and Komodo rolls it out (auto_update polling, plus the workflow's
// notify). The config nodes talk to the forge/Komodo HTTP APIs, so each carries its backend url + login.
// Returns each environment's ingress pair so the caller can aggregate the host's tunnel ingress.
// `controlPlaneHost` is the id of the host running the deploy orchestrator (and Forgejo, on that stack);
// identity nodes (forgejo-org) are scoped under it, not `intent.on` (which may be a worker host).
export const resolveApp = (
    intent: AppIntent,
    forge: AppForge,
    deploy: DeployRefs,
    apiToken: SecretRef,
    zone: string,
    controlPlaneHost: string,
    // The control-plane host's connection block: the engine-side Forgejo/Komodo API nodes (repo, ci,
    // deployment, notify) reach their services over an SSH port-forward to this host, never the public routes.
    cpHost: HostInput,
    // The backing instances this app may consume, keyed by instance id, each with the host it runs on (the
    // binding nodes deploy onto that host over SSH). emit builds this from intent.backings + the host map.
    backings: ReadonlyMap<string, { readonly intent: BackingIntent; readonly host: HostInput }>,
): { nodes: ResolvedNode[]; ingress: IngressPair[] } => {
    const repo = repoId(intent.id);
    const cpSsh = sshOf(cpHost);
    // The PUBLIC Komodo url, content for the hosted forges' CI only (their notify step runs on a hosted
    // runner, off the host); the engine itself never dials it.
    const komodoUrl = makeRef<string>(deploy.deploy, "url");
    const komodoAdmin = { adminUser: adminUsername, adminPassword: generated("KOMODO_ADMIN_PASSWORD") };
    const registry = forgeRegistry(forge, zone);

    // The repo + registry namespace. Forgejo: the first team grant's org owns the app, falling back to the
    // single admin owner (the admin still authenticates every call, it owns the org). Hosted forges: the
    // forge account's owner output (teams are a Forgejo-stack concept; emit rejects them on hosted stacks).
    // Komodo pulls with the admin's packages token (Forgejo) or the forge PAT (its [[docker_registry]]
    // account is keyed by the same owner).
    const ownerTeam = forge.kind === "forgejo" ? intent.teams?.[0] : undefined;
    const owner: Input<string> =
        forge.kind === "forgejo"
            ? ownerTeam !== undefined
                ? orgName(ownerTeam.team)
                : adminUsername
            : makeRef<string>(forge.kind === "github" ? forge.githubId : forge.gitlabId, "owner");
    const ownerDeps = ownerTeam !== undefined ? [forgejoOrgId(controlPlaneHost, ownerTeam.team)] : [];
    const registryAccount: Input<string> = forge.kind === "forgejo" ? adminUsername : owner;

    // Telemetry wiring: when the app observes a service, every deployment exports OTLP to that service's
    // host-internal endpoint. Spread before the author's own env so an explicit OTEL_* can still override.
    const otel =
        intent.observe !== undefined
            ? { OTEL_EXPORTER_OTLP_ENDPOINT: makeRef<string>(intent.observe, "otlpEndpoint"), OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" }
            : undefined;

    // Backing wiring: for each capability the app uses, emit a per-app binding node that mints the app's
    // isolated credentials on the instance, inject its connection env vars (DATABASE_URL, VALKEY_URL, …) into
    // every deployment, and gate each deployment on the binding so the credentials exist before it registers.
    // The app's public domains across environments, the auth binding whitelists OIDC redirects under them.
    const appDomains = Object.values(intent.environments).map((environment) => environment.domain);
    const bindingNodes: ResolvedNode[] = [];
    const bound: Record<string, Ref<string>> = {};
    const bindingDeps: string[] = [];
    for (const binding of intent.use ?? []) {
        const backing = backings.get(binding.target);
        if (backing === undefined) {
            throw new Error(`app "${intent.id}" uses unknown backing "${binding.target}"; declare it with i.want.${binding.capability}`);
        }
        const node = resolveBinding(intent.id, backing.intent, backing.host, appDomains);
        bindingNodes.push(node);
        Object.assign(bound, bindingEnv(intent.id, backing.intent));
        bindingDeps.push(node.id);
    }

    const forgejoAdmin = { adminUser: adminUsername, adminPassword: generated("FORGEJO_ADMIN_PASSWORD") };
    const repoNode: ResolvedNode =
        forge.kind === "forgejo"
            ? {
                  id: repo,
                  type: "repo",
                  inputs: {
                      name: intent.id,
                      owner,
                      private: true,
                      ...cpSsh,
                      domain: gitDomain(zone),
                      ...forgejoAdmin,
                  },
                  // Reaches Forgejo over the CP host's SSH, so only Forgejo itself must be up; and after
                  // the owning org exists when the app is team-owned.
                  explicitDependsOn: [forge.platform.forgejo, ...ownerDeps],
              }
            : forge.kind === "github"
              ? {
                    id: repo,
                    type: "gh-repo",
                    inputs: { name: intent.id, owner, private: true, token: forge.token },
                    explicitDependsOn: [forge.githubId],
                }
              : {
                    id: repo,
                    type: "gl-repo",
                    inputs: { name: intent.id, owner, private: true, url: forge.url, token: forge.token },
                    explicitDependsOn: [forge.gitlabId],
                };

    const nodes: ResolvedNode[] = [...bindingNodes, repoNode];
    const ingress: IngressPair[] = [];

    // GitLab wires ONE .gitlab-ci.yml per app (a job per environment); the other forges commit one workflow
    // file per environment inside the loop below.
    if (forge.kind === "gitlab") {
        nodes.push({
            id: glCiId(intent.id),
            type: "gl-ci",
            inputs: {
                url: forge.url,
                owner,
                repoName: intent.id,
                token: forge.token,
                registry,
                // The notify step runs on a hosted runner, so it reaches Komodo through its PUBLIC url.
                komodoUrl,
                ...komodoAdmin,
                environments: Object.entries(intent.environments).map(([name, environment]) => ({
                    name,
                    branch: environment.branch,
                    tag: name,
                    deploymentId: deploymentId(intent.id, name),
                })),
            },
            explicitDependsOn: [forge.gitlabId, repo, deploy.deploy, deploy.deployRoute],
        });
    }

    for (const [name, environment] of Object.entries(intent.environments)) {
        const id = deploymentId(intent.id, name);
        const port = deploymentPort(id);
        // OTLP + backing connection vars first, the author's own env last so an explicit value still wins.
        const merged = { ...otel, ...bound, ...environment.env };
        const env = Object.keys(merged).length > 0 ? merged : undefined;

        // CI/CD wiring: commits the build → push → notify-Komodo workflow + the secrets it consumes, and
        // seeds a starter Dockerfile if the repo has none.
        let ciDep: string;
        if (forge.kind === "forgejo") {
            ciDep = ciId(intent.id, name);
            nodes.push({
                id: ciDep,
                type: "ci",
                inputs: {
                    ...cpSsh,
                    ...forgejoAdmin,
                    komodoPassword: komodoAdmin.adminPassword,
                    owner,
                    repoName: intent.id,
                    branch: environment.branch,
                    registry,
                    tag: name,
                    packagesToken: makeRef<string>(forge.platform.forgejo, "packagesToken"),
                    // The workflow's notify step runs ON the host (runner is --network host), so it reaches
                    // Komodo at its internal url directly, the public url would hairpin through the tunnel.
                    komodoUrl: makeRef<string>(deploy.deploy, "internalUrl"),
                    deployment: id,
                },
                // Commits over the CP host's SSH and bakes Komodo's internal url into the workflow (waits on
                // Komodo being up); the repo it commits into is owned by the org.
                explicitDependsOn: [forge.platform.forgejo, deploy.deploy, repo, ...ownerDeps],
            });
        } else if (forge.kind === "github") {
            ciDep = ghCiId(intent.id, name);
            nodes.push({
                id: ciDep,
                type: "gh-ci",
                inputs: {
                    owner,
                    repoName: intent.id,
                    branch: environment.branch,
                    tag: name,
                    token: forge.token,
                    // The notify step runs on a hosted runner, so it reaches Komodo through its PUBLIC url.
                    komodoUrl,
                    ...komodoAdmin,
                    deployment: id,
                },
                explicitDependsOn: [forge.githubId, repo, deploy.deploy, deploy.deployRoute],
            });
        } else {
            ciDep = glCiId(intent.id);
        }

        nodes.push({
            id,
            type: "deployment",
            inputs: {
                // The Komodo Server to target: worker hosts use the host id (registered by komodo-server);
                // the CP host omits this so the schema default "Local" is used (auto-created by Komodo's
                // KOMODO_FIRST_SERVER_NAME).
                ...(intent.on !== controlPlaneHost ? { server: intent.on } : {}),
                owner,
                repoName: intent.id,
                registry,
                registryAccount,
                tag: name,
                domain: environment.domain,
                internalIp: makeRef<string>(intent.on, "internalIp"),
                port,
                ...cpSsh,
                ...komodoAdmin,
                ...(env !== undefined ? { env } : {}),
            },
            // Depends on ci so the workflow + secrets exist first; on Komodo being up (registered over the CP
            // host's SSH, no public route in the path); and on each backing binding so the app's credentials
            // exist before it registers. No default readyWhen: apply only registers the deployment (it does
            // not go live until CI pushes an image), so an httpOk gate would hang forever, honour only an
            // author-supplied one.
            explicitDependsOn: [ciDep, deploy.deploy, ...(intent.observe !== undefined ? [intent.observe] : []), ...bindingDeps],
            ...(environment.readyWhen !== undefined ? { readyWhen: environment.readyWhen } : {}),
        });
        const exposure = exposeRoute(intent.expose, intent.on, environment.domain, port, apiToken);
        nodes.push(exposure.route);
        ingress.push(exposure.ingress);
    }

    // CI/CD notifications: when the app wires a Discord handle (notify: discord), derive a Komodo alerter
    // scoped to this app's deployments on deploy results (CD), all stacks, and a Forgejo repo webhook on
    // build results (CI) on the Forgejo stack (the hosted forges own their build notifications).
    if (intent.notify !== undefined) {
        const webhook = makeRef<string>(intent.notify, `appWebhook:${intent.id}`);
        if (forge.kind === "forgejo") {
            nodes.push({
                id: forgejoNotifyId(intent.id),
                type: "forgejo-notify",
                inputs: {
                    ...cpSsh,
                    ...forgejoAdmin,
                    owner,
                    repoName: intent.id,
                    webhook,
                    events: ["build"],
                },
                explicitDependsOn: [forge.platform.forgejo, repo, intent.notify, ...ownerDeps],
            });
        }
        const targets = Object.keys(intent.environments).map((environment) => deploymentId(intent.id, environment));
        nodes.push({
            id: komodoNotifyId(intent.id),
            type: "komodo-notify",
            inputs: { ...cpSsh, ...komodoAdmin, targets, webhook, events: ["deploy"] },
            explicitDependsOn: [deploy.deploy, intent.notify, ...targets],
        });
    }

    return { nodes, ingress };
};
