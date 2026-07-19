import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type ActivityEvent, ActivityEventSchema } from "@intentic/sandbox-contract";

// The activity audit log (historyRoot/activity.jsonl): append-only JSONL, written by the daemon only.
// Living under historyRoot keeps it outside the agent's /work mount, so the agent can't read or rewrite its
// own trail — the same placement rationale as workspace history.

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
    // Strictly monotonic `at`: Date.now() is ms-resolution, and equal stamps break
    // newest-first ordering and the exclusive `before` cursor.
    let lastAt = 0;
    const read = async (): Promise<ActivityEvent[]> => {
        let raw: string;
        try {
            raw = await readFile(path, "utf8");
        } catch {
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
    return {
        append: (event) => {
            const step = queue.then(async () => {
                await mkdir(dirname(path), { recursive: true });
                lastAt = Math.max(Date.now(), lastAt + 1);
                const record: ActivityEvent = { id: randomUUID(), at: lastAt, ...event };
                await appendFile(path, `${JSON.stringify(record)}\n`);
                if ((await stat(path)).size <= MAX_BYTES) {
                    return;
                }
                // ponytail: whole-file prune on the write path — fine at a 5MB cap.
                const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");
                await writeFile(path, `${lines.slice(-KEEP_LINES).join("\n")}\n`);
            });
            // A failed step surfaces to ITS caller; the chain itself never poisons later appends.
            queue = step.catch(() => undefined);
            return step;
        },
        list: async (query) =>
            (await read())
                .filter(
                    (event) =>
                        (query.provider === undefined || event.provider === query.provider) &&
                        (query.before === undefined || event.at < query.before),
                )
                .toSorted((a, b) => b.at - a.at)
                .slice(0, query.limit),
    };
};
