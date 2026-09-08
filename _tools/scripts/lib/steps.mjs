// Runs every independent step of a gate rather than stopping at the first failure, since a turn gets a bounded number
// of follow-ups and fail-fast can cost it more than one. A step depending on a failed one is skipped, not run against a
// broken tree; `finish` prints every failure and skip in one block, where a truncated output tail can't lose it.
import { spawnSync } from "node:child_process";

// A step's command as a pasteable line: `process.execPath` shown as `node`, and paths under `root` shortened to
// relative.
const spell = (command, args, root) => {
    const head = command === process.execPath ? "node" : command;
    const rest = args.map((arg) => (root !== undefined && arg.startsWith(`${root}/`) ? arg.slice(root.length + 1) : arg));
    return [head, ...rest].join(" ");
};

// Runner for one gate's steps; `name` prefixes every printed line, `root` is the commands' cwd and the digest's path
// base.
export const createSteps = (name, root) => {
    const say = (line) => console.error(`${name}: ${line}`);
    const results = [];
    const started = Date.now();

    // Runs one step; returns pass/fail and never exits, so an independent step still runs. A command that can't start
    // is recorded as a failure, not silently skipped.
    const step = (label, command, args, { env = {} } = {}) => {
        say(`${label} …`);
        const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
        const spelling = spell(command, args, root);
        if (result.error !== undefined) {
            say(`${label}: ${result.error.message}`);
            results.push({ label, spelling, status: "failed", why: result.error.message });
            return false;
        }
        if (result.status !== 0) {
            say(`${label} failed`);
            results.push({ label, spelling, status: "failed", why: `exit ${result.status ?? "signal"}` });
            return false;
        }
        results.push({ label, spelling, status: "passed" });
        return true;
    };

    // Records a step skipped because a real dependency already failed, so the digest can say that part of the tree is
    // unmeasured.
    const skip = (label, why) => {
        results.push({ label, status: "skipped", why });
    };

    // Records a failure found by reading rather than spawning (no command to spell); goes in the same digest as the
    // rest.
    const fail = (label, why) => {
        say(`${label} failed`);
        results.push({ label, status: "failed", why });
    };


    // Prints every step's verdict once at the end and exits 1 if anything failed. `summarize` runs only on a clean
    // tree, so recording a passing verdict is not a caller's side effect on a failed run; failed steps print before
    // skipped ones.
    const finish = (summarize) => {
        const failed = results.filter((result) => result.status === "failed");
        const skipped = results.filter((result) => result.status === "skipped");
        const seconds = Math.round((Date.now() - started) / 1000);
        if (failed.length === 0) {
            say(`passed in ${seconds}s: ${summarize()}`);
            return;
        }
        const width = Math.max(...[...failed, ...skipped].map(({ label }) => label.length));
        console.error("");
        say(`${failed.length} of ${results.length} steps failed in ${seconds}s: ${failed.map(({ label }) => label).join(", ")}`);
        for (const { label, spelling, why } of failed) {
            console.error(`  ✗ ${label.padEnd(width)}  ${spelling === undefined ? why : `${why} · ${spelling}`}`);
        }
        for (const { label, why } of skipped) {
            console.error(`  – ${label.padEnd(width)}  not run: ${why}`);
        }
        console.error("");
        say(
            skipped.length > 0
                ? "every step that could still say something about this tree ran; fix these together, and the skipped ones are unmeasured until they do"
                : "every step ran; fix these together rather than one per run",
        );
        process.exit(1);
    };

    return { say, step, skip, fail, finish };
};
