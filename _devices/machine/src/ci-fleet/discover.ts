import { basename, join } from "node:path";
import { parseJsonWith } from "@intentic/base/json";
import { type CiRunner, type CiRunnerHold, CiRunnerNameSchema, type CiRunnerState, CiRunnerStateSchema } from "@intentic/sandbox-contract/schemas/ci-fleet";
import { z } from "zod";
import type { Holds } from "./fleet-holds.js";
import { RUNNER_UNIT_GLOB, RUNNER_UNIT_PATTERN, SMOKE_PAUSE_DROPIN, SMOKE_PAUSE_FLAG } from "./paths.js";
import { answered, type FleetSys } from "./sys.js";

/* THE RUNNERS ON THIS COMPUTER, read the way the scripts it replaces read them, with nothing but systemd, the runner's
   own files and the process table: no root needed, so the person's agent reads them with the service down too.
   - which: every unit file matching `actions.runner.*.service` (setup-wsl-fleet.ps1's `list-unit-files`), so a runner
     whose unit is disabled and unloaded is still listed;
   - how each is: one `systemctl show` for all of them (state, folder, account, drop-ins);
   - what it is: its folder's `.runner` (name, what it is registered to), and the `bin` link a self-update points at
     `bin.<version>`;
   - whether it works: a live Runner.Worker under its folder, as fleet-janitor.sh's busy_runners reads it, and how long
     that worker has run (`ps -o etimes`).
   Pure parsers below, each tested on what the real programs print; `discoverRunners` strings them together. */

// How long each read may take on a loaded host: systemd and ps answer in well under a second.
const READ_MS = 20_000;
// How much of a worker log is read for the job's name: it says it as the job starts, near the top.
const WORKER_LOG_HEAD = 2 * 1024 * 1024;

const LIST_UNIT_FILES_ARGS: readonly string[] = ["list-unit-files", RUNNER_UNIT_GLOB, "--no-legend", "--plain", "--no-pager"];
const SHOW_PROPERTIES = ["Id", "ActiveState", "WorkingDirectory", "User", "DropInPaths"] as const;
const showArgs = (units: readonly string[]): string[] => ["show", "--no-pager", `--property=${SHOW_PROPERTIES.join(",")}`, ...units];
const PGREP_ARGS: readonly string[] = ["-a", "-x", "Runner.Worker"];
const psArgs = (pids: readonly number[]): string[] => ["-o", "pid=,etimes=", "-p", pids.join(",")];

// `systemctl list-unit-files … --no-legend --plain`: `<unit> <state> [<preset>]` a line.
export const parseUnitFiles = (stdout: string): string[] =>
    stdout
        .split(/\r?\n/u)
        .map((line) => line.trim().split(/\s+/u)[0] ?? "")
        .filter((unit) => RUNNER_UNIT_PATTERN.test(unit));

// `systemctl show` for several units: one `Key=Value` block each, blocks apart by an empty line, in the order asked.
export const parseShowBlocks = (stdout: string): Map<string, string>[] =>
    stdout
        .split(/\r?\n\r?\n/u)
        .map((block) => {
            const fields = new Map<string, string>();
            for (const line of block.split(/\r?\n/u)) {
                const at = line.indexOf("=");
                if (at > 0) {
                    fields.set(line.slice(0, at), line.slice(at + 1));
                }
            }
            return fields;
        })
        .filter((fields) => fields.has("Id"));

// `pgrep -a -x Runner.Worker`: `<pid> <path>/bin[.<version>]/Runner.Worker spawnclient …` a line, read into the runner
// folder each worker runs under (the path up to its `bin…` segment) and its pid.
export const parseWorkers = (stdout: string): Map<string, number> => {
    const workers = new Map<string, number>();
    for (const line of stdout.split(/\r?\n/u)) {
        const [pid, path] = line.trim().split(/\s+/u);
        const match = path === undefined ? null : /^(.*)\/bin[^/]*\/Runner\.Worker$/u.exec(path);
        if (pid !== undefined && match?.[1] !== undefined && /^\d+$/u.test(pid)) {
            workers.set(match[1], Number(pid));
        }
    }
    return workers;
};

// `ps -o pid=,etimes=`: each pid and the seconds it has run.
export const parseElapsed = (stdout: string): Map<number, number> => {
    const elapsed = new Map<number, number>();
    for (const line of stdout.split(/\r?\n/u)) {
        const [pid, seconds] = line.trim().split(/\s+/u);
        if (pid !== undefined && seconds !== undefined && /^\d+$/u.test(pid) && /^\d+$/u.test(seconds)) {
            elapsed.set(Number(pid), Number(seconds));
        }
    }
    return elapsed;
};

// `.runner` as config.sh writes it, with the byte-order mark .NET puts first.
const RunnerFileSchema = z.object({ agentName: z.string().optional(), gitHubUrl: z.string().optional(), workFolder: z.string().optional() });
export type RunnerFile = z.infer<typeof RunnerFileSchema>;
export const parseRunnerFile = (text: string): RunnerFile | undefined => parseJsonWith(text.replace(/^﻿/u, ""), RunnerFileSchema);

// `bin` → `bin.2.329.0` after a self-update; a fresh install's `bin` is a folder and names no version.
export const versionOfBinLink = (target: string | undefined): string | undefined => /^(?:.*\/)?bin\.(\d+(?:\.\d+)+)$/u.exec(target ?? "")?.[1];

// The name a unit carries, `actions.runner.<scope>.<name>.service`, for a runner whose `.runner` cannot be read. The
// scope (`<owner>-<repo>`) has no dot in the runners this fleet registers; a name with dots in it reads whole after it.
export const nameOfUnit = (unit: string): string => {
    const inner = unit.replace(/^actions\.runner\./u, "").replace(/\.service$/u, "");
    const dot = inner.indexOf(".");
    return dot === -1 ? inner : inner.slice(dot + 1);
};

// The job's name as the worker logs the job message it was handed; undefined where this log does not carry it.
export const jobOfWorkerLog = (text: string): string | undefined => /"jobDisplayName"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(text)?.[1]?.replaceAll(/\\(.)/gu, "$1");

const stateOf = (raw: string | undefined): CiRunnerState => {
    const known = CiRunnerStateSchema.safeParse(raw);
    return known.success ? known.data : "unknown";
};

// The runner's name: its `.runner`'s where that is a name GitHub would take, else its unit's.
const nameOf = (file: RunnerFile | undefined, unit: string): string => {
    const named = CiRunnerNameSchema.safeParse(file?.agentName);
    return named.success ? named.data : nameOfUnit(unit);
};

// The worker log of the running job: the newest `Worker_<stamp>-utc.log` in the runner's `_diag`.
const newestWorkerLog = async (sys: FleetSys, dir: string): Promise<string | undefined> => {
    const names = (await sys.list(join(dir, "_diag"))) ?? [];
    const newest = names
        .filter((name) => /^Worker_.*\.log$/u.test(name))
        .toSorted()
        .at(-1);
    return newest === undefined ? undefined : join(dir, "_diag", newest);
};

const LIGHT = /-light-\d+$/u;

export interface Discovery {
    readonly runners: readonly CiRunner[];
    // The running worker's pid per runner name, for a caller that acts on busy runners (the drain).
    readonly workerPids: ReadonlyMap<string, number>;
}

// What the whole fleet's reads found, shared by every runner's own assembly.
interface FleetReads {
    readonly workers: ReadonlyMap<string, number>;
    readonly elapsed: ReadonlyMap<number, number>;
    readonly smokePaused: boolean;
    readonly holds: Holds;
    readonly now: number;
}

// The job's name and how long it has run, for a runner whose worker is alive.
const jobOf = async (sys: FleetSys, dir: string): Promise<string | undefined> => {
    const log = await newestWorkerLog(sys, dir);
    const text = log === undefined ? undefined : await sys.readHead(log, WORKER_LOG_HEAD);
    return text === undefined ? undefined : jobOfWorkerLog(text);
};

// Why it is down on purpose: a smoke pause's drop-in on its unit, else the service's record (a drain still waiting is
// not down yet).
const holdOf = (fields: ReadonlyMap<string, string>, name: string, reads: FleetReads): CiRunnerHold | undefined => {
    const dropIns = (fields.get("DropInPaths") ?? "").split(/\s+/u);
    if (reads.smokePaused && dropIns.some((path) => basename(path) === SMOKE_PAUSE_DROPIN)) {
        return "smoke";
    }
    const entry = reads.holds[name];
    return entry === undefined || entry.draining ? undefined : entry.hold;
};

// One runner as its unit's fields, its folder and the fleet's reads describe it.
const runnerOf = async (sys: FleetSys, fields: ReadonlyMap<string, string>, reads: FleetReads): Promise<CiRunner> => {
    const unit = fields.get("Id") ?? "";
    const dir = fields.get("WorkingDirectory") ?? "";
    const text = dir === "" ? undefined : await sys.readText(join(dir, ".runner"));
    const file = text === undefined ? undefined : parseRunnerFile(text);
    const name = nameOf(file, unit);
    const pid = dir === "" ? undefined : reads.workers.get(dir);
    const user = fields.get("User") ?? "";
    const runner: CiRunner = {
        name,
        unit,
        dir,
        // A unit with no User= runs as root.
        user: user === "" ? "root" : user,
        light: LIGHT.test(name),
        state: stateOf(fields.get("ActiveState")),
        busy: pid !== undefined,
        draining: reads.holds[name]?.draining === true,
    };
    if (file?.gitHubUrl !== undefined) {
        runner.url = file.gitHubUrl;
    }
    const version = dir === "" ? undefined : versionOfBinLink(await sys.readLink(join(dir, "bin")));
    if (version !== undefined) {
        runner.version = version;
    }
    const held = holdOf(fields, name, reads);
    if (held !== undefined) {
        runner.held = held;
    }
    if (pid !== undefined) {
        const seconds = reads.elapsed.get(pid);
        if (seconds !== undefined) {
            runner.busySince = new Date(reads.now - seconds * 1000).toISOString();
        }
        const job = await jobOf(sys, dir);
        if (job !== undefined) {
            runner.job = job;
        }
    }
    return runner;
};

// Every live worker, by the runner folder it runs under; pgrep says 1 for "nothing matched", which is an idle fleet.
// The janitor and the host prune ask it again before each step, as fleet-janitor.sh's runner_busy did.
export const readWorkers = async (sys: FleetSys): Promise<Map<string, number>> => {
    const pgrep = await sys.run("pgrep", PGREP_ARGS, { timeoutMs: READ_MS });
    return pgrep.status === 1 ? new Map() : parseWorkers(answered("pgrep Runner.Worker", pgrep));
};

// Every runner unit file. systemd 257 answers a pattern that matches nothing with exit 1 and no output (z440 on
// 2026-11-24, whose runner units were gone), which is an empty list, not a failure; any other failure is said.
const readUnitFiles = async (sys: FleetSys): Promise<string[]> => {
    const listed = await sys.run("systemctl", LIST_UNIT_FILES_ARGS, { timeoutMs: READ_MS });
    if (listed.status === 1 && `${listed.stdout}${listed.stderr}`.trim() === "") {
        return [];
    }
    return parseUnitFiles(answered("systemctl list-unit-files", listed));
};

// Where the runner folders are, unless the settings say otherwise: the janitor's own glob (fleet-janitor.sh).
export const DEFAULT_RUNNERS_GLOB = "/home/*/actions-runner-*";

// The folders a glob of absolute paths names, with `*` only inside segments (`/home/*/actions-runner-*`), read through
// the seam one segment at a time.
export const expandGlob = async (sys: Pick<FleetSys, "list">, pattern: string): Promise<string[]> => {
    let found = ["/"];
    for (const segment of pattern.split("/").filter((part) => part !== "")) {
        if (!segment.includes("*")) {
            found = found.map((dir) => join(dir, segment));
            continue;
        }
        const matcher = new RegExp(`^${segment.split("*").map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u");
        const next: string[] = [];
        for (const dir of found) {
            // one folder at a time: a handful of homes
            const names = (await sys.list(dir)) ?? [];
            next.push(...names.filter((name) => matcher.test(name)).map((name) => join(dir, name)));
        }
        found = next;
    }
    return found.toSorted();
};

// Runner folders whose `.service` names a unit systemd does not have: configured once, now started by nothing.
const orphanFolders = async (sys: FleetSys, glob: string, units: ReadonlySet<string>): Promise<Map<string, string>[]> => {
    const orphans: Map<string, string>[] = [];
    for (const dir of await expandGlob(sys, glob)) {
        // one small file per folder
        const unit = (await sys.readText(join(dir, ".service")))?.trim();
        if (unit !== undefined && RUNNER_UNIT_PATTERN.test(unit) && !units.has(unit)) {
            const owner = /^\/home\/([^/]+)\//u.exec(dir)?.[1] ?? "";
            orphans.push(new Map([["Id", unit], ["ActiveState", "not-installed"], ["WorkingDirectory", dir], ["User", owner]]));
        }
    }
    return orphans;
};

/** Every runner on this computer, as the reads above find it: each unit, and each runner folder under `glob` whose unit
 *  is gone. `holds` is the fleet service's record of which are down on purpose. */
export const discoverRunners = async (sys: FleetSys, holds: Holds = {}, glob: string = DEFAULT_RUNNERS_GLOB): Promise<Discovery> => {
    const units = await readUnitFiles(sys);
    const orphans = await orphanFolders(sys, glob, new Set(units));
    if (units.length === 0 && orphans.length === 0) {
        return { runners: [], workerPids: new Map() };
    }
    const shown = [...(units.length === 0 ? [] : parseShowBlocks(answered("systemctl show", await sys.run("systemctl", showArgs(units), { timeoutMs: READ_MS })))), ...orphans];
    const workers = await readWorkers(sys);
    const pids = [...workers.values()];
    const elapsed = pids.length === 0 ? new Map<number, number>() : parseElapsed((await sys.run("ps", psArgs(pids), { timeoutMs: READ_MS })).stdout);
    const reads: FleetReads = { workers, elapsed, smokePaused: (await sys.readText(SMOKE_PAUSE_FLAG)) !== undefined, holds, now: sys.now() };
    const runners: CiRunner[] = await Promise.all(shown.map(async (fields) => await runnerOf(sys, fields, reads)));
    const workerPids = new Map<string, number>();
    for (const runner of runners) {
        const pid = workers.get(runner.dir);
        if (pid !== undefined) {
            workerPids.set(runner.name, pid);
        }
    }
    return { runners: runners.toSorted((a: CiRunner, b: CiRunner) => a.name.localeCompare(b.name)), workerPids };
};
