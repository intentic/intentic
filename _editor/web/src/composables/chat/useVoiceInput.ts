import { ref, type Ref } from "vue";
import { SandboxHttpError, sandboxJson } from "../sandbox/sandboxClient";
import { createSegmenter, resampleTo16k, wavOf16k } from "./voiceAudio";

/* Hands-free voice input for the composer: the microphone is captured in the page (AudioWorklet, any modern
 * browser), the silence segmenter cuts the stream into utterances (voiceAudio.ts), and each utterance's WAV is
 * transcribed privately by the SANDBOX's whisper (POST /speech/transcribe), audio never leaves the user's own
 * infrastructure, and no browser is excluded the way the old Web Speech path excluded everything un-Googled.
 *
 * Per-call state (each caller gets its own refs and capture chain). The caller supplies the transcript sink;
 * what "send" means, the countdown, Escape, the draft, is the composer's business, not this file's. */

// The capture worklet, inlined as a blob module: 128-sample process() blocks are batched to ~2048 before
// crossing the thread boundary (‾46ms at 44.1kHz: 20 messages/s instead of 375). A string rather than an
// asset file so the popout window and the dev server load it identically, with no Vite plumbing.
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

// The refusals the composer words for the user. `needs-rebuild` is the image without whisper (the one-time
// sandbox update); `unavailable` is voice failing to START (a daemon that doesn't answer /speech at all,
// e.g. one older than this app); `failed` is an utterance lost mid-session; the rest are the microphone's own.
export type VoiceError = `mic-blocked` | `no-mic` | `needs-rebuild` | `unavailable` | `failed`;

interface SpeechStatus {
    readonly provisioned: boolean;
    readonly model: `absent` | `downloading` | `ready`;
}

const STATUS_POLL_MS = 2500;
// A failed capture leaves its error on-screen; auto-clear it so it doesn't hold composer space forever.
const ERROR_DISMISS_MS = 8000;

export function useVoiceInput(): {
    state: Ref<VoiceState>;
    /** Live microphone level (RMS, 0..1), the listening indicator's pulse. */
    level: Ref<number>;
    /** Utterances transcribing right now, "Transcribing…" while > 0. */
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

    // The live capture chain, torn down whole by stop(). `generation` invalidates the async arms of a start
    // (status polls, getUserMedia) that resolve after the user already toggled off.
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

        // Utterances transcribe strictly one after another: whisper is serialized daemon-side anyway, and
        // chaining here keeps transcripts arriving in speech order however the network reorders responses.
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
                    // A 409 (model download raced us) or any transient failure: the utterance is lost, say so
                    // once, keep listening, the next pause retries the whole path naturally.
                    fail(`failed`);
                })
                .finally(() => {
                    // teardown() already zeroed the count for a stopped session, never step below it.
                    pending.value = Math.max(0, pending.value - 1);
                });
        };

        void (async () => {
            try {
                // Whether this sandbox can hear at all, and the first-use model download, which the status
                // poll both starts and watches ("Preparing voice…" is this loop).
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
                    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
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
                // The mic tap is the user gesture; resume() here is what satisfies the autoplay policy.
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
                    // A daemon refusal during start is about the sandbox, not about anything spoken: 501 is the
                    // image without whisper; anything else (a 404 from a daemon older than this app) is voice
                    // simply not being there to start.
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
