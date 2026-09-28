import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defineStep } from "../state-steps.js";

// What the push checks kept, retired on 2026-09-28 when CI became the only check and the pre-push hook went: each push
// the hook measured, what it let through, and every project's failed push with the decisions about it. Nothing reads it
// any more, so the step deletes it. Spelled here rather than through state-paths.ts, which lists only what the daemon
// still keeps. It sits under the state dir.
const RECORD = ["records", "push-checks.json"] as const;

export const pushChecksLeftoversStep = defineStep({
    id: "push-checks-leftovers",
    describe: "deletes what the retired push checks kept: each push they measured and what it left",
    plan: async ({ roots, kind }) => {
        const record = join(roots.workspace, STATE_DIR, ...RECORD);
        if ((await kind(record)) !== "file") {
            return undefined;
        }
        return {
            changes: ["deletes the record the retired push checks left behind"],
            writes: new Map([[record, undefined]]),
        };
    },
});
