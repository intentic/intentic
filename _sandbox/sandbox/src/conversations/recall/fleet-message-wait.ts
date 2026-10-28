import { whenAborted } from "@intentic/base/async";
import { DisposableStore } from "@intentic/base/lifecycle";
import type { Services } from "../../composition.js";
import type { DomainEventMap } from "../../seams/domain-events.js";
import { opt } from "../../opt.js";
import { whenSteered } from "../actor/conversation-holdings.js";
import { holdingWords, reachedBy, waitLetGo } from "./fleet-message-outcome.js";

// `agents message --wait`: the sender parks until the turn its message reached settles, and hears how that turn ended
// and the head of its last reply, where the answer to the message alone can only say the turn was opened.

type Settled = DomainEventMap["run.settled"];

/** How the turn a message reached ended. */
export interface MessageTurnEnding {
    readonly run: string;
    // `failed` covers a refusal at the door as well as a failure partway; `stopped` is a person's or a parent's stop.
    readonly ended: "finished" | "failed" | "stopped";
    readonly failure?: string;
    // For a failed turn: what holds it now, or what would let it go (fleet-message-outcome.ts holdingWords).
    readonly holding?: string;
    // The head of its last reply; empty when it said nothing.
    readonly reply: string;
    // Characters of the reply left out of `reply`: the whole is in `agents show <to> --transcript`.
    readonly replyCut?: number;
}

export type MessageWaited =
    | { readonly outcome: "ended"; readonly ending: MessageTurnEnding }
    // `message`: words were said into the sender's own turn meanwhile, which its runtime reads only once the wait returns.
    | { readonly outcome: "timeout" | "message" | "aborted" };

export interface WaitAsk {
    readonly timeoutMs: number;
    // The caller's connection: its close ends the wait.
    readonly signal?: AbortSignal | undefined;
}

// What a message reached, as its delivery answered: the run, where one is known yet, and the id it waits under.
export interface Delivered {
    readonly to: string;
    readonly run?: string | undefined;
    readonly messageId?: string | undefined;
    readonly opened: boolean;
}

// A settle as the wait reads it, taken the moment it is heard: the hold it describes is gone once the next turn starts.
interface Heard {
    readonly settled: Settled;
    readonly holding: string | undefined;
}

// Characters of the last reply a wait hands back; the rest stays in the target's chat.
const REPLY_CHARS = 1_500;

// How long a wait lets words said into the sender's turn travel to its runtime before handing the turn back, so they
// arrive with this answer rather than after the next tool call (work-wait.ts keeps the same grace).
const HEARD_GRACE_MS = 1_500;

const endedOf = (settled: Settled): MessageTurnEnding["ended"] => {
    if (settled.failure !== undefined) {
        return "failed";
    }
    return settled.stopped === true ? "stopped" : "finished";
};

const endingOf = ({ settled, holding }: Heard): MessageTurnEnding => {
    const reply = settled.closing.slice(0, REPLY_CHARS);
    const cut = settled.closing.length - reply.length;
    return {
        run: settled.run,
        ended: endedOf(settled),
        ...opt("failure", settled.failure),
        ...opt("holding", holding),
        reply,
        ...opt("replyCut", cut > 0 ? cut : undefined),
    };
};

export interface TurnFollow {
    // Parks until the turn the message reached settles, the timeout passes, the caller goes, or words are said into the
    // sender's own turn (`from`, when it has one).
    readonly until: (delivered: Delivered, from: string | undefined, ask: WaitAsk) => Promise<MessageWaited>;
    readonly stop: () => void;
}

/**
 * Hears every settle of the target from before the message goes, so a turn that ends before the wait parks (a steered
 * turn on its last tool call) is not missed.
 */
export const followTurns = (services: Pick<Services, "events" | "agents" | "conversations">, to: string): TurnFollow => {
    const heard: Heard[] = [];
    let listen: ((one: Heard) => void) | undefined;
    const stop = services.events.subscribe("run.settled", (settled) => {
        if (settled.conversationId !== to) {
            return;
        }
        const one: Heard = { settled, holding: settled.failure === undefined ? undefined : holdingWords(services, settled) };
        heard.push(one);
        listen?.(one);
    });
    const until = (delivered: Delivered, from: string | undefined, ask: WaitAsk): Promise<MessageWaited> =>
        new Promise((resolve) => {
            const held = new DisposableStore();
            let done = false;
            const finish = (answer: MessageWaited): void => {
                if (done) {
                    return;
                }
                done = true;
                held.dispose();
                listen = undefined;
                // Given up before the turn ended: an ending still to come is the sender's news again.
                if (answer.outcome !== "ended" && delivered.messageId !== undefined) {
                    waitLetGo(services.conversations, delivered.messageId);
                }
                resolve(answer);
            };
            // Judged in the breath the settle is announced in, as the sender's own wake is (fleet-message-outcome.ts),
            // which then still sees this wait parked and stays quiet.
            const judge = (one: Heard): void => {
                if (reachedBy(services.conversations, delivered, one.settled.run) !== undefined) {
                    finish({ outcome: "ended", ending: endingOf(one) });
                }
            };
            const deadline = setTimeout(() => finish({ outcome: "timeout" }), Math.max(0, ask.timeoutMs));
            deadline.unref();
            held.push(() => clearTimeout(deadline));
            held.push(whenAborted(ask.signal, () => finish({ outcome: "aborted" })));
            if (from !== undefined) {
                let grace: ReturnType<typeof setTimeout> | undefined;
                held.push(
                    whenSteered(services.conversations, from, () => {
                        grace ??= setTimeout(() => finish({ outcome: "message" }), HEARD_GRACE_MS);
                        grace.unref();
                    }),
                );
                held.push(() => clearTimeout(grace));
            }
            listen = judge;
            for (const one of heard) {
                judge(one);
            }
        });
    return { until, stop };
};
