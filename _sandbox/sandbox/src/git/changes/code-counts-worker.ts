import { parentPort, workerData } from "node:worker_threads";
import type { LineStat } from "@intentic/code-read";
import { type CountStore, keptLineStat } from "@intentic/code-read/count-cache";
import { grammars } from "@intentic/code-read/grammars";
import type { StatementSync } from "node:sqlite";
import { openSqlite } from "@intentic/base/sqlite";
import { serveCalls } from "@intentic/base/worker-calls";
import type { CodeCountAsk, CodeCountThread } from "./code-counts.js";

// Tokenizing both sides of a file with its TextMate grammar is the costly part of a code count (over a second for a
// large file); it runs on these threads, so a scan while files land holds a thread and never the daemon's loop. A count
// is kept on disk under what it was computed from, so a restart or a second checkout of the same content reads it.

const port = parentPort;
if (port === null) {
    throw new Error("the code count worker requires a parent port");
}

const { cachePath } = workerData as CodeCountThread;

// Counts held on disk, newest last; past this many rows the oldest go (a row is about 100 bytes).
const KEPT_ROWS = 500_000;

interface Store {
    readonly get: StatementSync;
    readonly put: StatementSync;
}

const openStore = (path: string): Store => {
    const db = openSqlite(path);
    // Null counts are a pair too far apart to diff, which is as final as a number.
    db.exec("CREATE TABLE IF NOT EXISTS counts (key TEXT NOT NULL UNIQUE, additions INTEGER, deletions INTEGER)");
    db.prepare("DELETE FROM counts WHERE rowid <= (SELECT max(rowid) FROM counts) - ?").run(KEPT_ROWS);
    return {
        get: db.prepare("SELECT additions, deletions FROM counts WHERE key = ?"),
        put: db.prepare("INSERT OR REPLACE INTO counts (key, additions, deletions) VALUES (?, ?, ?)"),
    };
};

const store = cachePath === undefined ? undefined : openStore(cachePath);
// The key, what it hashes and when a count is kept all live in code-read's `keptLineStat`, the path the perf scenarios
// measure too; this worker only lends it the table.
const counts: CountStore | undefined =
    store === undefined
        ? undefined
        : {
              get: (key) => store.get.get(key) as { additions: number | null; deletions: number | null } | undefined,
              put: (key, additions, deletions) => {
                  store.put.run(key, additions, deletions);
              },
          };

serveCalls<CodeCountAsk & { readonly id: number }>(port, (ask): Promise<LineStat | undefined> => keptLineStat(counts, ask.before, ask.after, ask.path, grammars));
