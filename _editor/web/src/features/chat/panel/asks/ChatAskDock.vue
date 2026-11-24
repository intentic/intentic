<!-- Everything this chat waits on a person for, as the dock's last lines over its composer: one line each in the order asked, and the open one answered here. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, provide, useTemplateRef, watch } from "vue";
import { CARD_ANSWERS_WITHHELD, CARD_HEADER_TAIL, CARD_TITLE_PRESS } from "../../../../components/ChatCard.vue";
import { dockedBody, type PendingAsk } from "../../../../models/conversations/panel/pendingAsks";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { useDriveRefusal } from "../../session/driveRefusal";
import { useAskDock } from "./askDock";
import ChatAskBody from "./ChatAskBody.vue";
import ChatAskChild from "./ChatAskChild.vue";
import ChatAskControls from "./ChatAskControls.vue";
import ChatAskRow from "./ChatAskRow.vue";
import { askKind } from "./askWords";

// One place for every ask, pinned where the transcript cannot scroll it away, as lines of the dock over the composer
// (ChatDock) like everything else there. It replaced a bar that named only the newest card and sent the reader up the
// transcript, then a box of its own with a header, a row of chips and the open card under them, whose presses stood
// first and under the words where every other line's stood last and beside them. Now an ask is a line: a plan's
// answers at its end, a card folded to its head, and the one open card drawn whole in its place.

const t = useT();

// The plan's two answers, done by the composer (composerSend), whose box holds the notes either one may carry.
const emit = defineEmits<{ approve: []; keepPlanning: [] }>();

const dock = useAskDock();
const asks = computed(() => dock?.asks.value ?? []);
const canDrive = computed(() => dock?.canDrive.value === true);

// The element the presses above look in (the ask's body, the pane it sits in), and what tells a row its card is here.
const root = useTemplateRef<HTMLElement>(`root`);
watch(root, (element) => dock !== undefined && (dock.element.value = element ?? undefined), { immediate: true });
onBeforeUnmount(() => dock !== undefined && (dock.element.value = undefined));

// A reader who follows this chat without driving it reads every card, told who answers it instead of being handed
// answers the daemon would refuse (ChatCard), as the transcript does.
const { conversation } = usePaneView();
const driveRefusal = useDriveRefusal(() => conversation.value.conversationId);
provide(
    CARD_ANSWERS_WITHHELD,
    computed(() => (driveRefusal.value === undefined ? undefined : t(`chat.cardReplies.waitsOnDriver`))),
);

// THE OPEN CARD IS ITS OWN LINE'S HEAD: the same word for what it is before its title, where the folded line's stood,
// the title going to where it was asked as a plan's does, and its fold where the folded line's unfold was.
const opened = computed(() => {
    const ask = dock?.selected.value;
    return ask !== undefined && dock?.open.value === true && dockedBody(ask) ? ask : undefined;
});
const isOpen = (ask: PendingAsk): boolean => ask.key === opened.value?.key;
provide(
    CARD_HEADER_TAIL,
    computed(() => ChatAskControls),
);
provide(
    CARD_TITLE_PRESS,
    computed(() => {
        const ask = opened.value;
        return ask === undefined || dock === undefined
            ? undefined
            : { label: t(`chat.askDock.showInChat`), press: () => void dock.showInChat(ask.key), kind: askKind(ask, t) };
    }),
);
const headline = computed(() => (canDrive.value ? t(`chat.askDock.waitingOnYou`) : t(`chat.askDock.waitingOnOthers`)));
</script>

<template>
    <div v-if="dock && asks.length > 0" ref="root" role="group" :aria-label="headline" data-ask-dock>
        <template v-for="ask in asks" :key="ask.key">
            <!-- The open card, capped so the transcript keeps room, its answers held at the foot while the rest scrolls.
                 The card clips rather than hides (`overflow-clip`): a box that hides is a scroller of its own, which the
                 answers row stuck to instead of this one, and so scrolled away with the options it answers. -->
            <div
                v-if="isOpen(ask)"
                data-ask-body
                :data-ask-line="ask.key"
                data-dock-tone="ask"
                class="chat-dock-row max-h-[50dvh] overflow-y-auto overscroll-contain [&_.chat-card]:overflow-clip [&_.chat-card-actions]:sticky [&_.chat-card-actions]:bottom-0 [&_.chat-card-actions]:bg-card"
            >
                <ChatAskBody :ask="ask" />
            </div>
            <ChatAskChild v-else-if="ask.source === `child`" :agent-id="ask.agentId" :kind="ask.kind" :can-drive="canDrive" :ask-key="ask.key" />
            <ChatAskRow v-else :ask="ask" :can-drive="canDrive" @approve="emit(`approve`)" @keep-planning="emit(`keepPlanning`)" />
        </template>
    </div>
</template>
