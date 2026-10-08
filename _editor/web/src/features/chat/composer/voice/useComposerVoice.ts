import type { NoticeTone, TooltipValue } from "@intentic/ui";
import { formatBytes } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef, nextTick, onBeforeUnmount, type Ref, ref, watch } from "vue";
import { UPDATE_ACTION_ANCHOR } from "../../../sandbox/overview/version/updateAnchor";
import {
    type Heard,
    useVoiceInput,
    type VoiceError,
    type VoicePage,
    type VoiceState,
    type VoiceUnsupported,
    voiceUnsupported,
} from "./useVoiceInput";

// Composer-side half of hands-free voice: one mic tap arms it, and an utterance's pause is the send. Capture
// and transcription live in useVoiceInput; this file owns the send rule, the glance window, the words appearing in
// the box while they are spoken, the model's setup as the composer shows it, and the state words. Stays armed across
// turns until the mic is tapped again, typing starts, or the owner calls `quit`.

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
    /** The speech model on its way while the mic is on: what the composer draws as a progress row. */
    readonly setup: ComputedRef<VoiceSetup | undefined>;
    /** The pointer is on its way to the mic: load the model now, so the first phrase does not wait for it. */
    readonly warm: () => void;
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
    /** The one way past it when the reader may take it: a page that fixes it (`to`), or a press that retries (`run`). */
    readonly action?: { readonly label: string; readonly to?: string; readonly run?: () => void };
    /** The same failure again, n times running: the line re-announces and shakes rather than sitting still. */
    readonly repeats: number;
}

export interface VoiceSetup {
    /** 0…1 of the model fetched. */
    readonly fraction: number;
    /** The row's words: how much of how much, how long is left when that can be said, and what happens to speech. */
    readonly line: string;
    /** The same, for a screen reader's meter. */
    readonly valuetext: string;
}

// The glance window between words appearing and the message going: a countdown, not a confirmation. It starts when
// the last spoken words land: while the person is speaking again, or a phrase is still being heard, it waits.
const VOICE_SEND_DELAY_MS = 1200;
const HOLD_POLL_MS = 200;
// A download's pace is read over at least this long before a time left is promised.
const ETA_AFTER_MS = 1500;

// Functions, not strings: `t` reads the active language from a ref, so a table built at import would freeze one in.
const BUTTON_HINT: Record<VoiceState, () => TooltipValue> = {
    preparing: () => t(`chat.composerVoice.openingMic`),
    listening: () => t(`chat.composerVoice.stopVoice`),
    idle: () => ({ title: t(`chat.chatPane.talkHandsFree`), note: t(`chat.composerVoice.pauseSends`) }),
};

// Shared with the turn's own shortcuts, so an idle mic yields it back.
const SLOT_HINT: Record<VoiceState, () => string | undefined> = {
    preparing: () => t(`chat.composerVoice.openingMic`),
    listening: () => t(`chat.composerVoice.listening`),
    idle: () => undefined,
};

// `needs-rebuild` is a sandbox that cannot hear at all: an image from before its speech engine, which an update brings.
const ERROR_LINE: Record<VoiceError, () => string> = {
    "mic-blocked": () => t(`chat.composerVoice.micBlocked`),
    "no-mic": () => t(`chat.composerVoice.noMic`),
    "needs-rebuild": () => t(`chat.composerVoice.needsUpdate`),
    unavailable: () => t(`chat.composerVoice.unavailable`),
    "fetch-failed": () => t(`chat.composerVoice.fetchFailed`),
    failed: () => t(`chat.composerVoice.failed`),
};

// The sandbox's are standing debts with a fix one step away (warning, as the sandbox chip ranks them); the
// microphone's and a lost utterance broke what was being done.
const ERROR_TONE: Record<VoiceError, NoticeTone> = {
    "mic-blocked": `danger`,
    "no-mic": `danger`,
    "needs-rebuild": `warning`,
    unavailable: `warning`,
    "fetch-failed": `warning`,
    failed: `danger`,
};

// Where each sandbox-side failure is fixed: the update card's own button (updateAnchor.ts). The microphone's fix is in
// the browser, so its sentence says where instead; a failed download is retried from the line itself, by anyone.
const ERROR_ACTION: Partial<Record<VoiceError, () => { label: string; to: string }>> = {
    "needs-rebuild": () => ({ label: t(`chat.composerVoice.updateSandbox`), to: `/sandbox#${UPDATE_ACTION_ANCHOR}` }),
    unavailable: () => ({ label: t(`chat.composerVoice.updateSandbox`), to: `/sandbox#${UPDATE_ACTION_ANCHOR}` }),
};

// Words joined as speech is: one space, nothing doubled at either end.
const joinWords = (before: string, after: string): string => (before.length > 0 ? `${before} ${after}` : after);

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
    /** The voice input to drive; the real one unless a test hands it another. */
    readonly input?: ReturnType<typeof useVoiceInput>;
}): ComposerVoice => {
    const input = composer.input ?? useVoiceInput();
    const { state, level, pending, speaking, interim, model, bridged, error, repeats, start, stop, abandon, dismiss, retry, warm } = input;
    // Asked once: a page's security, its policy and its browser don't change while it is open.
    const unsupported = voiceUnsupported(composer.page);
    const on = computed(() => state.value !== `idle`);
    const armed = ref(false);
    // More words of this message are on their way: someone is speaking, or a phrase is still being heard.
    const busy = (): boolean => speaking.value || pending.value > 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let held = false;

    const disarm = (): void => {
        clearTimeout(timer);
        armed.value = false;
        held = false;
    };

    // The countdown holds while more words are coming, then gives the glance window again from the last of them.
    const fire = (): void => {
        if (busy()) {
            held = true;
            timer = setTimeout(fire, HOLD_POLL_MS);
            return;
        }
        if (held) {
            held = false;
            timer = setTimeout(fire, VOICE_SEND_DELAY_MS);
            return;
        }
        armed.value = false;
        composer.send();
    };

    // The draft as it was before the running guess was shown in it, while one is.
    let beforeGuess: string | undefined;
    const showGuess = (guess: string): void => {
        if (guess === ``) {
            if (beforeGuess !== undefined) {
                composer.draft.value = beforeGuess;
                beforeGuess = undefined;
                void nextTick(() => composer.grew());
            }
            return;
        }
        beforeGuess ??= composer.draft.value.trim();
        composer.draft.value = joinWords(beforeGuess, guess);
        void nextTick(() => composer.grew());
    };
    // Synchronous, so a phrase's final replaces its guess before the next guess is drawn after it.
    watch(interim, showGuess, { flush: `sync` });

    // An utterance joins whatever the box already holds (its guess replaced), then the countdown re-arms: a second
    // utterance inside the glance window extends the message rather than racing it. Words that land after the mic was
    // stopped are written, not sent.
    const heard = (text: string, { live }: Heard): void => {
        const committed = beforeGuess ?? composer.draft.value.trim();
        beforeGuess = undefined;
        composer.draft.value = joinWords(committed, text);
        void nextTick(() => composer.grew());
        if (!live) {
            return;
        }
        disarm();
        armed.value = true;
        timer = setTimeout(fire, VOICE_SEND_DELAY_MS);
    };

    // What was shown as a guess stays in the box as written text: it is what was said, as best it was heard.
    const quit = (): void => {
        dismiss();
        beforeGuess = undefined;
        if (!on.value && !armed.value && pending.value === 0) {
            return;
        }
        abandon();
        disarm();
    };

    // The model's fetch pace, read off the progress it reports: where it was first seen, for a time left.
    let paceFrom: { readonly at: number; readonly received: number } | undefined;
    watch(
        model,
        (status) => {
            if (status?.model !== `downloading`) {
                paceFrom = undefined;
            } else {
                paceFrom ??= { at: Date.now(), received: status.received ?? 0 };
            }
        },
        { flush: `sync` },
    );

    const setup = computed((): VoiceSetup | undefined => {
        const status = model.value;
        if ((!on.value && pending.value === 0) || status?.model !== `downloading` || status.total === undefined || status.total <= 0) {
            return undefined;
        }
        const received = status.received ?? 0;
        const sizes = { received: formatBytes(received), total: formatBytes(status.total) };
        const parts = [t(`chat.composerVoice.setupProgress`, sizes)];
        const elapsed = paceFrom === undefined ? 0 : Date.now() - paceFrom.at;
        const rate = paceFrom === undefined || elapsed < ETA_AFTER_MS ? 0 : (received - paceFrom.received) / elapsed;
        if (rate > 0) {
            const seconds = Math.max(1, Math.round((status.total - received) / rate / 1000));
            parts.push(
                seconds < 90
                    ? t(`chat.composerVoice.setupSecondsLeft`, { count: seconds }, seconds)
                    : t(`chat.composerVoice.setupMinutesLeft`, { count: Math.round(seconds / 60) }, Math.round(seconds / 60)),
            );
        }
        if (bridged.value) {
            parts.push(t(`chat.composerVoice.setupBridged`));
        } else if (pending.value > 0) {
            parts.push(t(`chat.composerVoice.setupQueued`, { count: pending.value }, pending.value));
        } else {
            parts.push(t(`chat.composerVoice.setupSpeakNow`));
        }
        return { fraction: received / status.total, line: parts.join(` · `), valuetext: t(`chat.composerVoice.setupProgress`, sizes) };
    });

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
        // Armed-send first (narrowest window), then the model's setup, then transcription, then the two working states.
        slotHint: computed(() => {
            if (armed.value && !busy()) {
                return t(`chat.composerVoice.sending`);
            }
            if (state.value === `listening` && model.value !== undefined && model.value.model !== `ready`) {
                return bridged.value ? t(`chat.composerVoice.listeningBridged`) : t(`chat.composerVoice.listeningSetup`);
            }
            if (pending.value > 0 && !speaking.value) {
                return t(`chat.composerVoice.transcribing`);
            }
            return SLOT_HINT[state.value]() ?? (pending.value > 0 ? t(`chat.composerVoice.transcribing`) : undefined);
        }),
        unsupported,
        failure: computed(() => {
            const code = error.value;
            if (code === undefined) {
                return undefined;
            }
            const action =
                code === `fetch-failed`
                    ? { label: t(`chat.composerVoice.retry`), run: retry }
                    : composer.manages.value
                      ? ERROR_ACTION[code]?.()
                      : undefined;
            return { code, message: ERROR_LINE[code](), tone: ERROR_TONE[code], repeats: repeats.value, ...(action === undefined ? {} : { action }) };
        }),
        setup,
        warm,
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
