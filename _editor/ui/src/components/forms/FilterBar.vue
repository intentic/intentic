<!-- The instrument above a list: free text on the left, narrowing controls on the right, a bare action furthest right. -->
<script setup lang="ts">
import SearchBar from "./SearchBar.vue";
import { useT } from "../../i18n/index.js";

const t = useT();

/* `busy` and `clearable` are the field's own two states, forwarded rather than re-implemented. */
const {
    placeholder,
    busy = false,
    clearable = true,
} = defineProps<{
    placeholder?: string;
    /** The answer is in flight: for a bar whose list is fetched rather than filtered in the page. */
    busy?: boolean;
    /** Offer a clear affordance, and let Escape take the query back. On unless a caller's own Escape means something else. */
    clearable?: boolean;
    /** Names the field for assistive tech, where "Filter…" in a placeholder does not say WHAT is being filtered. */
    ariaLabel?: string;
}>();

const query = defineModel<string>({ required: true });
</script>

<template>
    <div class="flex flex-wrap items-center gap-2">
        <!-- 14rem before the controls beside it wrap to a line of their own: narrower, a phone's 16px field showed "Name, publishe…" of its placeholder and none of what was typed past it. -->
        <SearchBar
            v-model="query"
            variant="field"
            :placeholder="placeholder ?? t(`ui.action.filter`)"
            :busy="busy"
            :clearable="clearable"
            :aria-label="ariaLabel"
            class="min-w-[min(100%,14rem)] flex-1"
        />
        <div v-if="$slots[`controls`]" class="flex h-8 items-center gap-1 rounded-md bg-content/[0.055] px-1 max-md:h-10">
            <slot name="controls" />
        </div>
        <slot name="actions" />
    </div>
</template>
