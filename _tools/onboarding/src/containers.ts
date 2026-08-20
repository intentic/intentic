import { execFile } from "node:child_process";
import { promisify } from "node:util";

/* Containers driven through the docker CLI, rather than through a library.
 *
 * This started on testcontainers, which is what the CLI's hermetic tier uses, and moved off it for two reasons
 * that are the same reason: this tier needs to say exactly where each container sits.
 *
 *   - Its reaper (a helper container the library reaches over a published port) cannot be reached from every
 *     environment this has to run in, and a tier that blocks releases must not fail on a helper. Cleanup here
 *     is explicit teardown plus a label sweep, which is strictly less machinery.
 *   - Static addresses are not optional here, and the library has no way to ask for one. The api must be told
 *     the SPA's origin at boot and the SPA must be told the api's, so neither can wait for the other to start
 *     and report an address. A network with a subnet we chose makes both known before anything runs.
 *
 * Everything carries the run's label, so a hard-killed run leaves nothing a later one cannot find and remove.
 */

const run = promisify(execFile);

export const RUN_LABEL = `dev.intentic.onboarding`;

const docker = async (args: string[], what: string, timeoutMs = 120_000): Promise<string> => {
    try {
        const { stdout } = await run(`docker`, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
        return stdout.trim();
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`${what} failed — ${message}`, { cause });
    }
};

/* The run's own network, with a subnet chosen rather than allocated.
 *
 * 10.89.0.0/24 is inside RFC 1918 and deliberately away from Docker's own default pools (172.17-31, and the
 * 192.168 range a developer's LAN usually sits in), so creating it cannot collide with a network the machine
 * already routes.
 */
export const SUBNET = `10.89.0.0/24`;
export const IPS = {
    postgres: `10.89.0.10`,
    upstream: `10.89.0.11`,
    api: `10.89.0.12`,
    web: `10.89.0.13`,
    zrok: `10.89.0.14`,
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
    /** The address inside the run's network. Fixed, so peers can be told about it before it exists. */
    readonly ip: string;
    /** Also resolvable by this name from every other container on the network. */
    readonly alias: string;
    readonly env?: Readonly<Record<string, string>>;
    /** container port → host port. Published as well as networked, because a developer's run reaches it that way. */
    readonly ports?: Readonly<Record<number, number>>;
    readonly privileged?: boolean;
    readonly command?: readonly string[];
    /** host path → container path, read-only. The run's TLS pair, and the SPA front's rendered config. */
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

export const logsOf = async (name: string): Promise<string> =>
    docker([`logs`, `--tail`, `80`, name], `reading ${name}'s log`, 30_000).catch(() => `(no log)`);

/* Whether a container is still running.
 *
 * Worth asking on every poll of a wait, because the two ways a service fails to answer need completely
 * different reports and only one of them is worth waiting out. A container that is still starting deserves the
 * full budget; a container that has EXITED will never answer, and waiting the remaining minutes for it turns a
 * one-line crash into a timeout that names nothing. That is not a hypothetical, the api's first run here died
 * on a missing module and spent three minutes looking exactly like a slow boot.
 */
export const isRunning = async (name: string): Promise<boolean> =>
    (await docker([`inspect`, `-f`, `{{.State.Running}}`, name], `inspecting ${name}`, 15_000).catch(() => `false`)) === `true`;

export const removeContainer = async (name: string): Promise<void> => {
    await docker([`rm`, `-f`, name], `removing ${name}`, 60_000).catch(() => ``);
};

export const execIn = async (name: string, command: readonly string[], timeoutMs = 300_000): Promise<string> =>
    docker([`exec`, name, ...command], `running ${command.join(` `)} in ${name}`, timeoutMs);

/* Remove whatever a previous run left behind, before this one starts.
 *
 * Without a reaper this is the only thing standing between a killed run and a runner slowly filling with
 * containers, and it is also what makes a re-run on a developer's machine work rather than fail on a name that
 * is already taken. It sweeps by label, so it can only ever touch this tier's own.
 */
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
