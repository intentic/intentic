import type { EngineEvent } from "@intentic/engine";

// How a command renders: human prose (default), one JSON document at the end, or a live NDJSON event
// stream. Selected by the INTENTIC_OUTPUT env var (env.config.ts `intenticOutput`) so a backend driving the
// CLI as a subprocess sets it once; humans get `text` unchanged.
export type OutputMode = "text" | "json" | "ndjson";

export interface Sink {
    readonly write: (chunk: string) => void;
}

const REDACTED = "«redacted»";

/* The length of the longest suffix of `text` that is a PROPER PREFIX of some registered value, the only part
 * of what we are about to emit that could still become a secret once the next chunk arrives.
 *
 * This is what makes the hold-back cheap: ordinary output ends in no such suffix and flows straight through,
 * so progress lines during a long apply are not delayed. Only a genuinely ambiguous tail waits. */
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

/* Masks known secret VALUES out of everything a command writes (provider logs, ndjson events, results),
 * providers stream raw command output, which can echo tokens/passwords. Values register after the env and
 * generated secrets load (they aren't known when the sink is built), so `wrap` early, `add` when loaded.
 *
 * Masking is per-STREAM, not per-chunk. A plain replace on each chunk leaks any value that straddles a chunk
 * boundary, and the caller does not choose those boundaries: a provider streaming a remote command's output
 * gets them from the kernel's read sizes, so the same secret masks or leaks depending on timing. Holding the
 * ambiguous tail back until the next write makes the result depend on the bytes instead.
 *
 * `flush` is therefore part of the contract, not a nicety: whatever is still held when the command ends has
 * to be written, or the last line of output goes missing. Commands call it from their `finally`. */
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

// The single seam every command renders through. `onEvent`/`log` feed the engine (structured lifecycle
// events and providers' free-form strings); `text` is a human summary line; `result` is the final
// structured payload. Each method's behavior is decided by the mode. Failures are left to propagate,
// stricli renders them on stderr and sets a non-zero exit code, and a stream consumer still has the
// events emitted before the throw plus the exit code.
export interface Output {
    readonly mode: OutputMode;
    readonly onEvent: (event: EngineEvent) => void;
    readonly log: (message: string) => void;
    readonly text: (line: string) => void;
    readonly result: (result: Record<string, unknown>) => void;
}

// The text rendering of lifecycle events. Apply-phase node + readiness events print as live progress lines
// (an apply's terminal would otherwise sit blank through minutes of SSH reads and image pulls); plan-phase
// node events stay silent, plan.command prints its own step table. Iteration events exist for the stream.
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
    // Every ndjson line carries `t` (epoch ms): the persisted run logs are the only record of a run's timing,
    // and a postmortem must be able to see WHERE the time went (which read stalled, how long before a kill).
    // The wire schema is loose (IntenticLineSchema), so consumers that don't care simply ignore it.
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

    // text: the human default, identical to the CLI's prior output.
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

// Fan one command's rendering out to several Outputs at once, the human/text pane AND a structured ndjson
// events file, each a fully-formed Output with its own mode and sink. Every method calls through to every
// target; `mode` reports the primary (first) target's, the canonical stdout rendering. Used by apply so its
// pane stays human-readable while the same lifecycle events also land as ndjson for the web to tail.
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
