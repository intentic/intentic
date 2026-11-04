import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { errorMessage } from "@intentic/base/errors";
import { ORPCError } from "@orpc/client";
import type { Logger } from "pino";
import type { RunnerClient, RunnerHub } from "../runner-peer.js";

/* A RUNNER TURN AS THE PARENT RELAYS IT, across however many sockets it takes. The runner runs the turn to its end
   whether or not anyone follows it (remote-turns.ts); this side counts every frame it has, and when the socket under the
   stream dies it waits for the runner to dial back in and reads on from the next frame. A turn used to end "stopped" the
   moment its socket did, while the runner kept working on it unseen (2026-11-04, a two-second network drop on omen). */

// How long a turn waits for its runner to come back before giving up on it: as long as the runner keeps the turn's frames
// (remote-turns.ts, its retention). Stop ends the wait at any time.
const RUNNER_REATTACH_MS = 24 * 60 * 60 * 1000;

// How often the parent tells the runner how many frames it has: what a parent that restarted mid-turn reads on from.
const ACK_EVERY_MS = 2_000;

// Ceiling on asking the runner what it holds; a socket that does not answer within it is treated as gone.
const ASK_MS = 15_000;

// A few in a row is a runner that answers and then drops every stream it is handed: give up rather than spin.
const MAX_EMPTY_REATTACHES = 5;

const LINK_STATUS = "runner-link";

export interface RelayContext {
    readonly hub: Pick<RunnerHub, "client" | "reconnected">;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly runnerId: string;
    readonly conversationId: string;
    readonly signal: AbortSignal | undefined;
}

// How a relay ended: the turn said `done` (or the runner holds nothing more of it), Stop was pressed, or the turn is
// gone (the runner restarted, is too old to pick it back up, or never came back). `client` is the socket it ended on.
export interface RelayEnd {
    readonly outcome: "done" | "stopped" | "lost";
    readonly client: RunnerClient | undefined;
}

type PickUp =
    | { readonly kind: "attached"; readonly stream: AsyncIterable<AgentEvent> }
    | { readonly kind: "over" }
    | { readonly kind: "gone"; readonly why: string }
    | { readonly kind: "unreachable" };

const askOptions = () => ({ signal: AbortSignal.timeout(ASK_MS) });

const status = (text: string | null): AgentEvent => ({ kind: "agent_status", key: LINK_STATUS, text });

const notice = (text: string, level: "info" | "warning" = "info"): AgentEvent => ({ kind: "agent_notice", level, text });

const lasted = (ms: number): string => {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
};

// Every frame the parent has of the turn, and the runner told so every few seconds.
class RelayCursor {
    sawDone = false;
    private lastAck = 0;

    constructor(
        private readonly conversationId: string,
        public received: number,
    ) {}

    saw(event: AgentEvent, client: RunnerClient): void {
        this.received += 1;
        if (event.kind === "done") {
            this.sawDone = true;
        }
        if (Date.now() - this.lastAck >= ACK_EVERY_MS || this.sawDone) {
            this.ack(client);
        }
    }

    ack(client: RunnerClient | undefined): void {
        this.lastAck = Date.now();
        // allow(silent-catch): an ack is advisory; a runner too old to take one, or a socket mid-drop, costs only the count
        // a restarted parent would read on from.
        void client?.ackTurn({ conversationId: this.conversationId, after: this.received }).catch(() => undefined);
    }
}

// Asks the runner (on `client`) whether it still holds the turn, and opens a stream reading on after `received`.
const pickUp = async (client: RunnerClient, context: RelayContext, received: number): Promise<PickUp> => {
    const { conversationId, signal } = context;
    let held;
    try {
        held = await client.heldTurn({ conversationId }, askOptions());
    } catch (error) {
        return error instanceof ORPCError && error.code === "NOT_FOUND"
            ? {
                  kind: "gone",
                  why: "This runner's build cannot pick a turn back up after a dropped link; update it to match this sandbox. What the turn did there after the drop is not shown here; what it committed comes back with this turn's push.",
              }
            : { kind: "unreachable" };
    }
    if (held.state === "none") {
        return {
            kind: "gone",
            why:
                received === 0
                    ? "The turn never reached the runner: the link dropped as it was sent. Send it again."
                    : "The runner no longer holds this turn: it restarted while the link was down. What the turn did there after the drop is not shown here; what it committed comes back with this turn's push.",
        };
    }
    if (held.state === "finished" && held.events <= received) {
        return { kind: "over" };
    }
    try {
        return { kind: "attached", stream: await client.attachTurn({ conversationId, after: received }, signal === undefined ? {} : { signal }) };
    } catch (error) {
        return error instanceof ORPCError && error.code === "NOT_FOUND"
            ? { kind: "gone", why: "The runner let go of this turn as the link came back." }
            : { kind: "unreachable" };
    }
};

// The socket under the stream died: wait for the runner (the same socket first, since a stream can die alone), then read
// on. Says so while it waits, and how long the gap was once it is back.
async function* reattach(
    context: RelayContext,
    previous: RunnerClient,
    received: number,
): AsyncGenerator<AgentEvent, { readonly end: RelayEnd } | { readonly client: RunnerClient; readonly stream: AsyncIterable<AgentEvent> }> {
    const lostAt = Date.now();
    const deadline = lostAt + RUNNER_REATTACH_MS;
    yield status(`Lost the link to the runner "${context.runnerId}". The turn carries on there; it is picked back up here when the runner reconnects. Stop ends the wait.`);
    let candidate: RunnerClient | undefined = previous;
    let tried: RunnerClient | undefined;
    for (;;) {
        candidate ??= await context.hub.reconnected(context.runnerId, tried, deadline - Date.now(), context.signal);
        if (candidate === undefined) {
            yield status(null);
            if (context.signal?.aborted === true) {
                return { end: { outcome: "stopped", client: undefined } };
            }
            yield { kind: "error", message: `The runner "${context.runnerId}" did not come back within a day, so this turn stops waiting for it.` };
            return { end: { outcome: "lost", client: undefined } };
        }
        const attempt = await pickUp(candidate, context, received);
        if (attempt.kind === "unreachable") {
            tried = candidate;
            candidate = undefined;
            continue;
        }
        yield status(null);
        if (attempt.kind === "gone") {
            yield { kind: "error", message: attempt.why };
            return { end: { outcome: "lost", client: candidate } };
        }
        if (attempt.kind === "over") {
            return { end: { outcome: "done", client: candidate } };
        }
        context.logger.info({ id: context.conversationId, runner: context.runnerId, after: received, awayMs: Date.now() - lostAt }, "runner dispatch: picked the turn back up");
        yield notice(`The link to the runner was down for ${lasted(Date.now() - lostAt)}. The turn carried on there, and everything it did meanwhile is shown above.`);
        return { client: candidate, stream: attempt.stream };
    }
}

const opened = async (context: RelayContext, open: () => Promise<AsyncIterable<AgentEvent>>): Promise<AsyncIterable<AgentEvent> | undefined> => {
    try {
        return await open();
    } catch (error) {
        context.logger.warn({ err: error, id: context.conversationId }, "runner dispatch: the turn's stream would not open");
        return undefined;
    }
};

// One stream's frames, relayed until it ends or dies; a death is logged, not thrown, since the caller reads on elsewhere.
async function* drain(
    context: RelayContext,
    stream: AsyncIterable<AgentEvent> | undefined,
    seen: { readonly cursor: RelayCursor; readonly client: RunnerClient },
    frame: (event: AgentEvent) => readonly AgentEvent[],
): AsyncGenerator<AgentEvent> {
    try {
        for await (const event of stream ?? []) {
            seen.cursor.saw(event, seen.client);
            yield* frame(event);
        }
    } catch (error) {
        context.logger.info({ reason: errorMessage(error), id: context.conversationId }, "runner dispatch: the turn's stream dropped");
    }
}

// What a stream that ended leaves the relay to do: finish, or read on (counting streams that brought nothing).
const afterStream = (context: RelayContext, cursor: RelayCursor, client: RunnerClient, empty: number): RelayEnd | "reattach" => {
    if (cursor.sawDone) {
        return { outcome: "done", client };
    }
    if (context.signal?.aborted === true) {
        return { outcome: "stopped", client };
    }
    return empty > MAX_EMPTY_REATTACHES ? { outcome: "lost", client } : "reattach";
};

/**
 * The turn's frames from `first.open`, then, whenever the stream dies short of `done`, from wherever the runner reads on.
 * `frame` maps each frame to what is relayed for it (none drops it); every frame counts toward the cursor either way.
 */
export async function* relayTurn(
    context: RelayContext,
    first: { readonly client: RunnerClient; readonly open: (client: RunnerClient) => Promise<AsyncIterable<AgentEvent>>; readonly received?: number },
    frame: (event: AgentEvent) => readonly AgentEvent[] = (event) => [event],
): AsyncGenerator<AgentEvent, RelayEnd> {
    const cursor = new RelayCursor(context.conversationId, first.received ?? 0);
    let client = first.client;
    let stream = await opened(context, () => first.open(client));
    let empty = 0;
    for (;;) {
        const before = cursor.received;
        yield* drain(context, stream, { cursor, client }, frame);
        empty = cursor.received === before ? empty + 1 : 0;
        const next = afterStream(context, cursor, client, empty);
        if (next !== "reattach") {
            if (next.outcome === "lost") {
                yield { kind: "error", message: `The runner "${context.runnerId}" keeps dropping this turn's stream as soon as it is opened, so this turn stops following it.` };
            }
            return next;
        }
        const back = yield* reattach(context, client, cursor.received);
        if ("end" in back) {
            return back.end;
        }
        client = back.client;
        stream = back.stream;
    }
}

/* COLLECTING A TURN THE PARENT LOST: one the runner still holds for the conversation when the next turn is dispatched,
   because the parent restarted, gave up waiting, or was stopped while the runner was out of reach. Its frames are relayed
   into the new turn ahead of the new message, from the count the parent last acknowledged, so what the agent did there
   is shown and its branch comes back before the checkout is touched (runner-dispatch.ts). */

// The frames that are the earlier turn's work, which earn the notice saying whose they are.
const WORK = new Set<AgentEvent["kind"]>(["delta", "thinking", "tool_call", "terminal", "subagent", "todos"]);

const collectedNote = (live: boolean): string =>
    live
        ? "The runner is still running this conversation's previous turn, which carried on there after this sandbox lost track of it. It is followed to its end here, then your message runs."
        : "This conversation's previous turn carried on on the runner after this sandbox lost track of it. What it did there:";

// An earlier turn's end is not this turn's end, nor its failure this turn's: only its work crosses over.
const collectedFrames = (live: boolean): ((event: AgentEvent) => readonly AgentEvent[]) => {
    let announced = false;
    return (event) => {
        if (event.kind === "done" || event.kind === "init" || event.kind === "error") {
            return [];
        }
        if (announced || !WORK.has(event.kind)) {
            return [event];
        }
        announced = true;
        return [notice(collectedNote(live)), event];
    };
};

const withCollected =
    (first: (event: AgentEvent) => readonly AgentEvent[], then: (event: AgentEvent) => readonly AgentEvent[]) =>
    (event: AgentEvent): readonly AgentEvent[] =>
        first(event).flatMap(then);

/**
 * Relays what the runner still holds of an earlier turn on this conversation. `collected` says whether there was one,
 * which the caller then delivers (push and mirror) before pulling; `end` is how its relay ended, when it ran one.
 */
export async function* collectHeld(
    context: RelayContext,
    client: RunnerClient,
    // What every frame passes through first, as the dispatch's own relay does (the cards it notes).
    relayed: (event: AgentEvent) => readonly AgentEvent[],
): AsyncGenerator<AgentEvent, { readonly collected: boolean; readonly end?: RelayEnd }> {
    const { conversationId, signal } = context;
    let held;
    try {
        held = await client.heldTurn({ conversationId }, askOptions());
    } catch {
        // allow(silent-catch): a runner too old to say holds nothing it could hand over; its pull guards a live turn itself.
        return { collected: false };
    }
    if (held.state === "none") {
        return { collected: false };
    }
    if (held.state === "finished" && held.events <= held.acked) {
        return { collected: true };
    }
    context.logger.info({ id: conversationId, runner: context.runnerId, state: held.state, after: held.acked, events: held.events }, "runner dispatch: collecting a turn the runner still holds");
    const end = yield* relayTurn(
        context,
        { client, open: (current) => current.attachTurn({ conversationId, after: held.acked }, signal === undefined ? {} : { signal }), received: held.acked },
        withCollected(relayed, collectedFrames(held.state === "live")),
    );
    return { collected: true, end };
}

/* STOP, WHEREVER THE RUNNER IS. Pressed while the runner is out of reach, it is owed to it: delivered when the runner
   dials back in, or by the next dispatch on the conversation, whichever comes first. */

const owedStops = new Map<string, string>();

const payTo = (client: RunnerClient, runnerId: string, conversationId: string): Promise<void> => {
    owedStops.delete(conversationId);
    // allow(silent-catch): a stop that fails here is owed again by the caller, or the turn already ended.
    return client.interrupt({ conversationId }).then(
        () => undefined,
        () => undefined,
    );
};

const oweStop = (context: Pick<RelayContext, "hub" | "runnerId" | "conversationId">, previous: RunnerClient | undefined): void => {
    const { hub, runnerId, conversationId } = context;
    owedStops.set(conversationId, runnerId);
    void hub.reconnected(runnerId, previous, RUNNER_REATTACH_MS).then((back) => {
        if (back !== undefined && owedStops.get(conversationId) === runnerId) {
            void payTo(back, runnerId, conversationId);
        }
    });
};

// The person's Stop, reaching through to the runner now or as soon as it can be reached.
export const stopRemoteTurn = (context: Pick<RelayContext, "hub" | "runnerId" | "conversationId">): void => {
    const live = context.hub.client(context.runnerId);
    if (live === undefined) {
        oweStop(context, undefined);
        return;
    }
    void live.interrupt({ conversationId: context.conversationId }).catch(() => oweStop(context, live));
};

// A stop still owed to this conversation's turn on this runner, delivered before anything else runs there.
export const payOwedStop = async (context: Pick<RelayContext, "runnerId" | "conversationId">, client: RunnerClient): Promise<void> => {
    if (owedStops.get(context.conversationId) === context.runnerId) {
        await payTo(client, context.runnerId, context.conversationId);
    }
};
