import { createRecognizers, type RecognizerSpec } from "./speech-recognizers.js";

// The speech process: forked by speech-engine.ts, it holds the models in memory and hears one phrase at a time, asked
// over IPC with structured-clone serialization so a phrase's samples cross as a Float32Array rather than JSON.

export type WorkerAsk =
    | { readonly id: number; readonly kind: "load"; readonly spec: RecognizerSpec }
    | { readonly id: number; readonly kind: "decode"; readonly spec: RecognizerSpec; readonly samples: Float32Array };

export type WorkerAnswer =
    { readonly id: number; readonly ok: true; readonly text: string } | { readonly id: number; readonly ok: false; readonly message: string };

const recognizers = createRecognizers();

process.on("message", (ask: WorkerAsk) => {
    let answer: WorkerAnswer;
    try {
        if (ask.kind === "load") {
            recognizers.load(ask.spec);
            answer = { id: ask.id, ok: true, text: "" };
        } else {
            answer = { id: ask.id, ok: true, text: recognizers.decode(ask.spec, ask.samples) };
        }
    } catch (error) {
        answer = { id: ask.id, ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    process.send?.(answer);
});

// The daemon going away takes this process with it, rather than leaving a gigabyte of weights behind it.
process.on("disconnect", () => process.exit(0));
