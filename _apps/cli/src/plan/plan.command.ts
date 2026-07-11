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

// Whole-command backstop under the per-operation deadlines (ssh readyTimeout/keepalive, fetch timeouts): a
// plan that somehow still exceeds this fails naming its last activity instead of wedging the caller forever.
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
        // Renders to the pane (human text) AND, when the daemon points INTENTIC_EVENTS_FILE at a per-run file,
        // mirrors the events as ndjson so the web tails structured progress (the check flow's plan step). Both
        // sinks share the one redactor, so a value registered by redactor.add below is masked in both.
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
        // Track what the plan is doing so the deadline error below can NAME the stuck spot; node starts come
        // from the engine's events, the orphan scan narrates through log.
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
            // Read-only command: read generated secrets from the host-authoritative store (no backfill — plan never
            // mutates a store), falling back to the local cache when the host is unreachable.
            await ensureGeneratedSecrets(generatedSecretStore(graph, dir, ssh, false, log), collectSecrets(graph).generated, process.env);
            redactor.add(collectSecretUsage(graph).map((usage) => process.env[usage.key]));
            const engineConfig = { providers: createProviders({ ssh }), log, onEvent };
            const outcome = await plan(graph, engineConfig);
            for (const step of outcome.steps) {
                out.text(`${step.action}\t${step.type}\t${step.id}${step.reason !== undefined ? `\t(${step.reason})` : ""}`);
            }
            // The collection scan: live stamped resources absent from the graph. Entries carry delete inputs
            // (connection secrets) — strip to (id, type) before they reach any output. Against a targeted
            // subgraph every untargeted declared resource would read as an orphan, so the scan is skipped.
            let orphans: { id: string; type: string }[] = [];
            if (targets === undefined) {
                orphans = (await collectOrphans(graph, engineConfig)).map(({ id, type }) => ({ id, type }));
                for (const orphan of orphans) {
                    out.text(`orphan\t${orphan.type}\t${orphan.id}`);
                }
            } else {
                out.text("targeted plan — orphan scan skipped");
            }
            out.result({ steps: outcome.steps, orphans });
        };
        // The deadline rejects and the command exits non-zero (stricli renders the error); the raced work is
        // abandoned — its transports die with the process. unref keeps a fast plan from being held open.
        let deadline: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                work(),
                new Promise<never>((_, reject) => {
                    deadline = setTimeout(
                        () => reject(new Error(`plan exceeded ${PLAN_DEADLINE_MS / 60_000}m — last activity: ${lastActivity}`)),
                        PLAN_DEADLINE_MS,
                    );
                    deadline.unref();
                }),
            ]);
        } finally {
            clearTimeout(deadline);
            // Tear down the executor's cloudflared forwarders. Without this the forwarder child keeps the
            // event loop alive FOREVER after out.result() — the CLI never exits (cli.ts has no process.exit),
            // the daemon's SSE never closes, and every preview "stalls" 120s after its last frame.
            await ssh.dispose?.();
        }
    },
});
