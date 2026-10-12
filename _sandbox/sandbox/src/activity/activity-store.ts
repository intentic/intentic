import { randomUUID } from "node:crypto";
import { type ActivityEvent, ActivityEventSchema } from "@intentic/sandbox-contract";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openLedger } from "../store/open-document.js";

// The activity audit log (historyRoot/activity.jsonl): append-only JSONL, written by the daemon only, kept outside the
// agent's /work mount so the agent can't read or rewrite its own trail. Being its only writer, the daemon reads it once
// and keeps it in step with its own appends; a list is then a filter, not a parse of every line.

// One event per line. A document so a change to an event's shape ships with its conversion and the shape check sees it;
// `boot: false` since it is JSON Lines, converted line by line on every read.
export const activityLogDocument = defineDocument({
    root: "history",
    path: "activity.jsonl",
    schema: ActivityEventSchema,
    granularity: "entries",
    boot: false,
});

// Pruned to the newest KEEP_LINES once the file passes MAX_BYTES: an audit trail may forget its oldest events.
const MAX_BYTES = 5_000_000;
const KEEP_LINES = 2_000;

export interface ActivityStore {
    // Fills id + at; the ledger serializes appends, so a prune never interleaves with one.
    readonly append: (event: Omit<ActivityEvent, "id" | "at">) => Promise<void>;
    // Newest first; `before` is an exclusive `at` cursor.
    readonly list: (query: { provider?: string | undefined; before?: number | undefined; limit: number }) => Promise<ActivityEvent[]>;
}

export const fileActivityStore = (path: string): ActivityStore => {
    // Strictly monotonic `at`; equal ms-resolution stamps would break newest-first order and the `before` cursor.
    let lastAt = 0;
    // Only an absent log is empty; a torn line (crash mid-append) loses one event, never the log.
    const ledger = openLedger(activityLogDocument, path, { cap: { overBytes: MAX_BYTES, keepLines: KEEP_LINES } });
    // The log as the file holds it, in append order; read on first use, then extended by each append.
    let held: Promise<ActivityEvent[]> | undefined;
    const log = (): Promise<ActivityEvent[]> => {
        held ??= ledger.read();
        return held;
    };
    return {
        append: async (event) => {
            // Read before the first append, so the held log never counts the line it is about to be extended by.
            const events = await log();
            lastAt = Math.max(Date.now(), lastAt + 1);
            const record: ActivityEvent = { id: randomUUID(), at: lastAt, ...event };
            const { pruned } = await ledger.append(record);
            events.push(record);
            if (pruned) {
                events.splice(0, Math.max(0, events.length - KEEP_LINES));
            }
            publishRuntimeChange("activity");
        },
        list: async (query) =>
            (await log())
                .filter(
                    (event) =>
                        (query.provider === undefined || event.provider === query.provider) &&
                        (query.before === undefined || event.at < query.before),
                )
                .toSorted((a, b) => b.at - a.at)
                .slice(0, query.limit),
    };
};
