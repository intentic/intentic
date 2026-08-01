<script setup lang="ts">
/* What Maintenance shows before its first /chores response: the SHAPE of the chore book, not a line of text.
 * The geometry is a deliberate copy of the real thing — a repository heading, the measured-at strip, then chore
 * rows with a chevron, a chore icon, a title, a headline and a state badge — so the page does not jump when the
 * report lands, and so the wait already says what is being waited for.
 *
 * ONE repository group, not two. Every workspace has at least one repo and most have more, so one is the floor
 * that can only be grown into; guessing two would shrink the page the moment a single-repo workspace answers,
 * and a placeholder that has to un-draw itself is worse than one that is merely modest.
 *
 * FOUR rows, because the default filter is "Needs attention" and a workspace with eleven chores due is not the
 * case to size for. Erring short means the list grows downward — the direction reading already goes.
 *
 * The heights are the real ones, not approximations: every box below states the padding and the line box it is
 * copying, and those were measured against ChoreRow/ProbeStrip in a browser rather than guessed. Widths vary per
 * row and are fixed, not random — a column of identical bars reads as a rendering artifact rather than as a list
 * of chore names, and a placeholder that reshuffles on every re-render is worse than one that repeats. */

// Per row: the chore title (the book's run from "Update dependencies" at ~133px to "Find duplication worth
// collapsing" at ~199px), the headline the evidence produced, and the state badge, whose width is its word —
// `due` is 34px, `carrying` 53px, `unmeasured` 72px.
const ROWS = [
    { title: `w-40`, headline: `w-64`, badge: `w-14` },
    { title: `w-32`, headline: `w-44`, badge: `w-9` },
    { title: `w-36`, headline: `w-80`, badge: `w-14` },
    { title: `w-52`, headline: `w-52`, badge: `w-16` },
] as const;

// The four probes a repository is measured by — dependency versions, advisories, unreachable code, copy-paste —
// at the widths their names take, each followed by an age ("3h ago") or, for one that could not run, its reason.
const PROBES = [
    { title: `w-24`, age: `w-8` },
    { title: `w-24`, age: `w-20` },
    { title: `w-20`, age: `w-20` },
    { title: `w-14`, age: `w-16` },
] as const;
</script>

<template>
    <!-- aria-busy over aria-hidden: a screen reader should hear "this region is loading", not silence that is
         indistinguishable from a workspace with no chores due. The bars carry no text, so there is nothing to
         read out of them. -->
    <div class="flex animate-fade-in flex-col gap-4" role="status" aria-busy="true" aria-label="Reading the evidence">
        <section>
            <!-- RowGroup's heading: repository name, its due count, and the caption about evidence being
                 per-repository. h-4 is the one text-xs line the real heading is. -->
            <div class="mb-2 flex h-4 items-center gap-x-2 px-0.5">
                <span class="skeleton h-3 w-40"></span>
                <span class="skeleton h-3 w-2"></span>
                <span class="skeleton h-3 w-80 max-w-[40%]"></span>
            </div>

            <div class="divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
                <!-- ProbeStrip: py-2 around a 24px line (its refresh buttons set the line box, not the 11px
                     type), so the first chore row sits where it will still be sitting a moment from now. -->
                <div class="border-b border-line/60 px-4 py-2">
                    <div class="flex h-6 items-center gap-x-4 overflow-hidden">
                        <span class="skeleton h-2.5 w-12 shrink-0"></span>
                        <div v-for="(probe, index) in PROBES" :key="index" class="flex shrink-0 items-center gap-1.5">
                            <span class="skeleton h-3 w-3 rounded-full"></span>
                            <span class="skeleton h-2.5" :class="probe.title"></span>
                            <span class="skeleton h-2.5" :class="probe.age"></span>
                            <span class="skeleton h-3 w-3"></span>
                        </div>
                    </div>
                </div>

                <!-- Chore rows: px-4 py-2.5 around a 20px line box, which is what the text-sm title and the xs
                     badge both measure — 41px with the hairline, exactly what ChoreRow collapses to. -->
                <div v-for="(row, index) in ROWS" :key="index" class="border-t border-line/60 px-4 py-2.5">
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
