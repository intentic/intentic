// What a heavy program does as it starts, shared by the two ways one is caught: heavy-hook.cjs, loaded into every node
// program an agent's command starts, and heavy-exec.cjs, which the thin wrappers for native programs (pnpm, bun, cargo)
// run. Both know the program for a fact, and its arguments as it received them; heavy-rules.cjs says whether it is heavy.
//
// A heavy program is put in the toolchain class (its rank for the OOM killer, its CPU and IO priority) right away,
// whether or not anything queues it, then replaces itself with the same run behind queue-run (a slot, and memory first),
// or behind offload-run when the owner sends that kind of work to a runner. Everything it starts inherits both, and
// nothing below it is judged again (INTENTIC_HEAVY_HELD and queue-run's INTENTIC_QUEUE_SLOT say it is already covered)
// except by a `nests` rule while every pool held above is one no `nests` rule names (heavy-rules.cjs judgedUnder): the
// editor's `vue-tsc` takes its own lane even under a `pnpm -r typecheck` that holds a heavy slot.
//
// The daemon hands the table in INTENTIC_HEAVY, as JSON: { rules (heavy-rules.cjs mergeHeavyRules), queue, queueRun,
// offloadRun, offload: { <rule id>: <runner> }, klass: { oomScoreAdj, nice, lowIo } }. Every failure here is a program
// that runs as if nothing had looked at it. A match that needs more than a slot (cargo's jobs, a declared class's cores,
// the quiet lane) runs through heavy-launch.cjs, after queue-run has let it in.
"use strict";

const { spawnSync } = require("node:child_process");
const { accessSync, constants, readFileSync, writeFileSync } = require("node:fs");
const { getPriority, setPriority } = require("node:os");
const { isAbsolute, join, resolve } = require("node:path");
const { heldPoolsOf, matchInvocation, queueArgs, ruleById, sizeArgs } = require("./heavy-rules.cjs");

// What a match needing more than a slot is started through, after queue-run's `--` (heavy-launch.cjs).
const LAUNCH = join(__dirname, "heavy-launch.cjs");

// The spec the daemon handed down, or undefined when this program is not under it.
const handedSpec = (env) => {
    const raw = env.INTENTIC_HEAVY;
    return raw === undefined || raw === "" ? undefined : JSON.parse(raw);
};

// The spec the daemon handed down, or undefined when this program is not under it or is already covered.
const pendingSpec = (env = process.env) =>
    env.INTENTIC_HEAVY_HELD !== undefined || env.INTENTIC_QUEUE_SLOT !== undefined ? undefined : handedSpec(env);

// The class applied to this very process, raised only: descendants inherit all three at fork.
const applyClass = (klass) => {
    if (klass === undefined || process.platform !== "linux") {
        return;
    }
    try {
        const current = Number(readFileSync("/proc/self/oom_score_adj", "utf8").trim());
        if (Number.isFinite(current) && current < klass.oomScoreAdj) {
            writeFileSync("/proc/self/oom_score_adj", String(klass.oomScoreAdj));
        }
    } catch {
        // allow(silent-catch): procfs hidden by a hardened runtime; the kernel then weighs size alone
    }
    try {
        if (getPriority() < klass.nice) {
            setPriority(klass.nice);
        }
    } catch {
        // allow(silent-catch): a priority this process may not set leaves it where it was
    }
    if (klass.lowIo) {
        spawnSync("ionice", ["-c", "2", "-n", "7", "-p", String(process.pid)], { stdio: "ignore" });
    }
};

// POSIX single-quoting, as offload-run's --here prefix is read by a shell.
const quote = (word) => (/^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

// Programs every runner has on its PATH; anything else is a project's own, run there from its node_modules.
const ON_EVERY_PATH = new Set(["node", "npm", "npx", "pnpm", "yarn", "bun", "cargo"]);
const remoteArgv = (program, args) => (ON_EVERY_PATH.has(program) ? [program, ...args] : ["npx", "--no-install", program, ...args]);

// Whether `path` can be exec'd; checked first because a failed execve aborts the process rather than throwing.
const runnable = (path) => {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        // allow(silent-catch): absent or not executable is exactly "cannot run it"
        return false;
    }
};

// This process becomes `argv`: the same pid, so the class and every signal aimed at it still land. A Node too old to
// replace itself runs it as a child and leaves with its code, the way heavy-slot.mjs does. Returns only when `argv[0]`
// cannot be run at all, for the caller to run the program in place.
const become = (argv, env) => {
    if (!runnable(argv[0])) {
        return;
    }
    if (typeof process.execve === "function") {
        process.execve(argv[0], argv, env);
    }
    const run = spawnSync(argv[0], argv.slice(1), { stdio: "inherit", env });
    process.exit(run.status ?? (run.signal === null ? 1 : 128));
};

// The program's arguments that may name a file, as absolute paths against its working directory, and the script node
// was asked to run: what a declared class's `scripts` are matched against (heavy-rules.cjs scriptHit). A flag, a word
// with whitespace (an inline `-c` script) or an empty one names no file.
const pathsOf = (args, cwd, script) =>
    [...(script === undefined ? [] : [script]), ...args]
        .filter((arg) => arg !== "" && !arg.startsWith("-") && !/\s/u.test(arg))
        .map((arg) => (isAbsolute(arg) ? arg : resolve(cwd, arg)));

// heavy-launch.cjs's flags for a match that needs more than a slot; empty for one that does not.
const launchFlags = (match) => {
    const flags = [
        ...(match.parallel === undefined ? [] : ["--parallel", match.parallel, "--slots", String(match.limit)]),
        ...(match.cpus === undefined ? [] : ["--cpus", String(match.cpus)]),
        ...(match.pin === true ? ["--pin"] : []),
        ...(match.quiet === true ? ["--quiet"] : []),
    ];
    return flags.length === 0 ? [] : [process.execPath, LAUNCH, ...flags, "--label", match.id, "--"];
};

// The one line a project's declared class is announced with as it queues, so whoever ran it sees the project's rule
// taking effect and needs no lock or `nice` of their own.
const declaredWords = (match, rule) => {
    const mib = /^(\d+)m$/u.exec(match.size ?? "")?.[1];
    const how = [
        match.limit === 1 ? "one at a time" : `up to ${match.limit} at once`,
        match.pool === match.id ? undefined : `with the rest of group "${match.pool}"`,
        match.exclusive === true ? "with nothing else heavy beside it" : undefined,
        match.quiet === true ? "once the machine is calm" : undefined,
        match.cpus === undefined ? undefined : `on ${match.cpus} cores`,
        mib === undefined ? undefined : `priced at ${(Number(mib) / 1024).toFixed(1)} GiB`,
    ].filter((part) => part !== undefined);
    return `[heavy] ${match.id}: a heavy command this project declares (.intentic/heavy.json${rule.scripts === undefined ? "" : `, ${rule.scripts.join(", ")}`}); it runs through this sandbox's queue, ${how.join(", ")}.\n`;
};

/**
 * Judges one program as it starts. Returns false for one that is not heavy (or not under the daemon's table), true for
 * one that was classed and runs in place; a queued or offloaded one does not return. `script` is the file node was asked
 * to run, for a node program; `unless` passes over a match its caller already covered (a `cargo run`'s prebuild).
 */
const takeTurn = ({ program, args, command, env = process.env, cwd = process.cwd(), script, unless }) => {
    const spec = handedSpec(env);
    if (spec === undefined) {
        return false;
    }
    const invocation = [program, ...args].join(" ");
    const match = matchInvocation(invocation, spec.rules, undefined, { cwd, paths: pathsOf(args, cwd, script), heldPools: heldPoolsOf(env, spec.rules) });
    if (match === undefined || unless?.(match) === true) {
        return false;
    }
    env.INTENTIC_HEAVY_HELD = match.id;
    applyClass(spec.klass);
    // A quiet one waits for a calm machine before the gate, holding nothing (queue-run --calm-launcher).
    const calmFirst = match.quiet === true ? ["--calm-launcher", LAUNCH] : [];
    const queue = spec.queue === true && typeof spec.queueRun === "string" && runnable(spec.queueRun) ? [spec.queueRun, ...queueArgs(match, spec.rules), ...sizeArgs(match, invocation), ...calmFirst, "--"] : [];
    const launch = queue.length === 0 ? [] : launchFlags(match);
    // INTENTIC_OFFLOAD=0 keeps one command here, behind this sandbox's queue, when the owner sends its kind to a runner:
    // what offload-run names when it says where a command went (never INTENTIC_HEAVY_HELD, which skips the queue too).
    const runner = env.INTENTIC_OFFLOAD === "0" ? undefined : spec.offload?.[match.id];
    if (runner !== undefined && typeof spec.offloadRun === "string") {
        const here = queue.length === 0 ? "" : `${[...queue, ...launch].map(quote).join(" ")} `;
        become([spec.offloadRun, "--to", runner, "--label", match.id, "--here", here, "--", ...remoteArgv(program, args)], env);
    }
    if (queue.length > 0) {
        const rule = ruleById(spec.rules, match.id);
        if (rule?.declared === true) {
            process.stderr.write(declaredWords(match, rule));
        }
        become([...queue, ...launch, ...command], env);
    }
    return true;
};

module.exports = { takeTurn, pendingSpec, remoteArgv, pathsOf };
