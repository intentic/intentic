<!-- The explorer's outline while the sandbox has sent no tree yet: rows shaped as the tree draws them, in place of "empty workspace", which a tree that has not arrived cannot be. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";

const t = useT();

// Fixed, so the outline never reshuffles on a re-render: a few folders, one of them open a level, then loose files. The
// widths stay uneven so the rows do not read as a pattern.
const ROWS = [
    { depth: 0, width: `w-24` },
    { depth: 0, width: `w-16` },
    { depth: 1, width: `w-28` },
    { depth: 1, width: `w-20` },
    { depth: 1, width: `w-32` },
    { depth: 0, width: `w-20` },
    { depth: 0, width: `w-28` },
    { depth: 0, width: `w-14` },
    { depth: 0, width: `w-24` },
] as const;
</script>

<template>
    <!-- The bars are decoration; the status region and its sr-only line carry the wait to the readers who need it said. -->
    <div role="status" aria-busy="true">
        <span class="sr-only">{{ t(`ui.status.loading`) }}</span>
        <!-- The tree row's own geometry (WorkspaceTree.vue): chevron gutter, glyph, name, indented 0.75rem a level. -->
        <div
            v-for="(row, index) in ROWS"
            :key="index"
            class="flex items-center gap-1.5 py-0.5 pr-2 text-[0.8125rem]"
            :style="{ paddingLeft: `${0.5 + row.depth * 0.75}rem` }"
            aria-hidden="true"
        >
            <span class="w-[0.7rem] shrink-0"></span>
            <span class="flex min-h-[1lh] items-center"><span class="skeleton block h-3 w-3 shrink-0" /></span>
            <span class="skeleton block h-2.5" :class="row.width" />
        </div>
    </div>
</template>
