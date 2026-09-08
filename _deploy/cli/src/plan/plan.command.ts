import { dirname } from "node:path";
import { collectOrphans, plan } from "@intentic/engine";
import { collectSecretUsage, subgraph } from "@intentic/graph";
import { createProviders, createSshExecutor } from "@intentic/providers";
import { buildCommand, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { ARTIFACT_PATH, loadEnvFile, readArtifact } from "../lib/artifact.js";
import { createEventsFileSink } from "../lib/events-file.js";
import { createKnownHostsStore } from "../lib/known-hosts.js";
import { createOutput, createRedactor, teeOutput } from "../lib/output.js";
import { withRunLog } from "../lib/run-log.js";
import { ensureGeneratedSecrets } from "../secrets/generated-secrets.js";
import { generatedSecretStore } from "../secrets/secret-store.js";
import { collectSecrets } from "../secrets/secrets.js";

interface PlanFlags {
    readonly artifact?: string;
    readonly target?: string;
}

// Whole-command backstop under the per-op deadlines; a plan that exceeds it fails naming its last activity.
const PLAN_DEADLINE_MS = 5 * 60_000;

export const planCommand = buildCommand<PlanFlags>({
    docs: { brief: "Show what applying the artifact would create/update (read-only)" },
    parameters: {
        flags: {
            artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` },
            target: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Comma-separated resource ids: plan only these and their dependencies (skips the orphan scan)",
            },
        },
    },
    async func(this: CommandContext, flags: PlanFlags) {
        const redactor = createRedactor();
        const config = loadConfig();
        // Renders to the pane and, if INTENTIC_EVENTS_FILE is set, mirrors ndjson events; both share one redactor.
        const primary = createOutput(redactor.wrap(withRunLog(this.process.stdout, "plan")), config.intenticOutput);
        const eventsSink = config.intenticEventsFile === "" ? undefined : createEventsFileSink(config.intenticEventsFile, "plan");
        const out = eventsSink === undefined ? primary : teeOutput(primary, createOutput(redactor.wrap(eventsSink), "ndjson"));
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        const dir = dirname(artifact);
        loadEnvFile(dir);
        const full = await readArtifact(artifact);
        const targets = flags.target
            ?.split(",")
            .map((id) => id.trim())
            .filter((id) => id !== "");
        const graph = targets === undefined ? full : subgraph(full, targets);
        const ssh = createSshExecutor(createKnownHostsStore(dir));
        // Tracks the stuck spot for the deadline error: node starts come from engine events, the orphan scan via log.
        let lastActivity = "loading generated secrets";
        const onEvent: typeof out.onEvent = (event) => {
            if (event.kind === "node" && event.state === "start") {
                lastActivity = `reading ${event.id}`;
            }
            out.onEvent(event);
        };
        const log = (message: string): void => {
            if (message.startsWith("orphan scan:")) {
                lastActivity = message;
            }
            out.log(message);
        };
        const work = async (): Promise<void> => {
            // Read-only: reads generated secrets from the host store (no backfill), falling back to the local cache.
            await ensureGeneratedSecrets(generatedSecretStore(graph, dir, ssh, false, log), collectSecrets(graph).generated, process.env);
            redactor.add(collectSecretUsage(graph).map((usage) => process.env[usage.key]));
            const engineConfig = { providers: createProviders({ ssh }), log, onEvent };
            const outcome = await plan(graph, engineConfig);
            for (const step of outcome.steps) {
                out.text(`${step.action}\t${step.type}\t${step.id}${step.reason !== undefined ? `\t(${step.reason})` : ""}`);
            }
            // Collection scan: strips delete-input secrets to (id, type); skipped for a subgraph (false orphans).
            let orphans: { id: string; type: string }[] = [];
            if (targets === undefined) {
                orphans = (await collectOrphans(graph, engineConfig)).map(({ id, type }) => ({ id, type }));
                for (const orphan of orphans) {
                    out.text(`orphan\t${orphan.type}\t${orphan.id}`);
                }
            } else {
                out.text("targeted plan: orphan scan skipped");
            }
            out.result({ steps: outcome.steps, orphans });
        };
        // Deadline rejects and exits non-zero; the raced work is abandoned. unref keeps a fast plan from blocking.
        let deadline: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                work(),
                new Promise<never>((_, reject) => {
                    deadline = setTimeout(
                        () => reject(new Error(`plan exceeded ${PLAN_DEADLINE_MS / 60_000}m, last activity: ${lastActivity}`)),
                        PLAN_DEADLINE_MS,
                    );
                    deadline.unref();
                }),
            ]);
        } finally {
            clearTimeout(deadline);
            // Flushes buffered secret-prefix bytes so the last line isn't dropped; runs on the error path too.
            redactor.flush();
            // Tears down cloudflared forwarders; otherwise the event loop never exits and previews stall after.
            await ssh.dispose?.();
        }
    },
});
