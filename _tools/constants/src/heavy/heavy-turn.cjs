// What a heavy program does as it starts, shared by the two ways one is caught: heavy-hook.cjs, loaded into every node
// program an agent's command starts, and heavy-exec.cjs, which the thin wrappers for native programs (pnpm, bun, cargo)
// run. Both know the program for a fact, and its arguments as it received them; heavy-rules.cjs says whether it is heavy.
//
// A heavy program is put in the toolchain class (its rank for the OOM killer, its CPU and IO priority) right away,
// whether or not anything queues it, then replaces itself with the same run behind queue-run (a slot, and memory first),
// or behind offload-run when the owner sends that kind of work to a runner. Everything it starts inherits both, and
// nothing below it is judged again: INTENTIC_HEAVY_HELD and queue-run's INTENTIC_QUEUE_SLOT say it is already covered.
//
// The daemon hands the table in INTENTIC_HEAVY, as JSON: { rules (heavy-rules.cjs mergeHeavyRules), queue, queueRun,
// offloadRun, offload: { <rule id>: <runner> }, klass: { oomScoreAdj, nice, lowIo } }. Every failure here is a program
// that runs as if nothing had looked at it.
"use strict";

const { spawnSync } = require("node:child_process");
const { accessSync, constants, readFileSync, writeFileSync } = require("node:fs");
const { getPriority, setPriority } = require("node:os");
const { matchInvocation, queueArgs } = require("./heavy-rules.cjs");

// The spec the daemon handed down, or undefined when this program is not under it or is already covered.
const pendingSpec = (env = process.env) => {
    const raw = env.INTENTIC_HEAVY;
    if (raw === undefined || raw === "" || env.INTENTIC_HEAVY_HELD !== undefined || env.INTENTIC_QUEUE_SLOT !== undefined) {
        return undefined;
    }
    return JSON.parse(raw);
};

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

/**
 * Judges one program as it starts. Returns false for one that is not heavy (or not under the daemon's table), true for
 * one that was classed and runs in place; a queued or offloaded one does not return.
 */
const takeTurn = ({ program, args, command, env = process.env }) => {
    const spec = pendingSpec(env);
    if (spec === undefined) {
        return false;
    }
    const match = matchInvocation([program, ...args].join(" "), spec.rules);
    if (match === undefined) {
        return false;
    }
    env.INTENTIC_HEAVY_HELD = match.id;
    applyClass(spec.klass);
    const queue = spec.queue === true && typeof spec.queueRun === "string" && runnable(spec.queueRun) ? [spec.queueRun, ...queueArgs(match, spec.rules), "--"] : [];
    const runner = spec.offload?.[match.id];
    if (runner !== undefined && typeof spec.offloadRun === "string") {
        const here = queue.length === 0 ? "" : `${queue.map(quote).join(" ")} `;
        become([spec.offloadRun, "--to", runner, "--label", match.id, "--here", here, "--", ...remoteArgv(program, args)], env);
    }
    if (queue.length > 0) {
        become([...queue, ...command], env);
    }
    return true;
};

module.exports = { takeTurn, pendingSpec, remoteArgv };
