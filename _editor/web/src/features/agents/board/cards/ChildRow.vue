<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract";
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { formatElapsed } from "../../fleet/agentStatus";
import { relativeTime } from "../../../chat/models/catalog";
import { markSegments } from "../../review/markSegments";
import { inProcess, type TrayChild } from "../view/childFold";
import { childLook } from "./childLook";

// One child riding under its parent's card (childFold): how it stands, what it is called, and how long it has worked
// or when it settled. Everything else it has — the model, the branch, the cost, the diff — is its own chat's to say,
// one press away; a row carries only what tells the children apart at a glance. A child asking what only the reader can
// give wears its ask, in the card's own pill, and the row's one press opens its chat, where the ask is answered. Either
// kind of child draws here, from one reading (childLook): a subagent its parent's runtime ran in-process has no chat of
// its own, so its press opens its parent's, and it has no review or menu to offer.

const props = defineProps<{
    child: TrayChild;
    // Its chat is on screen, as a card's `selected` means it.
    selected: boolean;
    // The provider the card above it runs on: a child named only when it runs on another one.
    provider: AgentProvider;
    needle: string;
    matchCase: boolean;
}>();
const emit = defineEmits<{ open: [event: MouseEvent]; review: []; menu: [event: MouseEvent] }>();

const look = computed(() => childLook(props.child, props.provider));
// Ticks only while it works; a settled row shares the clock without re-ticking.
const now = useNow(() => look.value.working);
const titleRuns = computed(() => markSegments(look.value.title, props.matchCase ? props.needle : props.needle.toLowerCase(), props.matchCase));
// A conversation's own presses; an in-process subagent's row leaves the browser's menu alone, having none of its own.
const review = (): void => {
    if (!inProcess(props.child)) {
        emit(`review`);
    }
};
const menu = (event: MouseEvent): void => {
    if (inProcess(props.child)) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    emit(`menu`, event);
};
</script>

<template>
    <button
        type="button"
        class="ui-row-select flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left max-md:min-h-10"
        :class="{ 'ui-row-select-on': selected }"
        @click="emit(`open`, $event)"
        @dblclick="review"
        @contextmenu="menu"
    >
        <Icon
            :name="look.glyph.icon"
            :spin="look.glyph.spin"
            role="img"
            :aria-label="look.glyph.label"
            v-tooltip.top="look.hint"
            class="shrink-0 text-xs"
            :class="look.glyph.class"
        />
        <span class="min-w-0 flex-1 truncate text-xs" :class="look.quiet ? 'text-muted' : 'text-content'" v-tooltip.top="look.titleHint">
            <span v-for="(run, at) in titleRuns" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''">{{ run.text }}</span>
        </span>
        <span v-if="look.tag !== undefined" class="shrink-0 text-2xs text-subtle">{{ look.tag }}</span>
        <!-- The card's own pill and tone for an ask, so the reader meets the same word here as on any card that asks. -->
        <span v-if="look.ask !== undefined" class="ui-status-pill shrink-0 bg-warning/15 text-2xs font-semibold text-warning">{{ look.ask }}</span>
        <span v-if="look.working && look.since !== undefined" v-tooltip.top="look.doing" class="shrink-0 text-2xs font-medium tabular-nums text-link">{{
            formatElapsed(look.since, now)
        }}</span>
        <span v-else-if="look.ask === undefined && look.at > 0" class="shrink-0 text-2xs text-subtle">{{ relativeTime(look.at) }}</span>
    </button>
</template>
