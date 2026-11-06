// AN ANSWER KEPT ACROSS RUNS, for work that is a pure function of what it reads and is asked again after every edit with
// the same inputs: the per-edit linter's verdict on a file as HEAD holds it, vue-i18n's verdict on a catalog. Kept by a
// hash of every input, so a changed input is a new answer rather than a stale one, in the temporary directory, one small
// JSON file per answer.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEPT = join(tmpdir(), `intentic-kept-${process.getuid?.() ?? `user`}`);
// Past this many answers, those nobody read for a day go.
const KEPT_MOST = 2_000;
const DAY_MS = 86_400_000;

const prune = () => {
    const kept = readdirSync(KEPT);
    if (kept.length <= KEPT_MOST) {
        return;
    }
    for (const name of kept) {
        const path = join(KEPT, name);
        if (Date.now() - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > DAY_MS) {
            rmSync(path, { force: true });
        }
    }
};

/**
 * `compute()`'s answer for `inputs` (strings or buffers, every one the answer depends on), from an earlier run when one
 * kept it. An undefined answer (could not tell) is never kept.
 */
export const keptAnswer = (name, inputs, compute) => {
    const hash = createHash(`sha256`).update(name);
    for (const input of inputs) {
        hash.update(`\0${input.length}\0`).update(input);
    }
    const path = join(KEPT, `${name}-${hash.digest(`hex`)}.json`);
    try {
        const answer = JSON.parse(readFileSync(path, `utf8`));
        // Reading an answer is what keeps it past the pruning.
        const now = new Date();
        utimesSync(path, now, now);
        return answer;
    } catch {
        // allow(silent-catch): nothing kept, or a file that is not an answer: either way it is computed again
    }
    const answer = compute();
    if (answer !== undefined) {
        try {
            mkdirSync(KEPT, { recursive: true, mode: 0o700 });
            const scratch = `${path}.${process.pid}.tmp`;
            writeFileSync(scratch, JSON.stringify(answer));
            renameSync(scratch, path);
            prune();
        } catch {
            // allow(silent-catch): an answer that cannot be kept is computed again next time, which is all keeping saves
        }
    }
    return answer;
};
