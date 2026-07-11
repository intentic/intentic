import { dirname } from "node:path";
import { createStore, resolveInputs } from "@intentic/engine";
import { createSshExecutor, sshSchema, sshTarget } from "@intentic/providers";
import { buildCommand, type CommandContext, numberParser } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { ARTIFACT_PATH, loadEnvFile, readArtifact } from "../lib/artifact.js";
import { createKnownHostsStore } from "../lib/known-hosts.js";
import { createOutput } from "../lib/output.js";
import { withRunLog } from "../lib/run-log.js";

const DEFAULT_TAIL = 200;

// Node ids/types are interpolated into a host shell command — restrict them to the safe charset rather than
// quote-escaping (real ids already match; anything else is not a resource we deployed).
const SAFE_NAME = /^[a-zA-Z0-9_.-]+$/;

// The host-side fetch: compose stacks (forgejo/komodo/signoz/outline/…) keep their project at
// /opt/intentic/<type>, everything docker-run directly (workspace, runner, backup, backing services) carries
// an intentic.id label — <id> for direct runs, intentic-<type> for compose dashboards. `2>&1` folds each
// container's stderr log stream into the tap.
const logsScript = (id: string, type: string, tail: number): string =>
    [
        `if [ -f /opt/intentic/${type}/compose.yaml ]; then`,
        `  docker compose -p ${type} --project-directory /opt/intentic/${type} -f /opt/intentic/${type}/compose.yaml logs --no-color --tail ${tail}`,
        `else`,
        `  ids=$({ docker ps -aq --filter "label=intentic.id=${id}"; docker ps -aq --filter "label=intentic.id=intentic-${type}"; } | sort -u)`,
        `  if [ -z "$ids" ]; then echo "no containers labeled intentic.id=${id} (or intentic-${type}) on this host" >&2; exit 1; fi`,
        `  for c in $ids; do docker inspect -f '== {{.Name}}' "$c"; docker logs --tail ${tail} "$c" 2>&1; done`,
        `fi`,
    ].join("\n");

interface LogsFlags {
    readonly artifact?: string;
    readonly tail?: number;
}

export const logsCommand = buildCommand({
    docs: { brief: "Fetch a deployed resource's container logs from its host over SSH" },
    parameters: {
        flags: {
            artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` },
            tail: { kind: "parsed", parse: numberParser, optional: true, brief: `Lines per container (default ${DEFAULT_TAIL})` },
        },
        positional: {
            kind: "tuple",
            parameters: [{ parse: String, optional: true, brief: "Resource id from the artifact; omit to list what has logs", placeholder: "id" }],
        },
    },
    async func(this: CommandContext, flags: LogsFlags, id?: string) {
        const out = createOutput(withRunLog(this.process.stdout, "logs"), loadConfig().intenticOutput);
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        const dir = dirname(artifact);
        loadEnvFile(dir);
        const graph = await readArtifact(artifact);
        // A resource has host logs iff it was deployed over SSH — its inputs carry the copied ssh block
        // (state-resolver's sshOf). Komodo-managed app deployments keep runtime logs in Komodo by design:
        // `intentic deployments` deep-links there.
        const loggable = Object.values(graph.resources).filter((node) => node.inputs["address"] !== undefined && node.inputs["sshKey"] !== undefined);
        if (id === undefined) {
            for (const node of loggable) {
                out.text(`${node.id} (type "${node.type}")`);
            }
            out.text(`\nintentic logs <id> fetches that resource's container logs; app deployments live in Komodo (intentic deployments).`);
            out.result({ resources: loggable.map((node) => ({ id: node.id, type: node.type })) });
            return;
        }
        const node = graph.resources[id];
        if (node === undefined) {
            throw new Error(`no resource "${id}" in the artifact — run \`intentic logs\` to list them`);
        }
        if (!SAFE_NAME.test(node.id) || !SAFE_NAME.test(node.type)) {
            throw new Error(`resource id/type contains characters unsafe for a remote shell: "${node.id}" (type "${node.type}")`);
        }
        // lenient: a $ref input that only resolves during apply must not block reading the ssh block, which
        // is always literal (+ the sshKey $secret from the .env loaded above).
        const resolved = resolveInputs(node.inputs, createStore(), process.env, { lenient: true });
        const parsedSsh = sshSchema.safeParse(resolved);
        if (!parsedSsh.success) {
            throw new Error(`"${id}" (type "${node.type}") has no host SSH target — its runtime logs are not host-fetchable`);
        }
        const ssh = createSshExecutor(createKnownHostsStore(dir));
        const session = await ssh.connect(sshTarget(parsedSsh.data));
        try {
            // Stream chunks straight through the provider-log channel so text mode prints live and ndjson
            // frames each line for a driving backend (the sandbox UI).
            let pending = "";
            const result = await session.exec(logsScript(node.id, node.type, flags.tail ?? DEFAULT_TAIL), (chunk) => {
                pending += chunk;
                const lines = pending.split("\n");
                pending = lines.pop() ?? "";
                for (const text of lines) {
                    out.log(text);
                }
            });
            if (pending !== "") {
                out.log(pending);
            }
            if (result.code !== 0) {
                throw new Error(`fetching logs for "${id}" failed (exit ${result.code}): ${result.stderr.trim()}`);
            }
            out.result({ id: node.id, type: node.type, tail: flags.tail ?? DEFAULT_TAIL });
        } finally {
            await session.dispose();
            await ssh.dispose?.();
        }
    },
});
