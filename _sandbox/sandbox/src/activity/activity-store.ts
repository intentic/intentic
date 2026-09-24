import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { type ActivityEvent, ActivityEventSchema } from "@intentic/sandbox-contract";
import { publishRuntimeChange } from "../seams/runtime-feed.js";

// The activity audit log (historyRoot/activity.jsonl): append-only JSONL, written by the daemon only, kept outside the
// agent's /work mount so the agent can't read or rewrite its own trail. Being its only writer, the daemon reads it once
// and keeps it in step with its own appends; a list is then a filter, not a parse of every line.

// Prune to the newest KEEP_LINES once the file passes MAX_BYTES.
const MAX_BYTES = 5_000_000;
const KEEP_LINES = 2_000;

export interface ActivityStore {
    // Fills id + at; writes are serialized so a prune never interleaves with an append.
    readonly append: (event: Omit<ActivityEvent, "id" | "at">) => Promise<void>;
    // Newest first; `before` is an exclusive `at` cursor.
    readonly list: (query: { provider?: string | undefined; before?: number | undefined; limit: number }) => Promise<ActivityEvent[]>;
}

export const fileActivityStore = (path: string): ActivityStore => {
    let queue: Promise<unknown> = Promise.resolve();
    // Strictly monotonic `at`; equal ms-resolution stamps would break newest-first order and the `before` cursor.
    let lastAt = 0;
    const read = async (): Promise<ActivityEvent[]> => {
        // Only an absent log is empty: one that cannot be read answers with the error, not with no events.
        const raw = await readFile(path, "utf8").catch(undefinedIfMissing);
        if (raw === undefined) {
            return [];
        }
        return raw
            .split("\n")
            .filter((line) => line !== "")
            .flatMap((line) => {
                try {
                    const parsed = ActivityEventSchema.safeParse(JSON.parse(line));
                    return parsed.success ? [parsed.data] : [];
                } catch {
                    // A torn line (crash mid-append) loses one event, never the log.
                    return [];
                }
            });
    };
    // The log as the file holds it, in append order; read on first use, then extended by each append.
    let held: Promise<ActivityEvent[]> | undefined;
    const log = (): Promise<ActivityEvent[]> => {
        held ??= read();
        return held;
    };
    return {
        append: (event) => {
            const step = queue.then(async () => {
                const events = await log();
                await mkdir(dirname(path), { recursive: true });
                lastAt = Math.max(Date.now(), lastAt + 1);
                const record: ActivityEvent = { id: randomUUID(), at: lastAt, ...event };
                await appendFile(path, `${JSON.stringify(record)}\n`);
                events.push(record);
                publishRuntimeChange("activity");
                if ((await stat(path)).size <= MAX_BYTES) {
                    return;
                }
                // Whole-file prune on the write path; fine at a 5MB cap.
                const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");
                await writeFile(path, `${lines.slice(-KEEP_LINES).join("\n")}\n`);
                events.splice(0, Math.max(0, events.length - KEEP_LINES));
            });
            // A failed step surfaces to its caller; the chain itself never poisons later appends.
            queue = step.catch(() => undefined);
            return step;
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
