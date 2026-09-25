<!-- The instrument above a list: free text on the left, narrowing controls on the right, a bare action furthest right. -->
<script setup lang="ts">
import SearchBar from "./SearchBar.vue";
import { useT } from "../../i18n/index.js";

const t = useT();

/* `busy` and `clearable` are the field's own two states, forwarded rather than re-implemented. */
const {
    placeholder,
    busy = false,
    clearable = false,
} = defineProps<{
    placeholder?: string;
    /** Shown at the field's trailing edge while a query is active: "how much did I just narrow this to". */
    count?: number;
    /** The answer is in flight: for a bar whose list is fetched rather than filtered in the page. */
    busy?: boolean;
    /** Offer a clear affordance, and let Escape take the query back. */
    clearable?: boolean;
    /** Names the field for assistive tech, where "Filter…" in a placeholder does not say WHAT is being filtered. */
    ariaLabel?: string;
}>();

const query = defineModel<string>({ required: true });
</script>

<template>
    <div class="flex flex-wrap items-center gap-2">
        <div class="ui-search-row flex h-8 min-w-40 flex-1 items-center overflow-hidden rounded-md border border-line bg-canvas">
            <SearchBar
                v-model="query"
                :placeholder="placeholder ?? t(`ui.action.filter`)"
                :busy="busy"
                :clearable="clearable"
                :aria-label="ariaLabel"
                class="min-w-0 flex-1 border-b-0"
            />
            <span v-if="count !== undefined && query.trim() !== ``" class="shrink-0 pr-2.5 text-2xs tabular-nums text-subtle">{{ count }}</span>
        </div>
        <div v-if="$slots[`controls`]" class="flex h-8 items-center gap-2 rounded-md border border-line bg-canvas px-1">
            <slot name="controls" />
        </div>
        <slot name="actions" />
    </div>
</template>
