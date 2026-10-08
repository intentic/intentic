// Turbo's own answer to "which task is this hash", from `turbo run <args> --dry=json`: the hash, where its log goes,
// and its resolved definition. Both sides of the cache ask it. CI's import uses it to take only entries whose hash CI
// itself gives to an output-less task, and the sandbox's warmer uses it to know which entries to send.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The tasks a package has no script for: in the graph, never run, never cached.
const NO_SCRIPT = "<NONEXISTENT>";

/** The workspace's own turbo, or undefined before an install. */
export const turboBin = (root) => {
    const bin = join(root, "node_modules", ".bin", "turbo");
    return existsSync(bin) ? bin : undefined;
};

/** The tasks `turbo run <args>` would run, from a dry run in `root` under `env`. Throws with turbo's own words. `bin`
 *  overrides which turbo, for a checkout that has none of its own (a test's fixture). */
export const dryRunTasks = (root, args, { env = process.env, timeoutMs = 180_000, bin = turboBin(root) } = {}) => {
    if (bin === undefined) {
        throw new Error("turbo is not installed in this checkout");
    }
    const ran = spawnSync(bin, [...args, "--dry=json"], { cwd: root, env, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: timeoutMs });
    if (ran.status !== 0) {
        const said = `${ran.stderr ?? ""}${ran.error?.message ?? ""}`.trim().split("\n").slice(-5).join("\n");
        throw new Error(`turbo ${args.join(" ")} --dry=json exited ${ran.status ?? ran.signal}: ${said}`);
    }
    return JSON.parse(ran.stdout).tasks;
};

/** Whether a task's cache entry can only ever hold its log: cached, run, and declaring no outputs. */
export const isOutputLess = (task) => {
    const definition = task.resolvedTaskDefinition ?? {};
    return definition.cache === true && Array.isArray(definition.outputs) && definition.outputs.length === 0 && task.command !== NO_SCRIPT;
};
