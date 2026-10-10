import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { writeFileAtomic } from "@intentic/base/fs";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import type { Desktop, WindowInfo } from "@intentic/desktop-automation";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { assertPath, assertScope, ScopeError } from "../../policy.js";
import { destructiveClasses, destructiveRefusal } from "../shell.js";
import { inRuns, listArtifacts, sandboxRunsDir } from "./artifacts.js";
import { isolatedExit, startScript, stopWindowsSandbox, windowsSandboxExe, windowsSandboxMissing, windowsSandboxRunning, wsbConfig } from "./isolated.js";

const exec = promisify(execFile);

// PROGRAMS THE AGENT STARTED ON THIS MACHINE, AND KEPT AN EYE ON. run_command waits for its command and stops it at the
// deadline, which is right for a command and wrong for an app: an app is meant to stay up while the agent looks at it,
// clicks through it and reads what it logged. Here a program is started detached, its output goes to a log file of its
// own, its exit is recorded, and it is stopped with everything it started. The record outlives the agent's process
// (`apps.json` in the sandbox's runs folder), so a restarted agent still knows what it left running.
//
// Which switch: a program a sandbox pushed here (inside its runs folder) needs "Run programs this sandbox sends"; any
// other program on this machine is what "Run commands" already covers. Each sandbox sees and stops only its own.

export interface AppRun {
    readonly id: string;
    readonly name: string;
    readonly program: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly pid: number;
    readonly startedAt: string;
    readonly log: string;
    readonly endedAt?: string;
    readonly exitCode?: number;
    readonly signal?: string;
    readonly stoppedByAgent?: boolean;
    // Run inside Windows Sandbox (isolated.ts): `pid` is the launcher's, `log` the program's output inside the VM, and
    // it is running while a Windows Sandbox is open.
    readonly isolated?: true;
}

export interface StartRequest {
    readonly program: string;
    readonly args?: readonly string[] | undefined;
    readonly cwd?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly name?: string | undefined;
    readonly isolated?: boolean | undefined;
    readonly network?: boolean | undefined;
}

// The runs a sandbox keeps on record; an older ended one is forgotten (its log file stays until the folder is cleared).
const KEEP_RUNS = 30;
// How long a start waits to see whether the program falls over at once: a missing DLL ends a Windows exe within a second.
const EARLY_EXIT_MS = 1500;
// A graceful stop's grace before it is forced.
const STOP_GRACE_MS = 5000;
// How much of a log's end is read to answer app_logs.
const LOG_TAIL_BYTES = 1024 * 1024;
export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 2000;

const registryPath = (sandboxUrl: string): string => join(sandboxRunsDir(sandboxUrl), "apps.json");
const logsDir = (sandboxUrl: string): string => join(sandboxRunsDir(sandboxUrl), ".logs");

// The process handles this agent holds, by run id: an exit is heard directly while the agent that started it lives.
const children = new Map<string, ChildProcess>();
// One write at a time per registry, so two exits in one tick do not undo each other.
let writing: Promise<void> = Promise.resolve();

const readRuns = async (sandboxUrl: string): Promise<AppRun[]> => {
    try {
        const parsed: unknown = JSON.parse(await readFile(registryPath(sandboxUrl), "utf8"));
        return Array.isArray(parsed) ? (parsed as AppRun[]) : [];
    } catch {
        // allow(silent-catch): no record yet, or one torn by a crash: nothing is known to be running
        return [];
    }
};

const updateRuns = async (sandboxUrl: string, change: (runs: AppRun[]) => AppRun[]): Promise<void> => {
    const turn = writing.then(async () => {
        const next = change(await readRuns(sandboxUrl));
        const ended = next.filter((run) => run.endedAt !== undefined);
        const kept = ended.length > KEEP_RUNS ? next.filter((run) => run.endedAt === undefined || ended.indexOf(run) >= ended.length - KEEP_RUNS) : next;
        await mkdir(dirname(registryPath(sandboxUrl)), { recursive: true });
        await writeFileAtomic(registryPath(sandboxUrl), `${JSON.stringify(kept, null, 2)}\n`);
    });
    // allow(silent-catch): the chain only orders the writes; this one's failure reaches its caller through `await turn`
    writing = turn.catch(() => undefined);
    await turn;
};

const ended = (sandboxUrl: string, id: string, exitCode: number | null, signal: string | null): Promise<void> =>
    updateRuns(sandboxUrl, (runs) =>
        runs.map((run) =>
            run.id === id && run.endedAt === undefined
                ? {
                      ...run,
                      endedAt: new Date().toISOString(),
                      ...(exitCode === null ? {} : { exitCode }),
                      ...(signal === null ? {} : { signal }),
                  }
                : run,
        ),
    );

// Whether a process with this id is alive. Only a hint for a run this agent did not start itself: an id can be reused.
const pidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

// How far apart a run's recorded start and its process's own may be and still be one process: the record is written
// just after the spawn, so seconds at most, where a process handed a recycled id began long after or long before.
const SAME_PROCESS_MS = 10_000;

// When the process holding `pid` began, in epoch milliseconds, as the operating system says; undefined when it cannot
// say (no such process, or no way to ask).
const processStartedAt = async (pid: number): Promise<number | undefined> => {
    try {
        if (process.platform === "win32") {
            const { stdout } = await exec(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
                { windowsHide: true },
            );
            const at = Date.parse(stdout.trim());
            return Number.isNaN(at) ? undefined : at;
        }
        // `lstart` is the start in local time, to the second, on Linux and macOS alike.
        const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", LANG: "C" } });
        const at = Date.parse(stdout.trim().replace(/\s+/g, " "));
        return Number.isNaN(at) ? undefined : at;
    } catch {
        // allow(silent-catch): no such process, or no `ps`: the caller treats an unknown start as not this run's
        return undefined;
    }
};

// Whether a run is still going. A run this agent started is judged by the handle it holds; one an earlier agent process
// started (the machine rebooted, the agent was upgraded or crashed) only by its pid, which the system hands to another
// program once the run ends, so the pid counts only while the process holding it began when the run did. `unknown` is
// a live pid whose start cannot be read: nothing is signalled on its say-so.
type RunState = "running" | "ended" | "unknown";

const runState = async (run: AppRun): Promise<RunState> => {
    if (run.endedAt !== undefined) {
        return "ended";
    }
    if (run.isolated === true) {
        return "running";
    }
    const child = children.get(run.id);
    if (child !== undefined) {
        return child.exitCode === null && child.signalCode === null ? "running" : "ended";
    }
    if (!pidAlive(run.pid)) {
        return "ended";
    }
    const began = await processStartedAt(run.pid);
    if (began === undefined) {
        return "unknown";
    }
    return Math.abs(began - Date.parse(run.startedAt)) <= SAME_PROCESS_MS ? "running" : "ended";
};

// A run found ended without this agent hearing it is recorded so, its exit unknown, so it is not asked about again.
const settle = async (sandboxUrl: string, run: AppRun, state: RunState): Promise<AppRun> => {
    if (state !== "ended" || run.endedAt !== undefined || children.has(run.id)) {
        return run;
    }
    const endedAt = new Date().toISOString();
    await updateRuns(sandboxUrl, (runs) => runs.map((entry) => (entry.id === run.id && entry.endedAt === undefined ? { ...entry, endedAt } : entry)));
    return { ...run, endedAt };
};

// The Windows NTSTATUS codes a crashing program most often ends with, said as a person would look them up.
const NTSTATUS: Readonly<Record<number, string>> = {
    0xc0000005: "access violation (a crash)",
    0xc0000135: "a DLL it needs was not found",
    0xc0000139: "an entry point was not found in a DLL",
    0xc0000142: "a DLL failed to initialise",
    0xc000007b: "bad image format (a 32/64-bit or architecture mismatch)",
    0xc00000fd: "stack overflow",
    0xc0000409: "fail-fast / stack buffer overrun (a panic or abort)",
    0xc000013a: "stopped with Ctrl+C or a console close",
    0x40010004: "closed by a debugger or killed",
};

export const describeExit = (run: Pick<AppRun, "exitCode" | "signal" | "stoppedByAgent">): string => {
    if (run.stoppedByAgent === true) {
        return "stopped by the agent";
    }
    if (run.signal !== undefined) {
        return `ended by signal ${run.signal}`;
    }
    if (run.exitCode === undefined) {
        return "ended (its exit code is unknown: it ended while the agent was not watching)";
    }
    const code = run.exitCode >>> 0;
    if (code >= 0x40000000) {
        const hex = `0x${code.toString(16).toUpperCase().padStart(8, "0")}`;
        const meaning = NTSTATUS[code];
        return `exited with ${hex}${meaning === undefined ? "" : `: ${meaning}`}`;
    }
    return `exited with code ${run.exitCode}`;
};

const tailLines = async (path: string, lines: number): Promise<{ text: string; total: number }> => {
    const handle = await open(path, "r").catch(undefinedIfMissing);
    if (handle === undefined) {
        return { text: "", total: 0 };
    }
    try {
        const { size } = await handle.stat();
        const from = Math.max(0, size - LOG_TAIL_BYTES);
        const buffer = Buffer.alloc(size - from);
        await handle.read(buffer, 0, buffer.byteLength, from);
        const all = buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
        if (from > 0) {
            all.shift();
        }
        if (all.at(-1) === "") {
            all.pop();
        }
        return { text: all.slice(-lines).join("\n"), total: size };
    } finally {
        await handle.close();
    }
};

// What a folder holds that could be started, for a start pointed at the folder rather than the program in it.
const startablesIn = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir).catch(() => [] as string[]);
    const wanted = process.platform === "win32" ? [".exe"] : ["", ".sh", ".AppImage"];
    return entries.filter((entry) => !entry.startsWith(".") && wanted.includes(extname(entry))).slice(0, 12);
};

const idFor = (name: string): string => `${name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "app"}-${randomBytes(3).toString("hex")}`;

// The program and its arguments as the one command line they amount to, for the classifier run_command's commands go
// through: the program by the name it is known by (`rm`, `powershell`), each argument quoted only where a shell would
// need it, so the line reads the way a person would type it.
const commandLineOf = (program: string, args: readonly string[]): string =>
    [basename(program).replace(/\.exe$/i, ""), ...args.map((arg) => (arg === "" || /[\s'"|;&<>()$`\\]/.test(arg) ? (arg.includes("'") ? `"${arg}"` : `'${arg}'`) : arg))].join(" ");

// A program already on this machine started with these arguments is a command by another door, so it answers to the
// same "Run destructive commands" switch run_command does: `rm -rf ~/x`, or a shell handed one, is refused alike.
const assertNotDestructive = (program: string, args: readonly string[], scopes: DeviceScopes): void => {
    const destructive = destructiveClasses(commandLineOf(program, args));
    if (destructive.length > 0 && scopes.destructive !== "on") {
        throw new ScopeError(destructiveRefusal(destructive));
    }
};

// The program as given resolved to a path where it is one, and the switch that covers starting it.
const judgeProgram = async (program: string, args: readonly string[], scopes: DeviceScopes, sandboxUrl: string): Promise<string> => {
    if (!isAbsolute(program)) {
        // A bare name (`notepad`) is a program already on this machine, found on its PATH: a command's business.
        assertScope(scopes, "shell");
        assertNotDestructive(program, args, scopes);
        return program;
    }
    const path = resolve(program);
    const pushed = inRuns(path, sandboxUrl);
    assertScope(scopes, pushed ? "programs" : "shell");
    // A build this sandbox pushed is its own to run as it likes; any other program is a command like run_command's.
    if (!pushed) {
        assertNotDestructive(path, args, scopes);
    }
    const stats = await stat(path).catch(undefinedIfMissing);
    if (stats === undefined) {
        throw new Error(`Nothing at ${path}. A pushed build's path is what \`devices push\` printed.`);
    }
    if (stats.isDirectory()) {
        const startable = await startablesIn(path);
        throw new Error(
            startable.length === 0
                ? `${path} is a folder, and nothing in it looks startable: pass the program inside it.`
                : `${path} is a folder: pass the program inside it, e.g. ${join(path, startable[0] ?? "")}. It holds: ${startable.join(", ")}.`,
        );
    }
    if (process.platform === "win32" && [".bat", ".cmd"].includes(extname(path).toLowerCase())) {
        throw new Error(`${basename(path)} is a batch script, which needs a shell: run it with run_command instead.`);
    }
    return path;
};

export const startApp = async (request: StartRequest, scopes: DeviceScopes, sandboxUrl: string): Promise<string> => {
    const program = await judgeProgram(request.program, request.args ?? [], scopes, sandboxUrl);
    if (request.isolated === true) {
        return await startIsolated(program, request, sandboxUrl);
    }
    const cwd =
        request.cwd !== undefined
            ? await assertPath(request.cwd, scopes, "start a program in")
            : isAbsolute(program)
              ? dirname(program)
              : sandboxRunsDir(sandboxUrl);
    await mkdir(cwd, { recursive: true });
    const name = request.name ?? basename(program, extname(program));
    const id = idFor(name);
    await mkdir(logsDir(sandboxUrl), { recursive: true });
    const log = join(logsDir(sandboxUrl), `${id}.log`);
    const logHandle = await open(log, "a");
    let child: ChildProcess;
    // Heard from the moment it exists: a program that dies at once ends before anything awaited after the spawn.
    let exit: Promise<{ code: number | null; signal: string | null }> = Promise.resolve({ code: null, signal: null });
    try {
        child = spawn(program, [...(request.args ?? [])], {
            cwd,
            env: { ...process.env, ...request.env },
            // Its own process group (posix) or no console of ours (Windows): it outlives this agent, and a stop reaches
            // everything it started. Not hidden, since an app is started to be seen.
            detached: true,
            windowsHide: false,
            stdio: ["ignore", logHandle.fd, logHandle.fd],
        });
        const spawned = child;
        exit = new Promise((done) => spawned.once("exit", (code, signal) => done({ code, signal })));
        await new Promise<void>((done, fail) => {
            child.once("spawn", () => done());
            child.once("error", (error) => fail(error));
        });
    } catch (error) {
        throw new Error(`Could not start ${program}: ${errorMessage(error)}`, { cause: error });
    } finally {
        // The child holds its own copy of the descriptor.
        await logHandle.close();
    }
    const pid = child.pid ?? 0;
    const run: AppRun = { id, name, program, args: [...(request.args ?? [])], cwd, pid, startedAt: new Date().toISOString(), log };
    children.set(id, child);
    await updateRuns(sandboxUrl, (runs) => [...runs, run]);
    const exited = exit.then(async ({ code, signal }) => {
        children.delete(id);
        await ended(sandboxUrl, id, code, signal);
    });
    child.unref();
    // A program that falls over at once is answered as such, with what it said, rather than as started.
    const early = await Promise.race([exited.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), EARLY_EXIT_MS))]);
    if (early) {
        const final = (await readRuns(sandboxUrl)).find((entry) => entry.id === id) ?? run;
        const { text } = await tailLines(log, 40);
        return `${name} (${id}) ${describeExit(final)} within ${EARLY_EXIT_MS / 1000}s of starting.${text === "" ? " It printed nothing." : `\nIts last output:\n${text}`}`;
    }
    return `Started ${name} as ${id} (pid ${pid}) in ${cwd}. Its output goes to ${log}. Give it a moment, then app_status ${id} lists its windows (pass a window id to screenshot or ui_elements); app_logs reads what it printed; app_stop ends it with everything it started.`;
};

// A program started inside Windows Sandbox: the folder it is in mapped read-only, a log folder of its own writable, the
// launcher supervised like any program. One sandbox at a time is Windows' rule, said rather than queued.
const startIsolated = async (program: string, request: StartRequest, sandboxUrl: string): Promise<string> => {
    const missing = await windowsSandboxMissing();
    if (missing !== undefined) {
        throw new Error(missing);
    }
    if (!isAbsolute(program)) {
        throw new Error("An isolated run needs the program's full path: its folder is what the sandbox is given.");
    }
    if (request.cwd !== undefined) {
        throw new Error("An isolated run starts in its own folder inside the sandbox (C:\\app); leave cwd out.");
    }
    if (await windowsSandboxRunning()) {
        throw new Error("A Windows Sandbox is already open on this machine, and Windows runs one at a time: app_stop the isolated run holding it (or close it), then start again.");
    }
    const name = request.name ?? basename(program, extname(program));
    const id = idFor(name);
    const logFolder = join(logsDir(sandboxUrl), id);
    await mkdir(logFolder, { recursive: true });
    const spec = {
        appFolder: dirname(program),
        program: relative(dirname(program), program),
        args: [...(request.args ?? [])],
        env: { ...request.env },
        logFolder,
        network: request.network ?? true,
    };
    await writeFile(join(logFolder, "start.ps1"), startScript(spec));
    const wsb = join(logFolder, `${id}.wsb`);
    await writeFile(wsb, wsbConfig(spec));
    const child = spawn(windowsSandboxExe(), [wsb], { detached: true, windowsHide: false, stdio: "ignore" });
    await new Promise<void>((done, fail) => {
        child.once("spawn", () => done());
        child.once("error", (error) => fail(new Error(`Could not start Windows Sandbox: ${errorMessage(error)}`, { cause: error })));
    });
    child.unref();
    const log = join(logFolder, "output.log");
    const run: AppRun = { id, name, program, args: spec.args, cwd: spec.appFolder, pid: child.pid ?? 0, startedAt: new Date().toISOString(), log, isolated: true };
    await updateRuns(sandboxUrl, (runs) => [...runs, run]);
    return `Started ${name} as ${id} inside Windows Sandbox: it boots in ten or twenty seconds, then runs the program from ${spec.appFolder} (read-only, at C:\\app)${spec.network ? "" : " with networking off"}. Its output goes to ${logFolder}. app_status ${id} shows the "Windows Sandbox" window to screenshot; the app's own controls are inside the VM, out of ui_elements' reach. app_stop closes the sandbox, and everything in it is discarded.`;
};

// An isolated run ends when its Windows Sandbox closes, which nothing here hears: it is read when someone asks.
const refreshIsolated = async (sandboxUrl: string): Promise<void> => {
    const running = (await readRuns(sandboxUrl)).filter((run) => run.isolated === true && run.endedAt === undefined);
    // allow(silent-catch): a process list that cannot be read proves nothing closed, so the runs stay open until it can.
    if (running.length === 0 || (await windowsSandboxRunning().catch(() => true))) {
        return;
    }
    const ids = new Set(running.map((run) => run.id));
    await updateRuns(sandboxUrl, (runs) => runs.map((run) => (ids.has(run.id) && run.endedAt === undefined ? { ...run, endedAt: new Date().toISOString() } : run)));
};

// What an isolated run's program said about its end, from inside the VM.
const insideExit = async (run: AppRun): Promise<string | undefined> =>
    run.isolated === true ? isolatedExit(await readFile(join(dirname(run.log), "exit-code"), "utf8").catch(undefinedIfMissing)) : undefined;

// An isolated run's output is two files (Start-Process cannot merge them); the error one follows, marked.
const runOutput = async (run: AppRun, lines: number): Promise<{ text: string; total: number }> => {
    const out = await tailLines(run.log, lines);
    if (run.isolated !== true) {
        return out;
    }
    const err = await tailLines(join(dirname(run.log), "error.log"), lines);
    return err.text === "" ? out : { text: [out.text, `[stderr]\n${err.text}`].filter((part) => part !== "").join("\n"), total: out.total + err.total };
};

// Every process descended from `root`, root included, from (pid, parent) rows.
export const descendantsOf = (rows: readonly (readonly [number, number])[], root: number): Set<number> => {
    const tree = new Set<number>([root]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const [pid, parent] of rows) {
            if (!tree.has(pid) && tree.has(parent) && pid !== parent) {
                tree.add(pid);
                grew = true;
            }
        }
    }
    return tree;
};

const processRows = async (): Promise<[number, number][]> => {
    if (process.platform === "win32") {
        const { stdout } = await exec(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
            { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        );
        return parseRows(stdout);
    }
    const { stdout } = await exec("ps", ["-A", "-o", "pid=,ppid="], { maxBuffer: 8 * 1024 * 1024 });
    return parseRows(stdout);
};

export const parseRows = (text: string): [number, number][] =>
    text.split(/\r?\n/).flatMap((line) => {
        const [pid, parent] = line.trim().split(/\s+/).map(Number);
        return pid !== undefined && parent !== undefined && Number.isInteger(pid) && Number.isInteger(parent) ? [[pid, parent] as [number, number]] : [];
    });

const windowsOf = async (run: AppRun, screen: Desktop): Promise<WindowInfo[]> => {
    if (run.isolated === true) {
        return (await screen.windows()).filter((window) => /windows ?sandbox/i.test(`${window.app} ${window.title}`));
    }
    const tree = descendantsOf(await processRows(), run.pid);
    return (await screen.windows()).filter((window) => window.pid !== undefined && tree.has(window.pid));
};

const findRun = async (id: string, sandboxUrl: string): Promise<AppRun> => {
    const runs = await readRuns(sandboxUrl);
    const run = runs.find((entry) => entry.id === id);
    if (run === undefined) {
        const known = runs.map((entry) => entry.id).slice(-8);
        throw new Error(`No program started here as "${id}".${known.length === 0 ? "" : ` Known: ${known.join(", ")}.`}`);
    }
    return run;
};

// A run is this sandbox's to look at when it could have started it: either switch covers looking.
const assertEither = (scopes: DeviceScopes): void => {
    if (scopes.programs !== "on" && scopes.shell !== "on") {
        assertScope(scopes, "programs");
    }
};

const runLine = (run: AppRun, state: RunState): string => {
    const said =
        state === "running"
            ? `running, pid ${run.pid}`
            : state === "unknown"
              ? `perhaps running: pid ${run.pid} is alive, but whether it is still this run cannot be checked, so app_stop will not signal it`
              : describeExit(run);
    return `${state === "running" ? "▶" : state === "unknown" ? "?" : "■"} ${run.id}  ${run.name}  ${said}  (started ${run.startedAt}${run.endedAt === undefined ? "" : `, ended ${run.endedAt}`})`;
};

// A run as it stands now, its end recorded if it was found ended unheard, with the line that says so.
const judged = async (sandboxUrl: string, run: AppRun): Promise<{ readonly run: AppRun; readonly state: RunState; readonly line: string }> => {
    const state = await runState(run);
    const settled = await settle(sandboxUrl, run, state);
    return { run: settled, state, line: runLine(settled, state) };
};

export const appStatus = async (id: string | undefined, scopes: DeviceScopes, sandboxUrl: string, screen: () => Desktop): Promise<string> => {
    assertEither(scopes);
    await refreshIsolated(sandboxUrl);
    if (id === undefined) {
        const runs = (await readRuns(sandboxUrl)).toReversed();
        const builds = await listArtifacts(sandboxUrl);
        const lines = [
            runs.length === 0 ? "Nothing has been started here by this sandbox." : `${runs.length} program run(s), newest first:`,
            ...(await Promise.all(runs.map(async (run) => (await judged(sandboxUrl, run)).line))),
        ];
        if (builds.length > 0) {
            lines.push("", "Builds pushed here (devices push), newest first:", ...builds.slice(0, 10).map((build) => `  ${build.name}/${build.version}  ${build.path}`));
        }
        return lines.join("\n");
    }
    const { run, state, line } = await judged(sandboxUrl, await findRun(id, sandboxUrl));
    const lines = [line, `program: ${run.program}${run.args.length === 0 ? "" : ` ${run.args.join(" ")}`}`, `folder: ${run.cwd}`, `log: ${run.log}`];
    const inside = await insideExit(run);
    if (run.isolated === true) {
        lines.push(`isolated in Windows Sandbox${inside === undefined ? "" : `; ${inside}`}`);
    }
    if (state === "running") {
        if (scopes.screen !== "on") {
            lines.push(`(Its windows are not listed: "See the screen" is off for this device.)`);
        } else {
            const windows = await windowsOf(run, screen()).catch((error: unknown) => {
                lines.push(`(Its windows could not be listed: ${errorMessage(error)})`);
                return [];
            });
            lines.push(
                windows.length === 0
                    ? "It has no visible window yet."
                    : `Its windows (pass the id in brackets to screenshot, ui_elements or focus_window):\n${windows
                          .map((window) => `  [${window.id}] ${window.title}  (${window.bounds.width}×${window.bounds.height} at ${window.bounds.x},${window.bounds.y})${window.focused ? ", focused" : ""}`)
                          .join("\n")}`,
            );
        }
    }
    const { text } = await runOutput(run, 10);
    if (text !== "") {
        lines.push(`Last output:\n${text}`);
    }
    return lines.join("\n");
};

export const appLogs = async (id: string, lines: number, grep: string | undefined, scopes: DeviceScopes, sandboxUrl: string): Promise<string> => {
    assertEither(scopes);
    await refreshIsolated(sandboxUrl);
    const { run, line } = await judged(sandboxUrl, await findRun(id, sandboxUrl));
    const { text, total } = await runOutput(run, grep === undefined ? lines : MAX_LOG_LINES * 5);
    let shown = text;
    if (grep !== undefined) {
        let pattern: RegExp;
        try {
            pattern = new RegExp(grep, "i");
        } catch (error) {
            throw new Error(`grep is not a usable pattern: ${errorMessage(error)}`, { cause: error });
        }
        shown = text
            .split("\n")
            .filter((line) => pattern.test(line))
            .slice(-lines)
            .join("\n");
    }
    const head = `${line}\n${run.log}, ${total} bytes${grep === undefined ? "" : `, lines matching /${grep}/i`}:`;
    return shown === "" ? `${head}\n(nothing${grep === undefined ? " printed yet" : " matches"}; a GUI program often prints nothing at all)` : `${head}\n${shown}`;
};

const waitGone = async (run: AppRun, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if ((await runState(run)) === "ended") {
            return true;
        }
        await new Promise((done) => setTimeout(done, 200));
    }
    return (await runState(run)) === "ended";
};

const signalTree = async (pid: number, force: boolean): Promise<void> => {
    if (process.platform === "win32") {
        // /T takes everything it started; without /F a window is asked to close, as its close button would.
        // allow(silent-catch): taskkill fails when the tree already ended, which is the outcome a stop wants
        await exec("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { windowsHide: true }).catch(() => undefined);
        return;
    }
    try {
        process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
        // allow(silent-catch): a group already gone is the outcome a stop wants
    }
};

export const appStop = async (id: string, force: boolean, scopes: DeviceScopes, sandboxUrl: string): Promise<string> => {
    assertEither(scopes);
    await refreshIsolated(sandboxUrl);
    const { run, state } = await judged(sandboxUrl, await findRun(id, sandboxUrl));
    if (state === "ended") {
        return `${run.id} is not running: it ${describeExit(run)}.`;
    }
    if (state === "unknown") {
        // Signalling a pid on no better word than "alive" is how an agent restarted after a reboot kills a program
        // the system has since handed that id to.
        throw new Error(
            `${run.id} was started by an earlier run of this machine's agent, and whether pid ${run.pid} is still that program cannot be checked here, so it was not signalled. If it is, close it on the machine itself.`,
        );
    }
    if (run.isolated === true) {
        await stopWindowsSandbox();
        await updateRuns(sandboxUrl, (runs) =>
            runs.map((entry) => (entry.id === id ? { ...entry, endedAt: entry.endedAt ?? new Date().toISOString(), stoppedByAgent: true } : entry)),
        );
        return `Closed the Windows Sandbox ${run.id} ran in; everything inside it is gone.`;
    }
    await signalTree(run.pid, force);
    let forced = force;
    if (!(await waitGone(run, STOP_GRACE_MS)) && !force) {
        await signalTree(run.pid, true);
        forced = true;
    }
    const gone = await waitGone(run, STOP_GRACE_MS);
    await updateRuns(sandboxUrl, (runs) =>
        runs.map((entry) => (entry.id === id ? { ...entry, endedAt: entry.endedAt ?? new Date().toISOString(), stoppedByAgent: true } : entry)),
    );
    if (!gone) {
        throw new Error(`${run.id} (pid ${run.pid}) is still running after being forced to stop: something holds it (a debugger, an elevated child).`);
    }
    return `Stopped ${run.id}${forced && !force ? " (it did not close when asked, so it was forced)" : forced ? " (forced)" : ""}, with everything it started.`;
};

