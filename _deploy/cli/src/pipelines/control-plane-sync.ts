import { type DesiredStateGraph, secretRef, type SecretSource } from "@intentic/graph";
import { type ForgejoApi, forgejoApi } from "@intentic/providers";
import { ARTIFACT_FILE, CONFIG_FILE, INTENT_DIR, TARGET_DIR } from "../lib/artifact.js";
import { collectSecrets } from "../secrets/secrets.js";
import { APPLY_WORKFLOW_PATH, applyWorkflowYaml, type PipelineInputs, setRepoSecrets, writeWorkflow } from "./adopt-pipelines.js";

// SSH connection block for the control-plane host, as the forgejo node carries it: literal address/user, the key as a
// secret ref, optional port/via transport.
export interface ForgejoSsh {
    readonly address: string;
    readonly user: string;
    readonly sshKeyRef: { readonly source: SecretSource; readonly key: string };
    readonly port?: number;
    readonly via?: "direct" | "cloudflared";
}

// Forgejo's public domain, admin identity, and CP host SSH block; how `adopt` and the post-adopt resolve sync both
// reach it (an SSH port-forward, never the public route).
export const forgejoIdentity = (
    graph: DesiredStateGraph,
): {
    readonly domain: string;
    readonly user: string;
    readonly adminPasswordRef: { readonly source: SecretSource; readonly key: string };
    readonly ssh: ForgejoSsh;
} => {
    const forgejo = Object.values(graph.resources).find((node) => node.type === "forgejo");
    if (forgejo === undefined) {
        throw new Error("no forgejo resource in the artifact: run `intentic deploy apply` first");
    }
    const domain = forgejo.inputs["domain"];
    const user = forgejo.inputs["adminUser"];
    if (typeof domain !== "string" || typeof user !== "string") {
        throw new Error("forgejo resource is missing its domain/adminUser inputs");
    }
    const adminPasswordRef = secretRef(forgejo.inputs["adminPassword"]);
    if (adminPasswordRef === undefined) {
        throw new Error("forgejo resource is missing its adminPassword secret");
    }
    const address = forgejo.inputs["address"];
    const sshUser = forgejo.inputs["user"];
    const sshKeyRef = secretRef(forgejo.inputs["sshKey"]);
    if (typeof address !== "string" || typeof sshUser !== "string" || sshKeyRef === undefined) {
        throw new Error("forgejo resource is missing its ssh connection inputs");
    }
    const port = forgejo.inputs["port"];
    const via = forgejo.inputs["via"];
    return {
        domain,
        user,
        adminPasswordRef,
        ssh: {
            address,
            user: sshUser,
            sshKeyRef,
            ...(typeof port === "number" ? { port } : {}),
            ...(via === "direct" || via === "cloudflared" ? { via } : {}),
        },
    };
};

// Pushes newly-added generated secrets to Forgejo and regenerates apply.yaml, diffed against the previous artifact so
// existing secrets are never overwritten. New `env` secrets are returned for the caller to warn about.
export const syncControlPlaneSecrets = async (args: {
    readonly previousGraph: DesiredStateGraph | undefined;
    readonly newGraph: DesiredStateGraph;
    readonly env: Readonly<Record<string, string | undefined>>;
    // Desired-state repo checkout root; apply.yaml regenerates under <dir>/.forgejo/workflows/.
    readonly dir: string;
    // Forgejo admin password the secret PUTs authenticate with (HTTP Basic, same as adopt).
    readonly password: string;
    // Pinned into the regenerated apply.yaml's `pnpm dlx @intentic/cli@<version>`.
    readonly cliVersion: string;
    readonly log: (message: string) => void;
    readonly api?: ForgejoApi;
}): Promise<{ readonly pushed: readonly string[]; readonly newEnv: readonly string[] }> => {
    // Without a previous artifact every key looks new; skip rather than overwrite Forgejo's values.
    if (args.previousGraph === undefined) {
        args.log("sync-control-plane: no previous artifact to diff against, skipping secret sync");
        return { pushed: [], newEnv: [] };
    }
    const api = args.api ?? forgejoApi;
    const { domain, user, adminPasswordRef } = forgejoIdentity(args.newGraph);
    const previous = collectSecrets(args.previousGraph);
    const next = collectSecrets(args.newGraph);
    const addedGenerated = next.generated.filter((key) => !previous.generated.includes(key));
    const newEnv = next.env.filter((key) => !previous.env.includes(key));

    if (addedGenerated.length > 0) {
        const secrets: Record<string, string> = {};
        for (const key of addedGenerated) {
            // ensureGeneratedSecrets minted these into env before this call; a missing value is a caller bug.
            const value = args.env[key];
            if (value === undefined || value === "") {
                throw new Error(`generated secret ${key} has no value to push to Forgejo`);
            }
            secrets[key] = value;
        }
        await setRepoSecrets({ api, baseUrl: `https://${domain}`, user, password: args.password, owner: user, name: TARGET_DIR, secrets });
        args.log(
            `sync-control-plane: pushed ${addedGenerated.length} new generated secret(s) to ${user}/${TARGET_DIR}: ${addedGenerated.join(", ")}`,
        );
    }

    // Regenerates apply.yaml with the full current key set so newly-added keys get injected.
    const inputs: PipelineInputs = {
        cliVersion: args.cliVersion,
        user,
        domain,
        configFile: CONFIG_FILE,
        artifactFile: ARTIFACT_FILE,
        intentRepo: INTENT_DIR,
        desiredStateRepo: TARGET_DIR,
        applySecretKeys: [...next.generated, ...next.env].toSorted(),
        forgejoPasswordKey: adminPasswordRef.key,
    };
    await writeWorkflow(args.dir, APPLY_WORKFLOW_PATH, applyWorkflowYaml(inputs));

    if (newEnv.length > 0) {
        args.log(
            `sync-control-plane: set these user secret(s) in the app's Secrets page (or \`intentic deploy secrets push\` after setting .env), apply fails until they reach ${user}/${TARGET_DIR}: ${newEnv.join(", ")}`,
        );
    }
    return { pushed: addedGenerated, newEnv };
};
