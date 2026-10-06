import { dirname, join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import { collectOrphans, type EngineConfig, plan, rewriteGraphForMoves } from "@intentic/engine";
import { collectSecretUsage, subgraph } from "@intentic/graph";
import { createProviders } from "@intentic/providers";
import { buildCommand, type CommandContext } from "@stricli/core";
import { type Baseline, pruneBase, readBaseline, removedNodes } from "../apply/baseline.js";
import { scanRetiredHosts } from "../apply/retired-hosts.js";
import { loadConfig } from "../env.config.js";
import { ARTIFACT_PATH, LAST_APPLIED_FILE, loadEnvFile, readArtifact } from "../lib/artifact.js";
import { createEventsFileSink } from "../lib/events-file.js";
import { pinnedSshExecutor } from "../lib/known-hosts.js";
import { createOutput, createRedactor, teeOutput } from "../lib/output.js";
import { withRunLog } from "../lib/run-log.js";
import { type Named, pendingBlock, planSummary, planTable, type RetiredReport, retiredBlock, scanGapBlock, unownedBlock } from "../lib/tables.js";
import { ensureGeneratedSecrets } from "../secrets/generated-secrets.js";
import { generatedSecretStore } from "../secrets/secret-store.js";
import { collectSecrets } from "../secrets/secrets.js";

interface PlanFlags {
    readonly artifact?: string;
    readonly target?: string;
    readonly previous?: string;
    readonly check: boolean;
}

// Whole-command backstop under the per-op deadlines; a plan that exceeds it fails naming its last activity.
const PLAN_DEADLINE_MS = 5 * 60_000;

// What a drift check fails on, one phrase each: anything an apply would change or delete, and anything a person must
// settle (an unowned resource, an old host that cannot be scanned, a baseline that cannot be read, a scan gap).
export interface DriftFindings {
    readonly steps: readonly { readonly action: string }[];
    readonly orphans: readonly Named[];
    readonly unowned: readonly Named[];
    readonly pending: readonly Named[];
    readonly retired: readonly RetiredReport[];
    readonly scanSkipped: readonly unknown[];
    readonly baselineError?: string;
}

export const driftReasons = (findings: DriftFindings): string[] => {
    const changes = findings.steps.filter((step) => step.action !== "noop").length;
    const leftovers = findings.retired.reduce((sum, host) => sum + host.leftovers.length + host.unowned.length, 0);
    const unscanned = findings.retired.filter((host) => host.error !== undefined).length;
    return [
        ...(changes > 0 ? [`${plural(changes, "resource")} to create or update`] : []),
        ...(findings.orphans.length > 0 ? [plural(findings.orphans.length, "orphan")] : []),
        ...(findings.unowned.length > 0 ? [`${plural(findings.unowned.length, "unowned resource")}`] : []),
        ...(findings.pending.length > 0 ? [`${plural(findings.pending.length, "pending deletion")}`] : []),
        ...(leftovers > 0 ? [`${plural(leftovers, "leftover")} on retired hosts`] : []),
        ...(unscanned > 0 ? [`${plural(unscanned, "retired host")} not scanned`] : []),
        ...(findings.scanSkipped.length > 0 ? [`the orphan scan missed ${plural(findings.scanSkipped.length, "source")}`] : []),
        ...(findings.baselineError !== undefined ? ["the prune baseline cannot be read"] : []),
    ];
};

export const planCommand = buildCommand<PlanFlags>({
    docs: { brief: "Show what applying the artifact would create/update/delete (read-only)" },
    parameters: {
        flags: {
            artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` },
            target: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Comma-separated resource ids: plan only these and their dependencies (skips the orphan scan)",
            },
            previous: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: `Path to the prune baseline (default: ${LAST_APPLIED_FILE} beside the artifact), for the deletions it holds`,
            },
            check: {
                kind: "boolean",
                brief: "Drift check: exit non-zero when anything would change or be deleted, or needs a person (the scheduled CI job)",
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
        const ssh = pinnedSshExecutor(dir);
        // A plan never stops on its baseline: it reports one it cannot read, and a drift check fails on it.
        const baselinePath = flags.previous ?? join(dir, LAST_APPLIED_FILE);
        let previous: Baseline | undefined;
        let baselineError: string | undefined;
        try {
            previous = await readBaseline(baselinePath);
            if (previous === undefined && flags.previous !== undefined) {
                baselineError = `no prune baseline at ${baselinePath}`;
            }
        } catch (error) {
            baselineError = errorMessage(error);
        }
        const owner = full.owner ?? previous?.owner;
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
            const engineConfig: EngineConfig = { providers: createProviders({ ssh }), log, onEvent, ...(owner !== undefined ? { owner } : {}) };
            const outcome = await plan(graph, engineConfig);
            for (const line of planTable(outcome.steps)) {
                out.text(line);
            }
            // Collection scan: strips delete-input secrets to (id, type); skipped for a subgraph (false orphans).
            let orphans: Named[] = [];
            let unowned: Named[] = [];
            let pending: Named[] = [];
            let retired: RetiredReport[] = [];
            let scanSkipped: { readonly source: string; readonly reason: string }[] = [];
            if (targets === undefined) {
                const scan = await collectOrphans(graph, engineConfig);
                orphans = scan.orphans.map(({ id, type }) => ({ id, type }));
                unowned = [...scan.unowned];
                scanSkipped = [...scan.skipped];
                // What apply would prune from its baseline, renames taken as applied.
                pending =
                    previous === undefined
                        ? []
                        : removedNodes(rewriteGraphForMoves(pruneBase(previous), graph.moved ?? []), graph).map(({ id, type }) => ({ id, type }));
                lastActivity = "scanning retired hosts";
                retired = (
                    await scanRetiredHosts(previous?.retiredHosts ?? [], { ssh, env: process.env, owner, providers: engineConfig.providers })
                ).map((scan) => ({
                    id: scan.host.id,
                    address: scan.host.address,
                    leftovers: scan.leftovers.map(({ id, type }) => ({ id, type })),
                    unowned: scan.unowned,
                    ...(scan.error !== undefined ? { error: scan.error } : {}),
                }));
            } else {
                out.text("");
                out.text("A targeted plan reads only the named resources, so the orphan scan was skipped.");
            }
            for (const line of [
                ...planSummary(outcome.steps, orphans),
                ...unownedBlock(unowned),
                ...pendingBlock(pending),
                ...retiredBlock(retired),
                ...scanGapBlock(scanSkipped),
                ...(baselineError !== undefined ? ["", `The prune baseline cannot be read: ${baselineError}`] : []),
            ]) {
                out.text(line);
            }
            const reasons =
                targets === undefined
                    ? driftReasons({
                          steps: outcome.steps,
                          orphans,
                          unowned,
                          pending,
                          retired,
                          scanSkipped,
                          ...(baselineError !== undefined ? { baselineError } : {}),
                      })
                    : [];
            out.result({ steps: outcome.steps, orphans, unowned, pendingDeletion: pending, retiredHosts: retired, scanSkipped, drift: reasons });
            if (flags.check && reasons.length > 0) {
                throw new Error(
                    `drift check: ${reasons.join(", ")}. Run \`intentic deploy plan\` to see them, \`intentic deploy apply --yes\` to converge.`,
                );
            }
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
