import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DesiredStateGraph } from "@intentic/graph";
import { komodoApi } from "@intentic/providers";
import { z } from "zod";
import { loadEnvFile, readArtifact } from "../lib/artifact.js";
import { readGeneratedSecrets } from "../secrets/generated-secrets.js";

// One app deployment as the platform's Apps view renders it: the desired config the resolver baked into the
// graph (image/env/url) plus whether Komodo currently has it registered, with a deep-link into Komodo for the
// runtime detail (logs, status) a dashboard should not rebuild.
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

// A scalar field is surfaced only when present with the right type; anything else (missing, wrong type, a
// $ref/$secret object) reads as undefined — `.catch(undefined)` keeps the view best-effort instead of throwing.
const optionalString = z.string().optional().catch(undefined);
const optionalNumber = z.number().optional().catch(undefined);

// A deployment node's `env` input is a serialized record; surface keys with their scalar values, blanking any
// $ref/$secret value so a secret never leaves the sandbox. Missing/invalid env reads as {}.
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

// The `{$secret:{key}}` shape the resolver emits for generated/admin passwords; the key is the env var holding
// the value.
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

// Resolve the Komodo control plane's public URL + admin login from the graph's `komodo` node. The admin
// password is a generated secret: env-first (the apply pipeline injects it), else the local .secrets.json the
// resolve step wrote in the sandbox.
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

// Build the Apps view for every `deployment` node in the artifact. Liveness is best-effort: when Komodo can be
// reached we confirm each deployment is registered (and capture its id for the deep-link); when it cannot, the
// configured deployments still surface with `live:false` so the view shows what is declared.
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
    // Tri-state: undefined = no komodo in the graph (services-only intents deploy via compose and have NO
    // deployment engine — "unreachable" would be a false alarm); true/false = the declared engine answered
    // or didn't. Surfaced on the result (not just the log line) so the UI can show "Komodo is down on your
    // host" instead of silently painting every deployment as not-live.
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
