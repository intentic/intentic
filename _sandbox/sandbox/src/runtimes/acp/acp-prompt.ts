import { methods } from "@agentclientprotocol/sdk/unstable";
import { whenAborted, withDeadline } from "@intentic/base/async";
import type { AgentRequest } from "../../agent/providers/agent-request.js";
import type { AcpConnection } from "./acp-connection.js";
import { type IdleWait, type TurnTimeouts, type TurnWatchdog, watchedPull } from "../decorators/turn-watchdog.js";

// How long a stopped ACP phase waits for the agent to settle its prompt after session/cancel, which is only a notice.
// 2026-11-17, the shinobi-society audit: a Devin helper told to stop at its 20s deadline never settled its prompt, and
// its phase rode the 30-minute turn cap. Pi and Muse hold the same grace (pi-agent.ts, muse-agent.ts).
const ACP_ABORT_GRACE_MS = 5_000;

// The loop's deadlines, and the stop's grace and setup bounds where a caller (a test) names its own.
export type AcpTimeouts = TurnTimeouts & {
    readonly abortGraceMs?: number | undefined;
    readonly sessionOpenMs?: number | undefined;
    readonly optionWriteMs?: number | undefined;
};

// How long the agent may take over each request that sets a phase's session up, before the prompt and its watchdog
// start (2026-11-24: unbounded, a hung session/new held the turn to its 30-minute cap and a Stop did not end it). Opening
// a session may start every MCP server it is handed or replay a long history; an option write is a single switch.
const SESSION_OPEN_MS = 120_000;
const OPTION_WRITE_MS = 30_000;

// What a setup request is: opening the session, or writing one of its options (model, reasoning depth, mode).
export type SetupKind = "open" | "option";

/**
 * Runs one setup request to its deadline and the turn's stop. Past the deadline it rejects with a TimeoutError naming the
 * step that hung (`what`, the person's words for it), and on a stop with the stop's reason; the request itself is only
 * no longer waited for, since ACP has no cancel for anything but a prompt. A step that tolerates the agent's refusal
 * catches it inside `work`, so a deadline or a stop still ends the turn.
 */
export type SetupStep = <T>(kind: SetupKind, what: string, work: () => Promise<T>) => Promise<T>;

export const setupStep =
    (timeouts: AcpTimeouts, signal: AbortSignal): SetupStep =>
    (kind, what, work) => {
        const ms = kind === "open" ? (timeouts.sessionOpenMs ?? SESSION_OPEN_MS) : (timeouts.optionWriteMs ?? OPTION_WRITE_MS);
        const message = `The agent did not answer ${what} within ${String(Math.round(ms / 1_000))}s, so the turn was ended. Send again to retry.`;
        return withDeadline(async () => work(), ms, { signal, message });
    };

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
        // A person's stop ends what the turn started running as well: the agent's background subagents and tasks, which
        // a session/cancel leaves running (acp-connection.ts stopChildren).
        connection.stopChildren(sessionId);
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
