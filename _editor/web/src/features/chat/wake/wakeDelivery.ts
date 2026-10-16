import { type Ref, ref, shallowRef } from "vue";
import { track } from "../../../app/analytics";
import type { WakeRequest } from "../../../models/voice/phraseGate";
import { alternativeOf, routeWake, type WakeRoute, type WakeSituation, type WakeTarget } from "./wakeRoute";
import { askedForNew } from "../../../models/voice/wakeWord";

// Where a request said to the agent by name goes, and the moment before it goes. The rule is wakeRoute.ts's; this is the
// doing: the words wait GLANCE_MS on a card that says where they are bound, which the reader may send at once, send to
// the other place instead, or drop, and then they go. What it went to becomes the exchange under way (the thread),
// which the next request may go on in. Free of the chat's own modules, which the shell wires in (WakeListener.vue), so
// the doing can be pinned without a chat.

/** How long words wait on the card before they go: long enough to read where, short enough not to wait on. */
export const GLANCE_MS = 2000;
/** How long the card stays after the words went, saying where. */
export const SENT_SHOWN_MS = 4000;

/** One conversation open in this window, as the delivery reads it. */
export interface WakeConversation extends WakeTarget {
    /** Its title, or undefined for a chat with none yet. */
    readonly title: string | undefined;
}

/** What the delivery needs of the chat around it. */
export interface DeliveryHost {
    readonly now: () => number;
    /** A conversation open in this window, by id. */
    readonly lookup: (id: string) => WakeConversation | undefined;
    /** The chat in front of the reader, while this window is on screen. */
    readonly focused: () => WakeConversation | undefined;
    /** Starts a new session with these words, or empty; answers its id. */
    readonly startNew: (text: string) => string;
    /** Sends the words on in a conversation (shown, its turn started or the words queued). */
    readonly continueIn: (id: string, text: string) => void;
    /** Answers the card waiting in a conversation with the words; false when they cannot be read as an answer. */
    readonly answer: (id: string, text: string) => boolean;
    /** Says that the words were no answer to the card. */
    readonly unclear: () => void;
    /** The next phrase is the request (for a new session opened with nothing in it yet). */
    readonly expectRequest: () => void;
    /** Holds the person's other devices off the exchange this device is now in. */
    readonly hold: () => void;
    readonly sent: () => void;
    readonly dropped: () => void;
    /** Tells a reader who is not looking where the words went. */
    readonly notify: (destination: Destination, text: string) => void;
}

/** Where words are bound, as the card names it. */
export interface Destination {
    readonly route: WakeRoute;
    /** The conversation's title; undefined for a new session, or a chat with no title yet. */
    readonly title: string | undefined;
}

/** Words waiting on the card. */
export interface PendingWake {
    readonly text: string;
    readonly to: Destination;
    /** The other place they could go, offered as the switch. */
    readonly instead: Destination | undefined;
    /** When they go by themselves (epoch ms). */
    readonly until: number;
    /** The reader switched them once already. */
    readonly switched: boolean;
}

/** Words that went, for the card's last moment. */
export interface SentWake {
    readonly text: string;
    readonly to: Destination;
    /** The conversation they went to. */
    readonly id: string;
    readonly at: number;
}

export class WakeDelivery {
    readonly pending: Ref<PendingWake | undefined> = shallowRef();
    readonly sent: Ref<SentWake | undefined> = shallowRef();
    /** The conversation the last request went to, and when: the exchange under way. */
    readonly thread = ref<{ readonly id: string; readonly at: number }>();
    private calledFor: string | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private sentTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly host: DeliveryHost) {}

    /** Words said to the agent: routed, put on the card, and sent once its moment passes. */
    readonly heard = (request: WakeRequest): void => {
        this.clearPending();
        const opened = this.calledFor === undefined ? undefined : this.host.lookup(this.calledFor);
        this.calledFor = undefined;
        if (request.via === `called` && opened !== undefined) {
            // The request a new session was opened to wait for: it goes there, no question.
            this.go(request.text, this.destination({ kind: `continue`, id: opened.id, why: `thread` }), false);
            return;
        }
        const asked = askedForNew(request.text);
        const text = asked?.request ?? request.text;
        if (asked !== undefined && text === ``) {
            // "Leon, new session" with nothing yet to put in it: open it, and take the next phrase as its request.
            this.calledFor = this.host.startNew(``);
            this.thread.value = { id: this.calledFor, at: this.host.now() };
            this.host.expectRequest();
            track(`voice_wake_routed`, { kind: `new`, why: `asked`, empty: true });
            return;
        }
        const situation = this.situation(asked !== undefined);
        const route = routeWake(situation);
        const instead = alternativeOf(route, situation);
        this.pending.value = {
            text,
            to: this.destination(route),
            instead: instead === undefined ? undefined : this.destination(instead),
            until: this.host.now() + GLANCE_MS,
            switched: false,
        };
        this.timer = setTimeout(this.sendNow, GLANCE_MS);
    };

    /** Sends the waiting words now, where the card says. */
    readonly sendNow = (): void => {
        const waiting = this.pending.value;
        if (waiting === undefined) {
            return;
        }
        this.clearPending();
        this.go(waiting.text, waiting.to, waiting.switched);
    };

    /** Sends the waiting words to the other place instead, after a fresh moment to read it. */
    readonly switchRoute = (): void => {
        const waiting = this.pending.value;
        if (waiting?.instead === undefined) {
            return;
        }
        clearTimeout(this.timer);
        this.pending.value = { ...waiting, to: waiting.instead, instead: waiting.to, until: this.host.now() + GLANCE_MS, switched: !waiting.switched };
        this.timer = setTimeout(this.sendNow, GLANCE_MS);
    };

    /** Drops the waiting words. */
    readonly cancel = (): void => {
        if (this.pending.value === undefined) {
            return;
        }
        track(`voice_wake_cancelled`, {});
        this.clearPending();
        this.host.dropped();
    };

    readonly dispose = (): void => {
        this.clearPending();
        clearTimeout(this.sentTimer);
    };

    private clearPending(): void {
        clearTimeout(this.timer);
        this.pending.value = undefined;
    }

    private situation(askedForNewSession: boolean): WakeSituation {
        const thread = this.thread.value;
        const open = thread === undefined ? undefined : this.host.lookup(thread.id);
        return {
            now: this.host.now(),
            askedForNew: askedForNewSession,
            // The words the last request carried may not be in its transcript yet: the request is itself something said.
            thread: open === undefined || thread === undefined ? undefined : { ...open, lastSaidAt: Math.max(open.lastSaidAt ?? 0, thread.at) },
            onScreen: this.host.focused(),
        };
    }

    private destination(route: WakeRoute): Destination {
        return { route, title: route.kind === `new` ? undefined : this.host.lookup(route.id)?.title };
    }

    private go(text: string, to: Destination, switched: boolean): void {
        const { route } = to;
        let id: string;
        if (route.kind === `answer`) {
            id = route.id;
            if (!this.host.answer(id, text)) {
                this.host.unclear();
                this.thread.value = { id, at: this.host.now() };
                return;
            }
        } else if (route.kind === `continue`) {
            id = route.id;
            this.host.continueIn(id, text);
        } else {
            id = this.host.startNew(text);
        }
        this.thread.value = { id, at: this.host.now() };
        this.host.hold();
        this.host.sent();
        this.host.notify(to, text);
        track(`voice_wake_routed`, { kind: route.kind, why: route.why, switched });
        clearTimeout(this.sentTimer);
        this.sent.value = { text, to, id, at: this.host.now() };
        this.sentTimer = setTimeout(() => {
            this.sent.value = undefined;
        }, SENT_SHOWN_MS);
    }
}
