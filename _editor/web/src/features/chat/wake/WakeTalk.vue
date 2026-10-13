<script setup lang="ts">
import { computed, watch } from "vue";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import { conversationView } from "../panel/useChat-view";
import type { Conversation } from "../session/conversation";
import { useSpeechPlayer } from "../voice/speechPlayer";
import { useVoiceTalk } from "../voice/useVoiceTalk";
import { FOLLOWING_MS, WAKE_HOLD_MS, type WakeListener } from "./useWakeListener";

// The agent answering out loud in the conversation a wake went to, as hands-free voice answers in a composer
// (useVoiceTalk): a finished turn said short, a card it stops on put to the person. Its words over, the person may answer
// back without the name for a moment (the listener's `following` window). Renderless; one per exchange, keyed by the
// conversation, so the next exchange starts with nothing said.

const props = defineProps<{ conversation: Conversation; listener: WakeListener }>();

const view = conversationView(computed(() => props.conversation));
const settings = useSandboxSettings().settings;
const player = useSpeechPlayer();

useVoiceTalk({
    voice: {
        on: computed(() => props.listener.phase.value === `listening`),
        speaking: props.listener.speaking,
        rest: (deaf) => props.listener.rest(`talk`, deaf),
    },
    messages: view.messages,
    streaming: view.streaming,
    awaitingDecision: view.awaitingDecision,
    conversationId: () => props.conversation.conversationId,
    reply: (requestId, answer) => props.conversation.requests.reply(requestId, answer),
    settings: computed(() => settings.value?.voice),
    player,
});

const answerBack = (): void => {
    props.listener.follow(FOLLOWING_MS);
    props.listener.hold(FOLLOWING_MS + WAKE_HOLD_MS);
};

// What this exchange's voice is saying: its keys are `talk:<conversation>:…` (useVoiceTalk).
const mine = (key: string | undefined): boolean => key?.startsWith(`talk:${props.conversation.conversationId}:`) === true;
watch(player.speaking, (now, before) => {
    if (mine(before) && !mine(now)) {
        answerBack();
    }
});
// Nothing said aloud when replies are off: the turn's end is the moment to answer back.
watch(view.streaming, (now, before) => {
    if (before === true && !now && settings.value?.voice.replies === false) {
        answerBack();
    }
});
</script>

<template>
    <span hidden></span>
</template>
