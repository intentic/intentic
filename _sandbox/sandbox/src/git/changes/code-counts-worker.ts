import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { type CodeCount, codeLineStat, highlightLangFor, type LineStat } from "@intentic/code-read";
import { grammars } from "@intentic/code-read/grammars";
import type { StatementSync } from "node:sqlite";
import { openSqlite } from "../../store/sqlite.js";
import { serveCalls } from "../../workers/worker-calls.js";
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

// What a count depends on besides the two texts: code-read's reading of them (its own files) and the engine and
// grammars that tokenize (shiki, whose grammars ship at its own version). Either changing is a new key, so no count an
// older reading made is ever served; a hit loads no grammar at all.
const readingDigest = (): string => {
    const hash = createHash("sha256");
    const entry = fileURLToPath(import.meta.resolve("@intentic/code-read"));
    const codeRead = dirname(entry);
    for (const name of readdirSync(codeRead).toSorted()) {
        if (/\.(js|ts)$/.test(name) && !/\.(d|test)\.ts$/.test(name)) {
            hash.update(name).update("\0").update(readFileSync(join(codeRead, name)));
        }
    }
    // Shiki is code-read's dependency, not this package's, so it resolves from there.
    const shiki = createRequire(entry)("shiki/package.json") as { readonly version: string };
    return hash.update(shiki.version).digest("hex");
};

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
const reading = store === undefined ? "" : readingDigest();

const keyOf = (lang: string, before: string, after: string): string =>
    createHash("sha256").update(`${reading}\0${lang}\0${String(before.length)}\0`).update(before).update(after).digest("hex");

serveCalls<CodeCountAsk & { readonly id: number }>(port, async (ask): Promise<LineStat | undefined> => {
    // Resolved as codeLineStat resolves it; a path with no grammar is answered without tokenizing, so it is never kept.
    const lang = highlightLangFor(ask.path, Math.max(ask.before.length, ask.after.length), ask.after === "" ? ask.before : ask.after);
    const key = store === undefined || lang === undefined ? undefined : keyOf(lang, ask.before, ask.after);
    const kept = key === undefined ? undefined : (store?.get.get(key) as { additions: number | null; deletions: number | null } | undefined);
    if (kept !== undefined) {
        return kept.additions === null || kept.deletions === null ? undefined : { additions: kept.additions, deletions: kept.deletions };
    }
    // `codeLineStat` answers undefined when no grammar ships for the path, and a throw is treated the same way. Neither is
    // kept: a walk abandoned on a busy machine is not a property of the file.
    const count: CodeCount | undefined = await codeLineStat(ask.before, ask.after, ask.path, grammars).catch(() => undefined);
    if (count === undefined) {
        return undefined;
    }
    const stat = "stat" in count ? count.stat : undefined;
    if (key !== undefined) {
        store?.put.run(key, stat?.additions ?? null, stat?.deletions ?? null);
    }
    return stat;
});
