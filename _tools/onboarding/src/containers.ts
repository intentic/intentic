import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorMessage } from "@intentic/base/errors";

// Uses the docker CLI directly, not testcontainers, for two reasons: its reaper needs a port not reachable everywhere,
// and static IPs (the api and SPA must know each other's origin at boot) aren't available. Everything carries the run's
// label so a hard-killed run can be found and removed later.

const run = promisify(execFile);

export const RUN_LABEL = `dev.intentic.onboarding`;

const docker = async (args: string[], what: string, timeoutMs = 120_000): Promise<string> => {
    try {
        const { stdout } = await run(`docker`, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
        return stdout.trim();
    } catch (cause) {
        const message = errorMessage(cause);
        throw new Error(`${what} failed: ${message}`, { cause });
    }
};

// 10.89.0.0/24, chosen away from Docker's default pools and a typical LAN, to avoid collisions.
export const SUBNET = `10.89.0.0/24`;
export const IPS = {
    postgres: `10.89.0.10`,
    upstream: `10.89.0.11`,
    api: `10.89.0.12`,
    web: `10.89.0.13`,
    webtls: `10.89.0.15`,
} as const;

export const createNetwork = async (name: string): Promise<void> => {
    await docker([`network`, `create`, `--subnet`, SUBNET, `--label`, RUN_LABEL, name], `creating the network ${name}`);
};

export const removeNetwork = async (name: string): Promise<void> => {
    await docker([`network`, `rm`, name], `removing the network ${name}`).catch(() => ``);
};

export interface ContainerSpec {
    readonly name: string;
    readonly image: string;
    readonly network: string;
    /** Fixed address inside the run's network, known to peers before the container exists. */
    readonly ip: string;
    /** Also resolvable by this name from every other container on the network. */
    readonly alias: string;
    readonly env?: Readonly<Record<string, string>>;
    /** Container port → host port; published as well as networked so a developer's run can reach it. */
    readonly ports?: Readonly<Record<number, number>>;
    readonly privileged?: boolean;
    readonly command?: readonly string[];
    /** Host path → container path, read-only: the run's TLS pair and the SPA's rendered config. */
    readonly mounts?: Readonly<Record<string, string>>;
}

export const startContainer = async (spec: ContainerSpec): Promise<void> => {
    const args = [`run`, `-d`, `--name`, spec.name, `--label`, RUN_LABEL, `--network`, spec.network, `--ip`, spec.ip, `--network-alias`, spec.alias];
    for (const [key, value] of Object.entries(spec.env ?? {})) {
        args.push(`-e`, `${key}=${value}`);
    }
    for (const [containerPort, hostPort] of Object.entries(spec.ports ?? {})) {
        args.push(`-p`, `${hostPort}:${containerPort}`);
    }
    for (const [hostPath, containerPath] of Object.entries(spec.mounts ?? {})) {
        args.push(`-v`, `${hostPath}:${containerPath}:ro`);
    }
    if (spec.privileged === true) {
        args.push(`--privileged`);
    }
    args.push(spec.image, ...(spec.command ?? []));
    await docker(args, `starting ${spec.name}`, 300_000);
};

/* A container's last 80 lines, BOTH STREAMS, and not just stdout.
 *
 * `docker logs` writes the container's stdout to its own stdout and the container's stderr to its own stderr,
 * so reading only stdout through the helper above keeps exactly the half that a crashing container does not
 * use. A startup crash is on stderr, always: an unhandled throw, a failed bind, a missing module.
 *
 * That cost a night. The stand-in model exited instantly on `ERR_MODULE_NOT_FOUND` and the nightly reported
 * `the stand-in model exited before it answered at … , last attempt: fetch failed` with NOTHING under the
 * container's name — so the one line that named the cause was the one line thrown away, and the report read as
 * a container that had died silently. Hence also the note when the log really is empty: "the container printed
 * nothing" is a fact about the container, and it must not be confusable with a reporter that dropped it.
 */
export const logsOf = async (name: string): Promise<string> => {
    try {
        const { stdout, stderr } = await run(`docker`, [`logs`, `--tail`, `80`, name], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
        const both = `${stdout}${stderr}`.trim();
        return both === `` ? `(log empty: the container printed nothing)` : both;
    } catch {
        return `(no log)`;
    }
};

// Distinguishes a container still starting (worth the full wait budget) from one that's exited (never will answer, and
// waiting out the budget hides a crash as a timeout).
export const isRunning = async (name: string): Promise<boolean> =>
    (await docker([`inspect`, `-f`, `{{.State.Running}}`, name], `inspecting ${name}`, 15_000).catch(() => `false`)) === `true`;

export const removeContainer = async (name: string): Promise<void> => {
    await docker([`rm`, `-f`, name], `removing ${name}`, 60_000).catch(() => ``);
};

export const execIn = async (name: string, command: readonly string[], timeoutMs = 300_000): Promise<string> =>
    docker([`exec`, name, ...command], `running ${command.join(` `)} in ${name}`, timeoutMs);

// Removes whatever a previous run left behind; without a reaper, this is what keeps a killed run from blocking a name
// reuse. Sweeps by label, touching only this tier's own containers.
export const sweepStrays = async (): Promise<void> => {
    const containers = await docker([`ps`, `-aq`, `--filter`, `label=${RUN_LABEL}`], `listing stray containers`, 30_000).catch(() => ``);
    if (containers !== ``) {
        await docker([`rm`, `-f`, ...containers.split(`\n`)], `removing stray containers`, 120_000).catch(() => ``);
    }
    const networks = await docker([`network`, `ls`, `-q`, `--filter`, `label=${RUN_LABEL}`], `listing stray networks`, 30_000).catch(() => ``);
    for (const id of networks.split(`\n`).filter((entry) => entry !== ``)) {
        await docker([`network`, `rm`, id], `removing a stray network`, 30_000).catch(() => ``);
    }
};
