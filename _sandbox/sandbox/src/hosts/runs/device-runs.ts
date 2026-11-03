import type { DeviceRun, DeviceRunState, RunBuiltFrom, RunOutput } from "@intentic/sandbox-contract/schemas/run-targets";
import type { Logger } from "pino";
import { opt } from "../../opt.js";
import type { DeviceTunnels } from "../device-tunnels.js";

// PROGRAMS RUNNING ON THE OWNER'S COMPUTERS, AS THE SANDBOX SEES THEM: what a device run (`devices run`, the Run
// dialog's Run on <device>) left running there, its state, its output, and the Stop that ends it together with the
// ports the sandbox opened for it (`reach`). The computer is the record: its app_status lists every program this
// sandbox started there, whoever started it, and survives a daemon restart. What only the sandbox knows (which
// repository a run came from, which tunnels it opened) is held here in memory, beside it.
//
// The machine's app_* tools answer in sentences (devices/machine/src/device/tools/programs/programs.ts: runLine,
// appLogs, startApp), which are read here by their shape. A line that does not read is left out rather than guessed at,
// so an agent that words them differently shows fewer runs, never wrong ones.

// A run id the machine mints: the run's name, slugged, and six hex digits (programs.ts idFor).
const RUN_ID = String.raw`[A-Za-z0-9._-]+-[0-9a-f]{6}`;

// One run as app_status lists it: `▶ <id>  <name>  <said>  (started <at>[, ended <at>])`.
const RUN_LINE = new RegExp(String.raw`^(▶|■|\?) (${RUN_ID}) {2}(.+?) {2}(.+) {2}\(started ([^,)]+)(?:, ended ([^)]+))?\)$`);
const stateOf = (glyph: string): DeviceRunState => (glyph === "▶" ? "running" : glyph === "■" ? "ended" : "unknown");

export type ListedRun = Omit<DeviceRun, "device" | "repo" | "ports" | "startedBy" | "builtFrom" | "landsSince">;

const parseRunLine = (line: string): ListedRun | undefined => {
    const match = RUN_LINE.exec(line.trim());
    if (match === null) {
        return undefined;
    }
    const [, glyph = "", id = "", name = "", said = "", startedAt = "", endedAt] = match;
    const code = /^exited with (?:code (-?\d+)|(0x[0-9A-Fa-f]+))/.exec(said);
    const exitCode = code === null ? undefined : code[1] !== undefined ? Number(code[1]) : Number.parseInt(code[2] ?? "", 16);
    const run: ListedRun = { id, name, state: stateOf(glyph), said, startedAt };
    if (exitCode !== undefined && !Number.isNaN(exitCode)) {
        run.exitCode = exitCode;
    }
    if (endedAt !== undefined) {
        run.endedAt = endedAt;
    }
    return run;
};

// app_status without an id: one line per run, newest first, and the builds pushed after them.
export const parseRunList = (text: string): ListedRun[] =>
    text
        .split("\n")
        .map(parseRunLine)
        .filter((run) => run !== undefined);

export interface RunLogsRead {
    readonly run: ListedRun | undefined;
    readonly total: number;
    readonly lines: string[];
}

// app_logs: the run's line, `<log>, <total> bytes:`, then what it printed (or a sentence saying it printed nothing).
export const parseRunLogs = (text: string): RunLogsRead => {
    const all = text.split("\n");
    const header = all.findIndex((line) => /, \d+ bytes(?:,[^:]*)?:$/.test(line));
    if (header === -1) {
        return { run: undefined, total: 0, lines: [] };
    }
    const run = all
        .slice(0, header)
        .map(parseRunLine)
        .find((entry) => entry !== undefined);
    const total = Number(/, (\d+) bytes/.exec(all[header] ?? "")?.[1] ?? 0);
    const body = all.slice(header + 1);
    const nothing = total === 0 || (body.length === 1 && /^\(nothing printed yet;.*\)$/.test(body[0] ?? ""));
    return { run, total, lines: nothing ? [] : body };
};

// What app_start's answer names as the run it started, or the run that fell over at once: undefined when it names none.
export const startedRun = (text: string): { id: string; ended: boolean } | undefined => {
    const started = new RegExp(String.raw`^Started .+? as (${RUN_ID})\b`).exec(text);
    if (started?.[1] !== undefined) {
        return { id: started[1], ended: false };
    }
    const fell = new RegExp(String.raw`^.+? \((${RUN_ID})\) (?:exited|ended|stopped)`).exec(text);
    return fell?.[1] === undefined ? undefined : { id: fell[1], ended: true };
};

// The lines of a log's tail that came after an earlier read, from the two sizes the reads answered. Counted back from
// the end in bytes, a line and its newline each, so a log of `\r\n` lines can repeat a line or two at worst.
export const linesSince = (tail: readonly string[], total: number, since: number): string[] => {
    if (total === since) {
        return [];
    }
    if (total < since) {
        // The log was started again or cut: all of what is there is new.
        return [...tail];
    }
    let bytes = 0;
    let index = tail.length;
    while (index > 0 && bytes < total - since) {
        index -= 1;
        bytes += Buffer.byteLength(tail[index] ?? "") + 1;
    }
    return tail.slice(index);
};

// What the app_* tools are called with here.
export type DeviceToolArgs = Readonly<Record<string, string | number | boolean>>;

export interface DeviceToolAnswer {
    readonly text: string;
    // The machine's own refusal, said in `text`.
    readonly refused: boolean;
}

// One call to a device tool.
export type DeviceToolCall = (device: string, tool: string, args: DeviceToolArgs, timeoutMs: number) => Promise<DeviceToolAnswer>;

const LIST_MS = 15_000;
const LOGS_MS = 15_000;
// app_stop asks, waits the run's grace (five seconds unless its target says otherwise), forces, and waits five more:
// this covers all of it but the grace, which is added per run.
const STOP_MS = 30_000;
const DEFAULT_GRACE_SECONDS = 5;
// A run this sandbox did not start since its last restart has an unknown grace: this much is allowed for it.
const UNKNOWN_GRACE_SECONDS = 60;
// The most of a log read at once, to find what came after an earlier read (programs.ts MAX_LOG_LINES).
const MAX_TAIL_LINES = 2000;

interface Held {
    readonly name: string;
    readonly repo: string | undefined;
    readonly ports: readonly number[];
    readonly stopGraceSeconds: number | undefined;
    readonly startedBy: string | undefined;
    readonly builtFrom: RunBuiltFrom | undefined;
    ended: boolean;
}

// What the door knows of a run it just started (device-door.routes.ts).
export interface StartedRun {
    readonly name: string;
    readonly repo?: string | undefined;
    readonly ports: readonly number[];
    readonly ended?: boolean;
    readonly stopGraceSeconds?: number | undefined;
    readonly startedBy?: string | undefined;
    readonly builtFrom?: RunBuiltFrom | undefined;
}

// A stop's options: `by` is who asked, as the computer records it ("stopped by <by>": programs.ts appStop).
export interface StopAsk {
    readonly force?: boolean;
    readonly by?: string | undefined;
}

export interface DeviceRuns {
    // A run the door just started: which repository it came from and the ports opened for it.
    readonly started: (device: string, id: string, held: StartedRun) => void;
    readonly list: (device: string) => Promise<DeviceRun[]>;
    // The computer's sentence; throws its refusal.
    readonly stop: (device: string, id: string, ask?: StopAsk) => Promise<string>;
    // Every running program called `name` on the computer, stopped.
    readonly stopNamed: (device: string, name: string, by?: string) => Promise<{ id: string; text: string }[]>;
    readonly output: (device: string, id: string, read: { since?: number | undefined; lines: number }) => Promise<RunOutput>;
    // Which computer holds a run this sandbox started, for a stop that names only the run.
    readonly deviceOf: (id: string) => string | undefined;
}

// A listed run with what this sandbox holds of it: its repository, ports, starter, provenance and the lands since.
const seenRun = (own: Held | undefined, device: string, run: ListedRun, landsSince: ((repo: string, since: number) => number) | undefined): DeviceRun => {
    const seen: DeviceRun = { ...run, device, ports: own === undefined || own.ended ? [] : [...own.ports] };
    if (own?.repo !== undefined) {
        seen.repo = own.repo;
    }
    if (own?.startedBy !== undefined) {
        seen.startedBy = own.startedBy;
    }
    if (own?.builtFrom !== undefined) {
        seen.builtFrom = own.builtFrom;
        const since = Date.parse(own.builtFrom.at);
        if (own.repo !== undefined && landsSince !== undefined && !Number.isNaN(since)) {
            seen.landsSince = landsSince(own.repo, since);
        }
    }
    return seen;
};

const keyOf = (device: string, id: string): string => `${device}\n${id}`;

export const createDeviceRuns = (deps: {
    readonly call: DeviceToolCall;
    readonly tunnels: () => Pick<DeviceTunnels, "close">;
    readonly logger: Pick<Logger, "info">;
    // Lands into a repository since a moment (run-builds.ts), for a run's `landsSince`.
    readonly landsSince?: (repo: string, since: number) => number;
}): DeviceRuns => {
    const held = new Map<string, Held>();

    const asked = async (device: string, tool: string, args: DeviceToolArgs, timeoutMs: number): Promise<string> => {
        const { text, refused } = await deps.call(device, tool, args, timeoutMs);
        if (refused) {
            throw new Error(text);
        }
        return text;
    };

    const withHeld = (device: string, run: ListedRun): DeviceRun => seenRun(held.get(keyOf(device, run.id)), device, run, deps.landsSince);

    // A run that ended gives back the ports opened for it, unless another of this sandbox's runs there still holds one.
    const release = async (device: string, id: string): Promise<void> => {
        const own = held.get(keyOf(device, id));
        if (own === undefined || own.ended) {
            return;
        }
        own.ended = true;
        const stillHeld = new Set(
            [...held.entries()].filter(([key, other]) => key.startsWith(`${device}\n`) && !other.ended).flatMap(([, other]) => other.ports),
        );
        for (const port of own.ports.filter((entry) => !stillHeld.has(entry))) {
            if (await deps.tunnels().close(device, port)) {
                deps.logger.info({ device, port, run: id }, "device run ended: closed the port the sandbox reached for it");
            }
        }
    };

    const list = async (device: string): Promise<DeviceRun[]> => {
        const runs = parseRunList(await asked(device, "app_status", {}, LIST_MS));
        await Promise.all(runs.filter((run) => run.state === "ended").map((run) => release(device, run.id)));
        return runs.map((run) => withHeld(device, run));
    };

    const stop = async (device: string, id: string, ask: StopAsk = {}): Promise<string> => {
        const own = held.get(keyOf(device, id));
        const grace = own === undefined ? UNKNOWN_GRACE_SECONDS : (own.stopGraceSeconds ?? DEFAULT_GRACE_SECONDS);
        const args = { id, force: ask.force === true, ...opt("by", ask.by) };
        const text = await asked(device, "app_stop", args, STOP_MS + grace * 1000);
        await release(device, id);
        return text;
    };

    return {
        started: (device, id, run) => {
            held.set(keyOf(device, id), {
                name: run.name,
                repo: run.repo,
                ports: [...run.ports],
                stopGraceSeconds: run.stopGraceSeconds,
                startedBy: run.startedBy,
                builtFrom: run.builtFrom,
                ended: false,
            });
            if (run.ended === true) {
                void release(device, id);
            }
        },
        list,
        stop,
        stopNamed: async (device, name, by) => {
            const running = (await list(device)).filter((run) => run.name === name && run.state === "running");
            const stopped: { id: string; text: string }[] = [];
            for (const run of running) {
                stopped.push({ id: run.id, text: await stop(device, run.id, { by }) });
            }
            return stopped;
        },
        output: async (device, id, { since, lines }) => {
            const read = parseRunLogs(await asked(device, "app_logs", { id, lines: since === undefined ? lines : MAX_TAIL_LINES }, LOGS_MS));
            if (read.run?.state === "ended") {
                await release(device, id);
            }
            const answer: RunOutput = { total: read.total, lines: since === undefined ? read.lines : linesSince(read.lines, read.total, since) };
            if (read.run !== undefined) {
                answer.run = withHeld(device, read.run);
            }
            return answer;
        },
        deviceOf: (id) => {
            const found = [...held.keys()].findLast((key) => key.endsWith(`\n${id}`));
            return found?.split("\n")[0];
        },
    };
};
