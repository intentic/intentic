// Runs every independent step of a gate rather than stopping at the first failure, since a turn gets a bounded number
// of follow-ups and fail-fast can cost it more than one. A step depending on a failed one is skipped, not run against a
// broken tree; `finish` prints every failure and skip in one block, where a truncated output tail can't lose it.
import { spawnSync } from "node:child_process";

// Bytes of failure lines the digest prints across every failed step, so the digest fits the ~4,000-byte tail a Stop quotes.
const DETAIL_BYTES = 2_600;
// One failure line's ceiling, so a single long message cannot spend the whole budget.
const LINE_BYTES = 240;

const clip = (line) => (line.length > LINE_BYTES ? `${line.slice(0, LINE_BYTES - 1)}…` : line);

// `lines` cut to about `budget` bytes, what was cut counted on a closing line.
const within = (lines, budget) => {
    const kept = [];
    let used = 0;
    for (const [index, line] of lines.entries()) {
        const next = clip(line);
        used += next.length + 7;
        if (used > budget) {
            kept.push(`…and ${lines.length - index} more`);
            break;
        }
        kept.push(next);
    }
    return kept;
};

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
    // `judge` reads a non-zero exit before it is recorded: `{ ok: true, note }` clears it, `{ ok: false, why }` names it,
    // `spelling` replaces the command the digest shows and `details` are the failure lines it prints under it.
    // `shown` stands in for the spelled command where the real one is too long to be worth a line of the digest.
    const step = (label, command, args, { env = {}, judge, shown } = {}) => {
        say(`${label} …`);
        const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
        const spelling = shown ?? spell(command, args, root);
        if (result.error !== undefined) {
            say(`${label}: ${result.error.message}`);
            results.push({ label, spelling, status: "failed", why: result.error.message });
            return false;
        }
        return settle(label, spelling, result.status === 0 ? { ok: true } : (judge?.() ?? { ok: false }), result.status);
    };

    // Records a spawned step's verdict; a failure without a reason is named by its exit.
    const settle = (label, spelling, verdict, status) => {
        if (verdict.ok) {
            if (verdict.note !== undefined) {
                say(`${label}: ${verdict.note}`);
            }
            results.push({ label, spelling, status: "passed" });
            return true;
        }
        say(`${label} failed`);
        results.push({ label, spelling: verdict.spelling ?? spelling, status: "failed", why: verdict.why ?? `exit ${status ?? "signal"}`, details: verdict.details ?? [] });
        return false;
    };

    // Whether any step so far failed.
    const failing = () => results.some((result) => result.status === "failed");

    // Records a step skipped because a real dependency already failed, so the digest can say that part of the tree is
    // unmeasured.
    const skip = (label, why) => {
        results.push({ label, status: "skipped", why });
    };

    // Records a failure found by reading rather than spawning (no command to spell); goes in the same digest as the
    // rest.
    const fail = (label, why, details = []) => {
        say(`${label} failed`);
        results.push({ label, status: "failed", why, details });
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
        // An even share per step with details, what one leaves unspent passing to the next.
        let left = DETAIL_BYTES;
        let sharing = failed.filter(({ details = [] }) => details.length > 0).length;
        for (const { label, spelling, why, details = [] } of failed) {
            console.error(`  ✗ ${label.padEnd(width)}  ${spelling === undefined ? why : `${why} · ${spelling}`}`);
            if (details.length === 0) {
                continue;
            }
            const shown = within(details, Math.floor(left / sharing));
            for (const line of shown) {
                console.error(`      ${line}`);
            }
            left -= shown.reduce((sum, line) => sum + line.length + 7, 0);
            sharing -= 1;
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

    return { say, step, skip, fail, failing, finish };
};
