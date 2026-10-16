import { WAKE_WORD_DEFAULT } from "@intentic/sandbox-contract/schemas/speech";
import { computed, type ComputedRef, ref, shallowRef } from "vue";
import { track } from "../../app/analytics";
import { sandboxRaw } from "../../client/sandbox/sandboxRaw";
import { openSpeechLink, type SpeechLink, type SpeechLinkEvents } from "./speechLink";
import { voiceUnsupported } from "./useVoiceInput";
import { createSegmenter, type Segmenter } from "./voiceAudio";
import { PhraseGate, type WakeMode, type WakeRequest } from "./phraseGate";
import { type OpenWakeMic, openWakeMic, type WakeMic } from "./wakeMic";
import { playWakeSound, type WakeSound, wakeSoundMs } from "./wakeSounds";

export type { WakeMode, WakeRequest } from "./phraseGate";

// LISTENING FOR THE AGENT'S NAME, on a device whose reader switched it on: the microphone stays open, the silence
// segmenter (voiceAudio.ts) cuts what it hears into phrases, and only a phrase that opens with the wake word becomes a
// request (phraseGate.ts). Hearing is this sandbox's own model, the one dictation uses, over the same live wire
// (speechLink.ts), asked for finals alone. Nothing heard is kept.
//
// What a phrase means is decided when it opens, by the listener's mode:
// - `wake`: listening for the name. "Leon, fix the build" is a request; "Leon" alone moves to `called`.
// - `called`: the name was said on its own, so the next phrase (within CALLED_MS) is the request, name or not.
// - `following`: an answer was just given (the delivery says so: wakeDelivery.ts), so the next phrase within the window
//   goes on without the name, as a person answers back.
// One window per browser listens (a Web Lock), and one device per person acts on a wake (POST /speech/wake): every
// device in earshot hears the same "Leon".

/** How long after the name alone the next phrase is taken as the request. */
export const CALLED_MS = 8000;
/** How long after an answer the person may answer back without the name. */
export const FOLLOWING_MS = 8000;
/** How long the live wire is kept with nothing said, before it is let go (it is dialled again at the next phrase). */
const LINK_IDLE_MS = 120_000;
/** How long a mic that opened waits to run before the listener says it needs a click. */
const BLOCKED_AFTER_MS = 1500;
/** How long this device keeps the person's other devices off a wake it acted on: the exchange that usually follows. */
export const WAKE_HOLD_MS = 2 * 60_000;

const ENABLED_KEY = `intentic.wake.on`;
const PAUSED_KEY = `intentic.wake.pausedUntil`;
const DEVICE_KEY = `intentic.wake.device`;
const LOCK_NAME = `intentic.wake`;

/**
 * Where listening stands:
 * - `off`: not switched on here, or paused.
 * - `unsupported`: this page can never capture (insecure, a policy withholding the microphone, an old browser).
 * - `elsewhere`: another window of this browser is the one listening.
 * - `starting`: the microphone is opening (its permission prompt included).
 * - `blocked`: the microphone is open but the browser waits for a click on the page before any sound runs.
 * - `listening`: hearing.
 * - `failed`: stopped on `error`.
 */
export type WakePhase = `off` | `unsupported` | `elsewhere` | `starting` | `blocked` | `listening` | `failed`;
/** `needs-rebuild`: a sandbox that cannot hear at all; `unavailable`: one too old for the live wire. */
export type WakeError = `mic-blocked` | `no-mic` | `needs-rebuild` | `unavailable`;

/** The seams a test replaces. */
export interface WakeDeps {
    readonly openMic: OpenWakeMic;
    readonly openLink: (lang: string, events: SpeechLinkEvents) => SpeechLink;
    /** Claims a wake for this device, keeping its other devices off for `holdMs`; false when another device holds it. */
    readonly claim: (device: string, holdMs: number) => Promise<boolean>;
    /** Calls `held` once this window is the one that listens, and lets go when `signal` aborts. */
    readonly lock: (held: () => void, signal: AbortSignal) => void;
    readonly storage: Pick<Storage, `getItem` | `setItem` | `removeItem`> | undefined;
    readonly now: () => number;
    readonly lang: () => string;
    readonly supported: () => boolean;
    readonly sound: (sound: WakeSound) => void;
    /** Waits for the next press or key on the page, which is what lets a browser start sound; returns the way to stop. */
    readonly onGesture: (listener: () => void) => () => void;
}

const mintDevice = (): string => Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(36).padStart(2, `0`)).join(``);

class Listener {
    readonly enabled = ref(false);
    readonly word = ref(WAKE_WORD_DEFAULT);
    readonly phase = ref<WakePhase>(`off`);
    readonly mode = ref<WakeMode>(`wake`);
    /** Until when the mode holds (epoch ms), for a `called` or `following` window. */
    readonly modeUntil = ref<number>();
    readonly pausedUntil = ref<number>();
    readonly error = ref<WakeError>();
    /** The microphone's level, 0…1, while it hears. */
    readonly level = ref(0);
    /** A phrase is being spoken into it now. */
    readonly speaking = ref(false);
    /** Phrases sent and not heard back yet. */
    readonly hearing = ref(0);
    private readonly deafFor = shallowRef<ReadonlySet<string>>(new Set());
    /** The microphone is open but deaf: the agent's own voice speaks, a composer took the microphone, a sound plays. */
    readonly deaf: ComputedRef<boolean> = computed(() => this.deafFor.value.size > 0);
    /** This device's id, as its wake claims name it. */
    readonly device: string;

    private handler: ((request: WakeRequest) => void) | undefined;
    private lockAbort: AbortController | undefined;
    private mic: WakeMic | undefined;
    private segmenter: Segmenter | undefined;
    private link: SpeechLink | undefined;
    private linkIdle: ReturnType<typeof setTimeout> | undefined;
    private modeTimer: ReturnType<typeof setTimeout> | undefined;
    private pauseTimer: ReturnType<typeof setTimeout> | undefined;
    private releaseGesture: (() => void) | undefined;
    // Each start's own generation: an arm that resolves after a stop speaks for nobody.
    private generation = 0;
    // Whether the window this runs in listens at all (WakeListener.vue starts it): a surface that only reads where
    // listening stands (the status bar, the settings) never opens a microphone by asking.
    private started = false;
    private readonly gate: PhraseGate;

    constructor(private readonly deps: WakeDeps) {
        const stored = (key: string): string | null => deps.storage?.getItem(key) ?? null;
        this.readStored();
        this.device = stored(DEVICE_KEY) ?? mintDevice();
        deps.storage?.setItem(DEVICE_KEY, this.device);
        this.gate = new PhraseGate({
            mode: () => this.mode.value,
            word: () => this.word.value,
            wire: this.wire,
            claim: () => deps.claim(this.device, WAKE_HOLD_MS),
            request: (request) => {
                if (request.text.trim() !== ``) {
                    this.handler?.(request);
                }
            },
            called: this.called,
            idle: this.idleLater,
            speaking: this.speaking,
            hearing: this.hearing,
        });
    }

    /* ---- what the shell and the delivery call ---- */

    /** Listens from this window from now on, whenever listening is wanted. */
    readonly start = (): void => {
        this.started = true;
        this.sync();
    };

    /** Takes up what another window of this browser switched (its storage changed under this one). */
    readonly reload = (): void => {
        this.readStored();
        this.sync();
    };

    /** Switches listening on or off on this device (a press: the gesture that lets sound start). */
    readonly setEnabled = (on: boolean): void => {
        this.enabled.value = on;
        if (on) {
            this.deps.storage?.setItem(ENABLED_KEY, `1`);
            // Switching on is also coming back from a pause or a failure.
            this.clearPause();
            if (this.phase.value === `failed`) {
                this.phase.value = `off`;
            }
        } else {
            this.deps.storage?.removeItem(ENABLED_KEY);
        }
        track(on ? `voice_wake_on` : `voice_wake_off`, {});
        this.sync();
    };

    readonly pause = (minutes: number): void => {
        const until = this.deps.now() + minutes * 60_000;
        clearTimeout(this.pauseTimer);
        this.pausedUntil.value = until;
        this.deps.storage?.setItem(PAUSED_KEY, String(until));
        this.pauseTimer = setTimeout(this.resume, minutes * 60_000);
        this.sync();
    };

    readonly resume = (): void => {
        this.clearPause();
        this.sync();
    };

    /** Deaf for `reason` while `on`; heard again once no reason is left. */
    readonly rest = (reason: string, on: boolean): void => {
        if (this.deafFor.value.has(reason) === on) {
            return;
        }
        const next = new Set(this.deafFor.value);
        if (on) {
            next.add(reason);
            // What was being said as it went deaf is not a phrase anybody meant for it.
            this.segmenter?.discard();
            this.level.value = 0;
        } else {
            next.delete(reason);
        }
        this.deafFor.value = next;
    };

    /** The next phrase within `ms` goes on without the name. */
    readonly follow = (ms: number): void => this.setMode(`following`, ms);
    /** The next phrase is a request, as after the name alone ("Leon, new session" and nothing yet to put in it). */
    readonly expectRequest = (): void => this.called();
    /** Back to listening for the name alone. */
    readonly listenForName = (): void => this.setMode(`wake`);
    /** Holds the person's other devices off this exchange for `ms`. */
    readonly hold = (ms: number): void => void this.deps.claim(this.device, ms);

    /** Drops what is in flight and the wire: the sandbox changed under it. */
    readonly reset = (): void => {
        this.segmenter?.discard();
        this.closeLink();
        this.setMode(`wake`);
    };

    readonly onRequest = (handler: (request: WakeRequest) => void): void => {
        this.handler = handler;
    };

    /** Plays one of the listener's sounds, deaf for as long as it plays. */
    readonly sound = (which: WakeSound): void => {
        this.rest(`sound`, true);
        this.deps.sound(which);
        setTimeout(() => this.rest(`sound`, false), wakeSoundMs(which));
    };

    readonly dispose = (): void => {
        clearTimeout(this.pauseTimer);
        this.stop(`off`);
    };

    /* ---- the wire ---- */

    private readonly wire = (): SpeechLink => {
        clearTimeout(this.linkIdle);
        this.link ??= this.deps.openLink(this.deps.lang(), {
            status: () => {},
            partial: () => {},
            final: (id, text) => this.gate.final(id, text),
            failed: (id, failure) => {
                if (failure === `phrase`) {
                    this.gate.failed(id);
                    return;
                }
                this.fail(failure === `unprovisioned` ? `needs-rebuild` : `unavailable`);
            },
        });
        return this.link;
    };

    // Let go of a wire nobody is speaking into, once it has been quiet a while.
    private readonly idleLater = (): void => {
        clearTimeout(this.linkIdle);
        this.linkIdle = setTimeout(() => {
            if (this.gate.quiet) {
                this.closeLink();
            }
        }, LINK_IDLE_MS);
    };

    private closeLink(): void {
        clearTimeout(this.linkIdle);
        this.link?.close();
        this.link = undefined;
        this.gate.reset();
    }

    /* ---- modes ---- */

    private setMode(next: WakeMode, ms?: number): void {
        clearTimeout(this.modeTimer);
        this.mode.value = next;
        this.modeUntil.value = ms === undefined ? undefined : this.deps.now() + ms;
        if (ms !== undefined) {
            this.modeTimer = setTimeout(() => this.modeEnded(next), ms);
        }
    }

    // A phrase being spoken when the window closes was opened inside it, and keeps its meaning.
    private modeEnded(ended: WakeMode): void {
        if (this.mode.value !== ended) {
            return;
        }
        if (ended === `called`) {
            this.sound(`dropped`);
        }
        this.setMode(`wake`);
    }

    private readonly called = (): void => {
        // A request already being spoken is kept rather than cut by the sound's rest: it is the one just asked for.
        if (this.gate.promote()) {
            this.deps.sound(`heard`);
        } else {
            this.sound(`heard`);
        }
        this.setMode(`called`, CALLED_MS);
        this.hold(CALLED_MS + WAKE_HOLD_MS);
    };

    /* ---- the microphone ---- */

    private readonly heardFrame = (samples: Float32Array): void => {
        if (this.phase.value !== `listening` || this.segmenter === undefined) {
            return;
        }
        if (this.deaf.value) {
            this.level.value = 0;
            return;
        }
        this.level.value = this.segmenter.push(samples);
    };

    private fail(code: WakeError): void {
        this.error.value = code;
        track(`voice_wake_failed`, { code });
        this.stop(`failed`);
    }

    private stop(to: WakePhase): void {
        this.generation += 1;
        this.lockAbort?.abort();
        this.lockAbort = undefined;
        this.releaseGesture?.();
        this.releaseGesture = undefined;
        this.segmenter?.discard();
        this.segmenter = undefined;
        this.mic?.close();
        this.mic = undefined;
        this.closeLink();
        this.setMode(`wake`);
        this.level.value = 0;
        this.phase.value = to;
    }

    private running(current: number): void {
        if (current !== this.generation || this.phase.value === `listening`) {
            return;
        }
        this.releaseGesture?.();
        this.releaseGesture = undefined;
        this.phase.value = `listening`;
        this.error.value = undefined;
        track(`voice_wake_listening`, {});
    }

    // The page has not been clicked since it loaded: the next press anywhere starts the sound.
    private blockedUntilPressed(current: number, opened: WakeMic): void {
        if (current !== this.generation || opened.running()) {
            return;
        }
        this.phase.value = `blocked`;
        this.releaseGesture = this.deps.onGesture(() => {
            // allow(silent-catch): a press the browser still does not count leaves it blocked, waiting for the next.
            void opened.resume().then(() => this.running(current), () => {});
        });
    }

    private async run(current: number): Promise<void> {
        this.phase.value = `starting`;
        let opened: WakeMic;
        try {
            opened = await this.deps.openMic(this.heardFrame);
        } catch (cause) {
            if (current === this.generation) {
                const name = cause instanceof DOMException ? cause.name : ``;
                this.fail(name === `NotAllowedError` || name === `SecurityError` ? `mic-blocked` : `no-mic`);
            }
            return;
        }
        if (current !== this.generation) {
            opened.close();
            return;
        }
        this.mic = opened;
        opened.onLost(() => {
            if (current === this.generation) {
                this.fail(`no-mic`);
            }
        });
        this.segmenter = createSegmenter(this.gate);
        // allow(silent-catch): a context the browser will not start yet is the `blocked` phase, not a failure.
        void opened.resume().then(() => this.running(current), () => {});
        if (opened.running()) {
            this.running(current);
            return;
        }
        setTimeout(() => this.blockedUntilPressed(current, opened), BLOCKED_AFTER_MS);
    }

    private readStored(): void {
        const stored = (key: string): string | null => this.deps.storage?.getItem(key) ?? null;
        this.enabled.value = stored(ENABLED_KEY) === `1`;
        clearTimeout(this.pauseTimer);
        const paused = Number(stored(PAUSED_KEY));
        this.pausedUntil.value = Number.isFinite(paused) && paused > this.deps.now() ? paused : undefined;
        if (this.pausedUntil.value !== undefined) {
            this.pauseTimer = setTimeout(this.resume, this.pausedUntil.value - this.deps.now());
        }
    }

    private clearPause(): void {
        clearTimeout(this.pauseTimer);
        this.pausedUntil.value = undefined;
        this.deps.storage?.removeItem(PAUSED_KEY);
    }

    // Brings the microphone in line with what is wanted: on, not paused, and this page able to hear.
    private sync(): void {
        if (!this.started) {
            return;
        }
        const paused = this.pausedUntil.value !== undefined && this.pausedUntil.value > this.deps.now();
        if (!this.enabled.value || paused) {
            if (this.phase.value !== `off`) {
                this.stop(`off`);
            }
            return;
        }
        if (!this.deps.supported()) {
            this.phase.value = `unsupported`;
            return;
        }
        if (this.phase.value !== `off` && this.phase.value !== `failed` && this.phase.value !== `unsupported`) {
            return;
        }
        this.generation += 1;
        const current = this.generation;
        this.error.value = undefined;
        this.phase.value = `elsewhere`;
        const controller = new AbortController();
        this.lockAbort = controller;
        this.deps.lock(() => {
            if (current === this.generation) {
                void this.run(current);
            }
        }, controller.signal);
    }
}

export type WakeListener = Pick<
    Listener,
    | `enabled`
    | `start`
    | `reload`
    | `word`
    | `phase`
    | `mode`
    | `modeUntil`
    | `pausedUntil`
    | `error`
    | `level`
    | `speaking`
    | `hearing`
    | `deaf`
    | `device`
    | `setEnabled`
    | `pause`
    | `resume`
    | `rest`
    | `follow`
    | `expectRequest`
    | `listenForName`
    | `hold`
    | `reset`
    | `onRequest`
    | `sound`
    | `dispose`
>;

export const createWakeListener = (deps: WakeDeps): WakeListener => new Listener(deps);

/* ---- the page's own seams ---- */

const pageLock: WakeDeps[`lock`] = (held, signal) => {
    if (!(`locks` in navigator)) {
        held();
        return;
    }
    navigator.locks
        .request(LOCK_NAME, { signal }, async () => {
            held();
            await new Promise<void>((resolve) => signal.addEventListener(`abort`, () => resolve(), { once: true }));
        })
        // allow(silent-catch): the request aborts when listening is switched off before this window got its turn, which is the point of the signal.
        .catch(() => {});
};

const pageGesture: WakeDeps[`onGesture`] = (listener) => {
    const options = { capture: true } as const;
    const fire = (): void => listener();
    window.addEventListener(`pointerdown`, fire, options);
    window.addEventListener(`keydown`, fire, options);
    return () => {
        window.removeEventListener(`pointerdown`, fire, options);
        window.removeEventListener(`keydown`, fire, options);
    };
};

const pageStorage = (): WakeDeps[`storage`] => {
    try {
        return localStorage;
    } catch (cause) {
        // A browser that refuses storage (a SecurityError) keeps listening for this page's life alone.
        if (cause instanceof DOMException) {
            return undefined;
        }
        throw cause;
    }
};

export const pageWakeDeps = (): WakeDeps => ({
    openMic: openWakeMic,
    openLink: (lang, events) => openSpeechLink(lang, events, {}, { guesses: false }),
    claim: (device, holdMs) =>
        sandboxRaw(`POST /speech/wake`, { input: { device, holdMs } }).then(
            ({ granted }) => granted,
            // A daemon from before the claim has nobody to share a wake with but its own devices: act on it.
            () => true,
        ),
    lock: pageLock,
    storage: pageStorage(),
    now: Date.now,
    lang: () => navigator.language,
    supported: () => voiceUnsupported() === undefined,
    sound: playWakeSound,
    onGesture: pageGesture,
});

// One listener per window, made by the first surface that asks (the shell's WakeListener.vue).
let shared: WakeListener | undefined;
export const useWakeListener = (): WakeListener => (shared ??= createWakeListener(pageWakeDeps()));
