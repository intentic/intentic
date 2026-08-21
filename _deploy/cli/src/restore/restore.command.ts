import { dirname } from "node:path";
import { createStore, resolveInputs } from "@intentic/engine";
import { createSshExecutor, hostTarget, type RestoreScope, restoreBackup } from "@intentic/providers";
import { buildCommand, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { ARTIFACT_PATH, loadEnvFile, readArtifact } from "../lib/artifact.js";
import { createKnownHostsStore } from "../lib/known-hosts.js";
import { createOutput } from "../lib/output.js";
import { withRunLog } from "../lib/run-log.js";
import { ensureGeneratedSecrets } from "../secrets/generated-secrets.js";
import { generatedSecretStore } from "../secrets/secret-store.js";
import { collectSecrets } from "../secrets/secrets.js";

interface RestoreFlags {
    readonly artifact?: string;
    readonly snapshot?: string;
    readonly only?: string;
}

export const restore = buildCommand<RestoreFlags>({
    docs: { brief: "Restore Forgejo/Komodo from a restic backup snapshot, then re-apply (one-shot recovery)" },
    parameters: {
        flags: {
            artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` },
            snapshot: { kind: "parsed", parse: String, optional: true, brief: "restic snapshot id to restore (default: latest)" },
            only: { kind: "parsed", parse: String, optional: true, brief: "Which to restore: forgejo | komodo | all (default: all)" },
        },
    },
    async func(this: CommandContext, flags: RestoreFlags) {
        const out = createOutput(withRunLog(this.process.stdout, "restore"), loadConfig().intenticOutput);
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        const dir = dirname(artifact);
        loadEnvFile(dir);
        const graph = await readArtifact(artifact);
        // Recovery re-applies against the same host, so read the admin passwords from the host-authoritative
        // store (no backfill, restore reads what's there rather than reconciling layers).
        const ssh = createSshExecutor(createKnownHostsStore(dir));
        try {
            await ensureGeneratedSecrets(generatedSecretStore(graph, dir, ssh, false, out.log), collectSecrets(graph).generated, process.env);
            const backupNode = Object.values(graph.resources).find((node) => node.type === "backup");
            if (backupNode === undefined) {
                throw new Error("no backup resource in the artifact: declare one with i.have.backup and apply it first");
            }
            const scope = flags.only ?? "all";
            if (scope !== "forgejo" && scope !== "komodo" && scope !== "all") {
                throw new Error(`--only must be one of forgejo|komodo|all, got "${scope}"`);
            }
            // Resolve the backup node's inputs (substituting its repo password + backend cred secrets from the
            // loaded env); the same resolved block carries the host SSH creds hostTarget needs.
            const resolved = resolveInputs(backupNode.inputs, createStore(), process.env, { lenient: false });
            const repo = resolved["repo"];
            const password = resolved["password"];
            const image = resolved["image"];
            if (typeof repo !== "string" || typeof password !== "string" || typeof image !== "string") {
                throw new Error("backup resource is missing its repo/password/image inputs");
            }
            const credsRaw = resolved["credentials"];
            const credentials: Record<string, string> = {};
            if (typeof credsRaw === "object" && credsRaw !== null) {
                for (const [key, value] of Object.entries(credsRaw)) {
                    if (typeof value === "string") {
                        credentials[key] = value;
                    }
                }
            }
            await restoreBackup({
                target: hostTarget(resolved),
                image,
                repo,
                password,
                credentials,
                snapshot: flags.snapshot ?? "latest",
                scope: scope as RestoreScope,
                log: out.log,
                executor: ssh,
            });
            out.result({ snapshot: flags.snapshot ?? "latest", scope });
        } finally {
            // Tear down the executor's cloudflared forwarders, a live forwarder child holds the event loop
            // open forever after the result (cli.ts has no process.exit), hanging the caller.
            await ssh.dispose?.();
        }
    },
});
