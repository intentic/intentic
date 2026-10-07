import type { NoticeTone, TooltipValue } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef, nextTick, onBeforeUnmount, type Ref, ref } from "vue";
import { UPDATE_ACTION_ANCHOR } from "../../../sandbox/overview/version/updateAnchor";
import { useVoiceInput, type VoiceError, type VoicePage, type VoiceState, type VoiceUnsupported, voiceUnsupported } from "./useVoiceInput";

// Composer-side half of hands-free voice: one mic tap arms it, and an utterance's pause is the send. Capture
// and transcription live in useVoiceInput; this file owns the send rule, the glance window, and the state words.
// Stays armed across turns until the mic is tapped again, typing starts, or the owner calls `quit`.

export interface ComposerVoice {
    readonly state: Ref<VoiceState>;
    /** 0…1 microphone level, the listening icon breathes with it. */
    readonly level: Ref<number>;
    /** The mic is armed: capturing, or warming up to. */
    readonly on: ComputedRef<boolean>;
    /** An utterance is counting down to send, the glance window, catchable with Escape. */
    readonly armed: Ref<boolean>;
    /** Either of the two, what Escape claims, and what typing ends. */
    readonly live: ComputedRef<boolean>;
    /** The mic button's tooltip. */
    readonly buttonHint: ComputedRef<TooltipValue>;
    /** The composer's one hint slot while voice is doing something, or nothing when it isn't. */
    readonly slotHint: ComputedRef<string | undefined>;
    /** Why this page can never capture, or nothing: the button is disabled and says so rather than failing each press. */
    readonly unsupported: VoiceUnsupported | undefined;
    /** The capture's failure as the composer draws it, held until the next press, typing, or `dismiss`. */
    readonly failure: ComputedRef<VoiceFailure | undefined>;
    readonly dismiss: () => void;
    readonly toggle: () => void;
    /** Leaves hands-free and lets go of the last failure: what typing and leaving the pane do. */
    readonly quit: () => void;
}

export interface VoiceFailure {
    readonly code: VoiceError;
    /** In the user's words, including how to get past it when that is theirs to do (allowing the mic). */
    readonly message: string;
    readonly tone: NoticeTone;
    /** The one place that fixes it, when the reader may act there. */
    readonly action?: { readonly label: string; readonly to: string };
    /** The same failure again, n times running: the line re-announces and shakes rather than sitting still. */
    readonly repeats: number;
}

// The glance window between words appearing and the message going: a countdown, not a confirmation.
const VOICE_SEND_DELAY_MS = 1200;

// Functions, not strings: `t` reads the active language from a ref, so a table built at import would freeze one in.
const BUTTON_HINT: Record<VoiceState, () => TooltipValue> = {
    preparing: () => t(`chat.composerVoice.preparing`),
    listening: () => t(`chat.composerVoice.stopVoice`),
    idle: () => ({ title: t(`chat.chatPane.talkHandsFree`), note: t(`chat.composerVoice.pauseSends`) }),
};

// Shared with the turn's own shortcuts, so an idle mic yields it back.
const SLOT_HINT: Record<VoiceState, () => string | undefined> = {
    preparing: () => t(`chat.composerVoice.preparingFirstUse`),
    listening: () => t(`chat.composerVoice.listening`),
    idle: () => undefined,
};

// `needs-rebuild` means the image predates the whisper pack; the Environment card's rebuild adds it.
const ERROR_LINE: Record<VoiceError, () => string> = {
    "mic-blocked": () => t(`chat.composerVoice.micBlocked`),
    "no-mic": () => t(`chat.composerVoice.noMic`),
    "needs-rebuild": () => t(`chat.composerVoice.needsRebuild`),
    unavailable: () => t(`chat.composerVoice.unavailable`),
    failed: () => t(`chat.composerVoice.failed`),
};

// The sandbox's two are standing debts with a fix one page away (warning, as the sandbox chip ranks them); the
// microphone's and a lost utterance broke what was being done.
const ERROR_TONE: Record<VoiceError, NoticeTone> = {
    "mic-blocked": `danger`,
    "no-mic": `danger`,
    "needs-rebuild": `warning`,
    unavailable: `warning`,
    failed: `danger`,
};

// Where each sandbox-side failure is fixed: the rebuild on Environment, the update card's own button (updateAnchor.ts).
// The microphone's fix is in the browser, so its sentence says where instead.
const ERROR_ACTION: Partial<Record<VoiceError, () => { label: string; to: string }>> = {
    "needs-rebuild": () => ({ label: t(`chat.composerVoice.openEnvironment`), to: `/sandbox/environment` }),
    unavailable: () => ({ label: t(`chat.composerVoice.updateSandbox`), to: `/sandbox#${UPDATE_ACTION_ANCHOR}` }),
};

const UNSUPPORTED_NOTE: Record<VoiceUnsupported, () => string> = {
    insecure: () => t(`chat.composerVoice.unsupportedInsecure`),
    policy: () => t(`chat.composerVoice.unsupportedPolicy`),
    browser: () => t(`chat.composerVoice.unsupportedBrowser`),
};

export const useComposerVoice = (composer: {
    /** The box the words land in; an utterance joins whatever is already there. */
    readonly draft: Ref<string>;
    /** No daemon, no transcription: the tap does nothing rather than failing halfway. */
    readonly reachable: Ref<boolean>;
    /** The reader may rebuild and update this sandbox, so a sandbox-side failure can offer the page that fixes it. */
    readonly manages: Ref<boolean>;
    /** Re-size the box around the words that just arrived. */
    readonly grew: () => void;
    /** What the pause does. */
    readonly send: () => void;
    /** The page asked what it can capture with; the real one unless a test hands it another. */
    readonly page?: VoicePage;
}): ComposerVoice => {
    const { state, level, pending, error, repeats, start, stop, dismiss } = useVoiceInput();
    // Asked once: a page's security, its policy and its browser don't change while it is open.
    const unsupported = voiceUnsupported(composer.page);
    const on = computed(() => state.value !== `idle`);
    const armed = ref(false);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const disarm = (): void => {
        clearTimeout(timer);
        armed.value = false;
    };

    // An utterance joins whatever the box already holds, then the countdown re-arms: a second utterance inside
    // the glance window extends the message rather than racing it.
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
        dismiss();
        if (!on.value && !armed.value) {
            return;
        }
        stop();
        disarm();
    };

    // A mic left running in a torn-down pane keeps recording; tear it down on unmount.
    onBeforeUnmount(quit);

    return {
        state,
        level,
        on,
        armed,
        live: computed(() => on.value || armed.value),
        buttonHint: computed(() =>
            unsupported === undefined
                ? BUTTON_HINT[state.value]()
                : { title: t(`chat.chatPane.talkHandsFree`), note: UNSUPPORTED_NOTE[unsupported]() },
        ),
        // Armed-send first (narrowest window), then transcription, then the two working states.
        slotHint: computed(() => {
            if (armed.value) {
                return t(`chat.composerVoice.sending`);
            }
            if (pending.value > 0) {
                return t(`chat.composerVoice.transcribing`);
            }
            return SLOT_HINT[state.value]();
        }),
        unsupported,
        failure: computed(() => {
            const code = error.value;
            if (code === undefined) {
                return undefined;
            }
            const action = composer.manages.value ? ERROR_ACTION[code]?.() : undefined;
            return { code, message: ERROR_LINE[code](), tone: ERROR_TONE[code], repeats: repeats.value, ...(action === undefined ? {} : { action }) };
        }),
        dismiss,
        toggle: (): void => {
            if (on.value) {
                stop();
                disarm();
                return;
            }
            if (!composer.reachable.value || unsupported !== undefined) {
                return;
            }
            start(heard);
        },
        quit,
    };
};
