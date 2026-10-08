#!/usr/bin/env node
// THE SANDBOX'S SIDE OF THE SHARED CACHE: as an isolated turn ends, make sure the fleet's cache holds a typecheck
// result for each package the turn changed, so the push that carries the change finds CI's typecheck already done.
// `turn` in .intentic/checks.json runs it; by hand it is `node _tools/turbo-cache/warm.mjs [--budget <seconds>]`.
//
// It needs the `turbo-cache` connector card (whose variables the turn's own shell has, credential-gateway addresses
// and all) and stays out of the way without it. It never reports a finding: it exits 0 whatever happens, so it never
// adds noise to the turn, and says on stderr what it did. A type error is CI's to report, as it is today.
//
// In order, until the budget is spent:
//   1. Only when this checkout's install matches its lockfile: a stale node_modules would vouch for a hash that names a
//      newer lockfile than the one it typechecked against.
//   2. Send the results this worktree already has: an agent that ran `pnpm typecheck` left them in .turbo/cache.
//   3. Typecheck what is still missing, through turbo with the cache as its remote, which uploads each pass itself.
//   4. File each pass under the `--only` hash as well. CI's `quick` job typechecks with `--only`, which hashes the same
//      package differently (it leaves out the dependencies' hashes), so one run serves both quick and the verify groups.
//      The claim is the same one: this command passed on this package's inputs, in this tree.
// The server keeps log-only entries alone, and CI takes them only for hashes it attributes to output-less tasks
// (import.mjs), so nothing here can put a file into a build.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../constants/src/node.mjs";
import { git } from "../scripts/lib/git.mjs";
import { dryRunTasks, isOutputLess } from "./dry-run.mjs";
import { readEntry } from "./store.mjs";

// Seconds the whole warm may take: a turn's Stop waits on it (TURN_CHECK_CEILING_MS bounds it at 180).
export const DEFAULT_BUDGET_SECONDS = 90;
// Where a change is read as leaving the main line, as verify-turn.mjs asks it.
const MAIN_LINES = ["main", "origin/HEAD", "origin/main"];

/** The connector card's variables, whatever instance suffix they carry, or undefined when the card is not connected. */
export const cacheEnv = (env) => {
    for (const [key, url] of Object.entries(env)) {
        const suffix = /^TURBO_CACHE_URL(_[A-Z0-9_]+)?$/.exec(key)?.[1] ?? (key === "TURBO_CACHE_URL" ? "" : undefined);
        const token = suffix === undefined ? undefined : env[`TURBO_CACHE_TOKEN${suffix}`];
        if (url && token) {
            return { url: url.replace(/\/+$/, ""), token, team: env[`TURBO_CACHE_TEAM${suffix}`] || "intentic" };
        }
    }
    return undefined;
};

/** Whether node_modules was installed from this checkout's lockfile. pnpm keeps what it installed in
 *  node_modules/.pnpm/lock.yaml: the lockfile itself, less the leading document pnpm 12 keeps its own pin in. Anything
 *  else, including either file missing, reads as stale, which only means nothing is sent. */
export const installMatchesLockfile = (root) => {
    const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
    const wanted = read(join(root, "pnpm-lock.yaml"));
    const installed = read(join(root, "node_modules", ".pnpm", "lock.yaml"));
    if (wanted === undefined || installed === undefined || installed.length === 0) {
        return false;
    }
    const prefix = wanted.slice(0, wanted.length - installed.length);
    return wanted.endsWith(installed) && (prefix === "" || prefix.endsWith("\n"));
};

/** Where turbo keeps this checkout's local cache: TURBO_CACHE_DIR when set, else `.turbo/cache` in the main worktree,
 *  which turbo shares with every linked worktree (an agent's included). The main worktree is the git common directory's
 *  parent, `<repo>/.git` -> `<repo>`, as it is for this sandbox's bare-style common directory. */
export const localCacheDir = (root, env) => {
    if (env.TURBO_CACHE_DIR) {
        return isAbsolute(env.TURBO_CACHE_DIR) ? env.TURBO_CACHE_DIR : join(root, env.TURBO_CACHE_DIR);
    }
    const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")?.trim() ?? "";
    return common === "" ? join(root, ".turbo", "cache") : join(dirname(common), ".turbo", "cache");
};

// A list of task ids short enough to read in one line.
const named = (tasks) => {
    const ids = tasks.map((task) => task.taskId);
    return ids.length <= 4 ? ids.join(", ") : `${ids.slice(0, 3).join(", ")} and ${ids.length - 3} more`;
};

const baseOf = (root) => {
    for (const line of MAIN_LINES) {
        const base = git(root, "merge-base", "HEAD", line)?.trim() ?? "";
        if (base !== "") {
            return base;
        }
    }
    return undefined;
};

const upload = async (cache, hash, body, durationMs) => {
    const response = await fetch(`${cache.url}/v8/artifacts/${hash}?slug=${encodeURIComponent(cache.team)}`, {
        method: "PUT",
        body,
        headers: { authorization: `Bearer ${cache.token}`, "content-type": "application/octet-stream", "x-artifact-duration": String(durationMs) },
        signal: AbortSignal.timeout(20_000),
    });
    return response.ok ? undefined : `${response.status} ${(await response.text()).slice(0, 200)}`;
};

/** Which of `hashes` the cache holds, asked a few at a time. A hash it could not be asked about counts as not held,
 *  which at worst sends an entry the server then keeps as it was; how many went unasked, and why, is said once. */
const heldRemotely = async (cache, hashes) => {
    const held = new Set();
    const queue = [...new Set(hashes)];
    const unasked = { count: 0, first: undefined };
    const worker = async () => {
        for (let hash = queue.shift(); hash !== undefined; hash = queue.shift()) {
            const response = await fetch(`${cache.url}/v8/artifacts/${hash}?slug=${encodeURIComponent(cache.team)}`, {
                method: "HEAD",
                headers: { authorization: `Bearer ${cache.token}` },
                signal: AbortSignal.timeout(10_000),
            }).catch((error) => {
                unasked.count++;
                unasked.first ??= String(error?.message ?? error);
                return undefined;
            });
            if (response?.ok) {
                held.add(hash);
            }
        }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    if (unasked.count > 0) {
        process.stderr.write(`turbo-cache warm: ${unasked.count} cache lookup(s) failed, counted as not held: ${unasked.first}\n`);
    }
    return held;
};

const download = async (cache, hash) => {
    const response = await fetch(`${cache.url}/v8/artifacts/${hash}?slug=${encodeURIComponent(cache.team)}`, {
        headers: { authorization: `Bearer ${cache.token}` },
        signal: AbortSignal.timeout(20_000),
    });
    return response.ok ? { body: Buffer.from(await response.arrayBuffer()), durationMs: Number(response.headers.get("x-artifact-duration")) || 0 } : undefined;
};

// A command that may take no longer than `ms`: killed with its process group at the deadline, never throwing.
const runFor = (command, args, { cwd, env, ms }) =>
    new Promise((resolve) => {
        const child = spawn(command, args, { cwd, env, stdio: ["ignore", "ignore", "pipe"], detached: true });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr = `${stderr}${chunk}`.slice(-2000);
        });
        const timer = setTimeout(() => {
            try {
                process.kill(-child.pid, "SIGTERM");
            } catch {
                // allow(silent-catch): the group exited between the deadline and the kill.
            }
        }, Math.max(ms, 0));
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stderr });
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({ code: undefined, signal: undefined, stderr: String(error.message) });
        });
    });

// One warm's state, handed from step to step: the card, the change's filter, the two environments turbo runs in, where
// turbo keeps this checkout's local cache, the deadline, and what has been said so far.

// 2. What this checkout's turbo already computed. Turbo never sends a local hit to the remote by itself.
const sendLocal = async (run, pending) => {
    const sent = [];
    for (const task of pending) {
        const entry = readEntry(run.localDir, task.hash);
        if (entry === undefined) {
            continue;
        }
        const failed = await upload(run.cache, task.hash, entry.body, entry.durationMs);
        if (failed === undefined) {
            sent.push(task);
        } else {
            run.said.push(`could not send ${task.taskId}: ${failed}`);
        }
    }
    if (sent.length > 0) {
        run.said.push(`sent ${named(sent)} from the local cache`);
    }
    return sent;
};

// 3. What is still not in the shared cache, while the budget lasts. The declarations first, as `pnpm typecheck` emits
// them. Local reads are off: a local hit is replayed and never sent, so whatever step 2 could not send is run again.
const typecheckMissing = async (run, missing) => {
    const { root, env } = run;
    const emit = await runFor(process.execPath, [join(root, "_tools/scripts/build/emit-declarations.mjs")], { cwd: root, env, ms: run.deadline - run.now() });
    if (emit.code !== 0) {
        run.said.push(`could not emit declarations, so nothing was typechecked: ${emit.signal ?? emit.stderr.trim().split("\n").at(-1)}`);
        return;
    }
    const sizing = spawnSync(process.execPath, [join(root, "_tools/scripts/verify/test-workers.mjs"), "--typecheck-concurrency"], { cwd: root, encoding: "utf8" });
    const concurrency = sizing.stdout?.trim() || "2";
    const ran = await runFor(
        join(root, "node_modules/.bin/turbo"),
        ["run", "typecheck", run.filter, "--cache=local:w,remote:rw", "--output-logs=none", `--concurrency=${concurrency}`],
        { cwd: root, env: run.turboEnv, ms: run.deadline - run.now() },
    );
    run.said.push(
        ran.signal === null
            ? `typechecked ${named(missing)}; turbo exited ${ran.code}, and every pass was sent`
            : `stopped typechecking at the ${run.budgetSeconds}s budget; what finished was sent`,
    );
};

// 4. Each result under the `--only` hash quick asks for, from the entry the full hash now has. When the change selects
// every package a task depends on, the two hashes are the same one and there is nothing to file.
const fileTwins = async (run, tasks) => {
    const shared = await heldRemotely(run.cache, tasks.map((task) => task.hash));
    const twins = new Map(
        dryRunTasks(run.root, ["run", "typecheck", run.filter, "--only"], { env: run.planEnv })
            .filter(isOutputLess)
            .map((each) => [each.taskId, each]),
    );
    const pairs = tasks.flatMap((task) => {
        const twin = twins.get(task.taskId);
        return shared.has(task.hash) && twin !== undefined && twin.hash !== task.hash ? [{ task, twin }] : [];
    });
    const held = await heldRemotely(run.cache, pairs.map((pair) => pair.twin.hash));
    const filed = [];
    for (const pair of pairs.filter((each) => !held.has(each.twin.hash))) {
        if (run.now() > run.deadline) {
            break;
        }
        const entry = readEntry(run.localDir, pair.task.hash) ?? (await download(run.cache, pair.task.hash));
        const failed = entry === undefined ? "its entry could not be read back" : await upload(run.cache, pair.twin.hash, entry.body, entry.durationMs);
        if (failed === undefined) {
            filed.push(pair.task);
        } else {
            run.said.push(`could not file ${pair.task.taskId} for --only: ${failed}`);
        }
    }
    if (filed.length > 0) {
        run.said.push(`filed ${named(filed)} under quick's --only hashes too`);
    }
};

// Why this warm has nothing to do before it starts, or undefined when it has.
const standDown = (root, cache, base) => {
    if (cache === undefined) {
        return "no turbo-cache card is connected, so there is nowhere to send results";
    }
    if (!installMatchesLockfile(root)) {
        return "node_modules was not installed from this pnpm-lock.yaml, so no result from it is sent";
    }
    return base === undefined ? "no main line to measure the change against" : undefined;
};

/** One warm, start to end. Returns the lines it would say; never throws for anything the cache or turbo does. */
export const warm = async ({ root, env = process.env, budgetSeconds = DEFAULT_BUDGET_SECONDS, now = Date.now }) => {
    const deadline = now() + budgetSeconds * 1000;
    const cache = cacheEnv(env);
    const base = baseOf(root);
    const reason = standDown(root, cache, base);
    if (reason !== undefined) {
        return [reason];
    }
    // The plans are hashed without the remote: a hash never depends on it, and a dry run's `cache` field cannot say what
    // the remote holds anyway, since a local hit is reported without the remote being asked. The server is asked instead.
    const planEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !["TURBO_API", "TURBO_TOKEN", "TURBO_TEAM"].includes(key)));
    const filter = `--filter=[${base}]`;
    const tasks = dryRunTasks(root, ["run", "typecheck", filter], { env: planEnv }).filter(isOutputLess);
    if (tasks.length === 0) {
        return ["the change touches no package with a typecheck"];
    }
    const turboEnv = { ...planEnv, TURBO_API: cache.url, TURBO_TOKEN: cache.token, TURBO_TEAM: cache.team };
    delete turboEnv.TURBO_REMOTE_CACHE_READ_ONLY;
    const run = { root, env, cache, filter, planEnv, turboEnv, localDir: localCacheDir(root, env), deadline, now, budgetSeconds, said: [] };
    const shared = await heldRemotely(cache, tasks.map((task) => task.hash));
    const pending = tasks.filter((task) => !shared.has(task.hash));
    const sent = await sendLocal(run, pending);
    const missing = pending.filter((task) => !sent.includes(task));
    if (missing.length > 0) {
        await typecheckMissing(run, missing);
    }
    await fileTwins(run, tasks);
    return run.said.length === 0 ? ["every typecheck this change needs is already in the cache"] : run.said;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const argv = process.argv.slice(2);
    const budget = argv.includes("--budget") ? Number(argv[argv.indexOf("--budget") + 1]) : DEFAULT_BUDGET_SECONDS;
    try {
        for (const line of await warm({ root: repoRoot(import.meta.url), budgetSeconds: Number.isFinite(budget) ? budget : DEFAULT_BUDGET_SECONDS })) {
            process.stderr.write(`turbo-cache warm: ${line}\n`);
        }
    } catch (error) {
        // An optimisation that failed costs the turn this line and nothing else.
        process.stderr.write(`turbo-cache warm: skipped after an error: ${String(error?.message ?? error)}\n`);
    }
    process.exitCode = 0;
}
