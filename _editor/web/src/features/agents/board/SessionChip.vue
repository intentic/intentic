<script setup lang="ts">
// The session's name (the branch an isolated agent works on, its worktree name, its page's id) printed identically
// everywhere, since it's the only string linking this app to git, disk and CLI.
// A label by default, not pressable: copying lives on the card's right-click menu instead, since a rare action in the
// path of the frequent press/drag was hit by accident constantly.
// `reveal` is the one exception (the agent's own page, opening its identity panel); its label spelling is abbreviated
// (shared prefix dropped, overflow loses the middle) with the full name on hover.
import { computed } from "vue";
import { shortBranch } from "./sessionChip";

const {
    branch,
    reveal = false,
    compact = false,
} = defineProps<{
    branch: string;
    // Press to open the identity panel: the agent's own page, the one surface that shows every form of the name.
    reveal?: boolean;
    // Glyph only, for a header row with no width to spare (the detail page on a phone).
    compact?: boolean;
}>();
const emit = defineEmits<{ reveal: [event: MouseEvent] }>();

const shown = computed(() => shortBranch(branch));

const CHROME = `inline-flex min-w-0 items-center gap-1 rounded font-mono text-2xs text-subtle`;
</script>

<template>
    <button
        v-if="reveal"
        type="button"
        :class="[CHROME, `transition-colors hover:text-content`, compact ? `h-7 w-7 shrink-0 justify-center hover:bg-overlay` : `max-w-full shrink`]"
        :aria-label="`Session name: ${branch}`"
        @click.stop="emit(`reveal`, $event)"
    >
        <Icon name="code" class="shrink-0 text-2xs" />
        <template v-if="!compact">
            <span class="truncate">{{ branch }}</span>
            <Icon name="chevron-down" class="shrink-0 text-[0.6rem] opacity-60" />
        </template>
    </button>
    <span v-else v-tooltip.top="branch" :class="[CHROME, `max-w-full shrink`]">
        <Icon name="code" class="shrink-0 text-2xs" />
        <span class="truncate">{{ shown }}</span>
    </span>
</template>
