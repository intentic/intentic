import { parentPort, workerData } from "node:worker_threads";
import { serveCalls } from "@intentic/base/worker-calls";
import type { OcrAsk, OcrThread } from "./paddle-ocr.js";
import { loadOcrEngine, type OcrEngine } from "./paddle-ocr-engine.js";

// The thread the reader runs on (paddle-ocr.ts starts it): the models, and the seconds of arithmetic around them, held
// here so the process that asked keeps answering everything else while a photo is read.

const port = parentPort;
if (port === null) {
    throw new Error("the text reader's worker requires a parent port");
}

// SAFETY: paddle-ocr.ts is the only thing that starts this thread, and it always hands it an OcrThread.
const { dir } = workerData as OcrThread;
let engine: OcrEngine | undefined;

// A read loads the models too: a thread that died under a read is started afresh by the next one (worker-calls.ts).
serveCalls<OcrAsk & { readonly id: number }>(port, async (ask) => {
    if (ask.kind === "load") {
        engine ??= await loadOcrEngine(dir);
        return true;
    }
    if (ask.kind === "read") {
        engine ??= await loadOcrEngine(dir);
        return engine.read(ask.image);
    }
    await engine?.release();
    engine = undefined;
    return true;
});
