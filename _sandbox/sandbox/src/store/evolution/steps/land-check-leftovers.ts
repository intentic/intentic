import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defineStep } from "../state-steps.js";

// What the check after every land kept, retired on 2026-09-27 when CI became the only check: its verdicts and failing
// streaks, and each run's log, exit status, report and verdict beside them. Nothing reads either any more, so the step
// deletes both, and the emptied folder goes with its last file. Spelled here rather than through state-paths.ts, which
// lists only what the daemon still keeps. Both sit under the state dir.
const VERDICTS = ["records", "verify.json"] as const;
const RUN_FILES = ["local", "verify"] as const;

export const landCheckLeftoversStep = defineStep({
    id: "land-check-leftovers",
    describe: "deletes what the retired check after landing kept: its verdicts and its runs' files",
    plan: async ({ roots, kind, list }) => {
        const state = join(roots.workspace, STATE_DIR);
        const verdicts = join(state, ...VERDICTS);
        const runs = join(state, ...RUN_FILES);
        const runFiles = (await kind(runs)) === "directory" ? (await list(runs)).map((name) => join(runs, name)) : [];
        const doomed = [verdicts, ...runFiles];
        const present = (await Promise.all(doomed.map(async (path) => ((await kind(path)) === "file" ? path : undefined)))).filter(
            (path): path is string => path !== undefined,
        );
        if (present.length === 0) {
            return undefined;
        }
        return {
            changes: [`deletes ${present.length} file(s) the retired check after landing left behind`],
            writes: new Map(present.map((path) => [path, undefined])),
        };
    },
});
