// How a command renders: prose (default), one JSON document, or an NDJSON stream. Selected by INTENTIC_OUTPUT so a
// driving backend can set it once.
export type OutputMode = "text" | "json" | "ndjson";

export interface Sink {
    readonly write: (chunk: string) => void;
}

// The seam every command renders through: `text` is a human progress or summary line, `result` is the final payload.
// Behavior depends on mode; failures propagate to stricli's stderr/exit code.
export interface Output {
    readonly mode: OutputMode;
    readonly text: (line: string) => void;
    readonly result: (result: Record<string, unknown>) => void;
}

export const createOutput = (sink: Sink, mode: OutputMode): Output => {
    if (mode === "ndjson") {
        // Every line carries `t` (epoch ms); consumers can ignore it.
        return {
            mode,
            text: () => {},
            result: (result) => sink.write(`${JSON.stringify({ t: Date.now(), kind: "result", ...result })}\n`),
        };
    }

    if (mode === "json") {
        // Silent during the run; one document at the end.
        return {
            mode,
            text: () => {},
            result: (result) => sink.write(`${JSON.stringify(result, undefined, 4)}\n`),
        };
    }

    return {
        mode,
        text: (line) => sink.write(`${line}\n`),
        result: () => {}, // already printed via text()
    };
};
