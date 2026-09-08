<script setup lang="ts">
import { RowGroup } from "@intentic/extension-ui";

// Mirrors the real chore book's shape (heading + count/caption, rows with icon, title, headline, badge) so the page
// doesn't jump when data lands. Two groups, not four, matching the default 'needs attention' filter. Heights and widths
// are measured against ChoreRow/RowGroup, not guessed.

// Widths approximate real content; badge width matches its label's own word length.
const GROUPS = [
    {
        // Widest caption in the set; the real heading caption it approximates is the longest one.
        caption: `w-96`,
        rows: [
            { title: `w-40`, headline: `w-64`, badge: `w-14` },
            { title: `w-32`, headline: `w-44`, badge: `w-9` },
        ],
    },
    {
        caption: `w-72`,
        rows: [
            { title: `w-36`, headline: `w-80`, badge: `w-14` },
            { title: `w-52`, headline: `w-52`, badge: `w-16` },
        ],
    },
] as const;
</script>

<template>
    <!-- aria-busy, not aria-hidden: silence here reads as no chores due, not as loading. -->
    <div class="flex flex-col gap-6" role="status" aria-busy="true" aria-label="Reading the evidence">
        <RowGroup v-for="(group, index) in GROUPS" :key="index">
            <!-- Kind, due count, and caption; h-4 matches the real heading's single text-xs line. -->
            <template #label>
                <span class="flex h-4 items-center gap-x-2">
                    <span class="skeleton h-3 w-20"></span>
                    <span class="skeleton h-3 w-2"></span>
                    <span class="skeleton h-3 max-w-2/5" :class="group.caption"></span>
                </span>
            </template>

            <!-- Padding and line-box height copy ChoreRow's collapsed row exactly, not approximated. -->
            <div v-for="(row, rowIndex) in group.rows" :key="rowIndex" class="border-t border-line/60 px-4 py-2.5 first:border-t-0">
                <div class="flex h-5 items-center gap-3">
                    <span class="skeleton h-3 w-3 shrink-0"></span>
                    <span class="skeleton h-4 w-4 shrink-0"></span>
                    <span class="skeleton h-3.5 shrink-0" :class="row.title"></span>
                    <!-- The headline takes the flexible column, as it does in the row itself. -->
                    <div class="min-w-0 flex-1">
                        <span class="skeleton block h-3 max-w-full" :class="row.headline"></span>
                    </div>
                    <span class="skeleton h-5 shrink-0 rounded-full" :class="row.badge"></span>
                </div>
            </div>
        </RowGroup>
    </div>
</template>
