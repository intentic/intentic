import { computed, type ComputedRef, nextTick, onBeforeUnmount, type Ref, ref } from "vue";
import { useVoiceInput, type VoiceError, type VoiceState } from "./useVoiceInput";

/* HANDS-FREE VOICE, AS THE COMPOSER MEANS IT. One mic tap arms it; from there the gesture is speech itself:
 * talk, and the pause is the send.
 *
 * The capture and the transcription are useVoiceInput's (sandbox-side whisper — every browser, and audio never
 * leaves the user's infrastructure). What lives HERE is the half that is about a composer rather than a
 * microphone: what "send" means, the glance-window before it happens, the words for each state, and the rule
 * that the mic never records where nobody is looking.
 *
 * The mode STAYS ON between turns, because a conversation is the point of hands-free — until the mic is tapped
 * again, the user starts typing, or the pane stops being the one they are working in. The pane owns that last
 * one (its conversation and its focus both move under it) and says so by calling `quit`; leaving the page at all
 * is handled here, because a mic outliving its composer is never right. */

export interface ComposerVoice {
    readonly state: Ref<VoiceState>;
    /** 0…1 microphone level — the listening icon breathes with it. */
    readonly level: Ref<number>;
    /** The mic is armed: capturing, or warming up to. */
    readonly on: ComputedRef<boolean>;
    /** An utterance is counting down to send — the glance window, catchable with Escape. */
    readonly armed: Ref<boolean>;
    /** Either of the two — what Escape claims, and what typing ends. */
    readonly live: ComputedRef<boolean>;
    /** The mic button's tooltip. */
    readonly buttonHint: ComputedRef<string>;
    /** What the composer's one hint slot says while voice is doing something, or nothing when it isn't. */
    readonly slotHint: ComputedRef<string | undefined>;
    /** The capture's failure, in the user's words. */
    readonly errorMessage: ComputedRef<string | undefined>;
    readonly toggle: () => void;
    readonly quit: () => void;
}

// The glance-window between the words appearing and the message going. A countdown, not a confirmation: the
// default is that speaking sends, and this is only how long the catch stays possible.
const VOICE_SEND_DELAY_MS = 1200;

const BUTTON_HINT: Record<VoiceState, string> = {
    preparing: `Preparing voice…`,
    listening: `Stop voice mode`,
    idle: `Talk hands-free — pause to send, tap again to stop`,
};

// The hint slot is shared with the turn's own shortcuts, so an idle mic says nothing and yields it back.
const SLOT_HINT: Record<VoiceState, string | undefined> = {
    preparing: `Preparing voice (first use)…`,
    listening: `Listening — pause to send, Esc to stop`,
    idle: undefined,
};

// `needs-rebuild` is the one with an errand attached: the image predates the whisper pack, and the Environment
// card's rebuild is what adds it.
const ERROR_LINE: Record<VoiceError, string> = {
    "mic-blocked": `Microphone access is blocked. Allow it in your browser's site settings, then try again.`,
    "no-mic": `No microphone was found.`,
    "needs-rebuild": `Voice needs a one-time sandbox update — run the rebuild on the Sandbox page's Environment card first.`,
    unavailable: `Voice isn't available on this sandbox — update it, then try again.`,
    failed: `Couldn't transcribe that — try again.`,
};

export const useComposerVoice = (composer: {
    /** The box the words land in — an utterance joins whatever is already there. */
    readonly draft: Ref<string>;
    /** No daemon, no transcription: the tap does nothing rather than failing halfway. */
    readonly reachable: Ref<boolean>;
    /** Re-size the box around the words that just arrived. */
    readonly grew: () => void;
    /** What the pause does. */
    readonly send: () => void;
}): ComposerVoice => {
    const { state, level, pending, error, start, stop } = useVoiceInput();
    const on = computed(() => state.value !== `idle`);
    const armed = ref(false);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const disarm = (): void => {
        clearTimeout(timer);
        armed.value = false;
    };

    // An utterance's words join whatever the box already holds (a typed half-sentence stays the user's), then
    // the countdown re-arms — a second utterance inside the glance window extends the message rather than
    // racing it.
    const heard = (text: string): void => {
        disarm();
        const base = composer.draft.value.trim();
        composer.draft.value = base.length > 0 ? `${base} ${text}` : text;
        void nextTick(() => composer.grew());
        armed.value = true;
        timer = setTimeout(() => {
            armed.value = false;
            composer.send();
        }, VOICE_SEND_DELAY_MS);
    };

    const quit = (): void => {
        if (!on.value && !armed.value) {
            return;
        }
        stop();
        disarm();
    };

    // A mic left running in a torn-down pane records where nobody is looking, for the rest of the session.
    onBeforeUnmount(quit);

    return {
        state,
        level,
        on,
        armed,
        live: computed(() => on.value || armed.value),
        buttonHint: computed(() => BUTTON_HINT[state.value]),
        /* Armed-send first (the narrowest window), then transcription, then the two working states. Each of
         * these is the only place the user learns what the mode is doing right now. */
        slotHint: computed(() => {
            if (armed.value) {
                return `Sending — Esc to edit`;
            }
            if (pending.value > 0) {
                return `Transcribing…`;
            }
            return SLOT_HINT[state.value];
        }),
        errorMessage: computed(() => (error.value === undefined ? undefined : ERROR_LINE[error.value])),
        toggle: (): void => {
            if (on.value) {
                stop();
                disarm();
                return;
            }
            if (!composer.reachable.value) {
                return;
            }
            start(heard);
        },
        quit,
    };
};
