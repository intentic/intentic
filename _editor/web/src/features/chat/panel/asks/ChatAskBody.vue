<!-- The open ask in the dock above the composer: its whole card where the dock carries it, else its answers or the way to it. -->
<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import NeedCard from "../../../needs/NeedCard.vue";
import { CARDS } from "../../transcript/cards/cardComponents";
import { dockedBody, type PendingAsk } from "../../../../models/conversations/panel/pendingAsks";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { retryHydrate } from "../../../../models/conversations/run/useChat-sessions";
import type { CardAnswer } from "../../../../models/conversations/session/cardReplies";
import { useAskDock } from "./askDock";
import { askLabel } from "./askWords";
import ChatAskChild from "./ChatAskChild.vue";

const t = useT();

const props = defineProps<{ ask: PendingAsk; canDrive: boolean }>();
// The plan's two answers, done by the composer (composerSend), whose box holds the notes either one may carry.
const emit = defineEmits<{ approve: []; keepPlanning: [] }>();

const dock = useAskDock();
const { conversation, staged } = usePaneView();
const label = computed(() => askLabel(props.ask, t));
const requestId = computed(() => (props.ask.source === `card` ? props.ask.requestId : undefined));
const replying = computed(() => requestId.value !== undefined && conversation.value.requests.isReplying(requestId.value));
const reply = (answer: CardAnswer): Promise<void> => (requestId.value === undefined || dock === undefined ? Promise.resolve() : dock.reply(requestId.value, answer));

// The card this window has not drawn yet: asked for again on the press (a transcript stuck loading did for minutes).
const fetching = ref(false);
const fetchIt = (): void => {
    const chat = conversation.value;
    chat.registered.value = true;
    fetching.value = true;
    retryHydrate(chat);
};
</script>

<template>
    <!-- A card the dock carries whole: the same component the transcript draws, answering through the same reply. -->
    <component
        :is="CARDS[ask.field]"
        v-if="ask.source === `card` && dockedBody(ask)"
        :message="ask.message"
        :settling="dock?.settling(ask.requestId) ?? false"
        :reply="reply"
    />
    <NeedCard v-else-if="ask.source === `need`" :need-id="ask.need.id" />
    <ChatAskChild v-else-if="ask.source === `child`" :agent-id="ask.agentId" :kind="ask.kind" :can-drive="canDrive" />
    <!-- A plan or a page is read in the transcript: here, its answers (a plan's) or the way to it (a page's). -->
    <div v-else class="chat-card w-full">
        <div class="chat-card-header items-center text-xs">
            <Icon :name="ask.source === `undrawn` && fetching ? `spinner` : ask.icon" :spin="ask.source === `undrawn` && fetching" class="text-sm text-accent" />
            <span class="min-w-0 truncate font-semibold text-content" v-tooltip.top.overflow="label">{{ label }}</span>
        </div>
        <div class="chat-card-row chat-card-actions flex flex-wrap items-center gap-2">
            <template v-if="ask.source === `card` && ask.field === `plan`">
                <template v-if="canDrive">
                    <Button tier="accent" size="small" thumb :disabled="replying" @click="emit(`approve`)">
                        <Icon name="check" />{{ staged ? t(`chat.askDock.approveWithNotes`) : t(`ui.action.approve`) }}
                    </Button>
                    <Button tier="boring" size="small" thumb :disabled="replying" @click="emit(`keepPlanning`)">
                        <Icon name="pencil" />{{ t(`chat.askDock.keepPlanning`) }}
                    </Button>
                </template>
                <Button tier="quiet" size="small" thumb @click="dock?.showInChat(ask.key)"><Icon name="arrow-up" />{{ t(`chat.askDock.readPlan`) }}</Button>
            </template>
            <Button v-else-if="ask.source === `card`" tier="accent" size="small" thumb @click="dock?.showInChat(ask.key)">
                <Icon name="arrow-up" />{{ t(`chat.askDock.openPage`) }}
            </Button>
            <template v-else-if="ask.source === `undrawn`">
                <span class="text-muted">{{ t(`chat.askDock.fetching`) }}</span>
                <Button tier="quiet" size="small" thumb :disabled="fetching" @click="fetchIt">{{ t(`chat.askDock.showIt`) }}</Button>
            </template>
        </div>
    </div>
</template>
