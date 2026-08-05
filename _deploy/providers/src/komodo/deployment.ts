import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { hasPendingRef, parseInputs, registryImage, sshSchema } from "../core/inputs.js";
import { overSsh } from "../core/over-ssh.js";
import type { SshExecutor } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import type { DeploymentConfig, KomodoApi } from "./komodo-api.js";
import { komodoApi } from "./komodo-api.js";
import { KOMODO_CORE_PORT } from "./komodo.js";

// The Komodo server for control-plane-local deployments (auto-registered by KOMODO_FIRST_SERVER_NAME in
// komodo.ts). Worker-host deployments use the host id as server name, registered by komodo-server.
const LOCAL_SERVER = "Local";

// The ssh block is the CONTROL-PLANE host's (where Komodo Core runs) — the engine registers the deployment
// against Core over an SSH port-forward, even when the deployment itself targets a worker host's Server.
const deploymentSchema = sshSchema.extend({
    // The Komodo Server the deployment targets: "Local" for the CP host, the host id for workers.
    server: z.string().default(LOCAL_SERVER),
    adminUser: z.string(),
    adminPassword: z.string(),
    // The repo + registry namespace (a team's org, or the admin user when team-less) — matches CI's owner.
    owner: z.string(),
    repoName: z.string(),
    // The registry authority (Forgejo's built-in registry, ghcr.io, or the GitLab Container Registry) + the
    // image tag (= environment name); image = registry/<owner>/<repoName>:<tag>, matching exactly what the CI
    // workflow pushes. registryAccount is the [[docker_registry]] username komodo.ts wrote for that authority,
    // selected via image_registry_account so Komodo can pull the private image.
    registry: z.string(),
    registryAccount: z.string(),
    tag: z.string(),
    domain: z.string(),
    internalIp: z.string(),
    // The deterministic host port the deployment publishes, computed by the resolver (deploymentPort) so it
    // matches the tunnel's ingress for this environment exactly.
    port: z.coerce.number(),
    env: z.record(z.string(), z.unknown()).default({}),
});
type DeploymentInputs = z.infer<typeof deploymentSchema>;
const parse = (inputs: ResolvedInputs): DeploymentInputs => parseInputs(deploymentSchema, inputs, "deployment");

const outputsFor = (parsed: DeploymentInputs): Record<string, unknown> => ({
    url: `https://${parsed.domain}`,
    internalUrl: `http://${parsed.internalIp}:${parsed.port}`,
});

const deploymentConfig = (parsed: DeploymentInputs): Record<string, unknown> => ({
    server_id: parsed.server,
    // A registry Image (NOT a Komodo Build) — CI builds + pushes it; Komodo only pulls + runs it. The image
    // path is namespaced under the repo owner (the team's org), matching exactly what CI pushes.
    image: {
        type: "Image",
        params: { image: registryImage({ registry: parsed.registry, owner: parsed.owner, repoName: parsed.repoName, tag: parsed.tag }) },
    },
    // Selects the [[docker_registry]] account komodo.ts writes (domain = registry, username = registryAccount)
    // so Komodo can pull the private image.
    image_registry_account: parsed.registryAccount,
    // Komodo watches the tag's manifest digest (poll_for_updates) and redeploys when it changes (auto_update),
    // so a CI push of a new image goes live without intentic deploying anything.
    poll_for_updates: true,
    auto_update: true,
    // Komodo's CreateDeployment rejects the "host:container" string form; it wants the struct form. Ignored
    // at runtime under the default host network, but the published port is the host port either way.
    ports: [{ local: String(parsed.port), container: String(parsed.port) }],
    environment: Object.entries(parsed.env).map(([variable, value]) => ({ variable, value: String(value) })),
    restart: "unless-stopped",
});

// Collapse Komodo's env to a stable, order-independent set of canonical "K=V" lines. Komodo stores it as a
// multiline string with spaces around "=" ("  PORT = 27748\n"); we send the array-of-{variable,value} form.
// Normalize both: trim each line, then trim around the first "=".
const normalizeEnv = (env: string | readonly { readonly variable: string; readonly value: string }[]): string => {
    const lines = typeof env === "string" ? env.split("\n") : env.map(({ variable, value }) => `${variable}=${value}`);
    return lines
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => {
            const eq = line.indexOf("=");
            return eq < 0 ? line : `${line.slice(0, eq).trim()}=${line.slice(eq + 1).trim()}`;
        })
        .toSorted()
        .join("\n");
};

// A stable key over the one authored MUTABLE field the provisioner converges: env. server_id, the build
// image, the deterministic ports, and branch (a Build concept Komodo does not store on a Deployment) are all
// fixed/absent at the Deployment level, so they are excluded — keeping diff pure and free of ctx.id.
const desiredKey = (parsed: DeploymentInputs): string =>
    JSON.stringify(normalizeEnv(Object.entries(parsed.env).map(([variable, value]) => ({ variable, value: String(value) }))));
const observedKey = (config: DeploymentConfig): string => JSON.stringify(normalizeEnv(config.environment));

// One Komodo Deployment per environment (named <app>.<env> = ctx.id), pulled from the registry image CI
// pushes and exposed on a deterministic host port. All Komodo API calls go over an SSH port-forward to Core
// on the CP host — never the public route. read returns undefined until the host's internalIp resolves or
// while Komodo is unreachable, otherwise it surfaces the deployment's current config. diff converges on that
// config alone. apply ONLY registers the desired Komodo deployment (create-or-update) — it does NOT build or
// deploy: the image is produced by CI and rolled out by Komodo's poll/auto_update + the workflow's notify.
export const createDeploymentProvider = (api: KomodoApi = komodoApi, executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        if (hasPendingRef(inputs, "internalIp")) {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            return await overSsh(executor, parsed, KOMODO_CORE_PORT, async (baseUrl) => {
                const jwt = await api.login({ baseUrl, username: parsed.adminUser, password: parsed.adminPassword });
                const deployment = (await api.listDeployments({ baseUrl, jwt })).find((item) => item.name === ctx.id);
                if (deployment === undefined) {
                    return undefined;
                }
                const config = await api.getDeployment({ baseUrl, jwt, deployment: ctx.id });
                return { outputs: outputsFor(parsed), detail: { config } };
            });
        } catch (error) {
            ctx.log(`deployment "${ctx.id}": komodo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: (inputs, observed) => {
        const config = observed.detail?.["config"] as DeploymentConfig | undefined;
        if (config === undefined || observedKey(config) !== desiredKey(parse(inputs))) {
            return { action: "update", reason: "deployment config differs from desired" };
        }
        return { action: "noop" };
    },
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        await overSsh(executor, parsed, KOMODO_CORE_PORT, async (baseUrl) => {
            const jwt = await api.login({ baseUrl, username: parsed.adminUser, password: parsed.adminPassword });
            const existing = (await api.listDeployments({ baseUrl, jwt })).find((item) => item.name === ctx.id);
            if (existing === undefined) {
                await api.createDeployment({ baseUrl, jwt, name: ctx.id, config: deploymentConfig(parsed) });
            } else {
                await api.updateDeployment({ baseUrl, jwt, id: existing.id, config: deploymentConfig(parsed) });
            }
        });
        // No build, no deploy: CI pushes the image and Komodo's poll/auto_update (and the workflow's notify)
        // roll it out. apply only registers the desired deployment.
        return outputsFor(parsed);
    },
    delete: async (inputs, ctx) => {
        const parsed = parse(inputs);
        await overSsh(executor, parsed, KOMODO_CORE_PORT, async (baseUrl) => {
            const jwt = await api.login({ baseUrl, username: parsed.adminUser, password: parsed.adminPassword });
            const existing = (await api.listDeployments({ baseUrl, jwt })).find((item) => item.name === ctx.id);
            if (existing === undefined) {
                return;
            }
            await api.deleteDeployment({ baseUrl, jwt, id: existing.id });
        });
    },
});
