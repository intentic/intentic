<!--
    The instrument above a list: free text on the left, narrowing controls on the right, a bare action furthest right. The field takes the row's
    slack so the bar spans the list's full width.
-->
<script setup lang="ts">
import SearchBar from "./SearchBar.vue";

/* `busy` and `clearable` are the field's own two states, forwarded rather than re-implemented. They ship
 * because the first bar over a SERVER-backed list (the knowledge base's search) had both and this component
 * had neither, so adopting it would have cost a spinning magnifier and an Escape-to-clear, and a shared
 * component you have to give something up to use is one the next view hand-rolls instead. Neither is a style
 * fork: they say what the field is DOING, which only the caller knows. */
const {
    placeholder = `Filter…`,
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
                :placeholder="placeholder"
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
