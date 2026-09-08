import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    applyMoves,
    collectOrphans,
    type ConvergeResult,
    createStore,
    type PruneOutcome,
    prune,
    pruneOrphans,
    ReadinessTimeoutError,
    reconcile,
    resolveInputs,
    rewriteGraphForMoves,
} from "@intentic/engine";
import { connectWithRetry, createProviders, createSshExecutor, createSshProbe, hostTarget, readinessDiagnostics } from "@intentic/providers";
import { buildCommand, type CommandContext, numberParser } from "@stricli/core";
import { collectSecretUsage, subgraph } from "@intentic/graph";
import { loadConfig } from "../env.config.js";
import { ACCESS_FILE, ARTIFACT_PATH, LAST_APPLIED_FILE, loadEnvFile, readArtifact, STATUS_FILE, writeStatus } from "../lib/artifact.js";
import { createKnownHostsStore } from "../lib/known-hosts.js";
import { createOutput, createRedactor, teeOutput } from "../lib/output.js";
import { withRunLog } from "../lib/run-log.js";
import { ensureGeneratedSecrets } from "../secrets/generated-secrets.js";
import { generatedSecretStore } from "../secrets/secret-store.js";
import { collectSecrets } from "../secrets/secrets.js";
import { collectAccess, formatAccessSummary, writeAccessFile } from "./access.js";
import { createEventsFileSink } from "../lib/events-file.js";
import { acquireApplyLock } from "./apply-lock.js";
import { detectHostMoves, migrateHosts } from "./migrate.js";

const DEFAULT_MAX_ITERATIONS = 5;

interface ApplyFlags {
    readonly artifact?: string;
    readonly maxIterations?: number;
    readonly previous?: string;
    readonly yes: boolean;
    readonly target?: string;
}

export const apply = buildCommand<ApplyFlags>({
    docs: { brief: "Execute the desired-state artifact until state reads true" },
    parameters: {
        flags: {
            artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` },
            maxIterations: {
                kind: "parsed",
                parse: numberParser,
                optional: true,
                brief: `Max reconcile iterations (default ${DEFAULT_MAX_ITERATIONS})`,
            },
            previous: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Path to the last successfully-applied artifact; resources absent from the new one are pruned after convergence",
            },
            yes: {
                kind: "boolean",
                brief: "Confirm deletions: without it, pending prunes are listed and left in place (converge still runs)",
            },
            target: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Comma-separated resource ids: reconcile only these and their dependencies (prune and orphan scan are skipped)",
            },
        },
    },
    async func(this: CommandContext, flags: ApplyFlags) {
        const config = loadConfig();
        const redactor = createRedactor();
        // Renders to the tmux pane and, if INTENTIC_EVENTS_FILE is set, mirrors ndjson events; both share one redactor.
        const primary = createOutput(redactor.wrap(withRunLog(this.process.stdout, "apply")), config.intenticOutput);
        const eventsSink = config.intenticEventsFile === "" ? undefined : createEventsFileSink(config.intenticEventsFile, "apply");
        const out = eventsSink === undefined ? primary : teeOutput(primary, createOutput(redactor.wrap(eventsSink), "ndjson"));
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        const dir = dirname(artifact);
        loadEnvFile(dir);
        const full = await readArtifact(artifact);
        const targetIds = flags.target
            ?.split(",")
            .map((id) => id.trim())
            .filter((id) => id !== "");
        const graph = targetIds === undefined ? full : subgraph(full, targetIds);
        const ssh = createSshExecutor(createKnownHostsStore(dir));
        // Baseline for host-migration detection and prune; a moved host's old machine gets locked too.
        const previousPath = flags.previous ?? join(dir, LAST_APPLIED_FILE);
        const previous = existsSync(previousPath) ? await readArtifact(previousPath) : undefined;
        const hostMoves = previous !== undefined ? detectHostMoves(previous, graph) : [];
        // Readiness probes host-internal urls via SSH per host node; the composite probe tries each until one succeeds.
        const targets = Object.values(graph.resources)
            .filter((node) => node.type === "host")
            .map((node) => hostTarget(resolveInputs(node.inputs, createStore(), process.env, { lenient: false })));
        const probes = targets.map((target) => createSshProbe(target, ssh));
        const probe =
            probes.length === 0
                ? undefined
                : async (url: string, status: number): Promise<boolean> => {
                      for (const p of probes) {
                          if (await p(url, status)) {
                              return true;
                          }
                      }
                      return false;
                  };
        // Waits for each host to accept SSH before locking, so a warming tunnel can't shrink the lock's run coverage.
        await Promise.all(
            targets.map(async (target) => {
                const session = await connectWithRetry(ssh, target, { log: out.log });
                await session.dispose();
            }),
        );
        // Locks every host the graph touches plus a moved host's old machine, so neither migration end is mutated.
        const oldMoveTargets = hostMoves.map((move) =>
            hostTarget(resolveInputs(move.oldNode.inputs, createStore(), process.env, { lenient: false })),
        );
        const lock = await acquireApplyLock(ssh, [...targets, ...oldMoveTargets], { log: out.log });
        const onSignal = (): void => {
            void Promise.allSettled([lock.release(), ssh.dispose?.()]).finally(() => process.exit(130));
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        // tmux kill-session (or closing a tab) sends SIGHUP; release the lock instead of orphaning it for the TTL.
        process.once("SIGHUP", onSignal);
        try {
            // Mints secrets under the lock (backfill on) so two concurrent runs never bake divergent admin passwords.
            await ensureGeneratedSecrets(generatedSecretStore(graph, dir, ssh, true, out.log), collectSecrets(graph).generated, process.env);
            // Every secret the run resolved is now in process.env; mask all of it from output.
            redactor.add(collectSecretUsage(graph).map((usage) => process.env[usage.key]));
            // Migrates a moved host's data before reconcile; needs RESTIC_PASSWORD from the secrets step above.
            if (hostMoves.length > 0) {
                await migrateHosts(hostMoves, { next: graph, ssh, env: process.env, tmpDir: tmpdir(), log: out.log });
            }
            // Applies authored renames before reconcile, so a moved resource reads as present, not orphan+recreate.
            const movedApplied = await applyMoves(graph, {
                providers: createProviders({ ssh }),
                log: out.log,
                onEvent: out.onEvent,
                env: process.env,
            });
            let result: ConvergeResult;
            try {
                result = await reconcile(
                    graph,
                    { providers: createProviders({ ssh }), log: out.log, onEvent: out.onEvent, ...(probe !== undefined ? { probe } : {}) },
                    { maxIterations: flags.maxIterations ?? DEFAULT_MAX_ITERATIONS },
                );
            } catch (error) {
                // A readiness timeout means the service is up but the gate can't see it; sweep hosts, then rethrow.
                if (error instanceof ReadinessTimeoutError && targets.length > 0) {
                    out.log(await readinessDiagnostics(targets, ssh, error));
                }
                throw error;
            }
            const access = collectAccess(graph, result.outcome.outputs, process.env);
            // status.json is committed: access entries stay value-free (refs only); the web reveals values via a gate.
            await writeStatus(join(dir, STATUS_FILE), {
                converged: result.converged,
                iterations: result.iterations,
                steps: result.outcome.steps,
                access: access.map((entry) =>
                    entry.password === undefined ? entry : { ...entry, password: { source: entry.password.source, key: entry.password.key } },
                ),
            });
            // Prunes only after convergence (a failed apply never deletes); a baseline diff and scan feed it.
            let pruned: PruneOutcome = { deleted: [], skipped: [] };
            if (targetIds !== undefined) {
                // A targeted apply reconciles only a slice; baseline diff and collection scan need the full graph.
                out.text("targeted apply: prune and orphan scan skipped");
            } else {
                const pruneConfig = { providers: createProviders({ ssh }), log: out.log, onEvent: out.onEvent, env: process.env };
                const baseline = previous !== undefined ? rewriteGraphForMoves(previous, movedApplied) : undefined;
                const removed =
                    baseline === undefined ? [] : Object.values(baseline.resources).filter((node) => graph.resources[node.id] === undefined);
                const orphans = await collectOrphans(graph, pruneConfig);
                // Protected resources are excluded from confirmation; they show up as skipped once prune actually runs.
                const pending = [
                    ...removed.filter((node) => node.inputs["protect"] !== true),
                    ...orphans.filter((orphan) => orphan.protected !== true),
                ];
                if (pending.length > 0 && !flags.yes) {
                    for (const entry of pending) {
                        out.text(`pending delete\t${entry.type}\t${entry.id}`);
                    }
                    out.text(`${pending.length} deletion(s) pending: re-run \`intentic deploy apply --yes\` to prune`);
                } else {
                    if (pending.length > 0) {
                        // Renews the lock before deleting, then verifies it's still held (aborts if taken over).
                        await lock.renew();
                        await lock.verify();
                    }
                    if (baseline !== undefined) {
                        pruned = await prune(baseline, graph, pruneConfig);
                    }
                    const orphaned = await pruneOrphans(orphans, pruneConfig);
                    pruned = { deleted: [...pruned.deleted, ...orphaned.deleted], skipped: [...pruned.skipped, ...orphaned.skipped] };
                    if (pruned.deleted.length > 0 || pruned.skipped.length > 0) {
                        out.text(
                            `pruned ${pruned.deleted.length} resource(s)${pruned.skipped.length > 0 ? `, ${pruned.skipped.length} left in place` : ""}`,
                        );
                    }
                    // Snapshots the baseline only after prune ran, so a pending removal isn't silently dropped from it.
                    await writeFile(join(dir, LAST_APPLIED_FILE), await readFile(artifact, "utf8"));
                }
            }
            out.text(`${result.converged ? "converged" : "did not converge"} in ${result.iterations} iteration(s)`);
            if (access.length > 0) {
                await writeAccessFile(join(dir, ACCESS_FILE), access);
                out.text(formatAccessSummary(access));
            }
            out.result({
                converged: result.converged,
                iterations: result.iterations,
                steps: result.outcome.steps,
                outputs: result.outcome.outputs,
                pruned,
                access,
            });
            // Posts a reconcile summary to Discord if the graph declares a discord resource.
            const reconcileWebhook = result.outcome.outputs["discord"]?.["reconcileWebhook"];
            if (typeof reconcileWebhook === "string" && reconcileWebhook !== "") {
                const creates = result.outcome.steps.filter((s) => s.action === "create").length;
                const updates = result.outcome.steps.filter((s) => s.action === "update").length;
                const noops = result.outcome.steps.filter((s) => s.action === "noop").length;
                const summary = [
                    `**intentic deploy apply**, ${result.converged ? "✅ converged" : "⚠️ did not converge"} in ${result.iterations} iteration(s)`,
                    `📊 ${result.outcome.steps.length} resources: ${creates} created, ${updates} updated, ${noops} unchanged`,
                    ...(pruned.deleted.length > 0 ? [`🗑️ ${pruned.deleted.length} resource(s) pruned`] : []),
                ].join("\n");
                try {
                    await fetch(reconcileWebhook, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ content: summary }),
                        // Non-fatal nicety: a stalled webhook must not hold the whole apply open.
                        signal: AbortSignal.timeout(15_000),
                    });
                } catch {
                    out.log("discord: failed to post reconcile summary (non-fatal)");
                }
            }
        } finally {
            process.removeListener("SIGINT", onSignal);
            process.removeListener("SIGTERM", onSignal);
            process.removeListener("SIGHUP", onSignal);
            // Flushes buffered secret-prefix bytes so the last output line isn't dropped; runs on the error path too.
            redactor.flush();
            await lock.release();
            // No-op for direct-only applies; otherwise tears down cloudflared SSH forwarders.
            await ssh.dispose?.();
        }
    },
});
