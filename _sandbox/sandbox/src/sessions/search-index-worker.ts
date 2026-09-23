import { setImmediate as yieldTurn } from "node:timers/promises";
import { parentPort, workerData } from "node:worker_threads";
import { errorMessage } from "@intentic/base/errors";
import { post, type WorkerAnswer } from "../workers/worker-calls.js";
import type { SearchAsk, SearchIndexMetrics, SearchKind } from "./search-index.js";
import { openSearchStore } from "./search-store.js";
import type { SpokenLine } from "./transcript-search.js";

// The phrase index's own thread: every SQLite call runs here, so a slow query or a large write stalls this thread and
// never the daemon's. Writes run one at a time in arrival order; reads answer as they arrive, which during a long put
// means between its batches rather than behind the whole of it.

const port = parentPort;
if (port === null) {
    throw new Error("the search index worker requires a parent port");
}

const store = openSearchStore((workerData as { readonly dir: string }).dir);

// One put's lines per transaction, by count and by text: past either, a batch holds the thread long enough to keep a
// search waiting behind it.
const BATCH_LINES = 500;
const BATCH_CHARS = 256 * 1024;

const batches = function* (lines: readonly SpokenLine[]): Generator<readonly SpokenLine[]> {
    let batch: SpokenLine[] = [];
    let chars = 0;
    for (const line of lines) {
        batch.push(line);
        chars += line.text.length;
        if (batch.length >= BATCH_LINES || chars >= BATCH_CHARS) {
            yield batch;
            batch = [];
            chars = 0;
        }
    }
    if (batch.length > 0) {
        yield batch;
    }
};

// The source row goes first and is stamped last, so a put cut short leaves no version behind and the next backfill
// redoes it; a search in between sees the lines written so far.
const put = async (key: string, kind: SearchKind, version: string, lines: readonly SpokenLine[]): Promise<void> => {
    store.forget(key);
    for (const batch of batches(lines)) {
        store.add(key, kind, batch);
        await yieldTurn();
    }
    store.stamp(key, kind, version, lines.length);
};

type SearchRequest = SearchAsk & { readonly id: number };
type SearchAnswer = WorkerAnswer<SearchIndexMetrics>;

const reply = (message: SearchAnswer): void => post(port, message);

const answer = async (request: SearchRequest): Promise<SearchAnswer> => {
    try {
        switch (request.op) {
            case "search":
                return { id: request.id, ok: true, value: store.search(request.needle, request.kind, request.caseSensitive) };
            case "versions":
                return { id: request.id, ok: true, value: store.versions(request.kind) };
            case "put":
                await put(request.key, request.kind, request.version, request.lines);
                return { id: request.id, ok: true, news: store.metrics() };
            case "extend":
                store.extend(request.key, request.kind, request.version, request.lines);
                return { id: request.id, ok: true, news: store.metrics() };
            case "forget":
                store.forget(request.key);
                return { id: request.id, ok: true, news: store.metrics() };
            case "close":
                store.close();
                return { id: request.id, ok: true };
        }
    } catch (error) {
        return { id: request.id, ok: false, message: errorMessage(error) };
    }
};

// Writes queue behind each other; reads skip the queue.
let writes: Promise<void> = Promise.resolve();
port.on("message", (request: SearchRequest) => {
    if (request.op === "search" || request.op === "versions") {
        void answer(request).then(reply);
        return;
    }
    writes = writes.then(async () => reply(await answer(request)));
});

reply({ news: store.metrics() });
