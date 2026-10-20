import type { Ref } from "vue";
import { track } from "../../app/analytics";
import type { SpeechLink } from "./speechLink";
import { TARGET_RATE } from "./voiceAudio";
import { wakeHeard } from "./wakeWord";

// The wake listener's gate between the room and the sandbox: each phrase the segmenter cuts is heard only as far as it
// takes to tell whether it opens with the agent's name, and the rest of it goes to the sandbox only when it did. A
// phrase opened while the listener expects a request (`called`, `following`) is the request, so it streams whole.
//
// A phrase in `wake` mode goes in two parts on the wire: its first PROBE_MS (the probe), and, once the probe's words
// open with the name and this device's claim on the wake is granted, the whole phrase again as a phrase of its own, so
// the request is heard in one piece rather than stitched from two. A phrase that ends inside its probe is whole already.

/**
 * How much of each phrase is heard to tell whether it opens with the name. Room for "Hey Leon," said slowly, and for a
 * short request whole: the segmenter closes a phrase only after a second and a half of quiet (voiceAudio.ts), which
 * streams too, so "Leon, fix the build" with its closing pause fits, and is heard once rather than twice.
 */
export const PROBE_MS = 4000;
const PROBE_SAMPLES = (PROBE_MS / 1000) * TARGET_RATE;

/** What a phrase means, fixed when it opens: listening for the name, or expecting the request itself. */
export type WakeMode = `wake` | `called` | `following`;

/** Words said to the agent: by name (`wake`), after the name alone (`called`), or back to an answer (`following`). */
export interface WakeRequest {
    readonly text: string;
    readonly via: WakeMode;
}

/**
 * What a heard phrase came to: the agent's name (`name`), words said to it (`request`: after the name, or while it
 * expected a reply), or talk that was not for it (`talk`).
 */
export type HeardVerdict = `name` | `request` | `talk`;

/** What the gate needs of the listener around it. */
export interface GateHost {
    readonly mode: () => WakeMode;
    readonly word: () => string;
    /** The live wire, dialled if it is not up. */
    readonly wire: () => SpeechLink;
    /** Claims the wake for this device; false when another device of the same person holds it. */
    readonly claim: () => Promise<boolean>;
    readonly request: (request: WakeRequest) => void;
    /** The name was said on its own: the next phrase is the request. */
    readonly called: () => void;
    /** Every phrase's words as the model wrote them and what they came to, so the person can see what was heard. */
    readonly heard: (text: string, verdict: HeardVerdict) => void;
    /** Nothing is open or in flight any more, so the wire may be let go. */
    readonly idle: () => void;
    readonly speaking: Ref<boolean>;
    readonly hearing: Ref<number>;
}

// A phrase as the gate follows it: its id on the wire, what it meant when it opened, and how far it has been heard.
interface Phrase {
    readonly id: number;
    // Fixed when it opens, except that a phrase begun before the name alone was heard becomes the request (`promote`).
    mode: WakeMode;
    // Samples sent so far while its part on the wire is still open; undefined once that part has ended.
    sent: number | undefined;
    // What was sent, kept until its part ends: the HTTP door (a daemon without the live wire) hears the samples `end`
    // hands over rather than what streamed before it.
    head: Float32Array[];
    // The wire heard the whole phrase (it ended inside the probe, or it was streamed whole).
    whole: boolean;
    verdict: `pending` | `wake` | `talk`;
    // The whole phrase, once it ended, while the probe's verdict is still out.
    full?: Float32Array;
    claimed?: Promise<boolean>;
}

const joined = (parts: readonly Float32Array[]): Float32Array => {
    const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};

// The first word off, for the rare whole phrase whose opening the model heard differently the second time.
const withoutFirstWord = (text: string): string => text.replace(/^\s*\S+[\s\p{P}]*/u, ``).trim();

export class PhraseGate {
    private nextId = 0;
    private open: Phrase | undefined;
    private readonly phrases = new Map<number, Phrase>();

    constructor(private readonly host: GateHost) {}

    /** Phrases neither open nor waiting on the wire. */
    get quiet(): boolean {
        return this.open === undefined && this.phrases.size === 0;
    }

    /**
     * The name was just heard on its own while the next phrase is already being spoken ("Leon" … "fix the build", the
     * second begun before the first was heard back): that phrase is the request, so it stops being a probe and streams
     * whole. False when no phrase is open early enough to be one.
     */
    readonly promote = (): boolean => {
        const phrase = this.open;
        if (phrase?.mode !== `wake` || phrase.sent === undefined) {
            return false;
        }
        phrase.mode = `called`;
        return true;
    };

    /** Forgets everything in flight: the wire it was on is gone. */
    readonly reset = (): void => {
        this.open = undefined;
        this.phrases.clear();
        this.host.speaking.value = false;
        this.host.hearing.value = 0;
    };

    /* ---- the segmenter's side ---- */

    readonly begin = (opening: Float32Array): void => {
        this.host.speaking.value = true;
        const phrase: Phrase = { id: this.nextId++, mode: this.host.mode(), sent: 0, head: [], whole: false, verdict: `pending` };
        this.open = phrase;
        this.phrases.set(phrase.id, phrase);
        const head = phrase.mode === `wake` ? opening.subarray(0, PROBE_SAMPLES) : opening;
        this.host.wire().begin(phrase.id, head);
        phrase.sent = head.length;
        phrase.head.push(head);
        this.probeFull(phrase);
    };

    readonly audio = (frame: Float32Array): void => {
        const phrase = this.open;
        if (phrase?.sent === undefined) {
            return;
        }
        const room = phrase.mode === `wake` ? PROBE_SAMPLES - phrase.sent : frame.length;
        const part = frame.length <= room ? frame : frame.subarray(0, room);
        this.host.wire().audio(phrase.id, part);
        phrase.sent += part.length;
        phrase.head.push(part);
        this.probeFull(phrase);
    };

    readonly end = (samples: Float32Array): void => {
        this.host.speaking.value = false;
        const phrase = this.open;
        this.open = undefined;
        if (phrase === undefined) {
            return;
        }
        if (phrase.sent !== undefined) {
            // Ended inside its probe, or streamed whole: the wire heard all of it, and these are its samples trimmed.
            phrase.whole = true;
            this.endOnWire(phrase, samples);
            return;
        }
        if (phrase.verdict === `wake`) {
            this.sendWhole(phrase, samples);
        } else if (phrase.verdict === `pending`) {
            phrase.full = samples;
        } else {
            this.forget(phrase);
        }
    };

    readonly drop = (): void => {
        this.host.speaking.value = false;
        const phrase = this.open;
        this.open = undefined;
        if (phrase?.sent !== undefined) {
            this.host.wire().drop(phrase.id);
            this.forget(phrase);
        }
    };

    /* ---- the wire's side ---- */

    readonly final = (id: number, text: string): void => {
        const phrase = this.settle(id);
        if (phrase === undefined) {
            return;
        }
        if (phrase.mode !== `wake`) {
            this.forget(phrase);
            this.expected(phrase.mode, text);
            return;
        }
        if (phrase.verdict === `wake`) {
            // The whole phrase, heard again after its probe opened with the name.
            this.forget(phrase);
            this.host.heard(text, `request`);
            this.host.request({ text: wakeHeard(text, this.host.word())?.request ?? withoutFirstWord(text), via: `wake` });
            return;
        }
        this.probed(phrase, text);
    };

    /** One phrase could not be heard: it is let go, and the rest go on. */
    readonly failed = (id: number | undefined): void => {
        const phrase = id === undefined ? undefined : this.settle(id);
        if (phrase !== undefined) {
            this.forget(phrase);
        }
    };

    /* ---- the gate itself ---- */

    // A probe at its full length ends on the wire; the phrase goes on being cut locally, for its whole.
    private probeFull(phrase: Phrase): void {
        if (phrase.mode === `wake` && phrase.sent !== undefined && phrase.sent >= PROBE_SAMPLES) {
            this.endOnWire(phrase, joined(phrase.head));
        }
    }

    private endOnWire(phrase: Phrase, samples: Float32Array): void {
        phrase.sent = undefined;
        phrase.head = [];
        this.host.hearing.value += 1;
        this.host.wire().end(phrase.id, samples);
    }

    private settle(id: number): Phrase | undefined {
        const phrase = this.phrases.get(id);
        if (phrase !== undefined && phrase.sent === undefined) {
            this.host.hearing.value = Math.max(0, this.host.hearing.value - 1);
        }
        return phrase;
    }

    private forget(phrase: Phrase): void {
        this.phrases.delete(phrase.id);
        if (this.quiet) {
            this.host.idle();
        }
    }

    // A phrase opened while a request was expected: all of it is the request, less the name if it was said again.
    private expected(mode: WakeMode, text: string): void {
        const called = wakeHeard(text, this.host.word());
        const request = called === undefined ? text.trim() : called.request;
        if (mode === `called` && request === ``) {
            this.host.heard(text, `name`);
            this.host.called();
            return;
        }
        this.host.heard(text, `request`);
        this.host.request({ text: request, via: called === undefined ? mode : `wake` });
    }

    // A probe's words: talk to let go, or the name, which is claimed and then heard whole.
    private probed(phrase: Phrase, text: string): void {
        const called = wakeHeard(text, this.host.word());
        this.host.heard(text, called === undefined ? `talk` : `name`);
        if (called === undefined) {
            phrase.verdict = `talk`;
            phrase.full = undefined;
            this.forget(phrase);
            return;
        }
        track(`voice_wake_heard`, { whole: phrase.whole, request: called.request !== `` });
        phrase.verdict = `wake`;
        phrase.claimed = this.host.claim();
        if (!phrase.whole) {
            if (phrase.full !== undefined) {
                this.sendWhole(phrase, phrase.full);
            }
            return;
        }
        this.forget(phrase);
        void phrase.claimed.then((granted) => this.granted(granted, called.request));
    }

    private granted(granted: boolean, request: string): void {
        if (!granted) {
            track(`voice_wake_yielded`, {});
            return;
        }
        if (request === ``) {
            this.host.called();
            return;
        }
        this.host.request({ text: request, via: `wake` });
    }

    private sendWhole(phrase: Phrase, samples: Float32Array): void {
        phrase.full = undefined;
        const claimed = phrase.claimed ?? Promise.resolve(true);
        void claimed.then((granted) => {
            if (!granted) {
                track(`voice_wake_yielded`, {});
                this.forget(phrase);
                return;
            }
            const whole: Phrase = { id: this.nextId++, mode: `wake`, sent: undefined, head: [], whole: true, verdict: `wake` };
            this.phrases.delete(phrase.id);
            this.phrases.set(whole.id, whole);
            this.host.hearing.value += 1;
            const wire = this.host.wire();
            wire.begin(whole.id, samples);
            wire.end(whole.id, samples);
        });
    }
}
