/* ONE RUN SAYS EVERYTHING THAT IS WRONG, at the level of the STEPS a gate is made of, which is the one level
 * where this repository was still saying one thing at a time.
 *
 * The pieces underneath already collect. `_tools/checks/run.mjs` runs every manifest check side by side and
 * prints all of their findings; `lib/report.mjs` makes each check report before it exits; oxlint reads the repo
 * in one pass; turbo continues into every task whose own dependencies are still green, and verify.yml says in
 * as many words why: "turbo otherwise stops at the first failing task, so a red pipeline reports one broken
 * package and the next push finds the next one." Then the scripts that ORCHESTRATE those pieces threw it away.
 * Their `step()` helper called `process.exit` on the first non-zero status, so a turn that broke the checkout
 * gates and a test learned about the gates, fixed them, ran again, and only then learned about the test.
 *
 * WHAT THAT COSTS IS NOT THE SECOND RUN, it is that there may not be one. The turn-ending check gets
 * MAX_FOLLOW_UPS = 2 (sandbox/src/rules/turn-ending.ts): the model is sent back at most twice, and the third
 * Stop is silent whatever the tree says. A fail-fast gate therefore surfaces at most two independent failure
 * classes per turn, each costing a full re-run, and a turn that broke three is a turn that cannot pass. Over
 * the six days before this was written the rule labelled "Verify before you finish" sent turns back 146 times
 * and hit that ceiling, holding finished work on its branch, 28 times.
 *
 * SO THE RULE HERE IS: a step that can still say something TRUE gets to run. Two things bound that.
 *
 *   A REAL DEPENDENCY IS STILL A DEPENDENCY. `typecheck` reads the declarations `emit-declarations.mjs` writes,
 *   so running it after a failed emit reports missing modules rather than anything about the tree — noise that
 *   is worse than silence, because it names files that are correct. Those steps are SKIPPED, and the digest
 *   says they were skipped and why, so nothing reads as measured that was not. Independence is declared by the
 *   caller, at the call site, because it is a fact about the commands and not about this file.
 *
 *   A CHEAP READER THAT ALREADY SAID NO CAN STILL REFUSE. The push gate's two cheap tiers exist so a push that
 *   is wrong in a way readable from the checkout is refused in a second rather than in ten minutes
 *   (verify-push.mjs's header). Collecting WITHIN a tier is free; running the ten-minute suite anyway would
 *   spend the wait this repository deliberately bought back. So that script collects inside each tier and still
 *   stops between them, which is a different question from the one this file answers and stays its own.
 *
 * AND THE DIGEST IS THE HALF THAT MAKES IT WORTH DOING. What rides back to the model is the TAIL of the output:
 * 4000 bytes, `COMMAND_OUTPUT_BYTES` in turn-ending.ts. Collect-all without a summary at the end is therefore
 * WORSE than fail-fast — the tail becomes the last step's output and every earlier failure scrolls off the top,
 * so the model is told about one failure out of three and cannot see that it was told about one out of three.
 * `finish` prints a compact block naming every failed step, every skipped one, and a runnable spelling of each,
 * last, where the tail cannot lose it. */
import { spawnSync } from "node:child_process";

/* A step's command as a line somebody can paste. `process.execPath` is an absolute path to the node binary and
 * the root prefix is noise in a message printed from that root, so both are shortened: the point of the digest
 * is that each line can be run on its own, and a line nobody will retype is not that. */
const spell = (command, args, root) => {
    const head = command === process.execPath ? "node" : command;
    const rest = args.map((arg) => (root !== undefined && arg.startsWith(`${root}/`) ? arg.slice(root.length + 1) : arg));
    return [head, ...rest].join(" ");
};

/* The runner for one gate's steps. `name` prefixes every line this prints, the way each script already prefixed
 * its own; `root` is what the commands run in and what the digest's spellings are relative to. */
export const createSteps = (name, root) => {
    const say = (line) => console.error(`${name}: ${line}`);
    const results = [];
    const started = Date.now();

    /* Run one step. Returns whether it passed, which is what a caller gates a dependent step on. It never
     * exits: the whole point is that the next independent step still gets to speak.
     *
     * A command that could NOT START is recorded as a failure and not as an absence. The gate has learned
     * nothing about the tree either way, and a runner that quietly treated "no such binary" as "nothing to
     * report" would pass a tree it never read. */
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

    /* A step that was not run because something it genuinely reads had already failed. Recorded rather than
     * dropped, so the digest can say the tree is UNMEASURED there — the reading a turn has to have before it
     * decides it is finished. */
    const skip = (label, why) => {
        results.push({ label, status: "skipped", why });
    };

    /* A failure the gate found by READING rather than by spawning: the push gate's manifest/lockfile lockstep
     * refuses a tree without running anything. It belongs in the same digest as the rest — a run that refuses
     * for two reasons has to say both — and it has no command to spell, so the digest prints its sentence. */
    const fail = (label, why) => {
        say(`${label} failed`);
        results.push({ label, status: "failed", why });
    };


    /* Every step's verdict, once, at the end. Exits 1 if anything failed, after printing the block described in
     * this file's header.
     *
     * `summarize` is a FUNCTION and it runs only on a clean tree: what a caller does on the way to saying
     * "passed" — recording a verdict against the tree it just measured — must not happen on a run that failed,
     * and taking the line as a ready-made string would have meant every caller writing that condition itself.
     *
     * The failed steps come first inside the block and the skipped ones after, because a skipped step is a
     * consequence of a failed one and reads as noise above its cause. */
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
