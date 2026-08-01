<script setup lang="ts">
import { type ChangeStatus, STATUS_CLASS, STATUS_LETTER } from "../pages/workspace/workspaceTabs";

/* Git's one-letter status, in the fixed-width cell every changed-file row reserves for it — M, A, D, R, ?.
 *
 * The LETTERS and their COLOURS were already shared (workspaceTabs.ts); the cell that renders them was not, so
 * six surfaces had each written the same span: the Changes panel, the agent review panel, the history panel,
 * the git graph, the file tabs and the diff toolbar. The width is the load-bearing part — `w-3` with centred
 * text is what keeps a column of paths starting at the same x whether their status letter is an I or a W, and
 * it is exactly the detail a seventh copy would get subtly wrong.
 *
 * Sits beside DiffStat, the other half of a changed-file row that both the workspace and the fleet render. */

defineProps<{ status: ChangeStatus }>();
</script>

<template>
    <span class="w-3 shrink-0 text-center font-mono text-2xs" :class="STATUS_CLASS[status]">{{ STATUS_LETTER[status] }}</span>
</template>
