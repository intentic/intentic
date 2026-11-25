import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { expiredFrame, type TurnWatchdog, turnWatchdog } from "./turn-watchdog.js";

// A loop that drives its own vendor stream end to end (the Claude Code SDK, Codex's app-server) has no watchdog of its
// own: until 2026-11-24 a CLI that stopped sending anything while its process lived held its turn until someone pressed
// Stop. This ends such a turn by the same clock the ACP, Pi, Muse and OpenCode loops run on (turn-watchdog.ts), read
// from the frames alone, so the loop needs no change: every frame is activity, and the clock is held while the turn is
// legitimately quiet on something it started (a tool call still running, whether a ten-minute build, a subagent or a
// daemon tool, and a card open on a person). Silence past the window with nothing open is a stall: the loop is told to
// stop through its signal, what it says on the way down is dropped, and the turn ends on the watchdog's frame.

// Long, because nothing here can tell a model thinking out of sight or a context compaction from a hang: past the
// vendors' own request timeouts and retries (each of which sends a frame), and well past any compaction measured.
const STALL_SILENCE_MS = 15 * 60_000;

// Frames that park the turn on a person until `resolved` names the same requestId.
const CARD_KINDS: ReadonlySet<AgentEvent["kind"]> = new Set([
    "plan",
    "question",
    "permission",
    "browser_help",
    "terminal_help",
    "capability_offer",
    "payment_offer",
    "credential_offer",
]);

const OPEN_STATUSES: ReadonlySet<string | undefined> = new Set(["pending", "in_progress"]);

// What the stream has open, each holding the clock: tool calls by id, cards by requestId.
const openings = (clock: TurnWatchdog) => {
    const held = new Map<string, () => void>();
    const open = (key: string): void => {
        if (!held.has(key)) {
            held.set(key, clock.hold());
        }
    };
    const close = (key: string): void => {
        held.get(key)?.();
        held.delete(key);
    };
    return {
        see: (event: AgentEvent): void => {
            clock.touch();
            if (event.kind === "tool_call" || event.kind === "tool_call_update") {
                // An update that names no status says nothing of whether the call is still running.
                if (event.status === undefined) {
                    return;
                }
                if (OPEN_STATUSES.has(event.status)) {
                    open(`tool:${event.id}`);
                } else {
                    close(`tool:${event.id}`);
                }
            } else if (event.kind === "resolved") {
                close(`card:${event.requestId}`);
            } else if (CARD_KINDS.has(event.kind) && "requestId" in event) {
                open(`card:${event.requestId}`);
            } else if (event.kind === "provider_retry" && event.nextAttemptAt !== undefined) {
                clock.extendPast(event.nextAttemptAt);
            }
        },
        dispose: (): void => {
            for (const release of held.values()) {
                release();
            }
            held.clear();
        },
    };
};

export interface StallGuardOptions {
    readonly silenceMs?: number;
    // The loop's own words around why it stopped, as expiredFrame takes them.
    readonly said: (why: string) => string;
}

/**
 * Runs `run` on the request with a signal that also aborts once the stream has been silent past the window with nothing
 * open, and ends the turn on the watchdog's frame (coded `provider-outage`, so the daemon re-runs it on backoff). Until
 * then every frame passes through untouched.
 */
export async function* stallGuarded<R extends { readonly signal: AbortSignal }>(
    request: R,
    run: (request: R) => AsyncIterable<AgentEvent>,
    options: StallGuardOptions,
): AsyncGenerator<AgentEvent> {
    const silenceMs = options.silenceMs ?? STALL_SILENCE_MS;
    const clock = turnWatchdog({ inactivityMs: silenceMs, maxTurnMs: Number.POSITIVE_INFINITY });
    const opened = openings(clock);
    const stalled = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Looked at again whenever the timer fires, since a hold taken or a frame seen meanwhile moved the deadline. A held
    // clock answers an endless wait, which becomes a look a window out.
    const look = (): void => {
        const remaining = clock.remaining();
        if (remaining <= 0) {
            stalled.abort();
            return;
        }
        timer = setTimeout(look, Number.isFinite(remaining) ? remaining : silenceMs);
        timer.unref();
    };
    look();
    let said = false;
    const stallFrame = (): AgentEvent => {
        said = true;
        return expiredFrame(clock, options.said);
    };
    try {
        for await (const event of run({ ...request, signal: AbortSignal.any([request.signal, stalled.signal]) })) {
            if (!stalled.signal.aborted || request.signal.aborted) {
                opened.see(event);
                yield event;
                continue;
            }
            // The loop's own account of a stop it did not ask for (an abort, an interrupted turn) is not what happened.
            if (event.kind === "error") {
                continue;
            }
            if (event.kind === "done" && !said) {
                yield stallFrame();
            }
            yield event;
        }
        if (stalled.signal.aborted && !request.signal.aborted && !said) {
            yield stallFrame();
        }
    } finally {
        clearTimeout(timer);
        opened.dispose();
    }
}
