import { readdir, readFile } from "node:fs/promises";
import { endianness } from "node:os";
import { mapPool } from "@intentic/base/async";
import { z } from "zod";
import type { ProcessRole } from "@intentic/sandbox-contract/schemas/metrics";
import { DAEMON_GEN_ENV, DEADLINE_ENV, DETACHED_ENV, DETACHED_KINDS, type DetachedKind, WORKLOAD_ENV } from "../../seams/workload-stamp.js";
import { opt } from "../../opt.js";
import { type ReadText, readText } from "./cgroup.js";
import { type ParsedProcStat, parseProcStat } from "./proc-stat.js";

// Every process and what it is: stamp, argv and cgroup are fixed at exec, so each is read once in a process's life.

const NUMERIC = /^\d+$/u;
// procfs reads in flight at once, so the daemon's other file work never queues behind hundreds of them.
const READ_CONCURRENCY = 8;

export const listPids = async (): Promise<number[]> =>
    (await readdir("/proc").catch(() => [] as string[])).filter((entry) => NUMERIC.test(entry)).map(Number);

// What /proc/<pid>/stat counts in: bytes per page for `rss`, clock ticks per second for CPU and start times.
export interface ProcUnits {
    readonly pageBytes: number;
    readonly ticksPerSecond: number;
}

// USER_HZ and the page size on every platform this daemon ships for; used only when auxv cannot be read.
const DEFAULT_UNITS: ProcUnits = { pageBytes: 4096, ticksPerSecond: 100 };
const AT_PAGESZ = 6n;
const AT_CLKTCK = 17n;

// The auxiliary vector the kernel handed this process: pairs of 64-bit words, type then value, in native byte order.
export const parseAuxv = (auxv: Buffer, littleEndian: boolean): ProcUnits => {
    const entries = new Map<bigint, bigint>();
    for (let at = 0; at + 16 <= auxv.length; at += 16) {
        entries.set(
            littleEndian ? auxv.readBigUInt64LE(at) : auxv.readBigUInt64BE(at),
            littleEndian ? auxv.readBigUInt64LE(at + 8) : auxv.readBigUInt64BE(at + 8),
        );
    }
    const pageBytes = Number(entries.get(AT_PAGESZ) ?? 0n);
    const ticksPerSecond = Number(entries.get(AT_CLKTCK) ?? 0n);
    return {
        pageBytes: pageBytes > 0 ? pageBytes : DEFAULT_UNITS.pageBytes,
        ticksPerSecond: ticksPerSecond > 0 ? ticksPerSecond : DEFAULT_UNITS.ticksPerSecond,
    };
};

let units: Promise<ProcUnits> | undefined;
export const procUnits = (): Promise<ProcUnits> =>
    (units ??= readFile("/proc/self/auxv")
        .then((auxv) => parseAuxv(auxv, endianness() === "LE"))
        .catch(() => DEFAULT_UNITS));

// Reads procfs's NUL-separated environ, fixed at exec, so a process cannot rewrite the stamp it was born with.
export const ownerOf = (environ: string): string | undefined => envValue(environ, WORKLOAD_ENV);

const envValue = (environ: string, name: string): string | undefined => {
    for (const entry of environ.split("\0")) {
        if (entry.startsWith(`${name}=`)) {
            return entry.slice(name.length + 1);
        }
    }
    return undefined;
};

// The stamps besides the owner (seams/workload-stamp.ts): which daemon run started it, and for a detached child of the
// daemon's own, what it is and when it is overdue. Absent fields were not stamped.
export interface ProcessStamps {
    readonly generation?: string;
    readonly detached?: DetachedKind;
    readonly deadlineAt?: number;
}

const DETACHED: ReadonlySet<string> = new Set(DETACHED_KINDS);

export const stampsOf = (environ: string): ProcessStamps => {
    const generation = envValue(environ, DAEMON_GEN_ENV);
    const detached = envValue(environ, DETACHED_ENV);
    const deadlineAt = Number(envValue(environ, DEADLINE_ENV) ?? Number.NaN);
    return {
        ...opt("generation", generation === "" ? undefined : generation),
        // SAFETY: membership in DETACHED_KINDS is checked in the same expression.
        ...opt("detached", detached !== undefined && DETACHED.has(detached) ? (detached as DetachedKind) : undefined),
        ...opt("deadlineAt", Number.isFinite(deadlineAt) && deadlineAt > 0 ? deadlineAt : undefined),
    };
};

const RUST_PROGRAMS = ["clippy-driver", "wasm-bindgen", "wasm-opt", "rust-lld", "rustdoc", "rustc", "cargo"] as const;
// Only these native build steps inherit Rust attribution through the parent chain. Unrelated C builds keep their role.
const NATIVE_BUILD_STEP = /^(?:[\w]+(?:-[\w]+)*-)?(?:cc|c\+\+|gcc|g\+\+|clang|clang\+\+|ld|ld\.lld|ld\.bfd|ld\.gold|collect2)(?:-\d+)?$/u;

// A label is one of these words or nothing, never argv (a prompt, a path); longer first so `vue-tsc` is not read as `tsc`.
const PROGRAMS = [
    ...RUST_PROGRAMS,
    "vue-tsc",
    "vitest",
    "tsc",
    "tsgo",
    "turbo",
    "vite",
    "esbuild",
    "tsdown",
    "oxlint",
    "prettier",
    "knip",
    "pnpm",
    "npm",
    "npx",
    "yarn",
    "bun",
    "claude",
    "codex",
    "opencode",
    "gemini",
    "kimi",
    "devin",
    "chrome",
    "chromium",
    "firefox",
    "webkit",
    "playwright",
    "llama-server",
    "ollama",
    "tsserver",
    "iq-engine",
    "iq",
    "git",
    "tmux",
    "postgres",
    "nginx",
    "dockerd",
    "containerd",
    "node",
] as const;

// A whole word or path component; `-` opens one (`google-chrome`), `.` and `@` close one (`vite.js`, `vitest@4.0.0`).
const programPattern = (name: string): RegExp => new RegExp(`(^|[ /-])${name}([ /.@-]|$)`, "u");

const PROGRAM_PATTERNS = PROGRAMS.map((name) => [name, programPattern(name)] as const);

export const programOf = (command: string): string | undefined => {
    const value = command.toLowerCase();
    return PROGRAM_PATTERNS.find(([, pattern]) => pattern.test(value))?.[0];
};

// A turn's build, test or typecheck and the package manager driving it; native TypeScript's --lsp serves the editor.
const TOOLCHAIN = [
    ...RUST_PROGRAMS,
    "vue-tsc",
    "vitest",
    "tsc",
    "turbo",
    "vite",
    "esbuild",
    "tsdown",
    "oxlint",
    "prettier",
    "knip",
    "pnpm",
    "npm",
    "npx",
    "yarn",
    "bun",
].map(programPattern);
const NATIVE_COMPILER = /(^|[ /])(?:tsgo|tsc)([ .]|$)/u;
const isToolchain = (value: string): boolean => {
    if (NATIVE_COMPILER.test(value) && /(?:^| )--lsp(?: |$)/u.test(value)) {
        return false;
    }
    return TOOLCHAIN.some((pattern) => pattern.test(value)) || NATIVE_COMPILER.test(value);
};

// A nested container's process, by the cgroup it sits in, or the engine that runs it, by name.
const CONTAINER_CGROUP = /[/]docker[/]/u;
const CONTAINER = /(^|[ /])(dockerd|containerd|docker-proxy|docker-init|runc)([ /-]|$)/u;

// The daemon's own speech process (@intentic/speech speech-worker.ts) is one too: a gigabyte of weights while it is loaded.
const LOCAL_MODEL = /(^|[ /-])(llama-server|llama-cli|llamafile|ollama|speech-worker)([ /.-]|$)/u;

const BROWSER = /chrom(e|ium)|firefox|webkit|playwright|browser-mcp|browser_server/u;
const LANGUAGE_SERVER =
    /typescript-language-server|tsserver|rust-analyzer|pyright|pylsp|gopls|clangd|jdtls|solargraph|intelephense|language-server|lsp-daemon/u;
const OWN_LANGUAGE_SERVER = /@intentic[/]lsp|_search[/]lsp|[/]lsp[/]dist[/]cli|(^|[ /])lsp([ /]|$)|(^|[ /])(?:tsgo|tsc)([ .]|$)/u;
// Its own role, not `other`: a long-lived index host with a heap cap of its own, whose growth `other` would hide.
const SEARCH_ENGINE = /iq-engine|(^|[ /])iq([ /]|$)/u;
const TRANSLATOR = /cli-proxy-api|endpoint-translator|translator-proxy/u;
const EXTENSION = /extension-backend|extension-host|backend-host-main|backend-supervisor/u;
const GIT = /git.*fork.*broker|(^|[ /])git([ /]|$)/u;
const AGENT_RUNTIME = /(^|[ /])(claude|codex|opencode|gemini|kimi|devin)([ /]|$)|agent-runtime/u;
const TERMINAL = /(^|[ /])(tmux|bash|zsh|fish|sshd)([ :/]|$)/u;

// Order matters: an engine before what it runs, a one-shot compiler before the language server it can also be.
const ROLE_RULES: readonly (readonly [ProcessRole, (value: string) => boolean])[] = [
    ["container", (value) => CONTAINER.test(value)],
    ["browser", (value) => BROWSER.test(value)],
    ["localModel", (value) => LOCAL_MODEL.test(value)],
    ["toolchain", isToolchain],
    ["languageServer", (value) => LANGUAGE_SERVER.test(value) || OWN_LANGUAGE_SERVER.test(value)],
    ["searchEngine", (value) => SEARCH_ENGINE.test(value)],
    ["translator", (value) => TRANSLATOR.test(value)],
    ["extension", (value) => EXTENSION.test(value)],
    ["git", (value) => GIT.test(value)],
    ["agentRuntime", (value) => AGENT_RUNTIME.test(value)],
    ["terminal", (value) => TERMINAL.test(value)],
];

// What classifyProcess reads: the kernel's name for the process, then its NUL-separated argv.
export const commandOf = (comm: string, cmdline: string): string => `${comm} ${cmdline.replaceAll("\0", " ")}`;

// A nested container's process is the container's whatever it runs, by the cgroup it sits in.
export const classifyProcess = (command: string, cgroup = ""): ProcessRole => {
    if (CONTAINER_CGROUP.test(cgroup)) {
        return "container";
    }
    const value = command.toLowerCase();
    return ROLE_RULES.find(([, matches]) => matches(value))?.[0] ?? "other";
};

/* WHICH BACKGROUND JOB A PROCESS IS PART OF (2026-11-05). A game client a conversation's background job started grew to
   17.6 GB and froze the sandbox, and the minute log filed it under `other` with nothing tying it to the job or the
   conversation. bin/tmux-run runs every agent command as `bash <capture dir>/runner` in a tmux pane, and tmux makes that
   runner the leader of a session of its own; the kernel keeps the session id on everything the command starts, through
   any number of forks, a reparenting to init after its launcher exits, or a process group of its own (setpgid), and only
   a process that calls setsid itself leaves it. So a process's job is found by its session: the session's leader is a
   runner, and the runner's capture dir names the job. Its process group is the fallback, since the runner's shell runs
   without job control and everything it starts stays in its group too: that is the id netd's memory guard records with a
   kill (memory-records.ts `pgid`). Neither is ancestry, which a process reparented to init loses.
   The runner's argv and the capture dirs are agent/tools/jobs's (job-processes.ts, background-jobs.ts, job-files.ts),
   which this layer may not import: a background job's dir is `intentic-run-job-<job id>`, and a foreground call filed as
   a job when it ran past its time keeps its own `intentic-run-…` dir, with the id in the `job.json` written into it. */
const RUNNER = /^bash\0(\/.*\/intentic-run-[^/\0]+)\/runner\0$/u;
const JOB_DIR = /\/intentic-run-job-([^/]+)$/u;
const JOB_FILE = "job.json";

/** The capture dir of the tmux-run runner this argv (NUL-separated, as procfs gives it) is, or undefined for any other. */
export const runnerDirOf = (cmdline: string): string | undefined => RUNNER.exec(cmdline)?.[1];

// Only the id of the job file background-jobs.ts writes, which is all a scan needs of it.
const JobFileIdSchema = z.object({ id: z.string().min(1) });

// The job id a filed foreground call's job.json names; undefined while it has none, which is every call that did not overrun.
const jobFileId = (text: string | undefined): string | undefined => {
    if (text === undefined) {
        return undefined;
    }
    try {
        return JobFileIdSchema.safeParse(JSON.parse(text)).data?.id;
    } catch {
        // allow(silent-catch): a job file torn mid-rename names no job yet; the next scan reads it whole.
        return undefined;
    }
};

// A background job, by its id and its capture dir.
type JobOf = { readonly jobId: string; readonly dir: string };
type JobRunners = ReadonlyMap<number, JobOf>;

// The jobs of the runners one scan found, by runner pid. A background job's id is in its dir's name; a filed foreground
// call's is read from its job.json once it has one and kept while its runner lives, the absence read again each scan,
// since the file is written after the runner starts.
const jobRunnerResolver = (source: ProcSource): ((runnerDirs: ReadonlyMap<number, string>) => Promise<JobRunners>) => {
    const fileIds = new Map<string, string>();
    const jobIdOf = async (dir: string): Promise<string | undefined> => {
        const id = JOB_DIR.exec(dir)?.[1] ?? fileIds.get(dir) ?? jobFileId(await source.readText(`${dir}/${JOB_FILE}`));
        if (id !== undefined && JOB_DIR.exec(dir) === null) {
            fileIds.set(dir, id);
        }
        return id;
    };
    return async (runnerDirs) => {
        const runners = new Map<number, JobOf>();
        for (const [pid, dir] of runnerDirs) {
            const jobId = await jobIdOf(dir);
            if (jobId !== undefined) {
                runners.set(pid, { jobId, dir });
            }
        }
        const live = new Set(runnerDirs.values());
        for (const dir of fileIds.keys()) {
            if (!live.has(dir)) {
                fileIds.delete(dir);
            }
        }
        return runners;
    };
};

// An argv as the kill records keep it: NUL-separated words joined by spaces, cut to 300 characters (memory-records.ts).
const ARGV_CHARS = 300;
const argvOf = (cmdline: string | undefined): string | undefined => {
    const said = (cmdline ?? "").replaceAll("\0", " ").trim();
    return said === "" ? undefined : said.slice(0, ARGV_CHARS);
};

export interface ScannedProcess extends ParsedProcStat {
    readonly pid: number;
    // The conversation its stamp names; undefined for unstamped work.
    readonly owner: string | undefined;
    readonly stamps?: ProcessStamps | undefined;
    readonly role: ProcessRole;
    readonly program: string | undefined;
    // Its command line, cut to 300 characters: for the record of a kill, never for the minute log, where a prompt or a
    // token in an argv would outlive the process by a week.
    readonly argv?: string | undefined;
    // The background job whose runner leads its session (or its group), when one does.
    readonly jobId?: string | undefined;
}

// What the shared scan last saw of each job's runner, by the runner's pid (the session and group id of everything in its
// job), and of every process found in a job, by its own pid; kept a while after each goes: a kill is told after the
// fact, and a job's runner exits the moment its command is killed, so the follower that marks the job's ending
// (agent/tools/jobs/memory-kills.ts) asks here once both are gone. netd's guard names a process by its pid and group
// alone, and the group is the runner's only for a process that never made one of its own: the incident's game client
// did, so its own pid is what ties it to its job.
// A pid outlives its process here, and the kernel hands it out again: a pid kept for a job and then seen by a scan as
// another process (another start time) and outside any job is forgotten by that scan, or a kill of the stranger would
// be marked on the old job's ending and told to its conversation. A kill names no start time, so the lookups stay by pid;
// what is left open is a stranger killed before any scan saw it, which needs it to grow to a kill between two scans.
const RUNNER_MEMORY_MS = 10 * 60_000;
type SeenJob = JobOf & { readonly startTimeTicks: number | undefined; readonly seenAt: number };
const recentRunners = new Map<number, SeenJob>();
const recentJobProcesses = new Map<number, SeenJob>();

const seenJob = (seen: SeenJob | undefined): JobOf | undefined => (seen === undefined ? undefined : { jobId: seen.jobId, dir: seen.dir });

/** The job a process group or session led by `pid` belonged to, as the daemon's own scan last saw its runner. */
export const recentJobRunner = (pid: number): JobOf | undefined => seenJob(recentRunners.get(pid));

/** The job the process `pid` was part of, as the daemon's own scan last saw it: by its own pid, whatever its group. */
export const recentJobProcess = (pid: number): JobOf | undefined => seenJob(recentJobProcesses.get(pid));

// `started` is every pid this scan found, with its start time. The same process outside any job now (one that called
// setsid) is still the job's until the memory runs out: the job started it.
const remember = (into: Map<number, SeenJob>, seen: ReadonlyMap<number, JobOf>, started: ReadonlyMap<number, number | undefined>, now: number): void => {
    for (const [pid, job] of seen) {
        into.set(pid, { jobId: job.jobId, dir: job.dir, startTimeTicks: started.get(pid), seenAt: now });
    }
    for (const [pid, kept] of into) {
        const reused = started.has(pid) && !seen.has(pid) && (kept.startTimeTicks === undefined || kept.startTimeTicks !== started.get(pid));
        if (reused || now - kept.seenAt > RUNNER_MEMORY_MS) {
            into.delete(pid);
        }
    }
};

export interface ProcSource {
    readonly listPids: () => Promise<readonly number[]>;
    readonly readText: ReadText;
}

// `key` is start time and comm, so a reused pid or a renaming exec is read again. `runner` is the capture dir of a
// tmux-run runner, for the one process each job has that leads its session.
type Identity = Pick<ScannedProcess, "owner" | "stamps" | "role" | "program" | "argv"> & { readonly key: string; readonly runner: string | undefined };

// Scans every process but `except`, keeping what each was found to be for the next scan. `remember` is the shared scan's
// alone: it keeps the runners it saw for recentJobRunner.
export const createProcessScanner = (
    source: ProcSource = { listPids, readText },
    options: { readonly remember?: boolean } = {},
): ((except?: number) => Promise<ScannedProcess[]>) => {
    const identities = new Map<number, Identity>();
    const jobRunners = jobRunnerResolver(source);
    const identify = async (pid: number, stat: ParsedProcStat): Promise<Identity> => {
        const key = `${stat.startTimeTicks ?? ""}:${stat.comm}`;
        const known = identities.get(pid);
        if (known?.key === key) {
            return known;
        }
        const [environ, cmdline, cgroup] = await Promise.all([
            source.readText(`/proc/${pid}/environ`),
            source.readText(`/proc/${pid}/cmdline`),
            source.readText(`/proc/${pid}/cgroup`),
        ]);
        const command = commandOf(stat.comm, cmdline ?? "");
        const identity = {
            key,
            owner: ownerOf(environ ?? ""),
            stamps: stampsOf(environ ?? ""),
            role: classifyProcess(command, cgroup ?? ""),
            program: programOf(command),
            argv: argvOf(cmdline),
            runner: runnerDirOf(cmdline ?? ""),
        };
        identities.set(pid, identity);
        return identity;
    };
    return async (except) => {
        const pids = (await source.listPids()).filter((pid) => pid !== except);
        const scanned: ScannedProcess[] = [];
        const runnerDirs = new Map<number, string>();
        await mapPool(pids, READ_CONCURRENCY, async (pid) => {
            const text = await source.readText(`/proc/${pid}/stat`);
            const stat = text === undefined ? undefined : parseProcStat(text);
            // Exited between the listing and the read, the ordinary case during a scan.
            if (stat === undefined) {
                return;
            }
            const { owner, stamps, role, program, argv, runner } = await identify(pid, stat);
            if (runner !== undefined) {
                runnerDirs.set(pid, runner);
            }
            scanned.push({ pid, ...stat, owner, stamps, role, program, ...opt("argv", argv) });
        });
        const alive = new Set(scanned.map((entry) => entry.pid));
        for (const pid of identities.keys()) {
            if (!alive.has(pid)) {
                identities.delete(pid);
            }
        }
        const runners = await jobRunners(runnerDirs);
        // The session first: the kernel keeps it through every fork and regrouping; the group for a session not a runner's.
        const runnerOf = (entry: ScannedProcess): JobOf | undefined =>
            (entry.session === undefined ? undefined : runners.get(entry.session)) ?? runners.get(entry.pgrp);
        const jobProcesses = new Map(scanned.flatMap((entry) => {
            const runner = runnerOf(entry);
            return runner === undefined ? [] : [[entry.pid, runner] as const];
        }));
        if (options.remember === true) {
            const now = Date.now();
            const started = new Map(scanned.map((entry) => [entry.pid, entry.startTimeTicks]));
            remember(recentRunners, runners, started, now);
            remember(recentJobProcesses, jobProcesses, started, now);
        }
        const byPid = new Map(scanned.map((entry) => [entry.pid, entry]));
        return scanned.map((scannedEntry) => {
            const jobId = jobProcesses.get(scannedEntry.pid)?.jobId;
            const entry = jobId === undefined ? scannedEntry : { ...scannedEntry, jobId };
            if (entry.role !== "other" || !NATIVE_BUILD_STEP.test(entry.comm)) {
                return entry;
            }
            const seen = new Set([entry.pid]);
            let parent = byPid.get(entry.ppid);
            while (parent !== undefined && !seen.has(parent.pid)) {
                if (RUST_PROGRAMS.some((program) => parent?.program === program)) {
                    return { ...entry, role: "toolchain" };
                }
                seen.add(parent.pid);
                parent = byPid.get(parent.ppid);
            }
            return entry;
        });
    };
};

// The daemon's one scanner: the gauge (live-metrics.ts), the minute log (resource-metrics.ts) and the reaper read the
// same processes, so they share what each process was found to be instead of reading every environ three times.
export const scanProcesses: (except?: number) => Promise<ScannedProcess[]> = createProcessScanner(undefined, { remember: true });
