import { setTimeout as sleep } from "node:timers/promises";
import type { Provider, ResolvedInputs } from "@intentic/engine";
import { HASH_KEY } from "@intentic/graph";
import { z } from "zod";
import { containerLabel } from "../core/backing-ssh.js";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import { listStampedContainers } from "../core/list-stamped.js";
import type { SshSession } from "../core/ssh.js";
import type { SshExecutor } from "../core/ssh.js";

// The inputs every catalog service shares (see state-resolver's resolveService): the host SSH block, the
// host-internal ip, and the routed domain. Per-service schemas extend this with their pinned image inputs.
export const serviceSchema = sshSchema.extend({
    internalIp: z.string(),
    domain: z.string(),
});

// One line of the write-once .env: a literal `value` (single-quoted into the shell AND in the file, so
// compose never interpolates a `$` inside it), or omitted to generate a host-side `openssl rand -hex 32` —
// the signoz JWT pattern, so secrets survive restarts and re-applies.
export interface EnvEntry {
    readonly key: string;
    readonly value?: string;
}

// Everything that distinguishes one compose-stack service from another. The provider skeleton around it
// (read = ssh + running + healthy, diff = image pins, apply = write files + `up -d` + wait, delete = down -v)
// is identical across the catalog — signoz predates this factory and keeps its own copy for its extra
// OTLP/seed-admin concerns.
export interface ComposeServiceSpec<S extends z.ZodType> {
    // Compose project + /opt/intentic/<kind> state dir; the dashboard container carries the node's
    // intentic.id stamp + intentic.type=<kind>.
    readonly kind: string;
    readonly schema: S;
    // The host port the dashboard publishes (the resolver catalog's port, tunnel-routed to <domain>).
    readonly port: number;
    // Appended to the internal url for the readiness probe ("" probes the root).
    readonly healthPath: string;
    readonly readyTimeoutMs?: number;
    // filename -> content, written on every apply; must include compose.yaml (its dashboard service
    // stamped with `id` + the intentic.hash drift-stamp).
    readonly files: (parsed: z.infer<S>, id: string, hash: string) => Record<string, string>;
    readonly env?: (parsed: z.infer<S>) => readonly EnvEntry[];
    // The long-running compose services' desired images by compose service name; diff drives an update on a
    // pin bump, which `up -d` turns into an in-place recreate of just the changed service.
    readonly images: (parsed: z.infer<S>) => Record<string, string>;
    // Runs after the stack reports healthy on apply — the seam for signoz-style admin seeding via the
    // service's own API from the host. Must tolerate an already-seeded instance (apply re-runs).
    readonly seed?: (session: SshSession, parsed: z.infer<S>, log: (message: string) => void) => Promise<void>;
}

const READY_INTERVAL_MS = 4_000;

// Bounded json-file logs for every long-running compose service — docker's default json-file log is
// unbounded and would grow with the host's uptime; `intentic logs` tails these back over SSH. One line per
// service in each template, right under its `restart:`.
export const SERVICE_LOGGING = `    logging: { driver: json-file, options: { max-size: 10m, max-file: "3" } }`;

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const createComposeServiceProvider = <S extends typeof serviceSchema>(spec: ComposeServiceSpec<S>, executor: SshExecutor): Provider => {
    const stateDir = `/opt/intentic/${spec.kind}`;
    const readyTimeoutMs = spec.readyTimeoutMs ?? 300_000;
    const parse = (inputs: ResolvedInputs): z.infer<S> => parseInputs(spec.schema, inputs, spec.kind);
    const internalUrl = (parsed: z.infer<S>): string => `http://${parsed.internalIp}:${spec.port}`;
    const outputsFor = (parsed: z.infer<S>): Record<string, unknown> => ({
        url: `https://${parsed.domain}`,
        internalUrl: internalUrl(parsed),
    });

    const running = async (session: SshSession, id: string): Promise<boolean> => {
        const result = await session.exec(`docker ps --filter "label=intentic.id=${id}" --format '{{.Names}}'`);
        return result.stdout.trim() !== "";
    };

    const runningImages = async (session: SshSession): Promise<Record<string, string>> => {
        const result = await session.exec(
            `ids=$(docker ps -q --filter "label=com.docker.compose.project=${spec.kind}"); ` +
                `[ -n "$ids" ] && docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}={{.Config.Image}}' $ids || true`,
        );
        const images: Record<string, string> = {};
        for (const line of result.stdout.trim().split("\n")) {
            const eq = line.indexOf("=");
            if (eq > 0) {
                images[line.slice(0, eq)] = line.slice(eq + 1);
            }
        }
        return images;
    };

    // Probe FROM THE HOST over SSH (the port is host-published), so the check works regardless of whether
    // the engine's own network can reach the host's internal ip.
    const healthy = async (session: SshSession, parsed: z.infer<S>): Promise<boolean> => {
        const result = await session.exec(`wget -q -T 10 -O /dev/null ${internalUrl(parsed)}${spec.healthPath}`);
        return result.code === 0;
    };

    const waitHealthy = async (session: SshSession, parsed: z.infer<S>): Promise<void> => {
        const deadline = Date.now() + readyTimeoutMs;
        for (;;) {
            if (await healthy(session, parsed)) {
                return;
            }
            if (Date.now() >= deadline) {
                throw new Error(`${spec.kind} did not become healthy within ${readyTimeoutMs}ms`);
            }
            await sleep(READY_INTERVAL_MS);
        }
    };

    // Config files are rewritten every apply; the .env is write-once (its secrets must survive restarts —
    // re-keying would invalidate sessions / database credentials). Randoms are generated host-side.
    const ensureFiles = async (session: SshSession, parsed: z.infer<S>, id: string, hash: string): Promise<void> => {
        // A write that MUST succeed — unlike read's probes, a failed mkdir/cat here leaves the stack unbootable.
        // Surface the host's own error (permission on /opt/intentic, disk full) at its origin, rather than letting
        // the later `docker compose up -d` report the confusing "compose.yaml: no such file" for the missing write.
        const write = async (command: string, what: string): Promise<void> => {
            const result = await session.exec(command);
            if (result.code !== 0) {
                throw new Error(`${spec.kind}: ${what} failed (exit ${result.code}): ${result.stderr.trim()}`);
            }
        };
        await write(`mkdir -p ${stateDir}`, `create ${stateDir}`);
        for (const [name, content] of Object.entries(spec.files(parsed, id, hash))) {
            const marker = `${spec.kind.toUpperCase()}_FILE_EOF`;
            await write(`cat > ${stateDir}/${name} <<'${marker}'\n${content}${marker}`, `write ${stateDir}/${name}`);
        }
        const entries = spec.env?.(parsed) ?? [];
        if (entries.length === 0) {
            return;
        }
        // Each line lands as KEY='value': compose treats single-quoted .env values as literal, so a `$` in a
        // value (bcrypt hashes) never hits compose interpolation. ponytail: a literal value containing a single
        // quote would break the line — every catalog value is machine-generated (hex/base64/bcrypt) today.
        const prints = entries
            .map((entry) => `printf "${entry.key}='%s'\\n" ${entry.value === undefined ? `"$(openssl rand -hex 32)"` : shellQuote(entry.value)}`)
            .join("; ");
        await write(`test -f ${stateDir}/.env || { { ${prints}; } > ${stateDir}/.env && chmod 600 ${stateDir}/.env; }`, `write ${stateDir}/.env`);
    };

    return {
        read: async (inputs, ctx) => {
            // A dependency of these $ref inputs is still a pending create (plan resolves leniently) —
            // the resource cannot be introspected yet; parsing would crash on the PENDING symbol.
            if (hasPendingRef(inputs, "internalIp")) {
                return undefined;
            }
            const parsed = parse(inputs);
            let session: SshSession;
            try {
                session = await executor.connect(sshTarget(parsed));
            } catch (error) {
                ctx.log(`${spec.kind} "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
                return undefined;
            }
            try {
                if (!(await running(session, ctx.id)) || !(await healthy(session, parsed))) {
                    return undefined;
                }
                const stampHash = await containerLabel(session, ctx.id, HASH_KEY);
                return { outputs: outputsFor(parsed), detail: { images: await runningImages(session) }, ...(stampHash === "" ? {} : { stampHash }) };
            } finally {
                await session.dispose();
            }
        },
        diff: (inputs, observed) => {
            const parsed = parse(inputs);
            const images = (observed.detail?.["images"] ?? {}) as Record<string, string>;
            for (const [service, desired] of Object.entries(spec.images(parsed))) {
                if (images[service] !== desired) {
                    return {
                        action: "update",
                        reason: `${spec.kind} ${service} image differs (running ${String(images[service])}, want ${desired})`,
                    };
                }
            }
            return { action: "noop" };
        },
        apply: async (inputs, _observed, ctx) => {
            const parsed = parse(inputs);
            const session = await executor.connect(sshTarget(parsed));
            try {
                await ensureFiles(session, parsed, ctx.id, ctx.inputsHash ?? "");
                // Stream compose's own progress (image pulls take minutes on first apply) line-by-line through
                // the provider log, so the operator's terminal shows it live instead of one blob at the end.
                let pending = "";
                const streamLines = (chunk: string): void => {
                    pending += chunk;
                    const lines = pending.split("\n");
                    pending = lines.pop() ?? "";
                    for (const text of lines) {
                        if (text.trim() !== "") {
                            ctx.log(`${spec.kind}: ${text}`);
                        }
                    }
                };
                const up = await session.exec(
                    `docker compose -p ${spec.kind} --project-directory ${stateDir} -f ${stateDir}/compose.yaml up -d`,
                    streamLines,
                );
                streamLines("\n");
                if (up.code !== 0) {
                    throw new Error(`failed to bring up ${spec.kind} stack: exited ${up.code}: ${up.stderr.trim()}`);
                }
                ctx.log(`${spec.kind}: waiting for ${internalUrl(parsed)}${spec.healthPath} (up to ${readyTimeoutMs / 1000}s)`);
                await waitHealthy(session, parsed);
                await spec.seed?.(session, parsed, ctx.log);
                return outputsFor(parsed);
            } finally {
                await session.dispose();
            }
        },
        // Parses only the SSH block, so it works from a removed node's inputs AND a ListedResource's (a host's).
        delete: async (inputs) => {
            const session = await executor.connect(sshTarget(parseInputs(sshSchema, inputs, spec.kind)));
            try {
                await session.exec(
                    `docker compose -p ${spec.kind} --project-directory ${stateDir} -f ${stateDir}/compose.yaml down -v 2>/dev/null || true`,
                );
                await session.exec(`rm -rf ${stateDir}`);
            } finally {
                await session.dispose();
            }
        },
        list: (sources, ctx) => listStampedContainers(executor, spec.kind, sources, ctx.log),
    };
};
