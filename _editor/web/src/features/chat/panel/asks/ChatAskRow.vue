<!-- An ask as one line of the dock: a plan's answers, the way to a page, an ask still on its way, or a card folded to its head. -->
<script setup lang="ts">
import { Button, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { dockedBody, type PendingAsk } from "../../../../models/conversations/panel/pendingAsks";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { retryHydrate } from "../../../../models/conversations/run/useChat-sessions";
import ChatDockRow from "../dock/ChatDockRow.vue";
import { useAskDock } from "./askDock";
import { askKind, askLabel } from "./askWords";

const t = useT();

const props = defineProps<{ ask: PendingAsk; canDrive: boolean }>();
// The plan's two answers, done by the composer (composerSend), whose box holds the notes either one may carry.
const emit = defineEmits<{ approve: []; keepPlanning: [] }>();

const dock = useAskDock();
const { conversation, staged } = usePaneView();

const plan = computed(() => props.ask.source === `card` && props.ask.field === `plan`);
const page = computed(() => props.ask.source === `card` && props.ask.field === `pageAsk`);
// A card the dock carries whole, folded to this line: its title and the fold open it again.
const folded = computed(() => dockedBody(props.ask));
// The word for what it is goes before its name, unless the name already is that word (an ask with no words of its own).
const kind = computed(() => askKind(props.ask, t));
const title = computed(() => askLabel(props.ask, t));
// The title goes where the ask is read: a folded card opens here, a plan in the chat it was made in. A page's one press
// already goes there, and an ask not drawn yet is nowhere to go.
const opens = computed(() => {
    if (folded.value) {
        return dock?.canDrive.value ? t(`ui.action.answer`) : t(`chat.askDock.show`);
    }
    return plan.value ? t(`chat.askDock.showInChat`) : undefined;
});
const open = (): void => {
    if (folded.value) {
        dock?.pick(props.ask.key);
        return;
    }
    void dock?.showInChat(props.ask.key);
};

const requestId = computed(() => (props.ask.source === `card` ? props.ask.requestId : undefined));
const replying = computed(() => requestId.value !== undefined && conversation.value.requests.isReplying(requestId.value));

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
    <ChatDockRow
        :icon="ask.source === `undrawn` && fetching ? `spinner` : ask.icon"
        :spin="ask.source === `undrawn` && fetching"
        tone="ask"
        :kind="kind"
        :title="title"
        :opens="opens"
        :data-ask-line="ask.key"
        @open="open"
    >
        <!-- A reader who may not answer is told who will, as a card says it in its answers' place (ChatCard). -->
        <template v-if="plan && !canDrive" #detail>
            <span class="flex items-center gap-1.5" data-card-withheld><Icon name="lock" aria-hidden="true" class="shrink-0" />{{ t(`chat.cardReplies.waitsOnDriver`) }}</span>
        </template>
        <template v-else-if="ask.source === `undrawn`" #detail>{{ t(`chat.askDock.fetching`) }}</template>
        <template v-if="(plan && canDrive) || page || ask.source === `undrawn`" #actions>
            <template v-if="plan">
                <Button tier="boring" size="small" thumb :disabled="replying" @click="emit(`keepPlanning`)">{{ t(`chat.askDock.keepPlanning`) }}</Button>
                <Button tier="accent" size="small" thumb :disabled="replying" @click="emit(`approve`)">
                    <Icon name="check" />{{ staged ? t(`chat.askDock.approveWithNotes`) : t(`ui.action.approve`) }}
                </Button>
            </template>
            <Button v-else-if="page" tier="accent" size="small" thumb @click="dock?.showInChat(ask.key)">
                <Icon name="arrow-up" />{{ t(`chat.askDock.openPage`) }}
            </Button>
            <Button v-else-if="ask.source === `undrawn`" tier="quiet" size="small" thumb :disabled="fetching" @click="fetchIt">{{ t(`chat.askDock.showIt`) }}</Button>
        </template>
        <template v-if="folded" #tail>
            <button
                type="button"
                :class="ui.iconButton({ size: `sm` })"
                aria-expanded="false"
                :aria-label="t(`chat.askDock.unfold`)"
                v-tooltip.top="t(`chat.askDock.unfold`)"
                @click="dock?.pick(ask.key)"
            >
                <Icon name="chevron-up" class="text-2xs" />
            </button>
        </template>
    </ChatDockRow>
</template>
