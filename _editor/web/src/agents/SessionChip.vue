<script setup lang="ts">
/* THE SESSION'S NAME, wherever it is printed: the branch an isolated agent works on, which is also the name of
 * its worktree and the id in its page's address. One component so the string looks the same on every surface,
 * because it is the only thing joining this app to git, the disk and the CLI: a name you have to retype off the
 * screen is not an identifier, it is a picture of one.
 *
 * IT IS A LABEL BY DEFAULT, AND THAT IS THE POINT. The board's card is one press (focus the agent) and one drag
 * (move it to a lane), and this line sits in the middle of it. Made pressable, it became a small target for a
 * rare want (copying) parked in the path of the press people make all day, and it was hit by accident far
 * more often than on purpose. Copying moved to the card's right-click menu, where a once-in-a-while action does
 * not have to share a surface with an every-time one.
 *
 * `reveal` is the exception, and only on the agent's own page: there the chip opens the identity panel, which
 * is that page's subject rather than something in the way of it. The chevron is what marks it: a chip that
 * opens something has to look different from one that just says a name. That spelling prints the name WHOLE:
 * the detail page is the one surface whose subject is this agent, it has the width, and it is where somebody
 * goes when the exact string is what they came for.
 *
 * ── THE LABEL SPELLING IS ABBREVIATED, AND ONLY THE LABEL SPELLING ───────────────────────────────────────
 * The rule and the whole argument for it live in `sessionChip.ts`; in one line, the shared `agent/` prefix
 * goes and anything still over the budget loses its MIDDLE rather than its end. The CSS truncation stays
 * underneath as the last resort for a very narrow lane.
 *
 * AND THE WHOLE NAME IS ON HOVER. That reverses this file's earlier note ("no hover label on either spelling:
 * the label spells the name out already") and it is the same rule, not a new one: a hover label is wrong when
 * it repeats what is on screen and right when it completes it. The label no longer spells the name out, so it
 * now owes the reader the rest of it. */
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
