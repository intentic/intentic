import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { AgentOrigin } from "@intentic/sandbox-contract/schemas/agent";
import { DELIVER_ID_FEATURE } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import { errorMessage } from "@intentic/base/errors";
import { listenerStatus } from "../../capabilities/status/listener-status.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { defineInFlight } from "../../seams/restart/in-flight.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openEntries } from "../../store/open-document.js";
import type { TurnStream } from "../../automations/fire/fire-options.js";
import { deliverThroughGateway, type GatewayFailure, GatewayDeliveryError } from "./listener-deliver.js";

// How a reply reaches its gateway: deliverThroughGateway, a stand-in in a test.
export type DeliverToGateway = (
    services: Services,
    provider: string,
    channelId: string,
    text: string,
    thread: string | undefined,
    id: string,
) => ReturnType<typeof deliverThroughGateway>;

// What the daemon owes a gateway's channel: an answer no live stream carried (a held wake released, a message replayed
// after a restart), a held wake's decline, a need's ask. Each is journalled here before anything is posted, tried at
// once, and tried again with backoff while the gateway is down or the provider fails it, until the gateway takes it,
// it has been owed a day, or the gateway says it never will. A reply goes out under its own id, the same on every try,
// so a gateway that declares DELIVER_ID_FEATURE posts it once however often it is tried; to a gateway that does not, a
// try that may have posted (no answer came back) is not tried again. Replies to one place (a channel, or a thread in
// it) go in the order they were owed: a later one waits while an earlier one is still owed. Whatever is given up is
// said in the daemon's log and the activity feed, with why.

const OwedReplySchema = z.object({
    id: z.string(),
    provider: z.string(),
    channelId: z.string(),
    thread: z.string().optional(),
    text: z.string(),
    // When it was owed, and when it is next tried.
    at: z.number(),
    nextAt: z.number(),
    attempts: z.number(),
    lastError: z.string().optional(),
});
export type OwedReply = z.infer<typeof OwedReplySchema>;

export const listenerOutboxDocument = defineDocument({
    root: "history",
    path: "listener-reply-outbox.json",
    // Replies owed to a gateway's channel, kept until the gateway takes them; travels with the conversations they answer.
    portability: "carry",
    granularity: "entries",
    schema: OwedReplySchema,
});

// How long a reply is owed before it is given up: past this, an answer arriving in the thread reads as a stray.
export const OWED_TTL_MS = 24 * 60 * 60 * 1000;
// Replies owed at once; past it the oldest goes, so a gateway gone for good cannot grow the file without bound.
const OWED_MAX = 500;
// Tries a reply the provider keeps failing gets (a 502 from the gateway), about eight minutes of backoff.
export const FAILED_TRIES_MAX = 8;
const BACKOFF_FIRST_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

export const backoffAfter = (attempts: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1));

type Deps = Pick<Services, "config">;
const outbox = (services: Deps) => openEntries(listenerOutboxDocument, join(services.config.historyRoot, listenerOutboxDocument.path));

export const owedReplies = (services: Deps): Promise<OwedReply[]> => outbox(services).read();

// Whether the provider's gateway posts one reply id once, by what its last status said it does.
const gatewayDedupes = (provider: string, now: number): boolean => listenerStatus(provider, now)?.features?.includes(DELIVER_ID_FEATURE) === true;

// What to do with a reply whose try failed so: why it is given up, or undefined to try it again.
export const givenUpBecause = (failure: GatewayFailure, attempts: number, dedupes: boolean): string | undefined => {
    switch (failure) {
        case "unreachable":
            return undefined;
        case "ambiguous":
            return dedupes ? undefined : "the gateway never answered and may have posted it; it cannot tell a retry from a new message, so it was not sent again";
        case "failed":
            return attempts >= FAILED_TRIES_MAX ? `the provider failed it ${attempts} times` : undefined;
        case "refused":
            return "the gateway refused it";
    }
};

const placeOf = (reply: OwedReply): string => `${reply.provider}\u0000${reply.channelId}\u0000${reply.thread ?? ""}`;

// What one pass decided for each reply it looked at.
interface Pass {
    readonly sent: Set<string>;
    readonly gaveUp: Map<string, string>;
    readonly retry: Map<string, { readonly nextAt: number; readonly attempts: number; readonly lastError: string }>;
}

const gaveUp = (services: Pick<Services, "logger" | "activity">, reply: OwedReply, reason: string): void => {
    services.logger.error(
        { provider: reply.provider, channelId: reply.channelId, thread: reply.thread, attempts: reply.attempts, lastError: reply.lastError, reason, owedFor: Date.now() - reply.at },
        "channel reply outbox: gave up on a reply the channel never took",
    );
    void services.activity
        .append({
            provider: reply.provider,
            direction: "out",
            type: "message.send",
            channelId: reply.channelId,
            content: reply.text,
            outcome: "error",
            error: `Never reached the channel: ${reason}.`,
        })
        .catch((error: Error) => services.logger.warn({ err: error }, "activity append failed"));
};

// One try of one reply, into the pass.
const tryReply = async (services: Services, deliver: DeliverToGateway, reply: OwedReply, pass: Pass, now: number): Promise<boolean> => {
    try {
        const delivered = await deliver(services, reply.provider, reply.channelId, reply.text, reply.thread, reply.id);
        if (delivered === undefined) {
            pass.gaveUp.set(reply.id, `no extension listens on ${reply.provider} any more`);
            return true;
        }
        pass.sent.add(reply.id);
        return true;
    } catch (error) {
        const failure: GatewayFailure = error instanceof GatewayDeliveryError ? error.failure : "failed";
        const attempts = reply.attempts + 1;
        const reason = givenUpBecause(failure, attempts, gatewayDedupes(reply.provider, now));
        if (reason !== undefined) {
            pass.gaveUp.set(reply.id, `${reason} (${errorMessage(error)})`);
            return true;
        }
        pass.retry.set(reply.id, { attempts, nextAt: Date.now() + backoffAfter(attempts), lastError: errorMessage(error) });
        return false;
    }
};

// One pass over what is owed, oldest first: each due reply tried unless an earlier one to its place is still owed. What
// the pass decided is written back over the file as it now stands, so a reply owed meanwhile is kept. Answers when the
// next reply falls due, if one does.
const drainPass = async (services: Services, deliver: DeliverToGateway, now: number): Promise<number | undefined> => {
    const pass: Pass = { sent: new Set(), gaveUp: new Map(), retry: new Map() };
    const waiting = new Set<string>();
    for (const reply of await owedReplies(services)) {
        const place = placeOf(reply);
        if (waiting.has(place)) {
            continue;
        }
        if (now - reply.at > OWED_TTL_MS) {
            pass.gaveUp.set(reply.id, `it was owed longer than a day${reply.lastError === undefined ? "" : ` (last: ${reply.lastError})`}`);
            continue;
        }
        if (reply.nextAt > now || !(await tryReply(services, deliver, reply, pass, now))) {
            waiting.add(place);
        }
    }
    // Filled afresh by each run of the update, which may run more than once; said once it is written.
    let dropped: Array<{ readonly reply: OwedReply; readonly reason: string }> = [];
    const left = await outbox(services).update((entries) => {
        dropped = [];
        return entries.flatMap((entry) => {
            const reason = pass.gaveUp.get(entry.id);
            if (reason !== undefined) {
                dropped.push({ reply: entry, reason });
                return [];
            }
            if (pass.sent.has(entry.id)) {
                return [];
            }
            const retry = pass.retry.get(entry.id);
            return retry === undefined ? [entry] : [{ ...entry, ...retry }];
        });
    });
    for (const { reply, reason } of dropped) {
        gaveUp(services, reply, reason);
    }
    return left.length === 0 ? undefined : Math.min(...left.map((entry) => entry.nextAt));
};

// One drain per daemon: a kick during a pass runs one more pass after it, and a timer wakes it when the next reply falls due.
interface Drainer {
    running: Promise<void> | undefined;
    again: boolean;
    timer: ReturnType<typeof setTimeout> | undefined;
}

// One per daemon, found by its automations store, as the automation dispatchers keep theirs: a restart test's second
// daemon on the same history starts with none of the first's.
const drainersOfStore = new WeakMap<object, Drainer>();
const drainersOf = {
    of: (services: Pick<Services, "automations">): Drainer => {
        const found = drainersOfStore.get(services.automations);
        if (found !== undefined) {
            return found;
        }
        const made: Drainer = { running: undefined, again: false, timer: undefined };
        drainersOfStore.set(services.automations, made);
        return made;
    },
};

// Tries what is owed now, and keeps trying until nothing is. Answers once this pass (and any it was asked for meanwhile)
// is done; never rejects, a pass that failed is logged and tried again on the backoff.
export const drainOwedReplies = (services: Services, deliver: DeliverToGateway = deliverThroughGateway): Promise<void> => {
    const drainer = drainersOf.of(services);
    if (drainer.running !== undefined) {
        drainer.again = true;
        return drainer.running;
    }
    clearTimeout(drainer.timer);
    drainer.timer = undefined;
    const run = async (): Promise<void> => {
        let due: number | undefined;
        do {
            drainer.again = false;
            due = await drainPass(services, deliver, Date.now()).catch((error: Error) => {
                services.logger.warn({ err: error }, "channel reply outbox: a pass failed, tried again shortly");
                return Date.now() + BACKOFF_FIRST_MS;
            });
        } while (drainer.again);
        drainer.running = undefined;
        if (due !== undefined) {
            drainer.timer = setTimeout(() => void drainOwedReplies(services, deliver), Math.max(0, due - Date.now()));
            drainer.timer.unref();
        }
    };
    drainer.running = run();
    return drainer.running;
};

// Owes `text` to the channel (and thread) the origin names, journalled before this answers, and starts trying it. An
// origin with no channel has nowhere to go. (2026-11-26) A Visitor chat's reply goes to its extension's gateway like any
// other, which puts it in the outbox the visitor's browser drains; the daemon wrote that outbox itself until then.
export const oweToListenerChannel = async (
    services: Services,
    origin: AgentOrigin,
    text: string,
    deliver: DeliverToGateway = deliverThroughGateway,
): Promise<"owed" | "no-gateway"> => {
    if (origin.channelId === undefined) {
        return "no-gateway";
    }
    const now = Date.now();
    const reply: OwedReply = {
        id: randomUUID(),
        provider: origin.provider,
        channelId: origin.channelId,
        ...opt("thread", origin.threadId),
        text,
        at: now,
        nextAt: now,
        attempts: 0,
    };
    let crowdedOut: OwedReply[] = [];
    await outbox(services).update((entries) => {
        const kept = [...entries, reply];
        crowdedOut = kept.slice(0, Math.max(0, kept.length - OWED_MAX));
        return kept.slice(-OWED_MAX);
    });
    for (const oldest of crowdedOut) {
        gaveUp(services, oldest, `more than ${OWED_MAX} replies were owed at once, and it was the oldest`);
    }
    void drainOwedReplies(services, deliver);
    return "owed";
};

// What an earlier daemon still owed when it stopped: tried again once the gate opens.
export const owedRepliesInFlight = defineInFlight({
    name: "channel replies owed",
    read: async (services: Deps) => owedReplies(services),
    recover: async (services: Services) => drainOwedReplies(services),
});

// A turn's answer gathered for somewhere no live stream reaches, and when it is journalled there. `TurnStream.end` returns
// void, so without `settled` the write is still in flight when the turn returns: a restart then loses the answer.
export interface OutboxSink {
    readonly stream: TurnStream;
    readonly settled: () => Promise<void>;
}

// The sink an approved wake from a gateway's channel answers into: the stream that carried the request closed when it
// was held, so the answer is gathered whole and owed to the channel's gateway once the turn ends (listener-outbox.ts),
// into the thread it came from, and retried until the gateway takes it. Attaching it earns the run its STREAM_NOTE, so
// the agent does not also post the reply itself. A turn that failed says so, as a live one would. Undefined for an
// origin with no channel (a webhook, a schedule). `settled` answers once the answer is journalled, not posted.
export const channelAnswerSink = (services: Services, origin: AgentOrigin | undefined): OutboxSink | undefined => {
    if (origin?.channelId === undefined) {
        return undefined;
    }
    let text = "";
    let failure: string | undefined;
    let posted: Promise<void> = Promise.resolve();
    return {
        stream: {
            delta: (chunk) => {
                text += chunk;
            },
            failed: (reason) => {
                failure = reason;
            },
            end: () => {
                const answer = failure === undefined ? text.trim() : `⚠️ ${failure}`;
                if (answer === "") {
                    return;
                }
                posted = oweToListenerChannel(services, origin, answer)
                    .then(() => undefined)
                    .catch((error: Error) => services.logger.error({ err: error, provider: origin.provider }, "held wake: the answer could not be journalled for its channel"));
            },
        },
        settled: () => posted,
    };
};
