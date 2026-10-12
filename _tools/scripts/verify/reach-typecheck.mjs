// THE PACKAGES A CHANGE REACHES, TYPECHECKED: verify-turn.mjs's second half. The checks in _tools/checks read files, and
// what they cannot see is a break a change makes in a package it never opened: a procedure added to the contract that
// the demo's exhaustive table does not list (TS1360 in _site/demo/src/unserved.ts, main failing for eleven hours on
// 2026-10-11), a provider added to the daemon that a list in the editor does not name. The change's own packages are its
// author's to typecheck, and warm.mjs typechecks them as the same turn ends; this typechecks the packages that DEPEND on
// them, which nobody working on the change has a reason to open.
//
// CHARGED ONLY AGAINST A RECORD OF A CLEAN TYPECHECK BEFORE THE CHANGE. Turbo files a pass and never a failure, so an
// entry under a task's hash is a clean run on that hash's inputs. An untouched package's `--only` hash covers its own
// inputs alone, so the hash it has now is the hash it had at the base; the base's full-graph hash (a dry run in a
// snapshot of the base, check-snapshot.mjs) is the one CI's verify groups file for every package on every push to main.
// Both are asked of the fleet's cache, through the turbo-cache card (_tools/turbo-cache/README.md), and of this
// machine's: CI's records live only in the fleet's (on 2026-10-12 this sandbox's own cache held none of the 211 task
// hashes CI's verify-core run at 3eb6c6a2 gave), so without the card nothing is planned and the turn says why. A package
// with no record is not typechecked here at all: what it says could be main's own failure, and charging a change with
// main's breakage sends every conversation running at that moment after the same thing. So a failing main never reaches
// a turn through here; a package CI has not typechecked since it last changed is left to CI, which is the cost.
//
// BOUNDED, since a turn's Stop waits on it and the machine is shared: a deadline, the typecheck concurrency the root
// `typecheck` script sizes to free memory, and the nearest dependents first, the fast compilers before vue-tsc.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { affectedBy, GLOBAL, readWorkspaceGraph } from "../../checks/lib/workspace-graph.mjs";
import { dryRunTasks, isOutputLess, turboBin } from "../../turbo-cache/dry-run.mjs";
import { hasEntry } from "../../turbo-cache/store.mjs";
import { cacheEnv, heldRemotely, installMatchesLockfile, localCacheDir } from "../../turbo-cache/warm.mjs";
import { withSnapshot } from "./check-snapshot.mjs";
import { typecheckConcurrency } from "./test-workers.mjs";

// Seconds the typecheck of what a change reaches may take. A turn's Stop allows 180 for every check together
// (TURN_CHECK_CEILING_MS), verify-turn's own reading of the checks takes seconds, and warm.mjs comes after it.
export const REACH_BUDGET_SECONDS = 75;
// Error lines quoted per failing package: the first ones name the break, the rest are usually its echoes.
export const ERROR_LINES = 6;
// Names listed in a note before the rest are counted.
const NAMED = 4;

const listed = (names) => (names.length <= NAMED ? names.join(", ") : `${names.slice(0, NAMED).join(", ")} and ${names.length - NAMED} more`);

/**
 * The packages that depend on what `changed` touches, the change's own packages left out: nearest first (a direct
 * dependent of a touched package before one further up), then by name. A root file (the lockfile, turbo.json) is no
 * package's source, so it reaches nothing here; an asset-only package reaches no dependent (affectedBy's
 * `throughAssets: false`, the closure a typecheck needs).
 */
export const dependentsOf = (graph, changed) => {
    const { seeds, affected } = affectedBy(
        graph,
        changed.filter((path) => !GLOBAL.has(path)),
        { throughAssets: false },
    );
    const direct = new Set([...seeds].flatMap((seed) => [...(graph.dependents.get(seed) ?? [])]));
    return [...affected].filter((name) => !seeds.has(name)).sort((a, b) => Number(direct.has(b)) - Number(direct.has(a)) || a.localeCompare(b));
};

// The compilers that take minutes on the editor's packages rather than seconds: run after every fast one.
const SLOW = /\bvue-tsc\b/;

/** The order to typecheck them in: `names`' order (nearest first), each fast compiler's package before any slow one's. */
export const runOrder = (names, tasks) =>
    names.filter((name) => tasks.has(name)).sort((a, b) => Number(SLOW.test(tasks.get(a).command)) - Number(SLOW.test(tasks.get(b).command)));

// A path the compiler printed relative to its package, as the workspace names it, so the line opens where it points.
const FILE_AT = /^(\S+?\.(?:[cm]?tsx?|vue))(?=\(\d+,\d+\))/;

/** What a failing typecheck said, as the lines worth quoting: its first `error TS` lines with their paths made
 *  workspace-relative, or its last words when it printed none (a crash, a missing binary). */
export const errorLines = (output, dir) => {
    const lines = output.split("\n").map((line) => line.trimEnd());
    const errors = lines.filter((line) => /\berror TS\d+:/.test(line)).map((line) => line.trim().replace(FILE_AT, `${dir}/$1`));
    return errors.length > 0 ? errors.slice(0, ERROR_LINES) : lines.filter((line) => line.trim() !== "").slice(-3);
};

// The environment a hash is worked out in: without the remote, which a hash never depends on (warm.mjs plans the same way).
const planEnvOf = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !["TURBO_API", "TURBO_TOKEN", "TURBO_TEAM"].includes(key)));

const filtersFor = (names) => names.map((name) => `--filter=${name}`);

/** Each named package's typecheck as turbo plans it under `--only`, by package; a package with no typecheck script is
 *  absent. Throws with turbo's own words. */
export const plannedTasks = (root, names, env, timeoutMs) =>
    new Map(
        dryRunTasks(root, ["run", "typecheck", ...filtersFor(names), "--only"], { env: planEnvOf(env), timeoutMs })
            .filter(isOutputLess)
            .map((task) => [task.package, task]),
    );

/**
 * Which of `tasks` (by package) passed before the change: an entry under its `--only` hash in this machine's turbo
 * cache or the fleet's, or, with the fleet's card, under the full-graph hash the base gives it.
 */
export const passedBefore = async ({ root, base, tasks, env, timeoutMs }) => {
    const local = localCacheDir(root, env);
    const card = cacheEnv(env);
    const passed = new Set([...tasks].filter(([, task]) => hasEntry(local, task.hash)).map(([name]) => name));
    if (card === undefined) {
        return passed;
    }
    const pending = [...tasks].filter(([name]) => !passed.has(name));
    const remote = await heldRemotely(
        card,
        pending.map(([, task]) => task.hash),
    );
    for (const [name, task] of pending) {
        if (remote.has(task.hash)) {
            passed.add(name);
        }
    }
    const unknown = pending.filter(([name]) => !passed.has(name)).map(([name]) => name);
    if (unknown.length === 0) {
        return passed;
    }
    // CI's verify groups typecheck every package of their closure on every push to main, under full-graph hashes, so the
    // base's own hash is the record that exists most often. The snapshot needs no install: a dry run reads the lockfile.
    const atBase = withSnapshot(root, base, (snapshot) =>
        dryRunTasks(snapshot, ["run", "typecheck", ...filtersFor(unknown)], { env: planEnvOf(env), timeoutMs, bin: turboBin(root) }).filter(isOutputLess),
    );
    const baseHashes = new Map((atBase ?? []).filter((task) => unknown.includes(task.package)).map((task) => [task.package, task.hash]));
    const held = await heldRemotely(card, [...baseHashes.values()]);
    for (const [name, hash] of baseHashes) {
        if (held.has(hash) || hasEntry(local, hash)) {
            passed.add(name);
        }
    }
    return passed;
};

// How much of a typecheck's output is kept: its errors are at the start, and a crash says why at the end.
const KEPT_OUTPUT = 256 * 1024;

/** One package's own `typecheck` script, killed with its process group at `ms`; never throws. */
export const typecheckPackage = (root, task, ms, env) =>
    new Promise((resolve) => {
        const child = spawn("pnpm", ["run", "--silent", "typecheck"], { cwd: join(root, task.directory), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
        let output = "";
        const keep = (chunk) => {
            output = output.length < KEPT_OUTPUT ? `${output}${chunk}` : `${output.slice(0, KEPT_OUTPUT / 2)}${`${output}${chunk}`.slice(-KEPT_OUTPUT / 2)}`;
        };
        child.stdout.on("data", keep);
        child.stderr.on("data", keep);
        let late = false;
        const timer = setTimeout(
            () => {
                late = true;
                try {
                    process.kill(-child.pid, "SIGTERM");
                } catch {
                    // allow(silent-catch): the group exited between the deadline and the kill
                }
            },
            Math.max(ms, 0),
        );
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ status: late ? "stopped" : code === 0 ? "passed" : "failed", output });
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({ status: "failed", output: String(error.message) });
        });
    });

// Why the packages a change reaches cannot be planned here, or the plan: the tasks by package, the order to run the
// ones with a clean record in, and the ones without.
const planned = async ({ root, changed, graph, plan, passed, left, installed }) => {
    let dependents;
    try {
        dependents = dependentsOf(graph ?? readWorkspaceGraph(root), changed);
    } catch (error) {
        return { why: `the workspace graph could not be read (${String(error?.message ?? error)})` };
    }
    if (dependents.length === 0) {
        return { order: [], unrecorded: [] };
    }
    if (!installed()) {
        return { why: `node_modules is not installed from this pnpm-lock.yaml, for the ${dependents.length} that depend on it` };
    }
    let tasks;
    try {
        tasks = plan(dependents, left());
    } catch (error) {
        return { why: `turbo could not plan them (${String(error?.message ?? error).split("\n")[0]})` };
    }
    const known = await passed(tasks, left());
    const ordered = runOrder(dependents, tasks);
    return { tasks, order: ordered.filter((name) => known.has(name)), unrecorded: ordered.filter((name) => !known.has(name)) };
};

// Each package in `order` typechecked while time is left, `concurrency` at once; a package never started has no result.
const typecheckAll = async ({ order, tasks, typecheck, left, concurrency }) => {
    const results = new Map();
    const queue = [...order];
    const worker = async () => {
        for (let name = queue.shift(); name !== undefined && left() > 0; name = queue.shift()) {
            results.set(name, await typecheck(tasks.get(name), left()));
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    return results;
};

// What the results say, as verify-turn prints it.
const reported = ({ order, unrecorded, tasks, results }) => {
    const notes = [];
    const statusOf = (name) => results.get(name)?.status;
    if (unrecorded.length > 0) {
        notes.push(`${listed(unrecorded)}: no record of a clean typecheck before this change, so a failure there could be main's own; left to CI`);
    }
    const unread = order.filter((name) => statusOf(name) !== "passed" && statusOf(name) !== "failed");
    if (unread.length > 0) {
        notes.push(`stopped at the typecheck budget with ${listed(unread)} unread; CI typechecks them`);
    }
    const clean = order.filter((name) => statusOf(name) === "passed");
    if (clean.length > 0) {
        notes.push(`${clean.length} package(s) that depend on this change typecheck clean: ${listed(clean)}`);
    }
    const failed = order.filter((name) => statusOf(name) === "failed");
    if (failed.length === 0) {
        return { out: [], notes, code: 0 };
    }
    const out = failed.flatMap((name) => errorLines(results.get(name).output, tasks.get(name).directory).map((line) => `✗ typecheck ${name}: ${line}`));
    out.push(
        `verify-turn: ${failed.length} package(s) that depend on what this change edits typechecked clean before it and fail now. Re-run one: pnpm --filter ${failed[0]} typecheck`,
    );
    return { out, notes, code: 1 };
};

/**
 * What the change did to the packages that depend on it: `{ out, notes, code }` as verify-turn prints them, `out` one
 * line per error quoted and a closing line, exit 1 when a package that typechecked clean before the change fails now.
 * The steps are injectable so the judging can be pinned without turbo or a compiler: `plan(names, ms)` (the tasks, by
 * package), `passed(tasks, ms)` (the packages with a clean record before), `typecheck(task, ms)`, and the clock.
 */
export const reachTypecheck = async ({
    root,
    base,
    changed,
    deadline,
    env = process.env,
    now = Date.now,
    graph,
    concurrency,
    plan = (names, ms) => plannedTasks(root, names, env, ms),
    passed = (tasks, ms) => passedBefore({ root, base, tasks, env, timeoutMs: ms }),
    typecheck = (task, ms) => typecheckPackage(root, task, ms, env),
    // A typecheck against an install that is not this lockfile's can fail for the install's sake, which is nobody's change.
    installed = () => turboBin(root) !== undefined && installMatchesLockfile(root),
    fleet = cacheEnv(env),
}) => {
    const left = () => deadline - now();
    if (fleet === undefined) {
        return {
            out: [],
            notes: ["the packages that depend on this change were not typechecked: no turbo-cache card is connected, and CI's record of which typechecked clean before it lives only there"],
            code: 0,
        };
    }
    if (left() <= 0) {
        return { out: [], notes: ["the packages that depend on this change were not typechecked: the checks before them took the time there was"], code: 0 };
    }
    const { why, tasks, order, unrecorded } = await planned({ root, changed, graph, plan, passed, left, installed });
    if (why !== undefined) {
        return { out: [], notes: [`the packages that depend on this change were not typechecked: ${why}`], code: 0 };
    }
    const results = await typecheckAll({ order, tasks, typecheck, left, concurrency: concurrency ?? typecheckConcurrency() });
    return reported({ order, unrecorded, tasks, results });
};
