<!-- AN AGENT THAT DOES NOT EXIST YET, drawn where its card will arrive (agentLaunches.ts): a press elsewhere is starting
     it, and the sandbox has not answered. Dashed and see-through like every place something will go (FirstAgentSlot),
     so it never passes for an agent you can open; what the start waits on and for how long is its one line. Refused, it
     goes solid and says why, in the sandbox's words, with the way back to where the press was made. -->
<script setup lang="ts">
import { Button, formatElapsed, Icon, toneRim, toneWash } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref } from "vue";
import type { AgentLaunch } from "../../../../models/fleet/launches/agentLaunches";

const t = useT();

const { launch, dense = false } = defineProps<{ launch: AgentLaunch; dense?: boolean }>();
const emit = defineEmits<{ dismiss: []; back: [path: string] }>();

const refused = computed(() => launch.failure !== undefined);
const now = useNow(() => !refused.value);
// Answered: the agent exists and its card is a roster frame away.
const line = computed(() =>
    launch.conversationId !== undefined
        ? t(`agents.launchCard.opening`)
        : `${launch.note ?? t(`agents.launchCard.waiting`)} · ${formatElapsed((now.value - launch.at) / 1000)}`,
);
// Brought into view as it arrives: the reader was sent here to see it, and with the chat open Active sits under Attention,
// below the fold, where a card nobody scrolls to reads as a press that did nothing. The board mounts before it has
// measured its grid (the card first reads as sitting at the very top), so this waits until the card has held one place
// for a few frames, a second and a half at most. Centred when it is not already clear of the edges: a phone's floating
// New agent covers the board's foot, where `nearest` would park it.
const SETTLED_FRAMES = 3;
const SETTLE_MS = 1_500;
const FOOT_PX = 96;
const root = ref<HTMLElement>();
const inClearView = (el: HTMLElement, box: DOMRect): boolean => {
    const frame = el.closest(`.overflow-auto`)?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    return box.top >= frame.top && box.bottom <= frame.bottom - FOOT_PX;
};
const bringIntoView = (deadline: number, last: number | undefined = undefined, held = 0): void => {
    const el = root.value;
    if (el === undefined) {
        return;
    }
    const box = el.getBoundingClientRect();
    const steady = box.height > 0 && box.top === last ? held + 1 : 0;
    if (steady >= SETTLED_FRAMES || performance.now() > deadline) {
        if (!inClearView(el, box)) {
            el.scrollIntoView({ block: `center`, behavior: `smooth` });
        }
        return;
    }
    requestAnimationFrame(() => bringIntoView(deadline, box.top, steady));
};
onMounted(() => bringIntoView(performance.now() + SETTLE_MS));
const back = computed(() => {
    const from = launch.from;
    return from === undefined ? undefined : { path: from.path, label: from.label === undefined ? t(`ui.action.back`) : t(`agents.launchCard.backTo`, { place: from.label }) };
});
</script>

<template>
    <div
        ref="root"
        role="status"
        :aria-label="launch.title"
        :aria-busy="!refused"
        class="flex w-full select-none flex-col rounded-2xl border text-left"
        :class="[dense ? 'gap-2 p-3.5' : 'gap-2.5 p-4', refused ? toneRim(`danger`, `soft`, `bg-card`) : 'border-dashed border-line-strong bg-card/50']"
    >
        <div class="flex items-center gap-2.5">
            <!-- Where an agent card has its identity tile: nothing to identify yet, only the wait or the refusal. -->
            <span
                class="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full"
                :class="refused ? toneWash(`danger`) : 'text-muted'"
            >
                <Icon :name="refused ? `exclamation-circle` : `spinner`" :spin="!refused" class="text-xs" />
            </span>
            <!-- `break-words` for the reason AgentCard's title states: a clamp only ellipsises a vertical overrun. -->
            <span
                class="min-w-0 flex-1 font-semibold"
                :class="[dense ? 'truncate text-xs' : 'line-clamp-2 break-words text-sm leading-snug', refused ? 'text-content' : 'text-muted']"
                >{{ launch.title }}</span
            >
            <span v-if="refused" class="ui-status-pill shrink-0 font-semibold" :class="toneWash(`danger`)">{{ t(`agents.launchCard.notStarted`) }}</span>
        </div>
        <!-- THE AGENT CARD'S OWN BODY, BLANKED: the model line as skeleton bars and the wait in the clock's seat at the right of
             the summary line, laid out with AgentCard's own classes, so the card that replaces this one lands at the height,
             and with its lines in the places, this one held for it. -->
        <div v-if="!refused" :class="dense ? 'flex flex-wrap items-center gap-x-3.5 gap-y-1.5' : 'flex flex-col gap-2'">
            <div class="flex h-4 min-w-0 items-center gap-x-3" aria-hidden="true">
                <span class="skeleton block h-2 w-20" />
                <span class="skeleton block h-2 w-14" />
                <span v-if="!dense" class="skeleton block h-2 w-24" />
            </div>
            <div class="flex min-w-0 items-center justify-end gap-1.5 text-2xs text-subtle" :class="dense ? 'min-w-32 flex-1' : ''">
                <span class="min-w-0 truncate tabular-nums">{{ line }}</span>
            </div>
        </div>
        <template v-else>
            <p class="select-text break-words text-xs text-content">{{ launch.failure }}</p>
            <div class="flex flex-wrap items-center justify-end gap-2">
                <Button v-if="back !== undefined" size="small" tier="quiet" thumb :label="back.label" @click="emit(`back`, back.path)">
                    <template #icon><Icon name="arrow-left" /></template>
                </Button>
                <Button size="small" tier="quiet" thumb @click="emit(`dismiss`)">{{ t(`ui.action.dismiss`) }}</Button>
            </div>
        </template>
    </div>
</template>
