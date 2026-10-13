<script setup lang="ts">
import { WAKE_WORD_DEFAULT } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, watch } from "vue";
import { postDesktopNotice } from "../../../app/environments/desktopNotices";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { onScreen } from "../../../workbench/window/onScreen";
import { startAgent } from "../../agents/fleet/agentActions";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import { handsFreeOn } from "../composer/voice/useComposerVoice";
import { summonChat, summonTurn } from "../run/summon";
import type { Conversation } from "../session/conversation";
import { active, conversations } from "../tabs/useChat-tabs";
import { useSpeechPlayer } from "../voice/speechPlayer";
import { cardWords } from "../voice/useVoiceTalk";
import { spokenCardOf } from "../voice/voiceCards";
import { useWakeListener, WAKE_HOLD_MS } from "./useWakeListener";
import WakeCard from "./WakeCard.vue";
import { type WakeConversation, WakeDelivery } from "./wakeDelivery";
import { startWakeDesktop } from "./wakeDesktop";
import { lastSaidAt } from "./wakeRoute";
import WakeTalk from "./WakeTalk.vue";
import { destinationLabel } from "./wakeWords";

// The wake word, wired into this window: the listener (useWakeListener.ts) hears, the delivery (wakeDelivery.ts) decides
// where the words go, and this hands both the chat they act on. Mounted once, above every route of a desktop-sized main
// window (WorkspaceRuntime.vue); a floating window and a phone have none, and the listener itself makes sure only one
// window of the browser holds the microphone.

const listener = useWakeListener();
const { settings } = useSandboxSettings();
const { activeSandboxId } = useSandbox();
const player = useSpeechPlayer();

// The sandbox names the word; until its settings are read, the default.
watch(
    () => settings.value?.voice.wake.word,
    (word) => {
        listener.word.value = word ?? WAKE_WORD_DEFAULT;
    },
    { immediate: true },
);

// Deaf while this page speaks (unless talking over it is how it is stopped), and while a composer has the microphone.
watch(
    () => player.speaking.value !== undefined && settings.value?.voice.interrupt !== true,
    (speaking) => listener.rest(`voice`, speaking),
    { immediate: true },
);
watch(handsFreeOn, (on) => listener.rest(`hands-free`, on), { immediate: true });

const open = (id: string): Conversation | undefined => conversations.value.find((conversation) => conversation.conversationId === id);

const asWake = (conversation: Conversation): WakeConversation => ({
    id: conversation.conversationId,
    title: conversation.title.value ?? undefined,
    asking: conversation.transcript.awaitingDecision.value,
    running: conversation.turn.streaming.value,
    lastSaidAt: lastSaidAt(conversation.transcript.messages.value),
});

const delivery = new WakeDelivery({
    now: Date.now,
    lookup: (id) => {
        const conversation = open(id);
        return conversation === undefined ? undefined : asWake(conversation);
    },
    focused: () => (onScreen.value ? asWake(active.value) : undefined),
    // Never landing by itself: anyone in the room can say the name, so what it opens waits for a person to land it.
    startNew: (text) => startAgent(text === `` ? undefined : text, undefined, undefined, { autoLand: false }),
    continueIn: (id, text) => {
        const conversation = open(id);
        if (conversation !== undefined) {
            summonTurn(conversation, text);
        }
    },
    answer: (id, text) => {
        const conversation = open(id);
        const card = conversation === undefined ? undefined : spokenCardOf(conversation.transcript.messages.value, cardWords());
        const answer = card?.answer(text);
        if (conversation === undefined || card === undefined || answer === undefined) {
            return false;
        }
        void conversation.requests.reply(card.requestId, answer);
        return true;
    },
    unclear: () => void player.say(t(`chat.voiceCards.notUnderstood`), { key: `wake:unclear:${Date.now()}`, as: `plain`, lang: navigator.language }),
    expectRequest: listener.expectRequest,
    hold: () => listener.hold(WAKE_HOLD_MS),
    sent: () => listener.sound(`sent`),
    dropped: () => listener.sound(`dropped`),
    notify: (to, text) => {
        if (onScreen.value) {
            return;
        }
        postDesktopNotice({
            key: `wake`,
            kind: `finished`,
            title: t(`chat.wake.notifyTitle`, { word: listener.word.value, destination: destinationLabel(to) }),
            body: text,
            path: `/chat`,
            silent: true,
        });
    },
});
listener.onRequest(delivery.heard);

// Another sandbox, another set of conversations: nothing in flight or under way carries over.
watch(activeSandboxId, () => {
    listener.reset();
    delivery.cancel();
    delivery.thread.value = undefined;
});

const stopDesktop = startWakeDesktop(listener);
// Another window of this browser switched listening, or paused it: this one takes it up.
const otherWindow = (event: StorageEvent): void => {
    if (event.key?.startsWith(`intentic.wake.`) === true) {
        listener.reload();
    }
};
window.addEventListener(`storage`, otherWindow);
listener.start();
onBeforeUnmount(() => {
    window.removeEventListener(`storage`, otherWindow);
    listener.onRequest(() => {});
    delivery.dispose();
    stopDesktop();
});

const threadConversation = computed(() => {
    const id = delivery.thread.value?.id;
    return id === undefined ? undefined : open(id);
});

const reveal = (id: string): void => {
    const conversation = open(id);
    if (conversation !== undefined) {
        summonChat({ kind: `reveal`, verb: `show`, entries: [conversation], focus: id, caret: true });
    }
};
</script>

<template>
    <WakeTalk v-if="threadConversation !== undefined" :key="threadConversation.conversationId" :conversation="threadConversation" :listener="listener" />
    <Teleport to="body">
        <WakeCard :listener="listener" :delivery="delivery" @open="reveal" />
    </Teleport>
</template>
