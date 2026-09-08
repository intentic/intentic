import { sleep } from "@intentic/base/async";
import { ref, type Ref } from "vue";
import { SandboxHttpError, sandboxJson } from "../../sandbox/client/sandboxClient";
import { createSegmenter, resampleTo16k, wavOf16k } from "./voiceAudio";

// Hands-free voice input: the mic is captured in-page (AudioWorklet), the silence segmenter (voiceAudio.ts)
// cuts the stream into utterances, and each utterance is transcribed by the sandbox's whisper
// (POST /speech/transcribe); audio never leaves the user's infrastructure. Per-call state; "send" is the composer's
// business.

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

export type VoiceState = `idle` | `preparing` | `listening`;

// `needs-rebuild` is the image without whisper; `unavailable` is voice failing to start (daemon too old for
// /speech); `failed` is an utterance lost mid-session; the rest are the microphone's own.
export type VoiceError = `mic-blocked` | `no-mic` | `needs-rebuild` | `unavailable` | `failed`;

interface SpeechStatus {
    readonly provisioned: boolean;
    readonly model: `absent` | `downloading` | `ready`;
}

const STATUS_POLL_MS = 2500;
// Live microphone level (RMS, 0..1), the listening indicator's pulse.
const ERROR_DISMISS_MS = 8000;

export function useVoiceInput(): {
    state: Ref<VoiceState>;
    /** Utterances transcribing right now, "Transcribing…" while > 0. */
    level: Ref<number>;
    /** A failed capture leaves its error on-screen; auto-clear it so it doesn't hold composer space forever. */
    pending: Ref<number>;
    error: Ref<VoiceError | undefined>;
    start(onTranscript: (text: string) => void): void;
    stop(): void;
} {
    const state = ref<VoiceState>(`idle`);
    const level = ref(0);
    const pending = ref(0);
    const error = ref<VoiceError>();

    let dismiss: ReturnType<typeof setTimeout> | undefined;
    const fail = (code: VoiceError): void => {
        error.value = code;
        clearTimeout(dismiss);
        dismiss = setTimeout(() => (error.value = undefined), ERROR_DISMISS_MS);
    };

    // The live capture chain, torn down by stop(); `generation` invalidates async start arms that resolve late.
    let generation = 0;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let controller: AbortController | undefined;

    const teardown = (): void => {
        generation += 1;
        controller?.abort();
        controller = undefined;
        stream?.getTracks().forEach((track) => track.stop());
        stream = undefined;
        void context?.close().catch(() => {});
        context = undefined;
        level.value = 0;
        pending.value = 0;
        state.value = `idle`;
    };

    const start = (onTranscript: (text: string) => void): void => {
        teardown();
        clearTimeout(dismiss);
        error.value = undefined;
        state.value = `preparing`;
        const mine = generation;
        const alive = (): boolean => generation === mine;
        controller = new AbortController();
        const signal = controller.signal;

        // Utterances transcribe one at a time; chaining keeps transcripts in speech order despite network reordering.
        let chain: Promise<void> = Promise.resolve();
        const transcribe = (samples: Float32Array): void => {
            pending.value += 1;
            chain = chain
                .then(async () => {
                    const wav = wavOf16k(samples);
                    const { text } = await sandboxJson<{ text: string }>(`/speech/transcribe?lang=${encodeURIComponent(navigator.language)}`, {
                        method: `POST`,
                        body: wav,
                        signal,
                    });
                    if (alive() && text !== ``) {
                        onTranscript(text);
                    }
                })
                .catch((cause: unknown) => {
                    if (!alive()) {
                        return;
                    }
                    if (cause instanceof SandboxHttpError && cause.status === 501) {
                        fail(`needs-rebuild`);
                        teardown();
                        return;
                    }
                    // A 409 (model download raced) or any transient failure: the utterance is lost, say so once, keep
                    // listening.
                    fail(`failed`);
                })
                .finally(() => {
                    // teardown() already zeroed the count for a stopped session; never step below it.
                    pending.value = Math.max(0, pending.value - 1);
                });
        };

        void (async () => {
            try {
                // Whether this sandbox can hear at all, and the first-use model download; "Preparing voice…" is this
                // loop.
                for (;;) {
                    const status = await sandboxJson<SpeechStatus>(`/speech/status`, { signal });
                    if (!alive()) {
                        return;
                    }
                    if (!status.provisioned) {
                        fail(`needs-rebuild`);
                        teardown();
                        return;
                    }
                    if (status.model === `ready`) {
                        break;
                    }
                    await sleep(STATUS_POLL_MS);
                    if (!alive()) {
                        return;
                    }
                }

                const captured = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                });
                if (!alive()) {
                    captured.getTracks().forEach((track) => track.stop());
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

                const segmenter = createSegmenter(transcribe);
                const capture = new AudioWorkletNode(audio, `intentic-voice-capture`);
                capture.port.addEventListener(`message`, (event: MessageEvent<Float32Array>) => {
                    if (alive()) {
                        level.value = segmenter.push(resampleTo16k(event.data, audio.sampleRate));
                    }
                });
                // Unlike `onmessage`, addEventListener doesn't implicitly open the port.
                capture.port.start();
                audio.createMediaStreamSource(captured).connect(capture);
                state.value = `listening`;
            } catch (cause) {
                if (!alive()) {
                    return;
                }
                const name = cause instanceof DOMException ? cause.name : ``;
                if (name === `NotAllowedError` || name === `SecurityError`) {
                    fail(`mic-blocked`);
                } else if (name === `NotFoundError` || name === `OverconstrainedError` || name === `NotReadableError`) {
                    fail(`no-mic`);
                } else if (cause instanceof SandboxHttpError) {
                    // During start, a daemon refusal is about the sandbox: 501 lacks whisper, anything else lacks
                    // voice.
                    fail(cause.status === 501 ? `needs-rebuild` : `unavailable`);
                } else {
                    fail(`failed`);
                }
                teardown();
            }
        })();
    };

    return { state, level, pending, error, start, stop: teardown };
}
