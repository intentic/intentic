<script setup lang="ts">
import { basename, parentDir } from "@intentic/ui/path";

/* HOW A CHANGED FILE IS NAMED IN A REVIEW ROW — the same way in both lists that have such rows (the workspace's
 * Changes panel, the fleet's agent review), because a file called one thing on one screen and another thing on
 * the next is how two panels stop feeling like one product.
 *
 * A review is read BY FILE NAME, so the name leads and is legible; the directory trails and is dimmed. The
 * full-path row this replaces was middle-truncated, which made every row in a deep tree look identical — the
 * one shape a list of thirty paths must not have.
 *
 * Under a module heading the directory is dropped entirely: the heading has already said where these files
 * live, and repeating the prefix on every row is precisely what module grouping exists to stop. There the full
 * path becomes the tooltip ALWAYS, not only when the row is cut off — a basename is ambiguous by construction
 * (two `index.ts` in one package), and this is the one reading where looking harder cannot resolve it.
 */
defineProps<{
    // Repo-relative, as the daemon ships it — what this row is naming.
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
