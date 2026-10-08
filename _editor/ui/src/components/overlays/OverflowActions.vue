<!-- A row's or a card's own presses: an icon button each where a pointer can hover them, one ⋯ opening them as an <ActionSheet> on a phone. -->
<script setup lang="ts">
import { ref } from "vue";
import { useDevice } from "../../composables/useDevice.js";
import { useT } from "../../i18n/index.js";
import { ui } from "../../lib/ui.js";
import Icon from "../primitives/Icon.vue";
import ActionSheet from "./ActionSheet.vue";
import type { ActionItem } from "./actionItem.js";

// A phone has no hover to reveal a row of glyphs on and no pointer precise enough to tell four of them apart, and
// every one it drew took width from the title beside it: a card's name read as "Add Stripe checkout t…" behind a
// pencil, a box, a plus and an arrow. So there the presses fold into one, and the sheet it opens names each of them in
// words, which the glyphs never did without a tooltip a phone cannot show.

defineOptions({ inheritAttrs: false });

const {
    actions,
    buttonClass = ui.iconButton(),
    iconClass = `text-sm`,
} = defineProps<{
    actions: readonly ActionItem[];
    /** Each icon button's class where they are drawn one by one: the caller's own chrome, reveal-on-hover included. */
    buttonClass?: string;
    iconClass?: string;
    /** The sheet's title on a phone: what the presses are about (the card's name). */
    header?: string;
}>();

const { mobile } = useDevice();
const sheetOpen = ref(false);
const more = ref<HTMLElement>();
const t = useT();
</script>

<template>
    <!-- One press folds into nothing: a sheet of one row is a detour, so it keeps its own button everywhere. -->
    <template v-if="!mobile || actions.length === 1">
        <button
            v-for="action in actions"
            :key="action.id"
            type="button"
            :class="buttonClass"
            :disabled="action.disabled"
            :aria-label="action.label"
            v-tooltip.top="action.hint ?? action.label"
            @click.stop="action.run($event.currentTarget as HTMLElement)"
        >
            <Icon :name="action.icon" :class="iconClass" />
        </button>
    </template>
    <template v-else-if="actions.length > 0">
        <button
            ref="more"
            type="button"
            :class="ui.iconButton({ size: `md` })"
            :aria-label="t(`ui.action.moreActions`)"
            aria-haspopup="menu"
            :aria-expanded="sheetOpen"
            @click.stop="sheetOpen = true"
        >
            <Icon name="ellipsis" :class="iconClass" />
        </button>
        <ActionSheet v-model="sheetOpen" :actions="actions" :header="header" :from="more" />
    </template>
</template>
