import { openMicStream } from "./micChoice";
import { CAPTURE_WORKLET } from "./useVoiceInput";
import { resampleTo16k } from "./voiceAudio";

// The microphone the wake listener keeps open: captured in-page exactly as dictation captures it (the same worklet, the
// same 16 kHz frames), but held for as long as listening is on rather than for one press. Opening it is two separate
// permissions in a browser: the microphone (asked once per site) and sound (an AudioContext only runs after the page
// has been clicked at least once since it loaded). The second is why `running` and `resume` are here: a page reloaded
// with listening on has the microphone at once and waits for one click anywhere before it hears anything.

export interface WakeMic {
    /** The microphone's name as the browser gives it ("Microphone (HyperX QuadCast)"), or empty when it gives none. */
    readonly label: string;
    /** The audio graph runs, so frames arrive. */
    readonly running: () => boolean;
    /** Asks the audio graph to run; settles once it does (which a browser holds back until the page is clicked). */
    readonly resume: () => Promise<void>;
    /** The microphone went away under it (unplugged, its permission taken back). */
    readonly onLost: (listener: () => void) => void;
    readonly close: () => void;
}

export type OpenWakeMic = (onFrame: (samples: Float32Array) => void) => Promise<WakeMic>;

export const openWakeMic: OpenWakeMic = async (onFrame) => {
    const stream = await openMicStream();
    const audio = new AudioContext();
    const close = (): void => {
        stream.getTracks().forEach((track) => track.stop());
        // allow(silent-catch): closing a context that is already closing has nothing left to report.
        void audio.close().catch(() => {});
    };
    try {
        const workletUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: `text/javascript` }));
        try {
            await audio.audioWorklet.addModule(workletUrl);
        } finally {
            URL.revokeObjectURL(workletUrl);
        }
        const capture = new AudioWorkletNode(audio, `intentic-voice-capture`);
        capture.port.addEventListener(`message`, (event: MessageEvent<Float32Array>) => onFrame(resampleTo16k(event.data, audio.sampleRate)));
        // Unlike `onmessage`, addEventListener doesn't implicitly open the port.
        capture.port.start();
        audio.createMediaStreamSource(stream).connect(capture);
    } catch (cause) {
        close();
        throw cause;
    }
    return {
        label: stream.getAudioTracks()[0]?.label ?? ``,
        running: () => audio.state === `running`,
        resume: () => audio.resume(),
        onLost: (listener) => {
            for (const track of stream.getAudioTracks()) {
                track.addEventListener(`ended`, listener, { once: true });
            }
        },
        close,
    };
};
