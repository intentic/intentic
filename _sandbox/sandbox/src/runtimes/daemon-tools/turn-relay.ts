import type { AgentEvent } from "@intentic/sandbox-contract";
import { type CommandGuard, consultWith, type CommandWhere, type GuardOutcome, type GuardSubject } from "../../guard/command-guard.js";
import type { TurnTaint } from "../../guard/turn-taint.js";
import type { GateHooks } from "./policy-gate-server.js";

// The late half of a daemon tool served over the door (daemon-servers.ts). The tool is built when the turn is planned, but
// what it needs of the running turn exists only once the runtime's loop runs: the stream its cards' frames go into, the
// watchdog a card must hold while a person answers, and the command gate (and taint bit) the loop mints. The relay is
// made at plan time, handed to the tools then, and attached by the loop when it starts; whatever a tool did before that
// waits here rather than being lost.

// What a loop hands the relay once it runs. Every field is optional: a loop attaches what it has.
export interface RelaySink {
    // Where the turn's frames go: the loop's own queue, so a question card lands in the stream the client reads.
    readonly push?: (event: AgentEvent) => void;
    // The loop's watchdog hold (turn-watchdog.ts): taken while a daemon tool runs, so a card open on a person, or a
    // child the agent waits on, is not read as a silent turn.
    readonly hold?: () => () => void;
    // The gate and taint bit the loop minted (vendor-gate.ts): what a script's run is consulted against, and what a
    // result that brought the outside in marks.
    readonly guard?: { readonly gate: CommandGuard; readonly taint: TurnTaint };
    // What a loop whose own hooks call the door's gate server adds to it (policy-gate-server.ts): the key its hook
    // configuration carries, its rewrite of what the rules let through, its record of each answer.
    readonly gateHooks?: GateHooks;
}

export interface TurnRelay {
    // Tool side: a frame for the turn's stream; buffered until a loop attaches its push.
    readonly push: (event: AgentEvent) => void;
    // Tool side: holds the turn's watchdog until the returned release; taken on the loop's watchdog the moment one
    // attaches, if the tool started first. The release counts once.
    readonly hold: () => () => void;
    // Tool side: outside content entered the turn. Applied to the loop's taint bit; remembered until one attaches, so a
    // mark can only arrive late, never be dropped.
    readonly mark: (source: string) => void;
    // Tool side: the loop's gate, or undefined while none is attached.
    readonly guard: () => RelaySink["guard"];
    // Tool side: the loop's gate hooks, or undefined while none are attached.
    readonly gateHooks: () => GateHooks | undefined;
    // Tool side: consults the loop's gate about a program, holding the watchdog while a card waits, its frames into the
    // stream. Refuses when no gate is attached: a program nothing can check does not run.
    readonly consult: (program: string, subject: GuardSubject, where?: CommandWhere) => Promise<GuardOutcome>;
    // Loop side: attaches what the loop has; returns the detach, which takes back exactly what it attached. Frames and
    // marks that arrived before flow to it at once.
    readonly attach: (sink: RelaySink) => () => void;
}

// The most frames held for a loop that has not attached. A tool that pushes before the loop runs pushes a card and its
// resolution, not a stream; a relay no loop ever attaches to must not grow without bound.
const BUFFERED_FRAMES = 256;

export const UNGATED =
    "This turn's command gate is not running yet, so nothing could check this against your owner's safety policy and it was refused. " +
    "Do not retry it in a loop: carry on with what you can do without it, and say plainly what you left undone.";

export const createTurnRelay = (): TurnRelay => {
    const frames: AgentEvent[] = [];
    const marks: string[] = [];
    let push: RelaySink["push"];
    let clock: RelaySink["hold"];
    let guard: RelaySink["guard"];
    let gateHooks: GateHooks | undefined;
    // Holds open now, each with the loop-side release it took, if a loop's watchdog was there to take one.
    const open = new Set<{ taken: (() => void) | undefined }>();
    const relay: TurnRelay = {
        push: (event) => {
            if (push !== undefined) {
                push(event);
                return;
            }
            if (frames.length < BUFFERED_FRAMES) {
                frames.push(event);
            }
        },
        hold: () => {
            const entry = { taken: clock?.() };
            open.add(entry);
            return () => {
                if (!open.delete(entry)) {
                    return;
                }
                entry.taken?.();
            };
        },
        mark: (source) => {
            if (guard !== undefined) {
                guard.taint.mark(source);
                return;
            }
            marks.push(source);
        },
        guard: () => guard,
        gateHooks: () => gateHooks,
        consult: async (program, subject, where) => {
            const current = guard;
            if (current === undefined) {
                return { allow: false, reason: UNGATED };
            }
            const release = relay.hold();
            try {
                return await consultWith(current.gate, program, subject, relay.push, where);
            } finally {
                release();
            }
        },
        attach: (sink) => {
            if (sink.push !== undefined) {
                push = sink.push;
                for (const frame of frames.splice(0)) {
                    sink.push(frame);
                }
            }
            if (sink.hold !== undefined) {
                clock = sink.hold;
                for (const entry of open) {
                    entry.taken ??= sink.hold();
                }
            }
            if (sink.gateHooks !== undefined) {
                gateHooks = sink.gateHooks;
            }
            if (sink.guard !== undefined) {
                guard = sink.guard;
                for (const source of marks.splice(0)) {
                    sink.guard.taint.mark(source);
                }
            }
            return () => {
                if (sink.push !== undefined && push === sink.push) {
                    push = undefined;
                }
                if (sink.hold !== undefined && clock === sink.hold) {
                    clock = undefined;
                    // The loop is gone; what it held for the daemon's tools goes with it.
                    for (const entry of open) {
                        entry.taken?.();
                        entry.taken = undefined;
                    }
                }
                if (sink.guard !== undefined && guard === sink.guard) {
                    guard = undefined;
                }
                if (sink.gateHooks !== undefined && gateHooks === sink.gateHooks) {
                    gateHooks = undefined;
                }
            };
        },
    };
    return relay;
};
