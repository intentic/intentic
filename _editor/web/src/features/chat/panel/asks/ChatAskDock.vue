<!-- Everything this chat waits on a person for, above its composer: how many, one chip each in the order asked, and the open one answered here. -->
<script setup lang="ts">
import { ui } from "@intentic/ui";
import { countBadgePlate, countBadgeText } from "@intentic/ui/count-badge";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, onBeforeUnmount, provide, useTemplateRef, watch } from "vue";
import { CARD_ANSWERS_WITHHELD } from "../../../../components/ChatCard.vue";
import type { PendingAsk } from "../../../../models/conversations/panel/pendingAsks";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { useDriveRefusal } from "../../session/driveRefusal";
import { useAskDock } from "./askDock";
import { askLabel } from "./askWords";
import ChatAskBody from "./ChatAskBody.vue";

// One place for every ask, pinned where the transcript cannot scroll it away. It replaced two: a bar that named only the
// newest card and sent the reader up the transcript to answer it, and a strip of needs answered in place. Both kinds are
// answered here now, and a row of chips says at a glance how many wait and what each is, by its glyph and a few words.

const t = useT();

// The plan's two answers, done by the composer (composerSend), whose box holds the notes either one may carry.
const emit = defineEmits<{ approve: []; keepPlanning: [] }>();

const dock = useAskDock();
const asks = computed(() => dock?.asks.value ?? []);
const selected = computed(() => dock?.selected.value);
const open = computed(() => dock?.open.value === true);
const canDrive = computed(() => dock?.canDrive.value === true);
const count = computed(() => asks.value.length);

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

// Chips whenever there is a choice to make or nothing open to read: several asks, or a folded dock.
const chips = computed(() => count.value > 1 || !open.value);
const isOn = (ask: PendingAsk): boolean => open.value && ask.key === selected.value?.key;
// A chip opens its ask; the open one's chip folds the dock again.
const press = (ask: PendingAsk): void => (isOn(ask) ? dock?.toggle() : dock?.pick(ask.key));
// Only an ask made in this transcript has a row to go to; a child's is in its own chat.
const inChat = computed(() => selected.value !== undefined && open.value && selected.value.source !== `child` && selected.value.source !== `undrawn`);
const headline = computed(() => (canDrive.value ? t(`chat.askDock.waitingOnYou`) : t(`chat.askDock.waitingOnOthers`)));
// The open ask's chip brought into the row's view, when the row has scrolled it off one side.
const chipRow = useTemplateRef<HTMLElement>(`chipRow`);
watch(
    () => selected.value?.key,
    async (key) => {
        await nextTick();
        const chip = [...(chipRow.value?.querySelectorAll<HTMLElement>(`[data-ask-chip]`) ?? [])].find((candidate) => candidate.dataset[`askChip`] === key);
        chip?.scrollIntoView({ block: `nearest`, inline: `nearest` });
    },
);
</script>

<template>
    <!-- `chat-card` for its measures alone (chat.css): the header's mark column and the chips' start stand on the card's own edges. -->
    <section
        v-if="dock && count > 0"
        ref="root"
        class="chat-card flex flex-col overflow-hidden rounded-xl border border-primary-500/40 bg-card text-2xs shadow-sm"
        :aria-label="headline"
        data-ask-dock
    >
        <div class="chat-card-header items-center text-xs" :class="chips && `pb-1`">
            <Icon name="exclamation-circle" class="text-sm text-accent" />
            <span class="flex min-w-0 items-center gap-1.5">
                <span class="truncate font-semibold text-content">{{ headline }}</span>
                <span v-if="count > 1" :class="[countBadgePlate(`warning`), `inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-2xs leading-none font-semibold tabular-nums`]">{{
                    countBadgeText(count)
                }}</span>
            </span>
            <button
                v-if="inChat"
                type="button"
                :class="ui.iconButton({ size: `sm` })"
                :aria-label="t(`chat.askDock.showInChat`)"
                v-tooltip.top="{ title: t(`chat.askDock.showInChat`) }"
                @click="selected && dock.showInChat(selected.key)"
            >
                <Icon name="arrow-up" class="text-2xs" />
            </button>
            <button
                type="button"
                :class="ui.iconButton({ size: `sm` })"
                :aria-expanded="open"
                :aria-label="open ? t(`chat.askDock.fold`) : t(`chat.askDock.unfold`)"
                v-tooltip.top="open ? t(`chat.askDock.fold`) : t(`chat.askDock.unfold`)"
                @click="dock.toggle()"
            >
                <Icon :name="open ? `chevron-down` : `chevron-up`" class="text-2xs" />
            </button>
        </div>
        <!-- One chip per ask, in the order asked: its glyph and a few words, lit for the open one. One line that scrolls
             sideways rather than wrapping, so a phone's footer does not grow a row per ask; the count says how many there are. -->
        <div
            v-if="chips"
            ref="chipRow"
            class="scrollbar-none flex gap-1 overflow-x-auto pr-3.5 pb-2 pl-[var(--chat-card-text)]"
            role="group"
            :aria-label="headline"
        >
            <button
                v-for="ask in asks"
                :key="ask.key"
                type="button"
                :aria-pressed="isOn(ask)"
                :class="ui.chip({ on: isOn(ask) }, `shrink-0`)"
                :data-ask-chip="ask.key"
                v-tooltip.top.overflow="askLabel(ask, t)"
                @click="press(ask)"
            >
                <Icon :name="ask.icon" class="shrink-0" />
                <span class="max-w-48 truncate">{{ askLabel(ask, t) }}</span>
            </button>
        </div>
        <!-- The open ask, capped so the transcript keeps room, its answers row held at the foot while the rest scrolls. -->
        <div
            v-if="open && selected"
            :key="selected.key"
            data-ask-body
            class="max-h-[50dvh] overflow-y-auto overscroll-contain border-t border-line [&_.chat-card-actions]:sticky [&_.chat-card-actions]:bottom-0 [&_.chat-card-actions]:bg-card"
        >
            <ChatAskBody :ask="selected" :can-drive="canDrive" @approve="emit(`approve`)" @keep-planning="emit(`keepPlanning`)" />
        </div>
    </section>
</template>
