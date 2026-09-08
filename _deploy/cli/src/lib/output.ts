import type { EngineEvent } from "@intentic/engine";

// How a command renders: prose (default), one JSON document, or a live NDJSON event stream. Selected by INTENTIC_OUTPUT
// so a driving backend can set it once.
export type OutputMode = "text" | "json" | "ndjson";

export interface Sink {
    readonly write: (chunk: string) => void;
}

const REDACTED = "«redacted»";

// Length of the longest suffix of `text` that is a proper prefix of some registered secret value, the only part that
// might still become a secret when the next chunk arrives.
const ambiguousTail = (text: string, values: ReadonlySet<string>): number => {
    let longest = 0;
    for (const value of values) {
        for (let length = Math.min(value.length - 1, text.length); length > longest; length--) {
            if (text.endsWith(value.slice(0, length))) {
                longest = length;
                break;
            }
        }
    }
    return longest;
};

// Masks known secret values from output; `wrap` before values are known, `add` once loaded. Holds back a value split
// across a chunk boundary; `flush` (call in `finally`) or the tail is lost.
export const createRedactor = (): {
    readonly wrap: (sink: Sink) => Sink;
    readonly add: (values: readonly (string | undefined)[]) => void;
    readonly flush: () => void;
} => {
    const values = new Set<string>();
    const drains: (() => void)[] = [];
    return {
        add: (incoming) => {
            for (const value of incoming) {
                // Short values ("22", "true") would mask ordinary output; real secrets are long.
                if (value !== undefined && value.length >= 6) {
                    values.add(value);
                }
            }
        },
        wrap: (sink) => {
            let held = "";
            const emit = (final: boolean): void => {
                let masked = held;
                for (const value of values) {
                    masked = masked.split(value).join(REDACTED);
                }
                const hold = final ? 0 : ambiguousTail(masked, values);
                held = masked.slice(masked.length - hold);
                const ready = masked.slice(0, masked.length - hold);
                if (ready !== "") {
                    sink.write(ready);
                }
            };
            drains.push(() => emit(true));
            return {
                write: (chunk) => {
                    held += chunk;
                    emit(false);
                },
            };
        },
        flush: () => {
            for (const drain of drains) {
                drain();
            }
        },
    };
};

// The seam every command renders through: `onEvent`/`log` feed engine events and free-form logs, `text` is a human
// summary, `result` is the final payload. Behavior depends on mode; failures propagate to stricli's stderr/exit code.
export interface Output {
    readonly mode: OutputMode;
    readonly onEvent: (event: EngineEvent) => void;
    readonly log: (message: string) => void;
    readonly text: (line: string) => void;
    readonly result: (result: Record<string, unknown>) => void;
}

// Renders lifecycle events as text. Apply-phase node/readiness events print live progress (else the terminal sits blank
// for minutes); plan-phase stays silent, plan.command prints its own table.
const eventText = (event: EngineEvent): string | undefined => {
    if (event.kind === "node" && event.phase === "apply") {
        if (event.state === "start") {
            return `applying "${event.id}" (type "${event.type}")`;
        }
        const reason = event.reason === undefined ? "" : ` (${event.reason})`;
        return `applied "${event.id}" (type "${event.type}"): ${event.action ?? "done"}${reason}`;
    }
    if (event.kind === "readiness") {
        return event.state === "waiting" ? `waiting for "${event.id}" at ${event.url}` : `"${event.id}" ready`;
    }
    if (event.kind === "prune") {
        return event.state === "deleted"
            ? `prune: deleted "${event.id}" (type "${event.type}")`
            : `prune: "${event.id}" (type "${event.type}") removed from desired state but its provider has no delete, left in place`;
    }
    if (event.kind === "orphan") {
        return `orphan: "${event.id}" (type "${event.type}") exists but is not in the desired graph`;
    }
    return undefined;
};

export const createOutput = (sink: Sink, mode: OutputMode): Output => {
    const line = (text: string): void => sink.write(`${text}\n`);
    // Every line carries `t` (epoch ms), the only timing record in persisted run logs; consumers can ignore it.
    const jsonLine = (value: object): void => sink.write(`${JSON.stringify({ t: Date.now(), ...value })}\n`);

    if (mode === "ndjson") {
        return {
            mode,
            onEvent: jsonLine,
            log: (message) => jsonLine({ kind: "log", message }),
            text: () => {},
            result: (result) => jsonLine({ kind: "result", ...result }),
        };
    }

    if (mode === "json") {
        // Silent during the run; one document at the end.
        return {
            mode,
            onEvent: () => {},
            log: () => {},
            text: () => {},
            result: (result) => sink.write(`${JSON.stringify(result, undefined, 4)}\n`),
        };
    }

    return {
        mode,
        onEvent: (event) => {
            const text = eventText(event);
            if (text !== undefined) {
                line(text);
            }
        },
        log: line,
        text: line,
        result: () => {}, // already printed via text()/onEvent()
    };
};

// Fans one command's rendering out to several Outputs (e.g., the human pane and an ndjson events file); every method
// calls through to all targets. `mode` reports the primary target's.
export const teeOutput = (primary: Output, ...rest: readonly Output[]): Output => {
    const targets = [primary, ...rest];
    return {
        mode: primary.mode,
        onEvent: (event) => {
            for (const target of targets) {
                target.onEvent(event);
            }
        },
        log: (message) => {
            for (const target of targets) {
                target.log(message);
            }
        },
        text: (line) => {
            for (const target of targets) {
                target.text(line);
            }
        },
        result: (result) => {
            for (const target of targets) {
                target.result(result);
            }
        },
    };
};
