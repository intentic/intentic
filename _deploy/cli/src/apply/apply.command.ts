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
        // Apply renders to the human tmux pane (text) AND, when the daemon points INTENTIC_EVENTS_FILE at a
        // per-run file, mirrors the same lifecycle events as ndjson so the web can tail structured progress.
        // Both sinks share the one redactor, so a value registered by redactor.add below is masked in both.
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
        // The last successfully-applied artifact: the shared baseline for host-migration detection (a host
        // whose address changed moved machines) and for prune below. A moved host is migrated before reconcile
        // so its data lands on the new machine; its old machine is also locked so no concurrent run mutates it.
        const previousPath = flags.previous ?? join(dir, LAST_APPLIED_FILE);
        const previous = existsSync(previousPath) ? await readArtifact(previousPath) : undefined;
        const hostMoves = previous !== undefined ? detectHostMoves(previous, graph) : [];
        // Readiness gates target host-internal urls (http://<internalIp>:<port>) reachable only from the host
        // itself, never from this CLI process. Build SSH probes from every host node in the graph so apply
        // gates on each host's own view; resolveInputs substitutes SSH_KEY secrets from the env loaded above.
        // The composite probe tries each host until one can reach the URL (the wrong host simply fails wget).
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
        // Deploy targets brought up as part of this flow may still be booting when apply runs — a freshly-minted
        // ssh-<id>.<zone> tunnel needs its DNS to propagate and its connector to join the edge, during which the
        // dial fails transiently (NXDOMAIN → ECONNRESET). Wait for each host to accept SSH before locking, so the
        // lock (and the prune it guards) is held for the whole run instead of skipped, and the cloudflared
        // forwarder is warm when reconcile reuses it. A host that never comes up fails here after the deadline
        // with the same actionable error. Only current-graph hosts are gated — a migrated-away old machine may
        // legitimately be gone.
        // Warm every host concurrently — the worst case is one slow host's tunnel warm-up, not the sum of all.
        await Promise.all(
            targets.map(async (target) => {
                const session = await connectWithRetry(ssh, target, { log: out.log });
                await session.dispose();
            }),
        );
        // Serialize this apply (and the prune that follows) against every host the graph touches, so a
        // concurrent run cannot interleave mutations. Released in `finally`; a hard crash leaves the lock to
        // free via its TTL. A SIGINT/SIGTERM handler releases on Ctrl-C before exiting.
        // Lock every host the graph touches PLUS the old machine of any moved host, so neither end of a
        // migration can be mutated by a concurrent run.
        const oldMoveTargets = hostMoves.map((move) =>
            hostTarget(resolveInputs(move.oldNode.inputs, createStore(), process.env, { lenient: false })),
        );
        const lock = await acquireApplyLock(ssh, [...targets, ...oldMoveTargets], { log: out.log });
        const onSignal = (): void => {
            // Release the lock and tear down any cloudflared SSH forwarders before exiting on Ctrl-C.
            void Promise.allSettled([lock.release(), ssh.dispose?.()]).finally(() => process.exit(130));
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        // tmux kill-session delivers SIGHUP — a killed pane (the terminal tab's ×, a stale-session sweep) must
        // release the host lock too, not orphan it for the 30-minute TTL.
        process.once("SIGHUP", onSignal);
        try {
            // Mint/read generated secrets UNDER the lock, against the host-authoritative store (backfill on, so a
            // value minted locally before the host existed is promoted to it). Under the lock this is the only
            // run minting, so two operators can never bake divergent admin passwords into Forgejo/Komodo.
            await ensureGeneratedSecrets(generatedSecretStore(graph, dir, ssh, true, out.log), collectSecrets(graph).generated, process.env);
            // Every secret value the run can resolve is now in process.env — mask them out of all output.
            redactor.add(collectSecretUsage(graph).map((usage) => process.env[usage.key]));
            // A host whose address changed moved machines: snapshot the old host and stream its data to the new
            // one BEFORE reconcile, so its services come up on the new machine atop migrated data, not an empty
            // disk. RESTIC_PASSWORD is in env now (ensureGeneratedSecrets above), so restore decrypts the repo.
            if (hostMoves.length > 0) {
                await migrateHosts(hostMoves, { next: graph, ssh, env: process.env, tmpDir: tmpdir(), log: out.log });
            }
            // Consume any authored renames BEFORE reconcile: re-stamp each moved resource in place so reconcile
            // sees it as already-present (a noop) instead of orphaning the old id and recreating the new one.
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
                // A readiness timeout means "the service came up but the gate can't see it" — sweep every
                // host over SSH (docker state, the node's logs, listeners, addresses, one verbose probe) so
                // the failure self-explains, then rethrow the same error.
                if (error instanceof ReadinessTimeoutError && targets.length > 0) {
                    out.log(await readinessDiagnostics(targets, ssh, error));
                }
                throw error;
            }
            const access = collectAccess(graph, result.outcome.outputs, process.env);
            // status.json is committed, so its access entries are VALUE-FREE ({source, key} refs only) — the
            // web renders them and reveals generated values through the daemon's owner-gated reveal route.
            await writeStatus(join(dir, STATUS_FILE), {
                converged: result.converged,
                iterations: result.iterations,
                steps: result.outcome.steps,
                access: access.map((entry) =>
                    entry.password === undefined ? entry : { ...entry, password: { source: entry.password.source, key: entry.password.key } },
                ),
            });
            // Prune AFTER convergence (reconcile throws if it never converges, so a failed apply never
            // deletes). Two sources feed it: the baseline diff (resources in the last-applied artifact the
            // new one no longer declares — covers types without `list`) and the collection scan (live
            // stamped resources absent from the graph — drift the baseline cannot see: a lost
            // .last-applied.json, a crashed apply). Rewrite the baseline for in-place renames so prune
            // treats a moved id as "became", not "removed".
            let pruned: PruneOutcome = { deleted: [], skipped: [] };
            if (targetIds !== undefined) {
                // A targeted apply reconciles a slice; the baseline diff and the collection scan are only
                // meaningful against the full graph (untargeted declared resources would read as removed).
                out.text("targeted apply — prune and orphan scan skipped");
            } else {
                const pruneConfig = { providers: createProviders({ ssh }), log: out.log, onEvent: out.onEvent, env: process.env };
                const baseline = previous !== undefined ? rewriteGraphForMoves(previous, movedApplied) : undefined;
                const removed =
                    baseline === undefined ? [] : Object.values(baseline.resources).filter((node) => graph.resources[node.id] === undefined);
                const orphans = await collectOrphans(graph, pruneConfig);
                // Deletions actually on the table: protected resources are never deleted, so they don't demand
                // confirmation — they surface as skipped when the prune runs.
                const pending = [
                    ...removed.filter((node) => node.inputs["protect"] !== true),
                    ...orphans.filter((orphan) => orphan.protected !== true),
                ];
                if (pending.length > 0 && !flags.yes) {
                    for (const entry of pending) {
                        out.text(`pending delete\t${entry.type}\t${entry.id}`);
                    }
                    out.text(`${pending.length} deletion(s) pending — re-run \`intentic deploy apply --yes\` to prune`);
                } else {
                    if (pending.length > 0) {
                        // The destructive phase: push the takeover deadline out for a long apply, then confirm we
                        // still hold every lock before deleting anything (abort if another run took over).
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
                    // Snapshot the current artifact so the next apply can prune against it — only after the prune
                    // actually ran, so an unconfirmed removal is not silently dropped from the baseline.
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
            // Post a reconcile summary to the Discord #reconcile channel if the graph has a discord resource.
            const reconcileWebhook = result.outcome.outputs["discord"]?.["reconcileWebhook"];
            if (typeof reconcileWebhook === "string" && reconcileWebhook !== "") {
                const creates = result.outcome.steps.filter((s) => s.action === "create").length;
                const updates = result.outcome.steps.filter((s) => s.action === "update").length;
                const noops = result.outcome.steps.filter((s) => s.action === "noop").length;
                const summary = [
                    `**intentic deploy apply** — ${result.converged ? "✅ converged" : "⚠️ did not converge"} in ${result.iterations} iteration(s)`,
                    `📊 ${result.outcome.steps.length} resources: ${creates} created, ${updates} updated, ${noops} unchanged`,
                    ...(pruned.deleted.length > 0 ? [`🗑️ ${pruned.deleted.length} resource(s) pruned`] : []),
                ].join("\n");
                try {
                    await fetch(reconcileWebhook, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ content: summary }),
                        // Non-fatal nicety — a stalled webhook must not hold the whole apply open.
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
            // Write back whatever the redactor is still holding as a possible secret prefix, or the
            // command's last line goes missing. Runs on the error path too — a throw must not eat output.
            redactor.flush();
            await lock.release();
            // Tear down any cloudflared SSH forwarders this run started (no-op for direct-only applies).
            await ssh.dispose?.();
        }
    },
});
