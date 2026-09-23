<script setup lang="ts">
import { explorerColorClass } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useChatSurface } from "../../tools/chatToolSurface";

/* The frame every attachment chip shares: its border and danger edge, its remove press, its upload bar. The body is the slot's, handed what opening the file takes. */

const t = useT();

const {
    name,
    path,
    progress,
    error,
    framed = false,
    removable = false,
} = defineProps<{
    name: string;
    // Workspace-relative path: what opening the chip opens.
    path: string;
    // Upload in flight: 0..1. Undefined once the bytes are on disk.
    progress?: number;
    // Why the chip is not what it names; draws the danger edge.
    error?: string;
    // Composer only: a bordered token, since chips in a row over the input have to read as discrete removable things.
    framed?: boolean;
    removable?: boolean;
}>();

const emit = defineEmits<{ remove: [] }>();

const surface = useChatSurface();
// Nothing to open while the bytes are still going up, and nothing at all on a page with no workspace behind it.
const openable = computed(() => surface.openFile !== undefined && progress === undefined);
const open = (): void => surface.openFile?.(path);

// Fixed `colorful`: a chip is not the file tree, but the tree's vocabulary of which hue means which kind is worth sharing.
const iconColor = computed(() => explorerColorClass(`colorful`, name, `file`, false));
</script>

<template>
    <div
        class="group relative flex max-w-72"
        :class="framed ? `overflow-hidden rounded-lg border bg-card ${error === undefined ? `border-line` : `border-danger`}` : ``"
    >
        <slot :openable="openable" :open="open" :icon-color="iconColor" />
        <!-- `self-center`: a chip carrying a thumbnail or a waveform is taller than its caption. -->
        <button
            v-if="removable"
            type="button"
            class="composer-ghost relative m-1 h-5 w-5 shrink-0 self-center"
            :aria-label="t(`chat.chatFileChip.removeAttachment`)"
            @click="emit(`remove`)"
        >
            <Icon name="times" class="text-2xs" />
        </button>
        <!-- Upload progress: the one thing drawn here that is about the transfer rather than the file. -->
        <div
            v-if="progress !== undefined"
            class="absolute inset-x-0 bottom-0 h-0.5 bg-primary-500"
            :style="{ width: `${Math.round(progress * 100)}%` }"
        ></div>
    </div>
</template>
