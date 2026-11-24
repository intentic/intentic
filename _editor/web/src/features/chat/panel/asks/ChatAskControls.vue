<!-- The fold of the ask the dock has open, at the end of its card's header (CARD_HEADER_TAIL): where its folded line's own stood. -->
<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useAskDock } from "./askDock";

const t = useT();

const dock = useAskDock();
</script>

<template>
    <!-- `-my-1`: the press stands over the header's padding rather than growing it, centred on a wrapped title's first line. -->
    <span v-if="dock" class="-my-1 flex shrink-0 items-center self-start">
        <button
            type="button"
            :class="ui.iconButton({ size: `sm` })"
            aria-expanded="true"
            :aria-label="t(`chat.askDock.fold`)"
            v-tooltip.top="t(`chat.askDock.fold`)"
            @click="dock.toggle()"
        >
            <Icon name="chevron-down" class="text-2xs" />
        </button>
    </span>
</template>
