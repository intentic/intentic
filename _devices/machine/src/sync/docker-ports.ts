import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { z } from "zod";
import { type ExecResult, runProcess } from "./exec.js";

// THE HOST PORTS THIS MACHINE'S DOCKER ENGINE PUBLISHES, which the port mirror never forwards onto (mirror.ts). A bind
// probe sees one instant, and a container Docker brings back by itself holds no socket while the engine restarts: in
// that window on 2026-10-01 the mirror took 5440 from the host's own Postgres, whose publish then failed for good. Asked
// of the engine, a port stays the container's through the restart.
//
// A container's name is for this agent's own log line and goes nowhere else: a report never enumerates containers
// (report.ts), so a port skipped for this reason is recorded and reported as plain "busy".

/** Each host port published here, with the container(s) publishing it, by name: for the log line only. */
export type PublishedPorts = ReadonlyMap<number, string>;

// One line per container: its name, whether it runs, its restart policy, its port bindings. Neither a name (Docker
// allows `[a-zA-Z0-9][a-zA-Z0-9_.-]`) nor a policy holds a "|", so only the last field, the JSON, can.
export const INSPECT_FORMAT = "{{.Name}}|{{.State.Running}}|{{.HostConfig.RestartPolicy.Name}}|{{json .HostConfig.PortBindings}}";

// The policies under which Docker starts a stopped container again by itself, its own restart included. `on-failure`
// waits for a crash and `no` for somebody, so a stopped container under either is not counted.
const COMES_BACK = new Set(["always", "unless-stopped"]);

// The bind addresses that hold the loopback port a forward listens on: every interface ("", 0.0.0.0, ::) or loopback
// itself. A binding to one other address leaves 127.0.0.1 free.
const HOLDS_LOOPBACK = new Set(["", "0.0.0.0", "::", "127.0.0.1", "::1"]);

const BindingsSchema = z.record(z.string(), z.array(z.object({ HostIp: z.string().optional(), HostPort: z.string().optional() })).nullable()).nullable();

// A binding's host port as the ports it can land on: the one it names, every port of a range (Docker picks one of them
// at start, so which is unknown until then), or none for an ephemeral one ("" or "0"), whose number no restart keeps.
const hostPorts = (hostPort: string | undefined): number[] => {
    const range = /^(\d+)(?:-(\d+))?$/.exec(hostPort ?? "");
    const low = Number(range?.[1]);
    const high = range?.[2] === undefined ? low : Number(range[2]);
    if (!(low >= 1 && high >= low && high <= 65_535)) {
        return [];
    }
    return Array.from({ length: high - low + 1 }, (_, index) => low + index);
};

const parseBindings = (json: string): z.infer<typeof BindingsSchema> | undefined => {
    try {
        return BindingsSchema.safeParse(JSON.parse(json)).data;
    } catch {
        // allow(silent-catch): bindings that are not JSON are a container this reader cannot speak for; every other line still stands
        return undefined;
    }
};

interface Publisher {
    readonly name: string;
    readonly ports: ReadonlySet<number>;
}

// One line of the inspection, or undefined for a line this reader cannot use, which costs that container and no other.
const publisherOf = (line: string): Publisher | undefined => {
    const [named, running, policy, ...json] = line.trim().split("|");
    if (named === undefined || running === undefined || policy === undefined || json.length === 0) {
        return undefined;
    }
    const name = named.replace(/^\//, "");
    // A stopped container nothing will start again holds nothing, whatever it would publish.
    if (running !== "true" && !COMES_BACK.has(policy)) {
        return { name, ports: new Set() };
    }
    const ports = Object.values(parseBindings(json.join("|")) ?? {})
        .flatMap((listed) => listed ?? [])
        .filter((binding) => HOLDS_LOOPBACK.has(binding.HostIp ?? ""))
        .flatMap((binding) => hostPorts(binding.HostPort));
    return { name, ports: new Set(ports) };
};

// What `docker inspect --format INSPECT_FORMAT` printed, as the ports it holds: every port a running container publishes,
// and every one a stopped container publishes that Docker brings back by itself. One port bound twice (0.0.0.0 and ::)
// is one entry; two containers on one port are both named.
export const parsePublishedPorts = (stdout: string): PublishedPorts => {
    const published = new Map<number, string>();
    const publishers = stdout
        .split(/\r?\n/)
        .map(publisherOf)
        .filter((publisher) => publisher !== undefined);
    for (const { name, ports } of publishers) {
        for (const port of ports) {
            const named = published.get(port);
            published.set(port, named === undefined ? name : `${named}, ${name}`);
        }
    }
    return published;
};

// How long each docker call may take. The watcher is sequential and passes every five seconds, so an engine that has
// not answered by then is read as one that cannot be asked, which the mirror already has an answer for.
const DOCKER_TIMEOUT_MS = 5000;

export type RunDocker = (args: readonly string[]) => Promise<ExecResult>;

// Async on purpose: spawnSync would block the transport this process serves (exec.ts).
const runDocker: RunDocker = async (args) => await runProcess("docker", args, { timeoutMs: DOCKER_TIMEOUT_MS });

// Every container, then one inspection of them all. Undefined is "could not ask": no docker on PATH, an engine down or
// still starting, a socket this user may not open, a call past its bound, a container removed between the two calls
// (the inspection then exits non-zero). Never "nothing is published", which would leave the mirror trusting the probe.
export const readPublishedPorts = async (docker: RunDocker = runDocker): Promise<PublishedPorts | undefined> => {
    const listed = await docker(["ps", "--all", "--quiet"]);
    if (listed.status !== 0) {
        return undefined;
    }
    const ids = listed.stdout.split(/\s+/).filter((id) => id !== "");
    if (ids.length === 0) {
        return new Map();
    }
    const inspected = await docker(["inspect", "--format", INSPECT_FORMAT, ...ids]);
    return inspected.status === 0 ? parsePublishedPorts(inspected.stdout) : undefined;
};

// How long one answer is used for. The mirror passes every five seconds; what Docker publishes moves only when a
// container is created, removed or reconfigured.
export const DOCKER_ANSWER_MS = 30_000;

// The reader the watcher holds: it asks at most once per DOCKER_ANSWER_MS, an ask that went unanswered included, and
// never throws, since a throw in a pairing's pass reads as its sandbox being unreachable (mirror.ts).
export const publishedPortsReader = (
    log: Log,
    read: () => Promise<PublishedPorts | undefined> = readPublishedPorts,
    now: () => number = Date.now,
): (() => Promise<PublishedPorts | undefined>) => {
    let held: { readonly at: number; readonly answer: PublishedPorts | undefined } | undefined;
    const ask = async (): Promise<PublishedPorts | undefined> => {
        try {
            return await read();
        } catch (error) {
            log(`  asking Docker which ports it publishes failed: ${errorMessage(error)}`);
            return undefined;
        }
    };
    return async () => {
        const at = now();
        if (held === undefined || at - held.at >= DOCKER_ANSWER_MS) {
            held = { at, answer: await ask() };
        }
        return held.answer;
    };
};
