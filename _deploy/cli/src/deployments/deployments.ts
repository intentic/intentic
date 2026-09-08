import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DesiredStateGraph } from "@intentic/graph";
import { komodoApi } from "@intentic/providers";
import { z } from "zod";
import { loadEnvFile, readArtifact } from "../lib/artifact.js";
import { readGeneratedSecrets } from "../secrets/generated-secrets.js";

// One app deployment as the Apps view renders it: the resolved config (image/env/url) plus whether Komodo has it
// registered, with a deep-link for runtime detail.
export interface DeploymentView {
    readonly name: string;
    readonly image: string;
    readonly tag: string;
    readonly domain?: string;
    readonly url?: string;
    readonly port?: number;
    readonly env: Record<string, string>;
    readonly live: boolean;
    readonly komodoUrl: string;
    readonly komodoDeploymentUrl?: string;
}

// Surfaces a scalar field only if present with the right type; anything else reads as undefined.
const optionalString = z.string().optional().catch(undefined);
const optionalNumber = z.number().optional().catch(undefined);

// Surfaces `env` keys with scalar values only, blanking any $ref/$secret so a secret never leaves the sandbox.
const envInput = z
    .record(z.string(), z.unknown())
    .transform((record) =>
        Object.fromEntries(
            Object.entries(record).map(([key, value]) => [
                key,
                typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "",
            ]),
        ),
    )
    .catch({});

// The `{$secret:{key}}` shape the resolver emits for generated/admin passwords: key names the env var.
const secretInput = z
    .object({ $secret: z.object({ key: z.string() }) })
    .optional()
    .catch(undefined);

// One deployment node's inputs, as the Apps view reads them.
const deploymentInputs = z.object({
    registry: optionalString,
    owner: optionalString,
    repoName: optionalString,
    tag: optionalString,
    domain: optionalString,
    port: optionalNumber,
    env: envInput,
});

// The komodo control-plane node's inputs needed to log in.
const komodoInputs = z.object({ domain: optionalString, adminUser: optionalString, adminPassword: secretInput });

// Resolves the Komodo control plane's URL and admin login from the graph's `komodo` node. The admin password is
// env-first, falling back to the local .secrets.json the resolve step wrote.
const komodoAccess = (graph: DesiredStateGraph, generated: Record<string, string>): { url: string; user: string; password: string } | undefined => {
    const node = Object.values(graph.resources).find((resource) => resource.type === "komodo");
    if (node === undefined) {
        return undefined;
    }
    const { domain, adminUser: user, adminPassword } = komodoInputs.parse(node.inputs);
    const key = adminPassword?.$secret.key;
    const password = key !== undefined ? (process.env[key] ?? generated[key]) : undefined;
    if (domain === undefined || user === undefined || password === undefined || password === "") {
        return undefined;
    }
    return { url: `https://${domain}`, user, password };
};

// Builds the Apps view for every `deployment` node. Liveness is best-effort: registered deployments get a Komodo id and
// deep-link when reachable; otherwise they surface with `live:false`.
export const collectDeployments = async (
    artifact: string,
    log: (message: string) => void,
): Promise<{ deployments: DeploymentView[]; komodoReachable: boolean | undefined }> => {
    if (!existsSync(artifact)) {
        return { deployments: [], komodoReachable: undefined };
    }
    const dir = dirname(artifact);
    loadEnvFile(dir);
    const graph = await readArtifact(artifact);
    const generated = await readGeneratedSecrets(dir);

    const access = komodoAccess(graph, generated);
    const komodoUrl = access?.url ?? "";
    const liveIds = new Map<string, string>();
    // Tri-state: undefined means no komodo node; true/false is whether the reachable engine answered.
    let komodoReachable: boolean | undefined = access === undefined ? undefined : true;
    if (access !== undefined) {
        try {
            const jwt = await komodoApi.login({ baseUrl: access.url, username: access.user, password: access.password });
            for (const item of await komodoApi.listDeployments({ baseUrl: access.url, jwt })) {
                liveIds.set(item.name, item.id);
            }
        } catch (error) {
            komodoReachable = false;
            log(`komodo not reachable, showing desired config only: ${String(error)}`);
        }
    }

    const deployments = Object.values(graph.resources)
        .filter((resource) => resource.type === "deployment")
        // oxlint-disable-next-line oxc/no-map-spread -- conditional spreads omit optional keys, required under exactOptionalPropertyTypes
        .map((node) => {
            const { registry, owner, repoName, tag, domain, port, env } = deploymentInputs.parse(node.inputs);
            const komodoId = liveIds.get(node.id);
            return {
                name: node.id,
                image: `${registry ?? ""}/${owner ?? ""}/${repoName ?? ""}:${tag ?? ""}`,
                tag: tag ?? "",
                ...(domain !== undefined ? { domain, url: `https://${domain}` } : {}),
                ...(port !== undefined ? { port } : {}),
                env,
                live: komodoId !== undefined,
                komodoUrl,
                ...(komodoId !== undefined && komodoUrl !== "" ? { komodoDeploymentUrl: `${komodoUrl}/deployment/${komodoId}` } : {}),
            };
        });
    return { deployments, komodoReachable };
};
