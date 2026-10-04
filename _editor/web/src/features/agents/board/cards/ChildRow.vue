<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract";
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { formatElapsed } from "../../fleet/agentStatus";
import AgentCardDate from "./AgentCardDate.vue";
import { markSegments } from "../../review/markSegments";
import { inProcess, type TrayChild } from "../view/childFold";
import { childLook } from "./childLook";
import RunFacts from "./RunFacts.vue";

// One child riding under its parent's card (childFold), in two lines. The first says which child and how it stands: its
// glyph, its title, and how long it has worked or when it settled, or its ask, in the card's own pill, when it asks what
// only the reader can give (its one press opens its chat, where the ask is answered). The second, quieter, says what it
// is: what it runs on (RunFacts), the model and tier a reader otherwise
// could not tell from its parent's (its kind or provider is only the title's hover, childLook); on a row wide enough for both (the button's own @container), it rides the first
// line, right of the title, and the row stays one line tall. Everything else — the branch, the cost, the diff — is its own chat's to say, one
// press away. Either kind of child draws here, from one reading (childLook): a subagent its parent's runtime ran
// in-process has no chat of its own, so its press shows its transcript in its parent's, and it has no review or menu.

const props = defineProps<{
    child: TrayChild;
    // Its chat is on screen, as a card's `selected` means it.
    selected: boolean;
    // The provider the card above it runs on: a child named only when it runs on another one.
    provider: AgentProvider;
    needle: string;
    matchCase: boolean;
    // The surface drawing it offers a conversation's row a menu of its own; without one the browser's stays.
    menus: boolean;
}>();
const emit = defineEmits<{ open: [event: MouseEvent]; review: []; menu: [event: MouseEvent] }>();

const look = computed(() => childLook(props.child, props.provider));
// Ticks each second only while it works; settled dates below follow their own minute-rate leaf.
const now = useNow(() => look.value.working);
// The second line, only for a child whose model is recorded; its kind rides the title row.
const facts = computed(() => look.value.run !== undefined);
const titleRuns = computed(() => markSegments(look.value.title, props.matchCase ? props.needle : props.needle.toLowerCase(), props.matchCase));
// A conversation's own presses; an in-process subagent's row leaves the browser's menu alone, having none of its own.
const review = (): void => {
    if (!inProcess(props.child)) {
        emit(`review`);
    }
};
const menu = (event: MouseEvent): void => {
    if (inProcess(props.child) || !props.menus) {
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
        class="ui-row-select @container flex min-h-7 w-full min-w-0 flex-col justify-center gap-px rounded-md px-2 text-left max-md:min-h-10"
        :class="{ 'ui-row-select-on': selected, 'py-1': facts }"
        @click="emit(`open`, $event)"
        @dblclick="review"
        @contextmenu="menu"
    >
        <span class="flex w-full min-w-0 items-center gap-2">
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
            <!-- Right of the title when the row has room for both; the title still gives way first. The model, the ladder and
                 the clock each keep a fixed width, so the rows of a tray read as columns rather than each hugging its own. -->
            <span v-if="look.run !== undefined" class="hidden shrink-0 items-center text-2xs text-subtle @md:flex">
                <RunFacts :run="look.run" columns />
            </span>
            <!-- The card's own pill and tone for an ask, so the reader meets the same word here as on any card that asks. -->
            <span v-if="look.ask !== undefined" class="ui-status-pill shrink-0 bg-warning/15 text-2xs font-semibold text-warning">{{ look.ask }}</span>
            <span v-if="look.working && look.since !== undefined" v-tooltip.top="look.doing" class="min-w-12 shrink-0 text-right text-2xs font-medium tabular-nums text-link">{{
                formatElapsed(look.since, now)
            }}</span>
            <span v-else-if="look.ask === undefined && look.at > 0" class="min-w-12 shrink-0 text-right text-2xs text-subtle">
                <AgentCardDate :at="look.at" />
            </span>
        </span>
        <!-- Under the title on a narrow row, where the title keeps the first line. -->
        <span v-if="look.run !== undefined" class="flex w-full min-w-0 items-center gap-1.5 pl-5 text-2xs text-subtle @md:hidden">
            <RunFacts :run="look.run" />
        </span>
    </button>
</template>
