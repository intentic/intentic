<script setup lang="ts">
/* What Maintenance shows before its first /chores response: the SHAPE of the chore book, not a line of text. The
 * geometry is a deliberate copy of the real thing — a kind heading with its count and its caption, then chore rows
 * with a chevron, a chore icon, a title, a headline and a state badge — so the page does not jump when the report
 * lands, and so the wait already says what is being waited for.
 *
 * TWO KIND GROUPS, not four. The default filter is "Needs attention", and a repository with something due in every
 * one of the four kinds is not the case to size for; two is what a workspace with anything to do usually has.
 * Erring short means the list grows downward — the direction reading already goes — while guessing four would
 * shrink the page the moment the report answers.
 *
 * Nothing here stands in for the rail or the scope strip. Both are DERIVED from the same report: until it lands
 * there is no list of repositories to index and no measurement to be honest about the age of, and drawing a
 * placeholder for either would be inventing the one thing this surface must never invent.
 *
 * The heights are the real ones, not approximations: every box below states the padding and the line box it is
 * copying, and those were measured against ChoreRow/RowGroup in a browser rather than guessed. Widths vary per row
 * and are fixed, not random — a column of identical bars reads as a rendering artifact rather than as a list of
 * chore names, and a placeholder that reshuffles on every re-render is worse than one that repeats. */

// Per row: the chore title (the book's run from "Update dependencies" at ~133px to "Find duplication worth
// collapsing" at ~199px), the headline the evidence produced, and the state badge, whose width is its word —
// `due` is 34px, `carrying` 53px, `unmeasured` 72px.
const GROUPS = [
    {
        // The caption beside the heading — "a risk this repository is running today — …" is the longest of them.
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
    <!-- aria-busy over aria-hidden: a screen reader should hear "this region is loading", not silence that is
         indistinguishable from a workspace with no chores due. The bars carry no text, so there is nothing to
         read out of them. -->
    <div class="flex animate-fade-in flex-col gap-6" role="status" aria-busy="true" aria-label="Reading the evidence">
        <section v-for="(group, index) in GROUPS" :key="index">
            <!-- RowGroup's heading: the kind, its due count, and the caption arguing for the grouping. h-4 is the
                 one text-xs line the real heading is. -->
            <div class="mb-2 flex h-4 items-center gap-x-2 px-0.5">
                <span class="skeleton h-3 w-20"></span>
                <span class="skeleton h-3 w-2"></span>
                <span class="skeleton h-3 max-w-[45%]" :class="group.caption"></span>
            </div>

            <div class="divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
                <!-- Chore rows: px-4 py-2.5 around a 20px line box, which is what the text-sm title and the xs
                     badge both measure — 41px with the hairline, exactly what ChoreRow collapses to. -->
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
            </div>
        </section>
    </div>
</template>
