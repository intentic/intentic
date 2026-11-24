// What a heavy program is started through once queue-run has let it in (its slot, and memory first), for the rules that
// ask for more than a slot (heavy-rules.cjs):
// - `parallel: cargo`: cargo's jobs and libtest's threads, chosen from the cores and the memory it was actually given,
//   unless the command, its environment or the project's cargo config already chose them. One line says what it chose.
// - `cpus`: a declared class that keeps that many cores busy starts once that many are idle (or at its ceiling), and is
//   told the number as INTENTIC_CPUS; with `pin`, it is pinned to that many of the idlest cores.
// - `quiet` (bin/quiet, or a class marked quiet): the conditions it ran under (cores busy and load before, what
//   everything else kept busy while it ran, load after) are printed with its result, so a measurement carries them. Its
//   wait for a calm machine is `--calm-first`, below, which queue-run runs BEFORE it takes the gate; after the gate
//   this only looks once, to pin and to report, and holds no one waiting.
// heavy-turn.cjs puts it after queue-run's `--`, so whatever ran before it holds the slot it holds; bin/quiet runs it the
// same way. Every failure here starts the command as it was given: this is never why a command did not run.
//
// node heavy-launch.cjs [--parallel cargo] [--slots N] [--cpus N] [--pin] [--quiet] [--idle N] [--calm-wait S]
//                       [--label NAME] -- <command> [args…]
// node heavy-launch.cjs --calm-first [--idle N] [--calm-wait S] [--label NAME]
//   queue-run's first step for a quiet run (2026-11-24, the shinobi-society audit): waits, holding nothing, for the load
//   OUTSIDE this sandbox to leave enough cores idle, and prints its verdict on one line for INTENTIC_QUIET_CALM. A quiet
//   run used to wait for calm after taking the gate, up to 10 minutes in which no other heavy command in the sandbox
//   could start, for load that came mostly from other sandboxes, which holding this one's gate cannot end.
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const { accessSync, constants, readFileSync } = require("node:fs");
const { availableParallelism, constants: osConstants, cpus: osCpus, loadavg } = require("node:os");
const { delimiter, dirname, join, resolve } = require("node:path");

const GIB = 1024 ** 3;
// What one cargo job takes at its peak, to size the jobs to the room: the `cargo-build` admission (7 GiB,
// memory-room.mjs SIZE_BYTES) was measured with cargo's default of a job per core on 16 cores, alongside other work.
const CARGO_JOB_BYTES = GIB;
// /proc/stat and /proc/<pid>/stat count in USER_HZ, which Linux fixes at 100 for userspace whatever the kernel's HZ.
const TICKS = 100;
// How long a look at the CPUs lasts, and how often a wait for idle cores says it is still waiting.
const SAMPLE_MS = 250;
const SAY_EVERY_MS = 30_000;
// The most a wait for idle cores lasts while the load keeps easing: a quiet run, and a class that names `cpus`. A backstop
// only: a wait ends when the cores are idle, or as soon as the load stops easing (STUCK_MS), whichever comes first.
const QUIET_WAIT_SECONDS = 600;
const CPUS_WAIT_SECONDS = 120;
// How long a wait for idle cores goes on with the load not easing before it gives up and starts. Waiting helps only
// while busy cores are coming free; a load that holds steady (another sandbox's build, the owner's own work) does not
// end because this waits, and a countdown to a fixed ceiling only delayed a run that then went ahead NOT calm anyway.
// The same rule as memory-room's stuckWait.
const STUCK_MS = 30_000;
// What counts as easing over that window: a core's worth of load gone.
const EASED_CORES = 1;
// The share of the machine's cores a quiet run wants idle when it names none.
const QUIET_IDLE_SHARE = 0.75;

const say = (prefix, line) => process.stderr.write(`[${prefix}] ${line}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const read = (path) => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        // allow(silent-catch): a file this kernel or container does not have is the absent figure every caller handles
        return undefined;
    }
};

// ---- the machine's CPUs ----

/** /proc/stat as ticks per CPU: busy and total, for `cpu<N>` lines. */
const parseProcStat = (text) =>
    (text ?? "")
        .split("\n")
        .filter((line) => /^cpu\d+\s/u.test(line))
        .map((line) => {
            const [name, ...fields] = line.trim().split(/\s+/u);
            const ticks = fields.slice(0, 8).map(Number);
            const total = ticks.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
            // idle and iowait
            const idle = (ticks[3] ?? 0) + (ticks[4] ?? 0);
            return { cpu: Number(name.slice(3)), busy: total - idle, total };
        });

/** Two looks at /proc/stat as how many cores were busy between them, in all and per CPU. */
const busyBetween = (before, after) => {
    const perCpu = after.map((now) => {
        const then = before.find((entry) => entry.cpu === now.cpu);
        const total = now.total - (then?.total ?? now.total);
        return { cpu: now.cpu, busy: total > 0 ? (now.busy - (then?.busy ?? now.busy)) / total : 0 };
    });
    return { busy: perCpu.reduce((sum, entry) => sum + entry.busy, 0), count: perCpu.length, perCpu };
};

// The CPU time this sandbox's own processes have used, in seconds, from its cgroup's cpu.stat; undefined where it is not
// in a cgroup of its own. The root cgroup has no cpu.max, so a host's whole-machine figure is never read as the sandbox's.
const sandboxSeconds = () => {
    if (read("/sys/fs/cgroup/cpu.max") === undefined) {
        return undefined;
    }
    const usec = Number(/^usage_usec\s+(\d+)/mu.exec(read("/sys/fs/cgroup/cpu.stat") ?? "")?.[1]);
    return Number.isFinite(usec) ? usec / 1e6 : undefined;
};

/** How busy the machine's cores were over `ms`, and how many of those cores this sandbox kept busy (`own`, when known). */
const lookAtCpus = async (ms = SAMPLE_MS) => {
    const before = parseProcStat(read("/proc/stat"));
    const ownBefore = sandboxSeconds();
    const startedAt = Date.now();
    await sleep(ms);
    const look = busyBetween(before, parseProcStat(read("/proc/stat")));
    const ownAfter = sandboxSeconds();
    const wall = (Date.now() - startedAt) / 1000;
    const own = ownBefore === undefined || ownAfter === undefined || wall <= 0 ? undefined : Math.min(look.busy, Math.max(0, (ownAfter - ownBefore) / wall));
    return { ...look, own };
};

/** The cores busy with work outside this sandbox (other sandboxes, the host); all of them where its own share is unknown. */
const outsideBusy = (look) => (look.own === undefined ? look.busy : Math.max(0, look.busy - look.own));

/** The cores this sandbox may use: what its affinity allows, and never more than its cgroup's CPU quota. */
const usableCores = () => {
    const allowed = availableParallelism?.() ?? osCpus().length;
    const [quota, period] = (read("/sys/fs/cgroup/cpu.max") ?? "max").trim().split(/\s+/u).map(Number);
    return Math.max(1, Number.isFinite(quota) && Number.isFinite(period) && period > 0 ? Math.min(allowed, Math.floor(quota / period)) : allowed);
};

const loadWords = () => `load ${loadavg().map((value) => value.toFixed(1)).join(" ")}`;
const busyWords = (look, outside = false) =>
    outside && look.own !== undefined
        ? `${outsideBusy(look).toFixed(1)} of ${look.count} cores busy outside this sandbox (${look.own.toFixed(1)} in it)`
        : `${look.busy.toFixed(1)} of ${look.count} cores busy`;
// Rounded once, so 599.6 seconds reads 10m00s, never 9m60s.
const minutes = (seconds) => {
    const whole = Math.round(seconds);
    return whole >= 60 ? `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}s` : `${whole}s`;
};

/**
 * Waits until `need` cores are idle; or until the load has not eased by EASED_CORES for `stuckMs` (`stuck`), since
 * waiting on then does not make them idle; or at the latest `ceilingSeconds`. With `outside`, only the load outside this
 * sandbox counts. Says so at once and every SAY_EVERY_MS while it waits. Returns whether the machine got calm, the last
 * look, how long it waited, and why it stopped when it is not calm.
 */
const waitForIdle = async ({ need, ceilingSeconds, prefix, why, look = lookAtCpus, now = Date.now, pause = sleep, outside = false, stuckMs = STUCK_MS }) => {
    const measured = (entry) => (outside ? outsideBusy(entry) : entry.busy);
    const startedAt = now();
    let last = await look();
    let saidAt;
    let easingSince = startedAt;
    let base = measured(last);
    while (last.count - measured(last) < need) {
        const at = now();
        if ((at - startedAt) / 1000 >= ceilingSeconds) {
            return { calm: false, look: last, waitedMs: at - startedAt, stopped: "ceiling" };
        }
        if (base - measured(last) >= EASED_CORES) {
            easingSince = at;
            base = measured(last);
        } else if (at - easingSince >= stuckMs) {
            return { calm: false, look: last, waitedMs: at - startedAt, stopped: "stuck" };
        }
        if (saidAt === undefined || at - saidAt >= SAY_EVERY_MS) {
            saidAt = at;
            say(prefix, `waiting for ${need} idle cores: ${busyWords(last, outside)} (${loadWords()}). ${why}It starts once they are idle, or once that load has gone ${minutes(stuckMs / 1000)} without easing.`);
        }
        await pause(1000);
        last = await look();
    }
    return { calm: true, look: last, waitedMs: now() - startedAt };
};

/** One line for a wait that ended: `calm`, `calm after 42s`, or `NOT calm (…)` saying what was busy and why it went on. */
const calmVerdict = ({ calm, look, waitedMs, stopped }, outside) => {
    if (calm) {
        return waitedMs < 1500 ? "calm" : `calm after ${minutes(waitedMs / 1000)}`;
    }
    const why = stopped === "stuck" ? `not easing after ${minutes(waitedMs / 1000)} of waiting` : `still busy at its ${minutes(waitedMs / 1000)} ceiling`;
    return `NOT calm (${busyWords(look, outside)}, ${why})`;
};

/** The `count` idlest CPUs in the last look, among those this process may run on; empty when it cannot tell. */
const idlestCpus = (look, count, allowed = allowedCpus()) => {
    // Sorted in place, on arrays made here: `toSorted` is Node 20's, and this runs on whatever Node a project pins.
    const usable = look.perCpu.filter((entry) => allowed === undefined || allowed.has(entry.cpu));
    usable.sort((left, right) => left.busy - right.busy || right.cpu - left.cpu);
    const chosen = usable.slice(0, count).map((entry) => entry.cpu);
    chosen.sort((left, right) => left - right);
    return chosen;
};

// /proc/self/status's Cpus_allowed_list (`0-3,8`) as a set; undefined where it is not said.
const allowedCpus = () => {
    const list = /^Cpus_allowed_list:\s*(\S+)/mu.exec(read("/proc/self/status") ?? "")?.[1];
    if (list === undefined) {
        return undefined;
    }
    const cpus = new Set();
    for (const range of list.split(",")) {
        const [from, to = from] = range.split("-").map(Number);
        for (let cpu = from; cpu <= to; cpu += 1) {
            cpus.add(cpu);
        }
    }
    return cpus;
};

// ---- cargo's jobs ----

// The project's cargo config naming `jobs` (`[build] jobs = 4`), from the working directory up and in CARGO_HOME.
const configJobs = (cwd, env) => {
    const dirs = [];
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
        dirs.push(join(dir, ".cargo"));
        if (dirname(dir) === dir) {
            break;
        }
    }
    dirs.push(env.CARGO_HOME ?? join(env.HOME ?? "/root", ".cargo"));
    return dirs.some((dir) => ["config.toml", "config"].some((file) => /^\s*jobs\s*=/mu.test(read(join(dir, file)) ?? "")));
};

/** Whether the command, its environment or the project already chose cargo's jobs, and libtest's threads. */
const cargoChosen = ({ args, env, cwd }) => {
    const end = args.indexOf("--");
    const own = end === -1 ? args : args.slice(0, end);
    const after = end === -1 ? [] : args.slice(end + 1);
    return {
        jobs: own.some((arg) => /^(-j\d*|--jobs(=.*)?)$/u.test(arg)) || (env.CARGO_BUILD_JOBS ?? "") !== "" || configJobs(cwd, env),
        threads: after.some((arg) => /^--test-threads(=.*)?$/u.test(arg)) || (env.RUST_TEST_THREADS ?? "") !== "",
    };
};

/**
 * Cargo's jobs for the room it was given: its share of the cores the heavy slots split (`slots`), no fewer than half that
 * share when other work keeps cores busy, and no more than the memory fits at CARGO_JOB_BYTES a job. Never fewer than 1.
 */
const cargoJobs = ({ cores, slots, idle, roomBytes }) => {
    const share = Math.max(1, Math.floor(cores / Math.max(1, slots)));
    const cpu = Math.min(share, Math.max(Math.floor(idle), Math.ceil(share / 2)));
    const memory = roomBytes === undefined ? cpu : Math.floor(roomBytes / CARGO_JOB_BYTES);
    return Math.max(1, Math.min(cpu, memory));
};

// The subcommand of `cargo [+toolchain] <verb>`.
const cargoVerb = (args) => args.find((arg, index) => !arg.startsWith("-") && !(index === 0 && arg.startsWith("+")));

/** The environment cargo starts with, and the one line saying what was chosen; undefined when nothing is left to choose. */
const cargoParallelism = ({ args, env, cwd, cores, slots, look, roomBytes }) => {
    const chosen = cargoChosen({ args, env, cwd });
    const tests = cargoVerb(args) === "test";
    if (chosen.jobs && (chosen.threads || !tests)) {
        return undefined;
    }
    const jobs = cargoJobs({ cores, slots, idle: Math.min(cores, look.count - look.busy), roomBytes });
    const set = {};
    if (!chosen.jobs) {
        set.CARGO_BUILD_JOBS = String(jobs);
    }
    if (tests && !chosen.threads) {
        set.RUST_TEST_THREADS = String(jobs);
    }
    const what = [set.CARGO_BUILD_JOBS === undefined ? undefined : `-j ${jobs}`, set.RUST_TEST_THREADS === undefined ? undefined : `${jobs} test threads`].filter(Boolean).join(" and ");
    const room = roomBytes === undefined ? "" : `, ${(roomBytes / GIB).toFixed(1)} GiB of memory for it at ~1 GiB a job`;
    const line = `cargo: ${what} (${cores} cores shared by ${slots} heavy slot${slots === 1 ? "" : "s"}, ${busyWords(look)}${room}). Pass -j / --test-threads, or set CARGO_BUILD_JOBS / RUST_TEST_THREADS, to choose yourself.`;
    return { set, line };
};

// The room this command has: free memory as the daemon counts it (what admitted work holds already taken off), plus what
// its own admission holds for it (INTENTIC_ROOM_ADMITTED, from queue-run's memory gate).
const roomOf = async (env) => {
    try {
        const { askFree } = await import("../memory-room.mjs");
        const { freeBytes } = await askFree();
        const admitted = Number(env.INTENTIC_ROOM_ADMITTED ?? "0");
        return freeBytes === undefined ? undefined : freeBytes + (Number.isFinite(admitted) ? admitted : 0);
    } catch {
        // allow(silent-catch): no reading is no memory bound on the jobs; the cores still bound them
        return undefined;
    }
};

// ---- running it ----

const parseArgs = (argv) => {
    const at = argv.indexOf("--");
    // `--calm-first` runs nothing, so its flags may come with no `--` after them.
    const flags = at === -1 ? (argv[0] === "--calm-first" ? argv : []) : argv.slice(0, at);
    const command = at === -1 ? argv : argv.slice(at + 1);
    const value = (name) => {
        const index = flags.indexOf(`--${name}`);
        return index === -1 ? undefined : flags[index + 1];
    };
    const count = (name, least = 1) => {
        const parsed = Number(value(name));
        return Number.isInteger(parsed) && parsed >= least ? parsed : undefined;
    };
    return {
        command,
        parallel: value("parallel"),
        slots: count("slots") ?? 1,
        cpus: count("cpus"),
        // 0 asks for no idle cores at all: the quiet run still holds the others off and reports.
        idle: count("idle", 0),
        calmWait: Number(value("calm-wait") ?? Number.NaN),
        pin: flags.includes("--pin"),
        quiet: flags.includes("--quiet"),
        calmFirst: flags.includes("--calm-first"),
        label: value("label") ?? "heavy",
    };
};

// The program's path, as a shell would find it.
const located = (name, env) => {
    if (name.includes("/")) {
        return resolve(name);
    }
    for (const dir of (env.PATH ?? "").split(delimiter).filter((entry) => entry !== "")) {
        try {
            accessSync(join(dir, name), constants.X_OK);
            return join(dir, name);
        } catch {
            // allow(silent-catch): not here is exactly "keep looking"
        }
    }
    return undefined;
};

// The children's CPU time this process has reaped, in seconds (/proc/self/stat cutime + cstime).
const childSeconds = () => {
    const stat = read("/proc/self/stat") ?? "";
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[13] ?? 0) + Number(fields[14] ?? 0)) / TICKS;
};

const exitOf = (code, signal) => code ?? (signal === null ? 1 : 128 + (osConstants.signals[signal] ?? 0));

/** Runs the command as a child and prints what it ran under, then leaves with its code. */
const runReported = (argv, env, before) => {
    const stat = parseProcStat(read("/proc/stat"));
    const reaped = childSeconds();
    const startedAt = Date.now();
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", env });
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
        process.on(signal, () => child.kill(signal));
    }
    child.on("error", (error) => {
        say("quiet", `could not start ${argv[0]}: ${error.message}`);
        process.exit(127);
    });
    child.on("exit", (code, signal) => {
        const wall = Math.max(0.001, (Date.now() - startedAt) / 1000);
        const during = busyBetween(stat, parseProcStat(read("/proc/stat")));
        const own = (childSeconds() - reaped) / wall;
        const others = Math.max(0, during.busy - own);
        say(
            "quiet",
            `${signal === null ? `exit ${code}` : `stopped by ${signal}`} after ${wall.toFixed(1)}s. Ran under: before, ${before}; while it ran, everything else kept ${others.toFixed(1)} cores busy (it used ${own.toFixed(1)}); after, ${loadWords()}.`,
        );
        process.exit(exitOf(code, signal));
    });
};

/** This process becomes the command: same pid, so queue-run's reservation and every signal aimed at it still land. */
const become = (argv, env) => {
    // Node 22.15 and later; an older one a project pins runs it as a child instead.
    if (process.execve !== undefined) {
        process.execve(argv[0], argv, env);
    }
    const run = spawnSync(argv[0], argv.slice(1), { stdio: "inherit", env });
    process.exit(exitOf(run.status, run.signal));
};

// The quiet wait or a class's wait for its cores; undefined when neither applies. A quiet one counts only the load outside
// this sandbox: its own heavy commands are the gate's to wait out, and the gate ends that wait the instant they end.
const calmFor = async (options, why) => {
    const quiet = options.quiet || options.calmFirst;
    const need = options.idle ?? (quiet ? Math.ceil(usableCores() * QUIET_IDLE_SHARE) : options.cpus);
    if (need === undefined) {
        return undefined;
    }
    const ceilingSeconds = Number.isFinite(options.calmWait) && options.calmWait >= 0 ? options.calmWait : quiet ? QUIET_WAIT_SECONDS : CPUS_WAIT_SECONDS;
    return { need, ...(await waitForIdle({ need, ceilingSeconds, prefix: quiet ? "quiet" : options.label, why, outside: quiet })) };
};

// A calm check that cannot read the cores says so, so a run that goes ahead unmeasured is never read as a calm one.
const cannotCheck = (prefix) => (error) => {
    say(prefix, `could not check how busy the cores are (${error instanceof Error ? error.message : String(error)}): running without waiting for calm`);
    return undefined;
};

/** --calm-first: the wait before the gate, holding nothing. Prints its verdict on one line; never fails. */
const judgeCalm = async (options) => {
    const calm = await calmFor(options, "Nothing in this sandbox waits on this. ").catch(cannotCheck("quiet"));
    if (calm !== undefined) {
        process.stdout.write(`${calmVerdict(calm, true)}\n`);
    }
};

const main = async (argv, env = { ...process.env }) => {
    const options = parseArgs(argv);
    if (options.calmFirst) {
        await judgeCalm(options);
        return;
    }
    const program = options.command[0] === undefined ? undefined : located(options.command[0], env);
    if (program === undefined) {
        process.stderr.write(`${options.command[0] ?? "heavy-launch"}: command not found\n`);
        process.exit(127);
    }
    let command = [program, ...options.command.slice(1)];
    // queue-run's --calm-first already waited, before the gate: here a quiet run only looks, to pin and to report. Not
    // passed on, so a quiet run nested in this one judges for itself.
    const judged = options.quiet ? env.INTENTIC_QUIET_CALM : undefined;
    delete env.INTENTIC_QUIET_CALM;
    const calm =
        judged !== undefined && judged !== ""
            ? { judged, look: await lookAtCpus().catch(cannotCheck("quiet")) }
            : await calmFor(options, options.quiet ? "New heavy commands in this sandbox wait meanwhile. " : "").catch(cannotCheck(options.quiet ? "quiet" : "heavy"));
    let look = calm?.look;
    if (options.parallel === "cargo") {
        look ??= await lookAtCpus();
        const chosen = cargoParallelism({ args: command.slice(1), env, cwd: process.cwd(), cores: usableCores(), slots: options.slots, look, roomBytes: await roomOf(env) });
        if (chosen !== undefined) {
            Object.assign(env, chosen.set);
            say("heavy", chosen.line);
        }
    }
    if (options.cpus !== undefined) {
        env.INTENTIC_CPUS = String(options.cpus);
    }
    const pinTo = options.pin && look !== undefined ? idlestCpus(look, options.cpus ?? Math.max(1, Math.round(look.count - look.busy))) : [];
    const taskset = pinTo.length === 0 ? undefined : located("taskset", env);
    if (taskset !== undefined) {
        command = [taskset, "-c", pinTo.join(","), ...command];
    }
    if (!options.quiet) {
        become(command, env);
        return;
    }
    const pinned = taskset === undefined ? "" : `, pinned to cores ${pinTo.join(",")}`;
    const verdict = calm?.judged ?? (calm === undefined ? "calm" : calmVerdict(calm, true));
    const said = verdict === "calm" ? "" : `${verdict}, `;
    const before = `${said}${look === undefined ? "" : `${busyWords(look, true)}, `}${loadWords()}${pinned}`;
    say("quiet", `starting: ${before}. New heavy commands in this sandbox wait until it ends.`);
    runReported(command, env, before);
};

if (require.main === module) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`[heavy] launch: ${error instanceof Error ? error.message : String(error)}\n`);
        const at = process.argv.indexOf("--");
        const argv = at === -1 ? [] : process.argv.slice(at + 1);
        if (argv.length === 0) {
            process.exit(127);
        }
        become([located(argv[0], process.env) ?? argv[0], ...argv.slice(1)], process.env);
    });
}

module.exports = { parseProcStat, busyBetween, outsideBusy, waitForIdle, calmVerdict, idlestCpus, cargoChosen, cargoJobs, cargoParallelism, parseArgs, CARGO_JOB_BYTES, STUCK_MS };
