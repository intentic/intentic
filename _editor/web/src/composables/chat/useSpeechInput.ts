import { ref, type Ref } from "vue";

/* Browser-native voice transcription over the Web Speech API. Per-call state (each caller gets its own
 * `listening` ref and recognizer). `supported` is false where the constructor is missing (e.g. Firefox) or on
 * Brave (ships the API but no Google speech key), so callers can hide their mic UI. */

// The DOM lib ships no `webkitSpeechRecognition` and often no `SpeechRecognition` type — declare the minimal
// surface we touch so this typechecks under strict TS.
interface SpeechRecognitionResult {
    readonly transcript: string;
}
interface SpeechRecognitionResultList {
    readonly length: number;
    [index: number]: { readonly 0: SpeechRecognitionResult };
}
interface SpeechRecognitionEvent extends Event {
    readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
    readonly error: string;
    readonly message: string;
}
interface SpeechRecognition extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start(): void;
    stop(): void;
}
type SpeechRecognitionConstructor = new () => SpeechRecognition;

declare global {
    interface Window {
        SpeechRecognition?: SpeechRecognitionConstructor;
        webkitSpeechRecognition?: SpeechRecognitionConstructor;
    }
    interface Navigator {
        brave?: { isBrave(): Promise<boolean> };
    }
}

export function useSpeechInput(): {
    supported: Ref<boolean>;
    listening: Ref<boolean>;
    error: Ref<string | undefined>;
    start(onTranscript: (text: string) => void): void;
    stop(): void;
} {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    const listening = ref(false);
    const error = ref<string>();
    const supported = ref(Boolean(Recognition));

    // Brave ships webkitSpeechRecognition but strips Google's speech key, so start() always network-errors and
    // can never transcribe. Detect Brave upfront (no mic prompt) and hide the button rather than fail mid-use.
    void navigator.brave?.isBrave().then((brave) => {
        if (brave) {
            supported.value = false;
        }
    });

    if (!Recognition) {
        return { supported, listening, error, start: () => {}, stop: () => {} };
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language;

    // The active transcript sink for the current dictation; set by start(). Listeners are registered once (not
    // per start) so repeated toggles don't stack handlers.
    let sink: ((text: string) => void) | undefined;
    // A failed recognizer leaves its error on-screen; auto-clear it so it doesn't hold composer space forever.
    let dismiss: ReturnType<typeof setTimeout> | undefined;
    recognition.addEventListener(`end`, () => (listening.value = false));
    recognition.addEventListener(`error`, (event) => {
        error.value = (event as SpeechRecognitionErrorEvent).error;
        listening.value = false;
        clearTimeout(dismiss);
        dismiss = setTimeout(() => (error.value = undefined), 6000);
    });
    recognition.addEventListener(`result`, (event) => {
        // Concatenate every segment (interim + final) into the running transcript.
        let transcript = ``;
        const { results } = event as SpeechRecognitionEvent;
        for (let i = 0; i < results.length; i += 1) {
            const result = results[i];
            if (result !== undefined) {
                transcript += result[0].transcript;
            }
        }
        sink?.(transcript);
    });

    const start = (onTranscript: (text: string) => void): void => {
        sink = onTranscript;
        clearTimeout(dismiss);
        error.value = undefined;
        listening.value = true;
        recognition.start();
    };

    return { supported, listening, error, start, stop: () => recognition.stop() };
}
