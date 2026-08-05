import type { EngineEvent } from "@intentic/engine";

// How a command renders: human prose (default), one JSON document at the end, or a live NDJSON event
// stream. Selected by the INTENTIC_OUTPUT env var (env.config.ts `intenticOutput`) so a backend driving the
// CLI as a subprocess sets it once; humans get `text` unchanged.
export type OutputMode = "text" | "json" | "ndjson";

export interface Sink {
    readonly write: (chunk: string) => void;
}

// Masks known secret VALUES out of everything a command writes (provider logs, ndjson events, results) —
// providers stream raw command output, which can echo tokens/passwords. Values register after the env and
// generated secrets load (they aren't known when the sink is built), so `wrap` early, `add` when loaded.
// ponytail: plain substring replace per chunk — a multi-line value split across two write() chunks slips
// through; log lines are short and values are single-line tokens today.
export const createRedactor = (): { readonly wrap: (sink: Sink) => Sink; readonly add: (values: readonly (string | undefined)[]) => void } => {
    const values = new Set<string>();
    return {
        add: (incoming) => {
            for (const value of incoming) {
                // Short values ("22", "true") would mask ordinary output; real secrets are long.
                if (value !== undefined && value.length >= 6) {
                    values.add(value);
                }
            }
        },
        wrap: (sink) => ({
            write: (chunk) => {
                let masked = chunk;
                for (const value of values) {
                    masked = masked.split(value).join("«redacted»");
                }
                sink.write(masked);
            },
        }),
    };
};

// The single seam every command renders through. `onEvent`/`log` feed the engine (structured lifecycle
// events and providers' free-form strings); `text` is a human summary line; `result` is the final
// structured payload. Each method's behavior is decided by the mode. Failures are left to propagate —
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
// node events stay silent — plan.command prints its own step table. Iteration events exist for the stream.
const eventText = (event: EngineEvent): string | undefined => {
    if (event.kind === "node" && event.phase === "apply") {
        if (event.state === "start") {
            return `applying "${event.id}" (type "${event.type}")`;
        }
        const reason = event.reason === undefined ? "" : ` (${event.reason})`;
        return `applied "${event.id}" (type "${event.type}") — ${event.action ?? "done"}${reason}`;
    }
    if (event.kind === "readiness") {
        return event.state === "waiting" ? `waiting for "${event.id}" at ${event.url}` : `"${event.id}" ready`;
    }
    if (event.kind === "prune") {
        return event.state === "deleted"
            ? `prune: deleted "${event.id}" (type "${event.type}")`
            : `prune: "${event.id}" (type "${event.type}") removed from desired state but its provider has no delete — left in place`;
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

    // text: the human default — identical to the CLI's prior output.
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

// Fan one command's rendering out to several Outputs at once — the human/text pane AND a structured ndjson
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
