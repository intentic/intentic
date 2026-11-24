<!-- The open ask's whole card in the dock above the composer: the card the transcript draws, answering through the same reply. -->
<script setup lang="ts">
import NeedCard from "../../../needs/NeedCard.vue";
import { CARDS } from "../../transcript/cards/cardComponents";
import type { PendingAsk } from "../../../../models/conversations/panel/pendingAsks";
import type { CardAnswer } from "../../../../models/conversations/session/cardReplies";
import { useAskDock } from "./askDock";

const props = defineProps<{ ask: PendingAsk }>();

const dock = useAskDock();
const reply = (answer: CardAnswer): Promise<void> =>
    props.ask.source !== `card` || dock === undefined ? Promise.resolve() : dock.reply(props.ask.requestId, answer);
</script>

<template>
    <component :is="CARDS[ask.field]" v-if="ask.source === `card`" :message="ask.message" :settling="dock?.settling(ask.requestId) ?? false" :reply="reply" />
    <NeedCard v-else-if="ask.source === `need`" :need-id="ask.need.id" />
</template>
