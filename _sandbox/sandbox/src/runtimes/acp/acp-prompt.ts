import { methods } from "@agentclientprotocol/sdk/unstable";
import { whenAborted } from "@intentic/base/async";
import type { AgentRequest } from "../../agent/providers/agent-request.js";
import type { AcpConnection } from "./acp-connection.js";
import { type IdleWait, type TurnTimeouts, type TurnWatchdog, watchedPull } from "../decorators/turn-watchdog.js";

// How long a stopped ACP phase waits for the agent to settle its prompt after session/cancel, which is only a notice.
// 2026-11-17, the shinobi-society audit: a Devin helper told to stop at its 20s deadline never settled its prompt, and
// its phase rode the 30-minute turn cap. Pi and Muse hold the same grace (pi-agent.ts, muse-agent.ts).
const ACP_ABORT_GRACE_MS = 5_000;

// The loop's deadlines, and the stop's grace where a caller (a test) names its own.
export type AcpTimeouts = TurnTimeouts & { readonly abortGraceMs?: number | undefined };

// A sealed request's words: its system prompt, where it names one, in front of its prompt.
export const sealedWords = (request: AgentRequest): string => {
    const system = request.spec.systemPrompt?.trim();
    return system === undefined || system === "" ? request.spec.prompt : `${system}\n\n${request.spec.prompt}`;
};

// The phase's best-effort session/cancel, sent on a stop as well. A Stop before the session exists reaches an
// already-aborted signal a bare listener would miss; the wake starts the stop's grace (phasePull) on a loop parked for
// the silence window, which would otherwise not look again until that window ran out.
export const cancelOnStop = (connection: AcpConnection, sessionId: string, signal: AbortSignal, wait: IdleWait) => {
    // allow(silent-catch): a cancel refused is a phase already over; the grace or the watchdog ends it regardless.
    const cancel = (): void => void connection.agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => {});
    const unwatch = whenAborted(signal, () => {
        cancel();
        wait.wake();
    });
    return { cancel, unwatch };
};

// A phase's pull over its queue: SETTLED once the prompt settles with nothing queued, EXPIRED on a watchdog or once a
// stop's grace passes with the prompt still open. The grace is fixed when the stop is first seen: re-read on every pass,
// as Pi's is, it only narrows each park and never ends the wait (turn-watchdog.test.ts), and Pi's kill is what ends its
// turn, where ACP has nothing but the notice. An expiry after a stop is the stop working, so the phase says nothing.
export const phasePull = <T>(
    queue: T[],
    settled: () => boolean,
    phase: { readonly clock: TurnWatchdog; readonly wait: IdleWait; readonly signal: AbortSignal; readonly graceMs: number | undefined },
) => {
    let graceEnds: number | undefined;
    return watchedPull({
        take: () => queue.shift(),
        settled,
        clock: phase.clock,
        wait: phase.wait,
        until: () => {
            if (phase.signal.aborted) {
                graceEnds ??= Date.now() + (phase.graceMs ?? ACP_ABORT_GRACE_MS);
            }
            return graceEnds;
        },
    });
};
