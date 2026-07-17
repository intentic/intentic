<script setup lang="ts">
import { MODES } from "../composables/chat/catalog";
import { useChat } from "../composables/chat/useChat";

/* The permission-mode picker body — width-agnostic (Popover on desktop, BottomSheet on mobile). Emits
 * `selected` so the host can close its overlay. */

const emit = defineEmits<{ selected: [] }>();

const { mode } = useChat();
</script>

<template>
    <div class="flex flex-col p-1">
        <button
            v-for="m in MODES"
            :key="m.value"
            type="button"
            class="qopt flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors max-md:py-3"
            :class="{ 'qopt-on': mode === m.value }"
            @click="
                mode = m.value;
                emit(`selected`);
            "
        >
            <Icon :name="m.icon" class="mt-0.5 text-xs" :class="mode === m.value ? 'text-primary-500' : 'text-subtle'" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content">{{ m.label }}</span>
                <span class="text-2xs text-subtle">{{ m.description }}</span>
            </span>
        </button>
    </div>
</template>
