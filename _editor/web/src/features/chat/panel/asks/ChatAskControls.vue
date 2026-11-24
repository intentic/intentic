<!-- The dock's own presses: to where the open ask was made, and folding the dock. In the dock's header, or at the end of
     the one card it holds when that card's header is the dock's head (CARD_HEADER_TAIL). -->
<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useAskDock } from "./askDock";

const t = useT();

const dock = useAskDock();
const selected = computed(() => dock?.selected.value);
const open = computed(() => dock?.open.value === true);
// Only an ask made in this transcript has a row to go to; a child's is in its own chat.
const inChat = computed(() => selected.value !== undefined && open.value && selected.value.source !== `child` && selected.value.source !== `undrawn`);
</script>

<template>
    <!-- `-my-1`: the presses stand over the header's padding rather than growing it, so a header holding them is as tall
         as one that does not, and they centre on a wrapped title's first line. -->
    <span v-if="dock" class="-my-1 flex shrink-0 items-center self-start">
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
    </span>
</template>
