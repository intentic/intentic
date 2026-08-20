import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createStore, prune, resolveInputs } from "@intentic/engine";
import type { DesiredStateGraph, ResourceNode } from "@intentic/graph";
import { collectSecretUsage, linearize } from "@intentic/graph";
import { createProviders, createSshExecutor, hostTarget } from "@intentic/providers";
import { buildCommand, type CommandContext } from "@stricli/core";
import { acquireApplyLock } from "../apply/apply-lock.js";
import { loadConfig } from "../env.config.js";
import { ARTIFACT_PATH, LAST_APPLIED_FILE, loadEnvFile, readArtifact } from "../lib/artifact.js";
import { createKnownHostsStore } from "../lib/known-hosts.js";
import { createOutput, createRedactor } from "../lib/output.js";
import { withRunLog } from "../lib/run-log.js";
import { ensureGeneratedSecrets } from "../secrets/generated-secrets.js";
import { generatedSecretStore } from "../secrets/secret-store.js";
import { collectSecrets } from "../secrets/secrets.js";

const EMPTY: DesiredStateGraph = { version: 1, resources: {} };

interface DestroyFlags {
    readonly artifact?: string;
    readonly yes: boolean;
}

// Teardown = prune against the empty graph: every resource the artifact declares is deleted in reverse
// dependency order using its own inputs (the store is seeded by reading the still-live graph, so an
// API-backed delete reaches its platform's creds before that platform is torn down). Owned inventory
// (host, cloudflare zone) is never touched, their deletes are logged no-ops.
export const destroy = buildCommand<DestroyFlags>({
    docs: { brief: "Tear down every resource the artifact declares (requires --yes)" },
    parameters: {
        flags: {
            artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` },
            yes: { kind: "boolean", brief: "Actually delete; without it the teardown plan is printed and nothing runs" },
        },
    },
    async func(this: CommandContext, flags: DestroyFlags) {
        const redactor = createRedactor();
        const out = createOutput(redactor.wrap(withRunLog(this.process.stdout, "destroy")), loadConfig().intenticOutput);
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        const dir = dirname(artifact);
        loadEnvFile(dir);
        const graph = await readArtifact(artifact);
        const order = [...linearize(graph)]
            .toReversed()
            .map((id) => graph.resources[id])
            .filter((node): node is ResourceNode => node !== undefined);
        if (!flags.yes) {
            for (const node of order) {
                out.text(node.inputs["protect"] === true ? `keep\t${node.type}\t${node.id}\t(protected)` : `delete\t${node.type}\t${node.id}`);
            }
            out.text(
                `destroy is destructive — re-run with --yes to tear down these ${order.filter((node) => node.inputs["protect"] !== true).length} resource(s)`,
            );
            out.result({
                steps: order.map((node) => ({ id: node.id, type: node.type, protected: node.inputs["protect"] === true })),
                executed: false,
            });
            return;
        }
        const ssh = createSshExecutor(createKnownHostsStore(dir));
        // Lock every host the artifact touches, exactly like apply: destroy is the destructive phase.
        const targets = Object.values(graph.resources)
            .filter((node) => node.type === "host")
            .map((node) => hostTarget(resolveInputs(node.inputs, createStore(), process.env, { lenient: false })));
        const lock = await acquireApplyLock(ssh, targets, { log: out.log });
        const onSignal = (): void => {
            void Promise.allSettled([lock.release(), ssh.dispose?.()]).finally(() => process.exit(130));
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        try {
            // Read-only secret load (no backfill): API-backed deletes resolve generated admin passwords from env.
            await ensureGeneratedSecrets(generatedSecretStore(graph, dir, ssh, false, out.log), collectSecrets(graph).generated, process.env);
            redactor.add(collectSecretUsage(graph).map((usage) => process.env[usage.key]));
            const pruned = await prune(graph, EMPTY, { providers: createProviders({ ssh }), log: out.log, onEvent: out.onEvent, env: process.env });
            // Nothing is applied anymore, a later apply must not prune against this stale baseline.
            await rm(join(dir, LAST_APPLIED_FILE), { force: true });
            out.text(`destroyed ${pruned.deleted.length} resource(s)${pruned.skipped.length > 0 ? `, ${pruned.skipped.length} left in place` : ""}`);
            out.result({ ...pruned, executed: true });
        } finally {
            process.removeListener("SIGINT", onSignal);
            process.removeListener("SIGTERM", onSignal);
            // Write back whatever the redactor is still holding as a possible secret prefix, or the
            // command's last line goes missing. Runs on the error path too, a throw must not eat output.
            redactor.flush();
            await lock.release();
            await ssh.dispose?.();
        }
    },
});
