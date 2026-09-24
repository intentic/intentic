import { parentPort, workerData } from "node:worker_threads";
import { serveCalls } from "../../workers/worker-calls.js";
import { putBlob } from "./record-blobs.js";
import { convertLegacy } from "./record-convert.js";
import type { ConvertAsk } from "./record-migration.js";

// One record's conversion off the daemon's loop: parsing, re-keeping and compressing the largest record here takes
// seconds, which on the daemon's own loop would freeze every terminal and stream for as long.

const port = parentPort;
if (port === null) {
    throw new Error("the record migration worker requires a parent port");
}

const { historyRoot } = workerData as { readonly historyRoot: string };

serveCalls<ConvertAsk & { readonly id: number }>(port, ({ conversationId, legacy, prepared }) =>
    convertLegacy({ historyRoot, conversationId, legacy, target: prepared, put: (text) => putBlob(historyRoot, text) }),
);
