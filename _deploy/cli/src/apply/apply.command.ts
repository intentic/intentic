import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { plural } from "@intentic/base/format";
import {
    applyMoves,
    collectOrphans,
    type ConvergeResult,
    createStore,
    type EngineConfig,
    ReadinessTimeoutError,
    reconcile,
    resolveInputs,
    rewriteGraphForMoves,
} from "@intentic/engine";
import {
    connectWithRetry,
    createProviders,
    createSshExecutor,
    createSshProbe,
    hostTarget,
    readinessDiagnostics,
    type SshTarget,
} from "@intentic/providers";
import { buildCommand, type CommandContext, numberParser } from "@stricli/core";
import { collectSecretUsage, type DesiredStateGraph, subgraph } from "@intentic/graph";
import { loadConfig } from "../env.config.js";
import { ACCESS_FILE, ARTIFACT_PATH, LAST_APPLIED_FILE, loadEnvFile, readArtifact, STATUS_FILE, writeStatus } from "../lib/artifact.js";
import { createKnownHostsStore } from "../lib/known-hosts.js";
import { createOutput, createRedactor, teeOutput } from "../lib/output.js";
import { withRunLog } from "../lib/run-log.js";
import { pendingBlock, resourceTable, retiredBlock, scanGapBlock, unownedBlock } from "../lib/tables.js";
import { ensureGeneratedSecrets, loadStoredSecrets } from "../secrets/generated-secrets.js";
import { generatedSecretStore } from "../secrets/secret-store.js";
import { collectSecrets } from "../secrets/secrets.js";
import { collectAccess, formatAccessSummary, writeAccessFile } from "./access.js";
import { createEventsFileSink } from "../lib/events-file.js";
import { acquireApplyLock, startLockHeartbeat } from "./apply-lock.js";
import {
    checkFirstApply,
    loadBaseline,
    mergeRetiredHosts,
    nextBaseline,
    pruneBase,
    removedNodes,
    type RetiredHost,
    writeBaseline,
} from "./baseline.js";
import { detectHostMoves, migrateHosts } from "./migrate.js";
import { runPrunePhase } from "./prune-phase.js";
import { retiredTarget, scanRetiredHosts } from "./retired-hosts.js";

const DEFAULT_MAX_ITERATIONS = 5;

interface ApplyFlags {
    readonly artifact?: string;
    readonly maxIterations?: number;
    readonly previous?: string;
    readonly yes: boolean;
    readonly target?: string;
    readonly firstApply: boolean;
}

// Every node a pruned or retired resource still references, so its generated secrets can be loaded for the delete.
const trackedGraph = (base: DesiredStateGraph | undefined, retired: readonly RetiredHost[]): DesiredStateGraph => ({
    version: 1,
    resources: { ...base?.resources, ...Object.fromEntries(retired.map((host) => [`retired:${host.id}@${host.address}`, host.node])) },
});

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
                brief: `Path to the prune baseline (default: ${LAST_APPLIED_FILE} beside the artifact); resources it holds and the new artifact lacks are pruned after convergence`,
            },
            yes: {
                kind: "boolean",
                brief: "Confirm deletions: without it, pending prunes are listed and kept in the baseline, left in place (converge still runs)",
            },
            target: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Comma-separated resource ids: reconcile only these and their dependencies (prune and orphan scan are skipped)",
            },
            firstApply: {
                kind: "boolean",
                brief: "Start a new prune baseline when none can be read, even though resources of this intent are live (what a lost baseline tracked is then removed by hand)",
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
        // The baseline drives host-migration detection and prune; an unreadable one stops the run here, before any change.
        const baselinePath = flags.previous ?? join(dir, LAST_APPLIED_FILE);
        const lastApplied = join(dir, LAST_APPLIED_FILE);
        const previous = await loadBaseline(baselinePath, { explicit: flags.previous !== undefined, firstApply: flags.firstApply, note: out.text });
        const owner = full.owner ?? previous?.owner;
        if (full.owner !== undefined && previous?.owner !== undefined && full.owner !== previous.owner) {
            throw new Error(
                `the artifact's owner id (${full.owner}) is not the one this intent was applied with (${previous.owner}): every resource it stamped would read as another intent's. Put "owner": "${previous.owner}" back in ${artifact} (resolve keeps whatever is there).`,
            );
        }
        if (full.owner === undefined) {
            out.text(
                "This artifact carries no owner id (it was resolved before owner stamps): nothing is stamped with an owner and no orphan is pruned. Re-run `intentic deploy resolve` to mint one.",
            );
        }
        const hostMoves = previous !== undefined ? detectHostMoves({ version: 1, resources: previous.resources }, graph) : [];
        const since = new Date().toISOString().slice(0, 10);
        const retiredHosts = mergeRetiredHosts(
            previous?.retiredHosts ?? [],
            hostMoves.map((move) => ({ id: move.id, address: move.oldAddress, node: move.oldNode, since })),
            full,
        );
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
        // Locks every host the graph touches plus every machine prune may delete on: a moved host's old one, and each
        // retired host reachable with the secrets at hand.
        const oldMoveTargets = hostMoves.map((move) =>
            hostTarget(resolveInputs(move.oldNode.inputs, createStore(), process.env, { lenient: false })),
        );
        const retiredTargets = retiredHosts
            .map((host) => retiredTarget(host, process.env))
            .filter((target): target is SshTarget => typeof target !== "string");
        const lock = await acquireApplyLock(ssh, [...targets, ...oldMoveTargets, ...retiredTargets], { log: out.log });
        // A long apply keeps its lease alive; a lost lock aborts the engine before its next change.
        const stop = new AbortController();
        const heartbeat = startLockHeartbeat(lock, {
            log: out.log,
            onLost: (error) => {
                out.log(`apply-lock: ${error.message}; stopping before the next change`);
                stop.abort(error);
            },
        });
        const onSignal = (): void => {
            void Promise.allSettled([lock.release(), ssh.dispose?.()]).finally(() => process.exit(130));
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        // tmux kill-session (or closing a tab) sends SIGHUP; release the lock instead of orphaning it for the TTL.
        process.once("SIGHUP", onSignal);
        // bun's Process augmentation hides EventEmitter's own removeListener; the base view still takes a signal name.
        const signals: NodeJS.EventEmitter = process;
        try {
            const engine = (): EngineConfig => ({
                providers: createProviders({ ssh }),
                log: out.log,
                onEvent: out.onEvent,
                env: process.env,
                signal: stop.signal,
                ...(owner !== undefined ? { owner } : {}),
            });
            // Mints secrets under the lock (backfill on) so two concurrent runs never bake divergent admin passwords.
            const store = generatedSecretStore(graph, dir, ssh, true, out.log);
            await ensureGeneratedSecrets(store, collectSecrets(graph).generated, process.env);
            // A pruned node's own generated secrets are loaded too (never minted): its delete may need them.
            const tracked = trackedGraph(previous !== undefined ? pruneBase(previous) : undefined, retiredHosts);
            const current = new Set(collectSecrets(graph).generated);
            await loadStoredSecrets(
                store,
                collectSecrets(tracked).generated.filter((key) => !current.has(key)),
                process.env,
                out.log,
            );
            // Every secret the run resolved is now in process.env; mask all of it from output.
            redactor.add([...collectSecretUsage(graph), ...collectSecretUsage(tracked)].map((usage) => process.env[usage.key]));
            // No baseline file: a first apply, unless something live already carries this intent's owner stamp.
            if (previous === undefined && targetIds === undefined) {
                const line = await checkFirstApply({
                    path: baselinePath,
                    owner,
                    firstApply: flags.firstApply,
                    scan: () => collectOrphans(graph, { ...engine(), onEvent: () => {}, log: () => {} }),
                });
                out.text(line);
            }
            // Migrates a moved host's data before reconcile; needs RESTIC_PASSWORD from the secrets step above.
            if (hostMoves.length > 0) {
                stop.signal.throwIfAborted();
                await migrateHosts(hostMoves, { next: graph, ssh, env: process.env, tmpDir: tmpdir(), log: out.log });
            }
            // Applies authored renames before reconcile, so a moved resource reads as present, not orphan+recreate.
            const movedApplied = await applyMoves(graph, engine());
            const base = previous !== undefined ? rewriteGraphForMoves(pruneBase(previous), movedApplied) : undefined;
            // Before anything is created, the baseline already holds this graph and everything still to delete: a run that
            // dies halfway leaves a baseline that covers what it may have made, so nothing it created goes untracked.
            if (targetIds === undefined) {
                await writeBaseline(
                    lastApplied,
                    nextBaseline({ graph, owner, pending: base === undefined ? [] : removedNodes(base, graph), retiredHosts }),
                );
            }
            let result: ConvergeResult;
            try {
                result = await reconcile(
                    graph,
                    { ...engine(), ...(probe !== undefined ? { probe } : {}) },
                    {
                        maxIterations: flags.maxIterations ?? DEFAULT_MAX_ITERATIONS,
                    },
                );
            } catch (error) {
                // A readiness timeout means the service is up but the gate can't see it; sweep hosts, then rethrow.
                if (error instanceof ReadinessTimeoutError && targets.length > 0) {
                    out.log(await readinessDiagnostics(targets, ssh, error));
                }
                throw error;
            }
            const access = collectAccess(graph, result.outcome.outputs);
            // status.json is committed; access entries carry no value by construction (access.ts), so it is safe to
            // write whole. The web reveals values through its own gate.
            await writeStatus(join(dir, STATUS_FILE), {
                converged: result.converged,
                iterations: result.iterations,
                steps: result.outcome.steps,
                access,
            });
            // Prunes only after convergence (a failed apply never deletes); the baseline, the scan and retired hosts feed it.
            let report: Record<string, unknown> = {};
            let pruned: { readonly deleted: readonly unknown[]; readonly skipped: readonly unknown[] } = { deleted: [], skipped: [] };
            if (targetIds !== undefined) {
                // A targeted apply reconciles only a slice; baseline diff and collection scan need the full graph.
                out.text("A targeted apply reconciles only the named resources, so prune and the orphan scan were skipped.");
            } else {
                const retired = await scanRetiredHosts(retiredHosts, { ssh, env: process.env, owner, providers: createProviders({ ssh }) });
                const phase = await runPrunePhase({
                    graph,
                    base,
                    owner,
                    retired,
                    yes: flags.yes,
                    config: engine(),
                    // Renews the lock before deleting, then verifies it's still held (aborts if taken over).
                    beforeDelete: async () => {
                        await lock.renew();
                        await lock.verify();
                    },
                });
                pruned = phase.pruned;
                const retiredReports = retired.map((scan) => ({
                    id: scan.host.id,
                    address: scan.host.address,
                    leftovers: scan.leftovers.map(({ id, type }) => ({ id, type })),
                    unowned: scan.unowned,
                    ...(scan.error !== undefined ? { error: scan.error } : {}),
                }));
                for (const line of [...unownedBlock(phase.scan.unowned), ...retiredBlock(retiredReports), ...scanGapBlock(phase.scan.skipped)]) {
                    out.text(line);
                }
                if (phase.scan.foreign > 0) {
                    out.text(`${plural(phase.scan.foreign, "stamped resource")} on shared hosts or zones belong to other intents; left alone.`);
                }
                if (phase.pending.length > 0) {
                    out.text("");
                    for (const line of resourceTable("delete", phase.pending)) {
                        out.text(line);
                    }
                    out.text(
                        `${plural(phase.pending.length, "deletion")} pending, nothing was deleted; the baseline keeps them. Re-run \`intentic deploy apply --yes\` to prune.`,
                    );
                } else if (phase.pruned.deleted.length > 0 || phase.pruned.skipped.length > 0) {
                    out.text(
                        `pruned ${plural(phase.pruned.deleted.length, "resource")}${phase.pruned.skipped.length > 0 ? `, ${phase.pruned.skipped.length} left in place` : ""}`,
                    );
                }
                const stillPending = Object.values(phase.baseline.pendingDeletion ?? {});
                if (phase.pending.length === 0) {
                    for (const line of pendingBlock(stillPending)) {
                        out.text(line);
                    }
                }
                stop.signal.throwIfAborted();
                await writeBaseline(lastApplied, phase.baseline);
                report = {
                    unowned: phase.scan.unowned,
                    pendingDeletion: phase.pending.length > 0 ? phase.pending : stillPending.map(({ id, type }) => ({ id, type })),
                    retiredHosts: retiredReports,
                    scanSkipped: phase.scan.skipped,
                };
            }
            out.text(`${result.converged ? "converged" : "did not converge"} in ${plural(result.iterations, "iteration")}`);
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
                ...report,
            });
            // Posts a reconcile summary to Discord if the graph declares a discord resource.
            const reconcileWebhook = result.outcome.outputs["discord"]?.["reconcileWebhook"];
            if (typeof reconcileWebhook === "string" && reconcileWebhook !== "") {
                const creates = result.outcome.steps.filter((s) => s.action === "create").length;
                const updates = result.outcome.steps.filter((s) => s.action === "update").length;
                const noops = result.outcome.steps.filter((s) => s.action === "noop").length;
                const summary = [
                    `**intentic deploy apply**, ${result.converged ? "✅ converged" : "⚠️ did not converge"} in ${plural(result.iterations, "iteration")}`,
                    `📊 ${plural(result.outcome.steps.length, "resource")}: ${creates} created, ${updates} updated, ${noops} unchanged`,
                    ...(pruned.deleted.length > 0 ? [`🗑️ ${plural(pruned.deleted.length, "resource")} pruned`] : []),
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
            heartbeat.stop();
            signals.removeListener("SIGINT", onSignal);
            signals.removeListener("SIGTERM", onSignal);
            signals.removeListener("SIGHUP", onSignal);
            // Flushes buffered secret-prefix bytes so the last output line isn't dropped; runs on the error path too.
            redactor.flush();
            await lock.release();
            // No-op for direct-only applies; otherwise tears down cloudflared SSH forwarders.
            await ssh.dispose?.();
        }
    },
});
