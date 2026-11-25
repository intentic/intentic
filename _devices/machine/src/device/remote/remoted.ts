import { setTimeout as delay } from "node:timers/promises";
import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { nextBackoff } from "../egress/follower.js";
import { z } from "zod";
import { commonProtocol, type ConnectRemoted, type ControlConnection, type ControlMessage } from "./remoted-control.js";
import { parseStatusLine, type RemotedStatus } from "./remoted-files.js";

/* intentic-remoted AS THE AGENT KEEPS IT (2026-11-20; adoption 2026-11-24). Started while some link holds an uplink,
   stopped once none does. A remoted that speaks the control protocol (remoted-control.ts) is started detached, with
   `--control <endpoint>`, and outlives this agent: the next agent, after an upgrade, a watchdog kill or a crash, adopts it
   over the endpoint instead of starting another, so people's terminals and the programs in them carry on. One it cannot
   adopt (no protocol in common) is asked to leave and replaced; one of another build than this agent ships (an upgrade)
   is adopted and replaced once nothing is open on it. A remoted from before the control protocol, and every remoted of
   an agent running before anyone signed in (its remoted has no desktop, and the session's agent must not adopt it), is
   this agent's child as before: `--parent-stdin`, its stdin a pipe the agent holds, so it exits when the agent does.
   An exit nobody asked for is logged with its code and the last thing it said, and it is started again after a second,
   doubling to a minute, and after a second again once a run has held for a minute (the egress follower's ladder). Its
   log lines go to the agent's log (stderr for a child, `log` lines over the endpoint for an adopted one); its status,
   a whole snapshot on each change, comes on stdout or over the endpoint. */

// How long a remoted asked to leave (stdin closed, or `stop` over its endpoint) gets before it is killed.
const STOP_GRACE_MS = 3_000;
// How long a remoted started detached has to open its control endpoint, and how often it is tried meanwhile.
const ENDPOINT_WAIT_MS = 10_000;
const ENDPOINT_POLL_MS = 100;

// How one run ended: the exit code or the signal, and an error when it could not start at all.
export interface RemotedExit {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error?: string;
}

// One running remoted as this agent holds it: its own child, or one adopted over the control endpoint.
export interface RemotedChild {
    readonly pid: number | undefined;
    // Its end, or for an adopted one the end of the connection (which its end closes).
    readonly exited: Promise<RemotedExit>;
    // Asks it to leave: its stdin closed, or `stop` over the endpoint.
    readonly leave: () => void;
    readonly kill: () => void;
    // An adopted one only: lets go of it, leaving it running for the next agent.
    readonly release?: () => void;
    // The last line it logged, for the words its exit is said in.
    readonly lastLine: () => string | undefined;
}

export type SpawnRemoted = (binary: string, configPath: string, onStdout: (line: string) => void, onStderr: (line: string) => void) => RemotedChild;

// A remoted started to outlive this agent: its stdout dropped, its stderr into remoted.log.
export interface DetachedRemoted {
    readonly pid: number | undefined;
    readonly exited: Promise<RemotedExit>;
    readonly kill: () => void;
    // The last line of its log file, once it has ended.
    readonly lastLine: () => Promise<string | undefined>;
}

export type DetachRemoted = (binary: string, configPath: string, endpoint: string) => DetachedRemoted;

// What adopting needs (remoted-control.ts); without it every remoted is this agent's child.
export interface RemotedControlSeams {
    readonly endpoint: string;
    readonly connect: ConnectRemoted;
    readonly detach: DetachRemoted;
    // The control protocols the binary at a path speaks; undefined for one from before them.
    readonly protocolsOf: (binary: string) => readonly number[] | undefined;
    // The build this agent starts; an adopted remoted of another is replaced once nothing is open on it. Undefined: any.
    readonly build: string | undefined;
    // Whether this agent's remoted may outlive it: not an agent's before anyone signed in.
    readonly detachable: () => boolean;
}

export interface RemotedProcessSeams {
    readonly spawn: SpawnRemoted;
    readonly control: RemotedControlSeams | undefined;
    readonly configPath: string;
    readonly log: Log;
    // Every status remoted printed, and undefined once it is no longer running (nobody is connected through it then).
    readonly onStatus: (status: RemotedStatus | undefined) => void;
    readonly now: () => number;
}

export interface RemotedProcess {
    // Starts (or adopts) it with this binary unless it already runs or waits to be started again.
    readonly ensure: (binary: string) => void;
    // Asks it to leave, then makes it; nothing starts it again until the next `ensure`.
    readonly stop: () => Promise<void>;
    // The agent is leaving: an adopted remoted is let go, running, for the next agent to adopt; a child is stopped.
    readonly release: () => Promise<void>;
    readonly running: () => boolean;
    readonly status: () => RemotedStatus | undefined;
    // The first status `wanted` accepts, the current one included; undefined once `timeoutMs` passes without one.
    readonly waitFor: (wanted: (status: RemotedStatus) => boolean, timeoutMs: number) => Promise<RemotedStatus | undefined>;
}

type State =
    | { readonly kind: "idle" }
    // Finding, adopting or starting one; `done` once it runs or waits.
    | { readonly kind: "starting"; readonly done: Promise<void> }
    // `stale`: adopted from another build, replaced once nothing is open on it.
    | { readonly kind: "running"; readonly child: RemotedChild; readonly startedAt: number; readonly stale: boolean }
    | { readonly kind: "waiting"; readonly timer: NodeJS.Timeout };

const FIRST_BACKOFF_MS = 1_000;

// How a run ended, as the log says it.
export const exitWords = (exit: RemotedExit, lastLine: string | undefined): string => {
    const how = exit.error ?? (exit.signal === null ? `exited with code ${exit.code ?? 1}` : `was ended by ${exit.signal}`);
    return lastLine === undefined ? how : `${how}; its last line: ${lastLine}`;
};

// Asks a running remoted to leave, and kills it once STOP_GRACE_MS have passed without its exit.
const endChild = async (child: RemotedChild, log: Log): Promise<void> => {
    child.leave();
    let timer: NodeJS.Timeout | undefined;
    const left = await Promise.race([
        child.exited.then(() => true),
        new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), STOP_GRACE_MS);
        }),
    ]);
    clearTimeout(timer);
    if (!left) {
        log(`remoted: still running ${STOP_GRACE_MS / 1_000}s after it was asked to leave; killing it`);
        child.kill();
        await child.exited;
    }
};

// The first status `wanted` accepts, the current one included, told of each new one through `listeners`; undefined once
// `timeoutMs` has passed without one.
const firstStatus = async (
    latest: () => RemotedStatus | undefined,
    listeners: Set<() => void>,
    wanted: (status: RemotedStatus) => boolean,
    timeoutMs: number,
): Promise<RemotedStatus | undefined> => {
    const now = latest();
    if (now !== undefined && wanted(now)) {
        return now;
    }
    return await new Promise<RemotedStatus | undefined>((resolve) => {
        const check = (): void => {
            const status = latest();
            if (status !== undefined && wanted(status)) {
                settle(status);
            }
        };
        const timer = setTimeout(() => settle(undefined), timeoutMs);
        const settle = (answer: RemotedStatus | undefined): void => {
            clearTimeout(timer);
            listeners.delete(check);
            resolve(answer);
        };
        listeners.add(check);
    });
};

const killPid = (pid: number): void => {
    try {
        process.kill(pid, "SIGKILL");
    } catch {
        // allow(silent-catch): gone already, which is what the kill wanted
    }
};

// Whether nothing is open for a person on the remoted this status is of: no terminal, nobody connected. Pure.
export const idleStatus = (status: RemotedStatus): boolean => status.terminals === 0 && status.people.length === 0;

// Whether an adopted remoted is of another build than this agent starts. Pure.
export const staleBuild = (adopted: string, ours: string | undefined): boolean => ours !== undefined && adopted !== ours;

const LogMessageSchema = z.object({ type: z.literal("log"), line: z.string() });
const NoticeSchema = z.looseObject({ type: z.enum(["refused", "replaced"]), reason: z.string().optional() });

const GONE: RemotedExit = { code: null, signal: null, error: "its control connection closed" };

// A remoted that ended before it was held, as a child whose end is already known.
const endedChild = (pid: number | undefined, exit: RemotedExit, lastLine: string | undefined): RemotedChild => ({
    pid,
    exited: Promise.resolve(exit),
    leave: () => undefined,
    kill: () => undefined,
    lastLine: () => lastLine,
});

// The last line an adopted remoted logged, kept for the words its end is said in.
interface LastLine {
    lastLine?: string;
}

// The end of a remoted started detached, once it is known.
interface Outcome {
    exit?: RemotedExit;
}

// A child as this agent holds it, once spawned, and the last line it logged.
interface ChildBox extends LastLine {
    held?: RemotedChild;
}

// Everything one supervisor holds between events, shared by the steps below.
interface Supervisor {
    readonly seams: RemotedProcessSeams;
    readonly listeners: Set<() => void>;
    state: State;
    binary: string | undefined;
    // Whether this agent wants a remoted now: false from a stop or a release on, so nothing starts one again.
    wanted: boolean;
    backoff: number;
    latest: RemotedStatus | undefined;
    // The one remoted whose lines are this agent's status: one asked to leave may still print on its way out.
    speaking: RemotedChild | undefined;
    saidChild: boolean;
}

const publish = (sv: Supervisor, status: RemotedStatus | undefined): void => {
    sv.latest = status;
    sv.seams.onStatus(status);
    for (const listener of sv.listeners) {
        listener();
    }
    const { state } = sv;
    if (status !== undefined && state.kind === "running" && state.stale && idleStatus(status)) {
        replaceStale(sv, state.child, status);
    }
};

// An adopted remoted's end: its connection closing, with the exit of the process when this agent started it.
const adoptedExit = async (closed: Promise<void>, own: DetachedRemoted | undefined): Promise<RemotedExit> => {
    await closed;
    if (own === undefined) {
        return GONE;
    }
    // Its end closes the connection a moment before its exit is reported.
    return (await Promise.race([own.exited, delay(STOP_GRACE_MS, undefined)])) ?? GONE;
};

// What an adopted remoted says: status lines, its log, and why it let go of this agent.
const heard = (sv: Supervisor, child: RemotedChild, said: LastLine, message: ControlMessage): void => {
    const log = LogMessageSchema.safeParse(message).data;
    if (log !== undefined) {
        if (log.line.trim() !== "") {
            said.lastLine = log.line;
            sv.seams.log(`remoted: ${log.line}`);
        }
        return;
    }
    const notice = NoticeSchema.safeParse(message).data;
    if (notice !== undefined) {
        sv.seams.log(`remoted: ${notice.type === "replaced" ? "another agent adopted it" : `it refused adoption (${notice.reason ?? "no reason given"})`}`);
        return;
    }
    const status = parseStatusLine(JSON.stringify(message));
    if (status !== undefined && sv.speaking === child) {
        publish(sv, status);
    }
};

// An adopted remoted as a child: `stop` asks it to leave, its connection closing is its end. Undefined when the two
// speak no protocol in common.
const adopt = (sv: Supervisor, connection: ControlConnection, spawned?: DetachedRemoted): RemotedChild | undefined => {
    const { hello } = connection;
    const protocol = commonProtocol(hello.accepts);
    if (protocol === undefined) {
        return undefined;
    }
    const said: LastLine = {};
    const child: RemotedChild = {
        pid: hello.pid,
        exited: adoptedExit(connection.closed, spawned?.pid === hello.pid ? spawned : undefined),
        leave: () => connection.send({ type: "stop" }),
        kill: () => killPid(hello.pid),
        release: () => connection.close(),
        lastLine: () => said.lastLine,
    };
    connection.onMessage((message) => heard(sv, child, said, message));
    connection.send({ type: "adopt", protocol });
    return child;
};

// A remoted started to outlive this agent, adopted once its endpoint answers.
const startDetached = async (sv: Supervisor, path: string, control: RemotedControlSeams): Promise<RemotedChild> => {
    const { seams } = sv;
    const spawned = control.detach(path, seams.configPath, control.endpoint);
    seams.log(`remoted: started${spawned.pid === undefined ? "" : ` (pid ${spawned.pid})`}, to outlive this agent`);
    const outcome: Outcome = {};
    void spawned.exited.then((exit) => (outcome.exit = exit));
    const deadline = seams.now() + ENDPOINT_WAIT_MS;
    while (outcome.exit === undefined && seams.now() < deadline) {
        const found = await control.connect(control.endpoint);
        const adopted = found === undefined ? undefined : adopt(sv, found, spawned);
        if (adopted !== undefined) {
            return adopted;
        }
        found?.close();
        await delay(ENDPOINT_POLL_MS);
    }
    if (outcome.exit !== undefined) {
        return endedChild(spawned.pid, outcome.exit, await spawned.lastLine());
    }
    spawned.kill();
    const exit = await spawned.exited;
    return endedChild(spawned.pid, { ...exit, error: `did not open its control endpoint within ${ENDPOINT_WAIT_MS / 1_000}s` }, await spawned.lastLine());
};

// This agent's own child, ending with it.
const startChild = (sv: Supervisor, path: string): RemotedChild => {
    const { seams } = sv;
    // The child as this agent holds it (the spawned one with its last line), which `speaking` names once it is held.
    const box: ChildBox = {};
    const spawned = seams.spawn(
        path,
        seams.configPath,
        (line) => {
            const status = parseStatusLine(line);
            if (status !== undefined && box.held !== undefined && sv.speaking === box.held) {
                publish(sv, status);
            }
        },
        (line) => {
            if (line.trim() !== "") {
                box.lastLine = line;
                seams.log(`remoted: ${line}`);
            }
        },
    );
    seams.log(`remoted: started${spawned.pid === undefined ? "" : ` (pid ${spawned.pid})`}`);
    const held: RemotedChild = { ...spawned, lastLine: () => box.lastLine ?? spawned.lastLine() };
    box.held = held;
    return held;
};

// A remoted running here that speaks no protocol of this agent's, asked to leave (the hello and `stop` never change).
const endIncompatible = async (sv: Supervisor, found: ControlConnection): Promise<void> => {
    const { pid, build, accepts } = found.hello;
    sv.seams.log(`remoted: the one running (pid ${pid}, ${build}) speaks control protocols ${accepts.join(", ")}, none of this agent's: replacing it`);
    const exited = found.closed.then((): RemotedExit => ({ code: null, signal: null }));
    await endChild({ pid, exited, leave: () => found.send({ type: "stop" }), kill: () => killPid(pid), lastLine: () => undefined }, sv.seams.log);
};

interface Reached {
    readonly child: RemotedChild;
    readonly stale: boolean;
}

// The remoted to hold: the one running here when this agent can adopt it, else one started.
const reach = async (sv: Supervisor, path: string): Promise<Reached> => {
    const { seams } = sv;
    const { control } = seams;
    if (control === undefined || !control.detachable()) {
        return { child: startChild(sv, path), stale: false };
    }
    const found = await control.connect(control.endpoint);
    if (found !== undefined) {
        const adopted = adopt(sv, found);
        if (adopted === undefined) {
            await endIncompatible(sv, found);
        } else {
            const { pid, build } = found.hello;
            const stale = staleBuild(build, control.build);
            seams.log(`remoted: adopted the one running (pid ${pid}, ${build})${stale ? `; replaced by ${control.build ?? ""} once nothing is open on it` : ""}`);
            return { child: adopted, stale };
        }
    }
    const protocols = control.protocolsOf(path);
    if (protocols !== undefined && commonProtocol(protocols) !== undefined) {
        return { child: await startDetached(sv, path, control), stale: false };
    }
    if (!sv.saidChild) {
        sv.saidChild = true;
        seams.log(`remoted: ${path} speaks no control protocol this agent does, so it runs as this agent's child and ends with it`);
    }
    return { child: startChild(sv, path), stale: false };
};

// Reached, or why not: a remoted that could not be had is held as one that ended, and started again on the ladder.
const reachOrFail = async (sv: Supervisor, path: string): Promise<Reached> => {
    try {
        return await reach(sv, path);
    } catch (error) {
        return { child: endedChild(undefined, { code: null, signal: null, error: `could not start (${errorMessage(error)})` }, undefined), stale: false };
    }
};

// An exit nobody asked for: said, and started again after the ladder's wait.
const ended = (sv: Supervisor, child: RemotedChild, startedAt: number, exit: RemotedExit): void => {
    if (sv.state.kind !== "running" || sv.state.child !== child) {
        return;
    }
    sv.speaking = undefined;
    publish(sv, undefined);
    if (!sv.wanted) {
        sv.state = { kind: "idle" };
        return;
    }
    const { wait, next } = nextBackoff(sv.backoff, startedAt, sv.seams.now());
    sv.backoff = next;
    sv.seams.log(`remoted: ${exitWords(exit, child.lastLine())}; starting it again in ${Math.round(wait / 1_000)}s`);
    const timer = setTimeout(() => {
        if (sv.state.kind === "waiting" && sv.state.timer === timer) {
            launch(sv);
        }
    }, wait);
    timer.unref();
    sv.state = { kind: "waiting", timer };
};

const hold = (sv: Supervisor, { child, stale }: Reached): void => {
    const startedAt = sv.seams.now();
    sv.speaking = child;
    sv.state = { kind: "running", child, startedAt, stale };
    void child.exited.then((exit) => ended(sv, child, startedAt, exit));
};

function launch(sv: Supervisor): void {
    const path = sv.binary;
    if (path === undefined) {
        return;
    }
    sv.state = { kind: "starting", done: reachOrFail(sv, path).then((reached) => hold(sv, reached)) };
}

// An adopted remoted of another build, now that nothing is open on it, ended and this agent's started in its place.
function replaceStale(sv: Supervisor, child: RemotedChild, status: RemotedStatus): void {
    sv.seams.log(`remoted: nothing is open on the adopted ${status.version}; replacing it with this agent's`);
    sv.speaking = undefined;
    const replaced = async (): Promise<void> => {
        await endChild(child, sv.seams.log);
        const path = sv.binary;
        if (path === undefined || !sv.wanted) {
            sv.state = { kind: "idle" };
            publish(sv, undefined);
            return;
        }
        hold(sv, await reachOrFail(sv, path));
    };
    sv.state = { kind: "starting", done: replaced() };
}

// Ends what runs or waits, after a start under way has finished: answers the running child, now let go of.
const settle = async (sv: Supervisor): Promise<RemotedChild | undefined> => {
    sv.wanted = false;
    while (sv.state.kind === "starting") {
        await sv.state.done;
    }
    const was = sv.state;
    sv.state = { kind: "idle" };
    if (was.kind === "waiting") {
        clearTimeout(was.timer);
    }
    return was.kind === "running" ? was.child : undefined;
};

const stopRemoted = async (sv: Supervisor): Promise<void> => {
    const child = await settle(sv);
    if (child === undefined) {
        return;
    }
    await endChild(child, sv.seams.log);
    sv.seams.log("remoted: stopped");
    if (sv.state.kind === "idle") {
        sv.speaking = undefined;
        publish(sv, undefined);
    }
};

const releaseRemoted = async (sv: Supervisor): Promise<void> => {
    const child = await settle(sv);
    if (child === undefined) {
        return;
    }
    sv.speaking = undefined;
    if (child.release === undefined) {
        await endChild(child, sv.seams.log);
        sv.seams.log("remoted: stopped with this agent");
        publish(sv, undefined);
        return;
    }
    // Its status file stays: it still says what runs, for `remote status` and the next agent.
    child.release();
    sv.seams.log(`remoted: left running${child.pid === undefined ? "" : ` (pid ${child.pid})`} for the next agent to adopt`);
};

export const createRemotedProcess = (seams: RemotedProcessSeams): RemotedProcess => {
    const sv: Supervisor = {
        seams,
        listeners: new Set(),
        state: { kind: "idle" },
        binary: undefined,
        wanted: false,
        backoff: FIRST_BACKOFF_MS,
        latest: undefined,
        speaking: undefined,
        saidChild: false,
    };
    return {
        ensure: (path) => {
            sv.binary = path;
            sv.wanted = true;
            if (sv.state.kind === "idle") {
                sv.backoff = FIRST_BACKOFF_MS;
                launch(sv);
            }
        },
        stop: async () => await stopRemoted(sv),
        release: async () => await releaseRemoted(sv),
        running: () => sv.state.kind !== "idle",
        status: () => sv.latest,
        waitFor: async (accepts, timeoutMs) => await firstStatus(() => sv.latest, sv.listeners, accepts, timeoutMs),
    };
};
