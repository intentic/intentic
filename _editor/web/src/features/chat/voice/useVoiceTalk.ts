import type { VoiceSettings } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef, onBeforeUnmount, type Ref, watch } from "vue";
import type { CardAnswer } from "../session/cardReplies";
import type { ChatMessage } from "../transcript/transcript";
import { type SpeechPlayer, useSpeechPlayer } from "./speechPlayer";
import { type CardWords, finalReplyOf, type SpokenCard, spokenCardOf } from "./voiceCards";

// The other half of hands-free voice: the agent answering out loud. While the composer's mic is armed (useComposerVoice),
// a turn that finishes is answered with a few spoken sentences (the sandbox's `reply` speech: the spoken-reply job, or
// the reply's own opening), and a turn that stops on a card puts the card to the person, whose next words answer it
// rather than queue behind it. The mic rests while the voice speaks, so the speakers are not heard as the person; with
// `interrupt` on it stays open instead, and talking over the voice stops it.

/** The slice of the composer's voice this drives. */
export interface TalkingVoice {
    readonly on: ComputedRef<boolean>;
    readonly speaking: Ref<boolean>;
    readonly rest: (deaf: boolean) => void;
}

export interface VoiceTalkPane {
    readonly voice: TalkingVoice;
    readonly messages: Ref<readonly ChatMessage[]>;
    readonly streaming: Ref<boolean>;
    readonly awaitingDecision: Ref<boolean>;
    readonly conversationId: () => string;
    /** Answers a card the way its own buttons do. */
    readonly reply: (requestId: string, answer: CardAnswer) => Promise<boolean>;
    /** The sandbox's voice settings, or undefined until they are read (then replies are on and interrupt off). */
    readonly settings: Ref<VoiceSettings | undefined>;
    readonly player?: SpeechPlayer;
    readonly words?: CardWords;
}

export interface VoiceTalk {
    /** Takes words the mic heard when they answer the card being waited on; false leaves them to the composer. */
    readonly intercept: (heard: string) => boolean;
    /** The composer's hint while the voice speaks. */
    readonly hint: ComputedRef<string | undefined>;
}

/** The words a card is said with, in the reader's language now; shared with the wake listener's answers. */
export const cardWords = (): CardWords => ({
    question: (question, options) => t(`chat.voiceCards.question`, { question, options }),
    questions: (count) => t(`chat.voiceCards.questions`, { count }),
    permission: (action) => t(`chat.voiceCards.permission`, { action }),
    plan: (title) => t(`chat.voiceCards.plan`, { title }),
    or: t(`chat.voiceCards.or`),
});

// The person's last words before the reply: what a spoken answer is matched to, in their language.
const lastAsked = (messages: readonly ChatMessage[]): string | undefined => messages.findLast((message) => message.role === `user`)?.text;

export const useVoiceTalk = (pane: VoiceTalkPane): VoiceTalk => {
    const player = pane.player ?? useSpeechPlayer();
    const replies = (): boolean => pane.settings.value?.replies ?? true;
    const interrupts = (): boolean => pane.settings.value?.interrupt ?? false;
    // What this pane has already said, so a re-render or a reconnect never says it twice.
    const said = new Set<string>();
    // The card put to the person and not yet answered.
    let asking: SpokenCard | undefined;
    // Keys this pane started, so it rests only for its own voice, not a reply read aloud by a press elsewhere.
    const mine = (key: string | undefined): boolean => key !== undefined && key.startsWith(`talk:${pane.conversationId()}:`);

    const speak = (key: string, text: string, as: `plain` | `reply`): void => {
        if (said.has(key)) {
            return;
        }
        said.add(key);
        void player.say(text, {
            key: `talk:${pane.conversationId()}:${key}`,
            as,
            lang: navigator.language,
            conversationId: pane.conversationId(),
            asked: as === `reply` ? lastAsked(pane.messages.value) : undefined,
        });
    };

    // A finished turn, while the mic is armed: its reply, said short.
    watch(pane.streaming, (now, before) => {
        if (before !== true || now || !pane.voice.on.value || !replies()) {
            return;
        }
        const last = pane.messages.value.findLast((message) => message.role === `assistant` && message.text.trim() !== ``);
        const reply = finalReplyOf(pane.messages.value);
        if (last !== undefined && reply !== undefined) {
            speak(`reply:${last.id}`, reply, `reply`);
        }
    });

    // A card waiting, while the mic is armed: said, and the next words heard are its answer.
    watch(
        () => (pane.awaitingDecision.value && pane.voice.on.value ? spokenCardOf(pane.messages.value, pane.words ?? cardWords()) : undefined),
        (card) => {
            asking = card;
            if (card !== undefined && replies()) {
                speak(`card:${card.requestId}`, card.text, `plain`);
            }
        },
    );

    // The mic rests while this pane's voice speaks, unless talking over it is how it is stopped.
    watch(
        () => mine(player.speaking.value) && !interrupts(),
        (deaf) => pane.voice.rest(deaf),
        { immediate: true },
    );
    watch(pane.voice.speaking, (talking) => {
        if (talking && interrupts() && mine(player.speaking.value)) {
            player.stop();
        }
    });
    onBeforeUnmount(() => {
        pane.voice.rest(false);
        if (mine(player.speaking.value)) {
            player.stop();
        }
    });

    return {
        intercept: (heard) => {
            const card = asking;
            if (card === undefined || !pane.awaitingDecision.value) {
                return false;
            }
            const answer = card.answer(heard);
            if (answer === undefined) {
                speak(`unclear:${card.requestId}:${said.size}`, t(`chat.voiceCards.notUnderstood`), `plain`);
                return true;
            }
            asking = undefined;
            if (mine(player.speaking.value)) {
                player.stop();
            }
            void pane.reply(card.requestId, answer);
            return true;
        },
        hint: computed(() => (mine(player.speaking.value) ? `${t(`chat.voiceReply.speaking`)} · ${t(`chat.voiceReply.stopHint`)}` : undefined)),
    };
};
