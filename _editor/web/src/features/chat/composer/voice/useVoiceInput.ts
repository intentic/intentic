import type { SpeechStatus } from "@intentic/sandbox-contract";
import { Latest } from "@intentic/base/async";
import { ref, type Ref, shallowRef } from "vue";
import { track } from "../../../../app/analytics";
import { type BrowserSpeech, browserSpeechFor } from "./browserSpeech";
import { openSpeechLink, prepareSpeech, type SpeechLink, type SpeechTransport } from "./speechLink";
import { createSegmenter, resampleTo16k, type Segmenter } from "./voiceAudio";

// Hands-free voice input: the mic is captured in-page (AudioWorklet), the silence segmenter (voiceAudio.ts) cuts the
// stream into phrases, and each phrase streams to the sandbox's own speech engine as it is spoken (speechLink.ts);
// audio never leaves the user's infrastructure. The press opens the microphone at once, whatever the model is doing:
// phrases spoken while it loads or downloads wait for it and are written out when it is ready, never lost, and the
// download's progress is `model`'s to show. Per-call state; "send" is the composer's business.

// Capture worklet, inlined as a blob string so it loads identically in a floating window and the dev server.
const CAPTURE_WORKLET = `
class IntenticVoiceCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.chunks = [];
        this.length = 0;
    }
    process(inputs) {
        const channel = inputs[0]?.[0];
        if (channel !== undefined) {
            this.chunks.push(new Float32Array(channel));
            this.length += channel.length;
            if (this.length >= 2048) {
                const batch = new Float32Array(this.length);
                let at = 0;
                for (const chunk of this.chunks) {
                    batch.set(chunk, at);
                    at += chunk.length;
                }
                this.chunks = [];
                this.length = 0;
                this.port.postMessage(batch, [batch.buffer]);
            }
        }
        return true;
    }
}
registerProcessor("intentic-voice-capture", IntenticVoiceCapture);
`;

// `preparing` is only the microphone opening (its permission prompt included): the model's readiness is not a state
// the person waits in, since they speak while it gets ready (`model`, `pending`).
export type VoiceState = `idle` | `preparing` | `listening`;

// `needs-rebuild` is a sandbox that cannot hear at all; `unavailable` is voice failing to start (daemon too old for
// /speech); `fetch-failed` is the model's download failing, which a retry restarts; `failed` is an utterance lost
// mid-session; the rest are the microphone's own.
export type VoiceError = `mic-blocked` | `no-mic` | `needs-rebuild` | `unavailable` | `fetch-failed` | `failed`;

// Why this page can never capture, whatever the sandbox says: served over plain http, a Permissions-Policy that
// withholds the microphone (nginx.conf shipped `microphone=()` and every Chromium refused every press), or a browser
// without getUserMedia or AudioWorklet.
export type VoiceUnsupported = `insecure` | `policy` | `browser`;

/** The slice of the page the capability check reads, so a test can hand it a browser of its own. */
export interface VoicePage {
    readonly isSecureContext?: boolean;
    readonly navigator?: { readonly mediaDevices?: { readonly getUserMedia?: unknown } };
    readonly AudioWorkletNode?: unknown;
    readonly document?: {
        readonly permissionsPolicy?: { readonly allowsFeature?: (feature: string) => boolean };
        readonly featurePolicy?: { readonly allowsFeature?: (feature: string) => boolean };
    };
}

/**
 * What stops this page from ever capturing, asked before the mic is offered rather than after a press: each of these
 * fails every press the same way, and a press that can only fail reads as one that didn't take (replays show it
 * pressed again and again).
 */
export const voiceUnsupported = (page: VoicePage = globalThis as VoicePage): VoiceUnsupported | undefined => {
    // First: an insecure page hides mediaDevices and AudioWorklet outright, which would read as an old browser.
    if (page.isSecureContext === false) {
        return `insecure`;
    }
    // Chromium's answer (`featurePolicy`, renamed `permissionsPolicy` in the spec); Firefox and Safari have neither and
    // count as allowed, since they ask the person instead.
    const policy = page.document?.permissionsPolicy ?? page.document?.featurePolicy;
    if (policy?.allowsFeature?.(`microphone`) === false) {
        return `policy`;
    }
    if (typeof page.navigator?.mediaDevices?.getUserMedia !== `function` || typeof page.AudioWorkletNode !== `function`) {
        return `browser`;
    }
    return undefined;
};

/** How a phrase's words arrived: `live` while capturing, so the composer may send them; after a stop, only written. */
export interface Heard {
    readonly live: boolean;
}

// The prepare a hover or focus sends ahead of a press, at most this often: it loads a model for ten minutes.
const WARM_EVERY_MS = 60_000;
// A press that stopped with phrases still being heard keeps the link this long for them, then lets go.
const DRAIN_MS = 120_000;

export interface VoiceInput {
    state: Ref<VoiceState>;
    /** Live microphone level (RMS, 0..1), the listening indicator's pulse. */
    level: Ref<number>;
    /** Phrases spoken and not written out yet: being heard, or waiting for the model. */
    pending: Ref<number>;
    /** A phrase is being spoken right now (the segmenter has one open). */
    speaking: Ref<boolean>;
    /** The running guess at the phrase being spoken (or the last one, until its words land). */
    interim: Ref<string>;
    /** Where the sandbox's model stands, as it last said; undefined until it has. */
    model: Ref<SpeechStatus | undefined>;
    /** The browser's own on-device recognizer is writing while the sandbox's model downloads. */
    bridged: Ref<boolean>;
    /**
     * The last failure, held until the next press, typing (`dismiss`) or the dismiss control: it used to clear itself
     * after 8 s, and a person who looked back at the composer found nothing to say why the mic hadn't come on.
     */
    error: Ref<VoiceError | undefined>;
    /** How many times in a row this same failure has come back: a press that fails again must not look like nothing. */
    repeats: Ref<number>;
    start(onTranscript: (text: string, heard: Heard) => void): void;
    /** Stop capturing; phrases already spoken are still written out (not sent) as their words land. */
    stop(): void;
    /** Stop and drop everything in flight: the pane is gone, or now holds another conversation. */
    abandon(): void;
    dismiss(): void;
    /** Ask the sandbox to fetch the model again after a failed download. */
    retry(): void;
    /** Load the model ahead of a press the pointer is about to make. */
    warm(): void;
}

export function useVoiceInput(options: { readonly lang?: () => string; readonly page?: object } = {}): VoiceInput {
    const lang = options.lang ?? (() => navigator.language);
    const state = ref<VoiceState>(`idle`);
    const level = ref(0);
    const pending = ref(0);
    const speaking = ref(false);
    const interim = ref(``);
    const model = shallowRef<SpeechStatus>();
    const bridged = ref(false);
    const error = ref<VoiceError>();
    const repeats = ref(0);

    // Outlives a press's clearing of `error`, so a press that meets the same failure counts as a repeat. Forgotten once
    // the mic actually comes on.
    let last: VoiceError | undefined;
    const fail = (code: VoiceError): void => {
        repeats.value = code === last ? repeats.value + 1 : 0;
        last = code;
        error.value = code;
        // The replays could only show a press that changed nothing; the code says which wall it hit.
        track(`voice_failed`, { code });
    };
    const dismiss = (): void => {
        error.value = undefined;
    };

    // The live capture chain. Each press's signal aborts with its teardown (or the next press), telling every async arm
    // that resolves late it speaks for nobody.
    const presses = new Latest();
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let segmenter: Segmenter | undefined;
    let bridge: BrowserSpeech | undefined;
    // The link outlives the capture while it still owes phrases (`stop`), and is closed by the next press or `abandon`.
    let link: SpeechLink | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let capturing = false;

    const closeLink = (): void => {
        clearTimeout(drainTimer);
        link?.close();
        link = undefined;
        pending.value = 0;
        interim.value = ``;
    };

    const stopCapture = (): void => {
        capturing = false;
        speaking.value = false;
        segmenter?.discard();
        segmenter = undefined;
        bridge?.stop();
        bridge = undefined;
        bridged.value = false;
        stream?.getTracks().forEach((audioTrack) => audioTrack.stop());
        stream = undefined;
        void context?.close().catch(() => {});
        context = undefined;
        level.value = 0;
        state.value = `idle`;
    };

    const abandon = (): void => {
        presses.abort();
        stopCapture();
        closeLink();
    };

    const stop = (): void => {
        // Ends a capture still being set up too (a permission prompt still open); the link answers to `link`, not to the
        // press, so what was already spoken still lands.
        presses.abort();
        stopCapture();
        if (pending.value === 0) {
            closeLink();
            return;
        }
        // Words already spoken are the person's: let them land, then let go.
        clearTimeout(drainTimer);
        drainTimer = setTimeout(closeLink, DRAIN_MS);
    };

    let warmedAt = 0;
    const warm = (): void => {
        if (Date.now() - warmedAt < WARM_EVERY_MS) {
            return;
        }
        warmedAt = Date.now();
        void prepareSpeech(lang()).then((status) => {
            if (status !== undefined && link === undefined) {
                model.value = status;
            }
        });
    };

    const retry = (): void => {
        if (error.value === `fetch-failed`) {
            error.value = undefined;
        }
        warmedAt = Date.now();
        void prepareSpeech(lang()).then((status) => {
            if (status !== undefined) {
                model.value = status;
            }
        });
    };

    const start = (onTranscript: (text: string, heard: Heard) => void): void => {
        abandon();
        error.value = undefined;
        state.value = `preparing`;
        const signal = presses.next();
        const alive = (): boolean => !signal.aborted;
        const pressedAt = performance.now();
        const language = lang();
        let transport: SpeechTransport | undefined;

        // Per phrase: when it ended (for the end-to-text latency) and its running guess.
        let nextId = 0;
        let current: number | undefined;
        const endedAt = new Map<number, number>();
        const guesses = new Map<number, string>();
        const showGuess = (): void => {
            const newest = Math.max(-1, ...guesses.keys());
            interim.value = guesses.get(newest) ?? ``;
        };
        const settled = (id: number): void => {
            if (endedAt.delete(id)) {
                pending.value = Math.max(0, pending.value - 1);
            }
            guesses.delete(id);
            showGuess();
            if (!capturing && pending.value === 0 && link === active) {
                closeLink();
            }
        };

        // The browser's on-device recognizer, asked once: it bridges only while the model is not ready yet, and only once
        // a press, so a recognizer that keeps quitting is not restarted on every progress tick.
        // allow(silent-catch): A browser without an on-device recognizer simply has no bridge; dictation waits for the daemon's model.
        const bridgeStarter = browserSpeechFor(language, options.page).catch(() => undefined);
        let bridgeTried = false;
        const maybeBridge = async (): Promise<void> => {
            const starter = await bridgeStarter;
            if (!alive() || !capturing || bridgeTried || starter === undefined || model.value === undefined || model.value.model === `ready`) {
                return;
            }
            bridgeTried = true;
            bridge = starter({
                partial: (text) => {
                    interim.value = text;
                },
                final: (text) => {
                    onTranscript(text, { live: capturing });
                    interim.value = ``;
                },
                ended: () => {
                    bridge = undefined;
                    bridged.value = false;
                },
            });
            bridged.value = true;
            track(`voice_bridged`, { engine: model.value?.engine ?? `unknown` });
        };

        const active: SpeechLink = openSpeechLink(language, {
            transport: (chosen) => {
                transport = chosen;
            },
            status: (status) => {
                if (link !== active) {
                    return;
                }
                model.value = status;
                if (status.model === `failed`) {
                    if (error.value !== `fetch-failed`) {
                        fail(`fetch-failed`);
                    }
                } else if (error.value === `fetch-failed`) {
                    error.value = undefined;
                }
                // The sandbox can hear now: the bridge hands back at the next phrase. Until then, it may write.
                if (status.model === `ready` && bridge !== undefined) {
                    bridge.stop();
                    bridge = undefined;
                    bridged.value = false;
                } else if (status.model !== `ready`) {
                    void maybeBridge();
                }
            },
            partial: (id, text) => {
                if (endedAt.has(id) || id === current) {
                    guesses.set(id, text);
                    showGuess();
                }
            },
            final: (id, text, decodeMs) => {
                const ended = endedAt.get(id);
                if (ended !== undefined) {
                    track(`voice_phrase`, {
                        transport: transport ?? `unknown`,
                        engine: model.value?.engine ?? `unknown`,
                        endToTextMs: Math.round(performance.now() - ended),
                        ...(decodeMs === undefined ? {} : { decodeMs: Math.round(decodeMs) }),
                        heard: text !== ``,
                    });
                }
                // The words first, then the guess they replace is let go: the composer swaps one for the other in place.
                if (text !== ``) {
                    // A lost utterance's line is about that one; the next that gets through answers it.
                    if (error.value === `failed`) {
                        error.value = undefined;
                    }
                    onTranscript(text, { live: capturing });
                }
                settled(id);
            },
            failed: (id, failure) => {
                if (link !== active) {
                    return;
                }
                if (failure === `phrase`) {
                    if (id !== undefined) {
                        settled(id);
                    }
                    // A failed download fails every phrase waiting on it; its own line says why and offers the retry.
                    if (error.value !== `fetch-failed` && model.value?.model !== `failed`) {
                        fail(`failed`);
                    }
                    return;
                }
                fail(failure === `unprovisioned` ? `needs-rebuild` : `unavailable`);
                abandon();
            },
        });
        link = active;

        void (async () => {
            try {
                const captured = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                });
                if (!alive()) {
                    captured.getTracks().forEach((audioTrack) => audioTrack.stop());
                    return;
                }
                stream = captured;
                const audio = new AudioContext();
                context = audio;
                const workletUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: `text/javascript` }));
                try {
                    await audio.audioWorklet.addModule(workletUrl);
                } finally {
                    URL.revokeObjectURL(workletUrl);
                }
                // The mic tap is the user gesture; resume() here satisfies the autoplay policy.
                await audio.resume();
                if (!alive()) {
                    return;
                }

                // While the bridge writes, the segmenter only drives the meter: its phrases are the bridge's to hear, and
                // sending them too would write each one twice once the model arrives.
                const cut = createSegmenter({
                    begin: (opening) => {
                        speaking.value = true;
                        if (bridge !== undefined) {
                            return;
                        }
                        current = nextId;
                        nextId += 1;
                        active.begin(current, opening);
                    },
                    audio: (frame) => {
                        if (current !== undefined) {
                            active.audio(current, frame);
                        }
                    },
                    end: (samples) => {
                        speaking.value = false;
                        if (current === undefined) {
                            return;
                        }
                        endedAt.set(current, performance.now());
                        pending.value += 1;
                        active.end(current, samples);
                        current = undefined;
                    },
                    drop: () => {
                        speaking.value = false;
                        if (current === undefined) {
                            return;
                        }
                        active.drop(current);
                        guesses.delete(current);
                        showGuess();
                        current = undefined;
                    },
                });
                segmenter = cut;
                const capture = new AudioWorkletNode(audio, `intentic-voice-capture`);
                capture.port.addEventListener(`message`, (event: MessageEvent<Float32Array>) => {
                    if (alive() && segmenter === cut) {
                        level.value = cut.push(resampleTo16k(event.data, audio.sampleRate));
                    }
                });
                // Unlike `onmessage`, addEventListener doesn't implicitly open the port.
                capture.port.start();
                audio.createMediaStreamSource(captured).connect(capture);
                capturing = true;
                state.value = `listening`;
                last = undefined;
                repeats.value = 0;
                track(`voice_started`, {
                    pressToListeningMs: Math.round(performance.now() - pressedAt),
                    model: model.value?.model ?? `unknown`,
                    loaded: model.value?.loaded === true,
                    transport: transport ?? `pending`,
                });
                void maybeBridge();
            } catch (cause) {
                if (!alive()) {
                    return;
                }
                const name = cause instanceof DOMException ? cause.name : ``;
                if (name === `NotAllowedError` || name === `SecurityError`) {
                    fail(`mic-blocked`);
                } else if (name === `NotFoundError` || name === `OverconstrainedError` || name === `NotReadableError`) {
                    fail(`no-mic`);
                } else {
                    fail(`failed`);
                }
                abandon();
            }
        })();
    };

    return { state, level, pending, speaking, interim, model, bridged, error, repeats, start, stop, abandon, dismiss, retry, warm };
}
