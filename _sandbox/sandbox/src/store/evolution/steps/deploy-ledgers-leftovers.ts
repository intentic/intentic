import { join } from "node:path";
import { defineStep } from "../state-steps.js";

// What the deploy engine's runs kept, retired on 2026-11-17 with self-hosting: each infra apply's event log, and the
// per-run event files its checks streamed. Nothing reads either any more, so the step deletes both, and the emptied
// folder goes with its last file. Spelled here rather than through a document, since the daemon no longer keeps one
// there. Both sit on /history.
const APPLY_EVENTS = "apply-events.ndjson";
const CHECK_EVENTS = "check-events";

export const deployLedgersLeftoversStep = defineStep({
    id: "deploy-ledgers-leftovers",
    describe: "deletes what the retired deploy engine's runs kept: the apply event log and its checks' event files",
    plan: async ({ roots, kind, list }) => {
        const applyEvents = join(roots.history, APPLY_EVENTS);
        const checks = join(roots.history, CHECK_EVENTS);
        const checkFiles = (await kind(checks)) === "directory" ? (await list(checks)).map((name) => join(checks, name)) : [];
        const present = (await Promise.all([applyEvents, ...checkFiles].map(async (path) => ((await kind(path)) === "file" ? path : undefined)))).filter(
            (path): path is string => path !== undefined,
        );
        if (present.length === 0) {
            return undefined;
        }
        return {
            changes: [`deletes ${present.length} file(s) the retired deploy engine's runs left behind`],
            writes: new Map(present.map((path) => [path, undefined])),
        };
    },
});
