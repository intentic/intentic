<script setup lang="ts">
import { computed } from "vue";
import { useT } from "@intentic/ui/i18n";

// A file a command's output is about, as a row: its directory quiet and its name clear, opening the file where there is
// a workspace to open it in, and a quiet figure at the far edge (a line range, a match count).

const props = defineProps<{
    path: string;
    meta?: string | undefined;
    openable: boolean;
}>();

const emit = defineEmits<{ open: [] }>();

const t = useT();

const cut = computed(() => props.path.lastIndexOf(`/`) + 1);
</script>

<template>
    <div class="flex min-w-0 items-center gap-2 px-2.5 py-1 text-2xs">
        <component
            :is="openable ? 'button' : 'span'"
            :type="openable ? 'button' : undefined"
            class="min-w-0 truncate text-left font-mono"
            :class="openable && 'transition-colors hover:underline'"
            v-tooltip.top="openable ? t(`chat.words.openFile`) : undefined"
            @click="emit(`open`)"
            ><span class="text-subtle">{{ path.slice(0, cut) }}</span
            ><span class="text-content">{{ path.slice(cut) }}</span></component
        >
        <span v-if="meta" class="ml-auto shrink-0 text-subtle tabular-nums">{{ meta }}</span>
    </div>
</template>
