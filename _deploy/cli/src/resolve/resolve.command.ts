import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveState } from "@intentic/state-resolver";
import { buildCommand, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { ARTIFACT_PATH, CONFIG_PATH, ENV_FILE, readArtifact, writeArtifact } from "../lib/artifact.js";
import { createEventsFileSink } from "../lib/events-file.js";
import { createOutput, teeOutput } from "../lib/output.js";
import { withRunLog } from "../lib/run-log.js";
import { version } from "../lib/version.js";
import { GIT_TOKEN_ENV } from "../pipelines/adopt-pipelines.js";
import { syncControlPlaneSecrets } from "../pipelines/control-plane-sync.js";
import { ensureGeneratedSecrets } from "../secrets/generated-secrets.js";
import { createLocalSecretStore } from "../secrets/secret-store.js";
import { collectSecrets, writeEnvExample } from "../secrets/secrets.js";
import { discoverZone, loadIntent } from "./resolve.js";

interface ResolveFlags {
    readonly config?: string;
    readonly out?: string;
    readonly syncControlPlane: boolean;
}

export const resolveCommand = buildCommand<ResolveFlags>({
    docs: { brief: "Resolve a deploy.config.ts into the desired-state artifact" },
    parameters: {
        flags: {
            config: { kind: "parsed", parse: String, optional: true, brief: `Path to the intent config (default: ${CONFIG_PATH})` },
            out: { kind: "parsed", parse: String, optional: true, brief: `Path to write the artifact (default: ${ARTIFACT_PATH})` },
            syncControlPlane: {
                kind: "boolean",
                brief: "Push newly-required generated secrets into Forgejo and regenerate apply.yaml (run by the resolve pipeline post-adopt; needs GIT_TOKEN)",
            },
        },
    },
    async func(this: CommandContext, flags: ResolveFlags) {
        const config = loadConfig();
        // Renders to the pane (human text) AND, when the daemon points INTENTIC_EVENTS_FILE at a per-run file,
        // mirrors the events as ndjson so the web tails structured progress (the check flow's resolve step).
        // No redactor: resolve prints secret key NAMES, never values.
        const primary = createOutput(withRunLog(this.process.stdout, "resolve"), config.intenticOutput);
        const eventsSink = config.intenticEventsFile === "" ? undefined : createEventsFileSink(config.intenticEventsFile, "resolve");
        const out = eventsSink === undefined ? primary : teeOutput(primary, createOutput(eventsSink, "ndjson"));
        const intent = await loadIntent(flags.config ?? CONFIG_PATH);
        const artifactOut = flags.out ?? ARTIFACT_PATH;
        const dir = dirname(artifactOut);
        // Capture the artifact being replaced BEFORE overwriting it, the control-plane sync diffs against it.
        const previousGraph = flags.syncControlPlane && existsSync(artifactOut) ? await readArtifact(artifactOut) : undefined;
        const zone = await discoverZone(intent, dir);
        const graph = resolveState(intent, zone);
        await writeArtifact(artifactOut, graph);
        const count = Object.keys(graph.resources).length;
        out.text(`resolved desired state (${count} resources) → ${artifactOut}`);
        if (zone !== undefined) {
            out.text(
                intent.cloudflare?.input.zone !== undefined
                    ? `using Cloudflare zone "${zone}" from the intent`
                    : `discovered Cloudflare zone "${zone}" from the API token`,
            );
        }
        // The resolver classifies each secret: `env` ones the user must supply (only knowable from the graph,
        // since the resolver injects platform secrets the authored config never names) → .env.example; the
        // `generated` ones (Forgejo/Komodo admin) intentic creates and owns itself → .secrets.json, written
        // here so it exists right after resolve (apply/plan reuse it).
        const { env: envKeys, generated } = collectSecrets(graph);
        if (envKeys.length > 0) {
            await writeEnvExample(join(dir, `${ENV_FILE}.example`), envKeys);
            out.text(`set these in ${ENV_FILE} before apply (see ${ENV_FILE}.example): ${envKeys.join(", ")}`);
        }
        if (generated.length > 0) {
            await ensureGeneratedSecrets(createLocalSecretStore(dir), generated, process.env);
            out.text(`generated these (stored in .secrets.json): ${generated.join(", ")}`);
        }
        let synced: { readonly pushed: readonly string[]; readonly newEnv: readonly string[] } | undefined;
        if (flags.syncControlPlane) {
            const password = process.env[GIT_TOKEN_ENV];
            if (password === undefined || password === "") {
                throw new Error(`set ${GIT_TOKEN_ENV} (the Forgejo admin password) to use --sync-control-plane`);
            }
            synced = await syncControlPlaneSecrets({
                previousGraph,
                newGraph: graph,
                env: process.env,
                dir,
                password,
                cliVersion: version,
                log: out.log,
            });
        }
        out.result({
            resources: count,
            ...(zone !== undefined ? { zone } : {}),
            envSecrets: envKeys,
            generatedSecrets: generated,
            ...(synced !== undefined ? { synced } : {}),
        });
    },
});
