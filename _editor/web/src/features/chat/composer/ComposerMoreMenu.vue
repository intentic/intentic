<script setup lang="ts">
import { Icon } from "@intentic/ui";
import type { ComposerControl, ComposerMoreRow } from "./composerMore";

// The composer's overflow: controls left at default, drawn from composerMore.ts. Every row is a
// handoff to the picker that owns the choice (or, for the one toggle, the press itself), not a
// setting of its own; pressing one promotes it out to a chip and off this list.

defineProps<{ rows: ComposerMoreRow[] }>();
const emit = defineEmits<{ pick: [control: ComposerControl] }>();
</script>

<template>
    <div class="flex flex-col p-1">
        <button
            v-for="row in rows"
            :key="row.key"
            type="button"
            class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            @click="emit(`pick`, row.key)"
        >
            <Icon :name="row.icon" class="mt-0.5 shrink-0 text-xs text-subtle" />
            <span class="flex min-w-0 flex-1 flex-col">
                <span class="flex min-w-0 items-baseline gap-2">
                    <span class="truncate text-sm text-content md:text-xs">{{ row.label }}</span>
                    <span class="ml-auto shrink-0 text-2xs text-subtle">{{ row.value }}</span>
                </span>
                <span class="text-2xs text-subtle">{{ row.description }}</span>
            </span>
        </button>
    </div>
</template>
