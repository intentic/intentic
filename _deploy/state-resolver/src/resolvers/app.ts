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

// Which forge sources the app: Forgejo carries platform refs, hosted forges carry their inventory node + PAT.
// Selects repo/CI node types and registry; Komodo deployment + route emission is identical across all three.
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

// Builds everything an app needs beyond the shared deploy orchestrator: repo, per-env CI node, Komodo deployment,
// route. intentic never builds or deploys; CI builds+pushes, Komodo rolls out. Identity nodes scope under
// controlPlaneHost, not intent.on.
export const resolveApp = (
    intent: AppIntent,
    forge: AppForge,
    deploy: DeployRefs,
    apiToken: SecretRef,
    zone: string,
    controlPlaneHost: string,
    // Control-plane host's connection block; API nodes reach it via SSH port-forward, never public routes.
    cpHost: HostInput,
    // Backing instances this app may consume, keyed by id with their host; bindings deploy there over SSH.
    backings: ReadonlyMap<string, { readonly intent: BackingIntent; readonly host: HostInput }>,
): { nodes: ResolvedNode[]; ingress: IngressPair[] } => {
    const repo = repoId(intent.id);
    const cpSsh = sshOf(cpHost);
    // Public Komodo url, for the hosted forges' CI only (their notify runs on a hosted runner, off the host).
    const komodoUrl = makeRef<string>(deploy.deploy, "url");
    const komodoAdmin = { adminUser: adminUsername, adminPassword: generated("KOMODO_ADMIN_PASSWORD") };
    const registry = forgeRegistry(forge, zone);

    // Repo/registry owner: Forgejo's first team org, else admin; hosted forges use the account's owner output.
    const ownerTeam = forge.kind === "forgejo" ? intent.teams?.[0] : undefined;
    const owner: Input<string> =
        forge.kind === "forgejo"
            ? ownerTeam !== undefined
                ? orgName(ownerTeam.team)
                : adminUsername
            : makeRef<string>(forge.kind === "github" ? forge.githubId : forge.gitlabId, "owner");
    const ownerDeps = ownerTeam !== undefined ? [forgejoOrgId(controlPlaneHost, ownerTeam.team)] : [];
    const registryAccount: Input<string> = forge.kind === "forgejo" ? adminUsername : owner;

    // Observe wires OTLP to the service's host-internal endpoint; spread before the author's env so overrides win.
    const otel =
        intent.observe !== undefined
            ? { OTEL_EXPORTER_OTLP_ENDPOINT: makeRef<string>(intent.observe, "otlpEndpoint"), OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" }
            : undefined;

    // Binding mints credentials and gates the deployment; appDomains let auth whitelist OIDC redirects.
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
                  // Depends on Forgejo (reached over the CP host's SSH) and, if team-owned, the owning org.
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

    // GitLab wires one .gitlab-ci.yml per app (a job per env); other forges commit one workflow file per env.
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
                // Notify step runs on a hosted runner, so it reaches Komodo through its public url.
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

        // Commits the build→push→notify workflow + secrets; seeds a starter Dockerfile if the repo has none.
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
                    // Notify runs on the host (--network host); uses Komodo's internal url, avoiding a tunnel hairpin.
                    komodoUrl: makeRef<string>(deploy.deploy, "internalUrl"),
                    deployment: id,
                },
                // Commits over the CP host's SSH; waits on Komodo being up and the repo's owning org.
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
                    // Notify step runs on a hosted runner, so it reaches Komodo through its public url.
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
                // Komodo Server to target: worker hosts use the host id; the CP host omits it, defaulting to Komodo's
                // "Local".
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
            // No default readyWhen: apply only registers the deployment; a default gate would hang until CI pushes an
            // image.
            explicitDependsOn: [ciDep, deploy.deploy, ...(intent.observe !== undefined ? [intent.observe] : []), ...bindingDeps],
            ...(environment.readyWhen !== undefined ? { readyWhen: environment.readyWhen } : {}),
        });
        const exposure = exposeRoute(intent.expose, intent.on, environment.domain, port, apiToken);
        nodes.push(exposure.route);
        ingress.push(exposure.ingress);
    }

    // notify: discord derives a Komodo alerter on deploy (all stacks) and, on Forgejo, a webhook on build results.
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
