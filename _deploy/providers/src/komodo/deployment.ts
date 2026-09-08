import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { hasPendingRef, parseInputs, registryImage, sshSchema } from "../core/inputs.js";
import { overSsh } from "../core/over-ssh.js";
import type { SshExecutor } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import type { DeploymentConfig, KomodoApi } from "./komodo-api.js";
import { komodoApi } from "./komodo-api.js";
import { KOMODO_CORE_PORT } from "./komodo.js";

// Komodo server for control-plane-local deployments; worker-host deployments use the host id as server name.
const LOCAL_SERVER = "Local";

// ssh targets the control-plane host running Komodo Core; the deployment itself may still target a worker's Server.
const deploymentSchema = sshSchema.extend({
    // The Komodo Server the deployment targets: "Local" for the CP host, the host id for workers.
    server: z.string().default(LOCAL_SERVER),
    adminUser: z.string(),
    adminPassword: z.string(),
    // The repo + registry namespace (a team's org, or the admin user when team-less), matches CI's owner.
    owner: z.string(),
    repoName: z.string(),
    // Registry + tag form the image CI pushes; registryAccount selects the matching docker_registry entry.
    registry: z.string(),
    registryAccount: z.string(),
    tag: z.string(),
    domain: z.string(),
    internalIp: z.string(),
    // Deterministic host port the deployment publishes, computed by the resolver to match the tunnel's ingress.
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
    // A registry Image, not a Komodo Build: CI builds and pushes it, Komodo only pulls and runs it.
    image: {
        type: "Image",
        params: { image: registryImage({ registry: parsed.registry, owner: parsed.owner, repoName: parsed.repoName, tag: parsed.tag }) },
    },
    // Selects the [[docker_registry]] account (domain=registry, username=registryAccount) so Komodo can pull it.
    image_registry_account: parsed.registryAccount,
    // Watches the tag's manifest digest and redeploys on change; a CI push goes live without intentic deploying.
    poll_for_updates: true,
    auto_update: true,
    // CreateDeployment requires struct form, not "host:container"; ignored under host network, but still the port.
    ports: [{ local: String(parsed.port), container: String(parsed.port) }],
    environment: Object.entries(parsed.env).map(([variable, value]) => ({ variable, value: String(value) })),
    restart: "unless-stopped",
});

// Collapses env to stable, order-independent "K=V" lines; Komodo stores it as a spaced multiline string
// (" PORT = 27748\n") while this sends {variable,value} pairs, so both are trimmed the same way.
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

// Stable key over the one field diff actually converges: env; server_id, image, ports and branch are fixed
// or absent at the Deployment level and excluded, keeping diff free of ctx.id.
const desiredKey = (parsed: DeploymentInputs): string =>
    JSON.stringify(normalizeEnv(Object.entries(parsed.env).map(([variable, value]) => ({ variable, value: String(value) }))));
const observedKey = (config: DeploymentConfig): string => JSON.stringify(normalizeEnv(config.environment));

// One Komodo Deployment per environment (name = ctx.id), pulled from the CI-pushed registry image; API calls go
// over an SSH port-forward to Core, never the public route. `apply` only registers it; CI and Komodo's auto_update roll
// it out.
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
        // No build, no deploy here; CI's push plus Komodo's poll/auto_update roll the image out.
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
