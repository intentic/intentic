import { dirname, join } from "node:path";
import { forgejoApi } from "@intentic/providers";
import { secretDigest, writeSyncState } from "@intentic/scaffold";
import { buildCommand, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { ARTIFACT_FILE, ARTIFACT_PATH, CONFIG_FILE, INTENT_DIR, loadEnvFile, readArtifact, TARGET_DIR } from "../lib/artifact.js";
import { createOutput, teeOutput } from "../lib/output.js";
import { withRunLog } from "../lib/run-log.js";
import { version } from "../lib/version.js";
import {
    collectSecretValues,
    GIT_TOKEN_SECRET,
    GIT_USER_SECRET,
    type PipelineInputs,
    setRepoSecrets,
    writeControlPlaneWorkflows,
} from "../pipelines/adopt-pipelines.js";
import { forgejoIdentity } from "../pipelines/control-plane-sync.js";
import { createEventsFileSink } from "../lib/events-file.js";
import { readGeneratedSecrets } from "../secrets/generated-secrets.js";
import { adoptRepos } from "./adopt.js";

export const adopt = buildCommand<{ artifact?: string; baseUrl?: string }>({
    docs: { brief: "Push the local intent and desired-state repos to the provisioned Forgejo" },
    parameters: {
        flags: {
            artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` },
            baseUrl: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Override the Forgejo base URL (default https://<git-domain>) — adopt before public DNS is live, or over an internal/mapped address",
            },
        },
    },
    async func(this: CommandContext, flags: { artifact?: string; baseUrl?: string }) {
        const config = loadConfig();
        // As the second half of the daemon's `apply && adopt` job, adopt appends its events (and terminal
        // {kind:"exit",command:"adopt"}) to the same durable file apply wrote — the web's whole-job completion
        // signal. The sink appends and never truncates, so apply's record is preserved.
        const primary = createOutput(withRunLog(this.process.stdout, "adopt"), config.intenticOutput);
        const out =
            config.intenticEventsFile === ""
                ? primary
                : teeOutput(primary, createOutput(createEventsFileSink(config.intenticEventsFile, "adopt"), "ndjson"));
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        const targetDir = dirname(artifact);
        // The scaffold layout: the intent repo is a sibling of the desired-state repo (`init` makes both).
        const intentDir = join(dirname(targetDir), INTENT_DIR);
        loadEnvFile(targetDir);
        const graph = await readArtifact(artifact);
        // Services-only (and github/gitlab-backed) intents provision no Forgejo control plane — nothing to adopt.
        if (!Object.values(graph.resources).some((node) => node.type === "forgejo")) {
            out.text("no forgejo in the artifact (no control plane) — nothing to adopt");
            out.result({ repos: [], reason: "no control plane" });
            return;
        }
        // Forgejo is what hosts the repos; its node carries the public domain + admin identity we push with.
        const { domain, user, adminPasswordRef: ref } = forgejoIdentity(graph);
        const generatedValues = await readGeneratedSecrets(targetDir);
        const password = ref.source === "generated" ? generatedValues[ref.key] : process.env[ref.key];
        if (password === undefined || password === "") {
            throw new Error(`forgejo admin password (${ref.source} secret ${ref.key}) is not available`);
        }

        // Resolve the graph's secret values (env from the loaded process.env, generated from .secrets.json).
        // These move into Forgejo Actions secrets so the pipelines authenticate without the files (which never
        // leave the operator's machine).
        const desiredStateSecrets = collectSecretValues(graph, process.env, generatedValues);

        const inputs: PipelineInputs = {
            cliVersion: version,
            user,
            domain,
            configFile: CONFIG_FILE,
            artifactFile: ARTIFACT_FILE,
            intentRepo: INTENT_DIR,
            desiredStateRepo: TARGET_DIR,
            applySecretKeys: Object.keys(desiredStateSecrets).toSorted(),
            forgejoPasswordKey: ref.key,
        };
        // Seed the pipelines into the repo dirs BEFORE the push, so adopt's normal commit/push carries them.
        await writeControlPlaneWorkflows(intentDir, targetDir, inputs);

        const baseUrl = flags.baseUrl ?? `https://${domain}`;
        const repos = await adoptRepos({
            baseUrl,
            user,
            password,
            repos: [
                { dir: intentDir, name: INTENT_DIR },
                { dir: targetDir, name: TARGET_DIR },
            ],
            log: out.log,
        });

        // The apply pipeline needs every secret; the resolve pipeline needs the Cloudflare token (for zone
        // discovery) plus the git-push credential it pushes the artifact to the desired-state repo with.
        const intentSecrets: Record<string, string> = { [GIT_USER_SECRET]: user, [GIT_TOKEN_SECRET]: password };
        if (desiredStateSecrets["CLOUDFLARE_API_TOKEN"] !== undefined) {
            intentSecrets["CLOUDFLARE_API_TOKEN"] = desiredStateSecrets["CLOUDFLARE_API_TOKEN"];
        }
        await setRepoSecrets({ api: forgejoApi, baseUrl, user, password, owner: user, name: INTENT_DIR, secrets: intentSecrets });
        await setRepoSecrets({ api: forgejoApi, baseUrl, user, password, owner: user, name: TARGET_DIR, secrets: desiredStateSecrets });
        // Record what was pushed so `secrets list` can report CI staleness and `secrets push` only re-pushes
        // values that actually changed.
        const pushedAt = new Date().toISOString();
        await writeSyncState(
            targetDir,
            Object.fromEntries(Object.entries(desiredStateSecrets).map(([key, value]) => [key, { digest: secretDigest(value), pushedAt }])),
        );
        out.text(
            `set ${Object.keys(intentSecrets).length} secret(s) on ${user}/${INTENT_DIR}, ${Object.keys(desiredStateSecrets).length} on ${user}/${TARGET_DIR}`,
        );
        out.result({
            repos,
            intentSecrets: Object.keys(intentSecrets).toSorted(),
            desiredStateSecrets: Object.keys(desiredStateSecrets).toSorted(),
        });
    },
});
