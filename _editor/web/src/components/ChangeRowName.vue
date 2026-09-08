<script setup lang="ts">
import { basename, parentDir } from "@intentic/ui/path";

// How a changed file is named in a review row, shared by the Changes panel and the fleet's agent review so they
// can't drift apart. The name leads and is legible; the directory trails, dimmed, and drops entirely under a
// module heading (which already says where the files live) — there the full path is always the tooltip, since a
// bare basename can be ambiguous.
defineProps<{
    // Repo-relative, as the daemon ships it: what this row is naming.
    path: string;
    // Repo-qualified, for the tooltip: the thing a reader needs when the row alone is not enough.
    label: string;
    // Whether a module heading above this run of rows has already named the package.
    named: boolean;
}>();
</script>

<template>
    <span v-if="named" class="min-w-0 flex-1 truncate text-2xs font-medium text-content max-md:text-xs" v-tooltip.right="label">{{
        basename(path)
    }}</span>
    <span v-else class="min-w-0 flex-1 truncate text-2xs max-md:text-xs" v-tooltip.right.overflow="label">
        <span class="font-medium text-content">{{ basename(path) }}</span>
        <span class="ml-1 text-subtle">{{ parentDir(path) }}</span>
    </span>
</template>
