// One run's lifecycle in this window, as one value that only `advance` moves: opened here (its words still being
// composed, or sent and waiting on the daemon's ack), taken by the daemon (acknowledged, or attached to), and settled.

// Everything a live run holds: the abort for its request or stream, and when it started (ms).
interface LiveRun {
    readonly controller: AbortController;
    readonly startedAt: number;
}

export type RunPhase =
    // Nothing live here; `accepted` is whether the daemon took the last run, which a late ending still reads.
    | { readonly kind: `idle`; readonly accepted: boolean }
    // Opened with its words still being composed (an errand): unknown to the daemon, so a Stop ends it here.
    | ({ readonly kind: `composing` } & LiveRun)
    // Its words have left and the daemon has not acknowledged them yet.
    | ({ readonly kind: `sending` } & LiveRun)
    // The daemon took it: acknowledged a send, or streamed a run at an attach; `run` is the name the daemon gave it.
    | ({ readonly kind: `running`; readonly run: string } & LiveRun);

export type RunEvent =
    | ({ readonly kind: `open`; readonly composing: boolean } & LiveRun)
    | { readonly kind: `composed` }
    | { readonly kind: `accepted`; readonly run: string }
    | ({ readonly kind: `attached`; readonly run: string } & LiveRun)
    | { readonly kind: `settled` };

export const IDLE: RunPhase = { kind: `idle`, accepted: false };

type Moves = { readonly [K in RunEvent["kind"]]: (phase: RunPhase, event: Extract<RunEvent, { kind: K }>) => RunPhase };

// Every move there is, one entry per event; a phase an event names no move from is left as it is.
const MOVES: Moves = {
    open: (phase, { composing, controller, startedAt }) =>
        phase.kind === `idle` ? { kind: composing ? `composing` : `sending`, controller, startedAt } : phase,
    composed: (phase) => (phase.kind === `composing` ? { ...phase, kind: `sending` } : phase),
    accepted: (phase, { run }) => (phase.kind === `sending` ? { ...phase, kind: `running`, run } : phase),
    attached: (phase, { controller, startedAt, run }) => (phase.kind === `idle` ? { kind: `running`, controller, startedAt, run } : phase),
    settled: (phase) => (phase.kind === `idle` ? phase : { kind: `idle`, accepted: phase.kind === `running` }),
};

// The table is keyed by the event's own kind, so the entry read always takes the event it is handed.
export const advance = (phase: RunPhase, event: RunEvent): RunPhase =>
    (MOVES[event.kind] as (phase: RunPhase, event: RunEvent) => RunPhase)(phase, event);

// Whether the daemon took this run, or, once it settled, the last one.
export const accepted = (phase: RunPhase): boolean => (phase.kind === `idle` ? phase.accepted : phase.kind === `running`);
