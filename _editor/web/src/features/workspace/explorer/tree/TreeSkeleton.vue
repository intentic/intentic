<!-- The explorer's outline while the sandbox has sent no tree yet: rows shaped as the tree draws them, in place of "empty workspace", which a tree that has not arrived cannot be. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";

const t = useT();

// Fixed, so the outline never reshuffles on a re-render: a workspace's root as it first opens, its folders shut (the
// repositories), then its loose files. The widths stay uneven so the rows do not read as a pattern.
const ROWS = [
    { folder: true, width: `w-16` },
    { folder: true, width: `w-10` },
    { folder: true, width: `w-12` },
    { folder: true, width: `w-20` },
    { folder: true, width: `w-12` },
    { folder: false, width: `w-24` },
    { folder: false, width: `w-20` },
] as const;
</script>

<template>
    <!-- The bars are decoration; the status region and its sr-only line carry the wait to the readers who need it said. -->
    <div role="status" aria-busy="true">
        <span class="sr-only">{{ t(`ui.status.loading`) }}</span>
        <!-- The tree row's own geometry (WorkspaceTree.vue): chevron gutter, glyph, name, at the root's indent. -->
        <div
            v-for="(row, index) in ROWS"
            :key="index"
            class="flex items-center gap-1.5 py-0.5 pr-2 pl-2 text-[0.8125rem]"
            aria-hidden="true"
        >
            <!-- The chevron a folder carries in the gutter, a file's gutter empty. -->
            <span class="flex w-[0.7rem] shrink-0 justify-center"><span v-if="row.folder" class="skeleton block size-1.5" /></span>
            <span class="flex min-h-[1lh] items-center"><span class="skeleton block h-3 w-3 shrink-0" /></span>
            <span class="skeleton block h-2.5" :class="row.width" />
        </div>
    </div>
</template>
