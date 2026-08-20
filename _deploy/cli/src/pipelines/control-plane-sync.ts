import { type DesiredStateGraph, secretRef, type SecretSource } from "@intentic/graph";
import { type ForgejoApi, forgejoApi } from "@intentic/providers";
import { ARTIFACT_FILE, CONFIG_FILE, INTENT_DIR, TARGET_DIR } from "../lib/artifact.js";
import { collectSecrets } from "../secrets/secrets.js";
import { APPLY_WORKFLOW_PATH, applyWorkflowYaml, type PipelineInputs, setRepoSecrets, writeWorkflow } from "./adopt-pipelines.js";

// The control-plane host's SSH connection block as the forgejo node carries it: literal address/user, the
// key as a secret ref the caller resolves, and the optional port/via transport selectors.
export interface ForgejoSsh {
    readonly address: string;
    readonly user: string;
    readonly sshKeyRef: { readonly source: SecretSource; readonly key: string };
    readonly port?: number;
    readonly via?: "direct" | "cloudflared";
}

// The Forgejo node carries the public git domain + admin identity the control plane authenticates with, and
// the CP host's SSH block, how `adopt` reaches Forgejo (an SSH port-forward, never the public route).
// Shared by `adopt` (the one-shot push) and the post-adopt resolve sync (this file).
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
        throw new Error("no forgejo resource in the artifact — run `intentic deploy apply` first");
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

// Keep Forgejo the live secret store after `adopt`: when a resolve in the control-plane pipeline introduces a
// secret the previous artifact did not have, push the new GENERATED ones into Forgejo and regenerate apply.yaml
// so the apply pipeline injects the full current set. "New" is decided by diffing the previous artifact (the
// one already in the cloned desired-state repo) against the freshly resolved graph, never by env presence, so
// secrets that already exist in Forgejo are never re-minted or overwritten (e.g. the Forgejo admin password,
// which a stale value would rotate and lock everyone out of). New `env` (user-supplied) secrets cannot be
// valued here; they are returned for the caller to warn about, apply then fails loudly until they are set.
export const syncControlPlaneSecrets = async (args: {
    readonly previousGraph: DesiredStateGraph | undefined;
    readonly newGraph: DesiredStateGraph;
    readonly env: Readonly<Record<string, string | undefined>>;
    // The desired-state repo checkout root, apply.yaml is regenerated under <dir>/.forgejo/workflows/.
    readonly dir: string;
    // The Forgejo admin password the secret PUTs authenticate with (HTTP Basic, same as `adopt`).
    readonly password: string;
    // Pinned into the regenerated apply.yaml's `pnpm dlx @intentic/cli@<version>`.
    readonly cliVersion: string;
    readonly log: (message: string) => void;
    readonly api?: ForgejoApi;
}): Promise<{ readonly pushed: readonly string[]; readonly newEnv: readonly string[] }> => {
    // Without a previous artifact every key looks new and we would overwrite the correct Forgejo values with
    // freshly-minted ones. `adopt` always commits the artifact, so this only guards misuse, skip safely.
    if (args.previousGraph === undefined) {
        args.log("sync-control-plane: no previous artifact to diff against — skipping secret sync");
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
            // `ensureGeneratedSecrets` minted these into env before this call; a missing value is a caller bug.
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

    // Regenerate apply.yaml with the full current key set so the apply pipeline injects any newly-added keys.
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
            `sync-control-plane: set these user secret(s) in the app's Secrets page (or \`intentic deploy secrets push\` after setting .env) — apply fails until they reach ${user}/${TARGET_DIR}: ${newEnv.join(", ")}`,
        );
    }
    return { pushed: addedGenerated, newEnv };
};
