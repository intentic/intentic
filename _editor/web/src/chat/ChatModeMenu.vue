<script setup lang="ts">
import { computed } from "vue";
import { modeOptions } from "../composables/chat/catalog";
import { usePaneView } from "../composables/chat/useChat";

/* The permission-mode picker body: width-agnostic (Popover on desktop, BottomSheet on mobile). Emits
 * `selected` so the host can close its overlay. Only the postures this conversation's runtime can actually be
 * put in are offered: a plan-only runtime shows two, because that is how many it has. */

const emit = defineEmits<{ selected: [] }>();

const { mode, capabilities } = usePaneView();
const modes = computed(() => modeOptions(capabilities.value));
</script>

<template>
    <div class="flex flex-col p-1">
        <button
            v-for="m in modes"
            :key="m.value"
            type="button"
            class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            :class="{ 'ui-row-select-on': mode === m.value }"
            @click="
                mode = m.value;
                emit(`selected`);
            "
        >
            <Icon :name="m.icon" class="mt-0.5 text-xs" :class="mode === m.value ? 'text-primary-500' : 'text-subtle'" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{ m.label }}</span>
                <span class="text-2xs text-subtle">{{ m.description }}</span>
            </span>
        </button>
    </div>
</template>
