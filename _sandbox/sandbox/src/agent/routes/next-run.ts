import type { HoldingsIndex, LiveRun } from "../../conversations/actor/conversation-holdings.js";
import { turnRunOf } from "../../conversations/actor/conversation-holdings.js";
import type { DomainEvents } from "../../seams/domain-events.js";

// The run a reader attaches to after one it watched end (AttachTurn.after). A conversation's queue sends its next
// message a moment after a turn settles, so a reader that asked at once would find nothing, and one that asked again on a
// timer would guess how long to wait. The start is an event here: the attach waits for it instead.

/** How long an attach `after` a run waits for the next one to start before answering that nothing runs. Long enough for
 *  the queue's next send, a recovery or a wake to begin; short enough that a reader of a conversation going quiet hears
 *  so while it is still looking. */
const NEXT_RUN_WAIT_MS = 10_000;

/** How often the wait looks again whether a run is held, beside the start event: not every starter announces one (a
 *  spawned child's turns from its parent start through `run`, unannounced). */
const NEXT_RUN_POLL_MS = 250;

/**
 * The conversation's run other than `after`: the one held now, else the first one held within `waitMs`. Undefined when
 * none starts in time, or the reader went away (`signal`).
 */
export const nextRunAfter = async (
    deps: { readonly conversations: Pick<HoldingsIndex, "holdings">; readonly events: Pick<DomainEvents, "subscribe"> },
    conversationId: string,
    after: string,
    signal?: AbortSignal,
    { waitMs = NEXT_RUN_WAIT_MS, pollMs = NEXT_RUN_POLL_MS }: { readonly waitMs?: number; readonly pollMs?: number } = {},
): Promise<LiveRun | undefined> => {
    const newer = (): LiveRun | undefined => {
        const run = turnRunOf(deps.conversations, conversationId);
        return run === undefined || run.id === after ? undefined : run;
    };
    const now = newer();
    if (now !== undefined || signal?.aborted === true) {
        return now;
    }
    return new Promise<LiveRun | undefined>((resolve) => {
        const done = (run: LiveRun | undefined): void => {
            clearTimeout(deadline);
            clearInterval(poll);
            unsubscribe();
            signal?.removeEventListener("abort", gone);
            resolve(run);
        };
        const look = (): void => {
            const run = newer();
            if (run !== undefined) {
                done(run);
            }
        };
        const gone = (): void => done(undefined);
        const deadline = setTimeout(gone, waitMs);
        const poll = setInterval(look, pollMs);
        // The run is held before its start is announced (turn-resume.ts), so the event finds it already there.
        const unsubscribe = deps.events.subscribe("run.started", (started) => {
            if (started.conversationId === conversationId) {
                look();
            }
        });
        signal?.addEventListener("abort", gone, { once: true });
    });
};

/** The run an attach opens on: the conversation's newest, or with `after` (a run the reader saw end) the next one. */
export const runToAttach = async (
    deps: Parameters<typeof nextRunAfter>[0],
    conversationId: string,
    after: string | undefined,
    signal?: AbortSignal,
): Promise<LiveRun | undefined> => (after === undefined ? turnRunOf(deps.conversations, conversationId) : nextRunAfter(deps, conversationId, after, signal));
