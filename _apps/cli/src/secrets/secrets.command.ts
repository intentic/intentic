import { dirname } from "node:path";
import { type ForgejoApi, forgejoApi } from "@intentic/providers";
import type { SecretInventoryEntry } from "@intentic/sandbox-contract";
import { collectSecretInventory, readSyncState, secretDigest, writeSyncState } from "@intentic/scaffold";
import { buildCommand, buildRouteMap, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { ARTIFACT_FILE, ARTIFACT_PATH, CONFIG_FILE, INTENT_DIR, loadEnvFile, readArtifact, TARGET_DIR } from "../lib/artifact.js";
import { createOutput, type Output } from "../lib/output.js";
import { version } from "../lib/version.js";
import {
    APPLY_WORKFLOW_PATH,
    applyWorkflowYaml,
    collectSecretValues,
    type PipelineInputs,
    setRepoSecrets,
    writeWorkflow,
} from "../pipelines/adopt-pipelines.js";
import { forgejoIdentity } from "../pipelines/control-plane-sync.js";
import { readGeneratedSecrets } from "../secrets/generated-secrets.js";

const entryLine = (entry: SecretInventoryEntry): string => {
    const requiredBy = entry.requiredBy.length > 0 ? `  → required by ${entry.requiredBy.map((r) => r.resourceId).join(", ")}` : "";
    const ci = entry.ci === undefined ? "" : `  [CI: ${entry.ci.synced ? "synced" : "out of date"}]`;
    return `${entry.key}  ${entry.status}  (${entry.kind}, ${entry.storedAt})${requiredBy}${ci}`;
};

const list = buildCommand<{ artifact?: string }>({
    docs: { brief: "List every secret the workspace knows about — status, consumers, and CI sync state (never values)" },
    parameters: {
        flags: { artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` } },
    },
    async func(this: CommandContext, flags: { artifact?: string }) {
        const out = createOutput(this.process.stdout, loadConfig().intenticOutput);
        const entries = await collectSecretInventory(dirname(flags.artifact ?? ARTIFACT_PATH));
        for (const entry of entries) {
            out.text(entryLine(entry));
        }
        out.result({ entries });
    },
});

// Re-push changed/new secret values into the provisioned Forgejo's Actions secrets, keeping CI in lockstep with
// the local .env / .secrets.json after `adopt`. Digest-diffed against .secrets-sync.json so unchanged values are
// never re-PUT. A workspace that was never adopted (no sync record — `adopt` seeds it) is a graceful no-op: the
// sandbox daemon fires this after every secrets.set without knowing whether adopt has happened.
export const pushSecrets = async (out: Output, artifact: string, api: ForgejoApi = forgejoApi): Promise<void> => {
    const targetDir = dirname(artifact);
    const sync = await readSyncState(targetDir);
    if (Object.keys(sync).length === 0) {
        out.text("not adopted (no CI secret record) — nothing to push");
        out.result({ pushed: [], reason: "not adopted" });
        return;
    }
    loadEnvFile(targetDir);
    const graph = await readArtifact(artifact);
    const { domain, user, adminPasswordRef: ref } = forgejoIdentity(graph);
    const generatedValues = await readGeneratedSecrets(targetDir);
    const password = ref.source === "generated" ? generatedValues[ref.key] : process.env[ref.key];
    if (password === undefined || password === "") {
        throw new Error(`forgejo admin password (${ref.source} secret ${ref.key}) is not available`);
    }

    const current = collectSecretValues(graph, process.env, generatedValues);
    const changed = Object.entries(current).filter(([key, value]) => sync[key]?.digest !== secretDigest(value));
    const baseUrl = `https://${domain}`;
    if (changed.length > 0) {
        await setRepoSecrets({ api, baseUrl, user, password, owner: user, name: TARGET_DIR, secrets: Object.fromEntries(changed) });
        // The resolve pipeline reads the Cloudflare token from the intent repo — keep its copy in step too.
        const cloudflare = changed.find(([key]) => key === "CLOUDFLARE_API_TOKEN");
        if (cloudflare !== undefined) {
            await setRepoSecrets({
                api,
                baseUrl,
                user,
                password,
                owner: user,
                name: INTENT_DIR,
                secrets: { CLOUDFLARE_API_TOKEN: cloudflare[1] },
            });
        }
    }

    // A new key changes the set apply.yaml injects — regenerate it (left as a local change for the next
    // commit/push of the desired-state repo).
    const keySetChanged = Object.keys(current).some((key) => sync[key] === undefined);
    if (keySetChanged) {
        const inputs: PipelineInputs = {
            cliVersion: version,
            user,
            domain,
            configFile: CONFIG_FILE,
            artifactFile: ARTIFACT_FILE,
            intentRepo: INTENT_DIR,
            desiredStateRepo: TARGET_DIR,
            applySecretKeys: Object.keys(current).toSorted(),
            forgejoPasswordKey: ref.key,
        };
        await writeWorkflow(targetDir, APPLY_WORKFLOW_PATH, applyWorkflowYaml(inputs));
        out.text(`regenerated ${APPLY_WORKFLOW_PATH} for the new key set — commit and push desired-state to activate it`);
    }

    const pushedAt = new Date().toISOString();
    await writeSyncState(targetDir, {
        ...sync,
        ...Object.fromEntries(changed.map(([key, value]) => [key, { digest: secretDigest(value), pushedAt }])),
    });
    const pushed = changed.map(([key]) => key).toSorted();
    const skipped = Object.keys(current)
        .filter((key) => !pushed.includes(key))
        .toSorted();
    out.text(pushed.length > 0 ? `pushed ${pushed.length} secret(s) to ${user}/${TARGET_DIR}: ${pushed.join(", ")}` : "CI secrets already in sync");
    out.result({ pushed, skipped });
};

const push = buildCommand<{ artifact?: string }>({
    docs: { brief: "Push changed secret values to the provisioned Forgejo's Actions secrets (no-op before adopt)" },
    parameters: {
        flags: { artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` } },
    },
    async func(this: CommandContext, flags: { artifact?: string }) {
        await pushSecrets(createOutput(this.process.stdout, loadConfig().intenticOutput), flags.artifact ?? ARTIFACT_PATH);
    },
});

export const secretsCommand = buildRouteMap({
    routes: { list, push },
    docs: { brief: "Inspect and sync the workspace's secrets (keys and status only — values never print)" },
});
