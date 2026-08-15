<script setup lang="ts">
import { type NavGroup, NavRail, Picker, type PickerOptions, Row, useCompact, useRailMemory } from "@intentic/extension-ui";
import { repoName } from "@intentic/sandbox-contract/chores";
import { computed } from "vue";

/* WHICH REPOSITORY — the view's primary navigation, and the reason the chore list can stay a list.
 *
 * This is bounded by how many repositories the workspace holds, never by how much maintenance they are owed. That
 * is the whole answer to the shape this page grows into: repos × thirteen chores in one scroll is twenty-six rows
 * at two repos and seventy-eight at six, with no way to get to one of them. The rail stays the same handful of
 * rows while the book behind it grows, and picking one is what makes the body finite.
 *
 * It NARROWS rather than selects: every row on the right is a real chore whether you came via "All repositories"
 * or via one of them, so there is nothing to go "into" — which is why <SplitView> folds it above the body once
 * the pane is too narrow for both (mobile="collapse") rather than covering the list, and why this swaps itself to
 * a Picker at that width.
 *
 * The count is what is DUE, not how many chores exist: thirteen is the same number in every repository and says
 * nothing. Whether any of them is a risk being CARRIED is the row's colour rather than a second number — see the
 * note on `tone` below. */

const { repos } = defineProps<{ repos: readonly { repo: string; due: number; carrying: number }[] }>();
// undefined = every repository. Kept undefined rather than a sentinel so the URL simply omits the parameter.
const selected = defineModel<string | undefined>();

// Which repository you were last reading about, kept across visits — the rail is where this page is steered
// from, and re-picking the same row on arrival was the cost of a URL that starts empty every time.
useRailMemory(`maintenance.repo`, selected, () => repos.map((entry) => entry.repo));

const total = computed(() => repos.reduce((sum, entry) => sum + entry.due, 0));
const carrying = computed(() => repos.reduce((sum, entry) => sum + entry.carrying, 0));

/* ONE NUMBER PER ROW, and the risk being carried is its COLOUR rather than a second number beside it. Two numbers
 * in a 16rem column read as "1 5" with nothing saying which is which — and the reader who needs the distinction is
 * scanning, not hovering. Tint is the encoding the rows themselves already use for the same fact (ChoreRow's badge
 * is warning for `carrying` and info for everything else), so the rail and the list say it the same way. The
 * tooltip is where the split is spelled out, because that is a question you ask of one row at a time. */
const tone = (count: number): string => (count > 0 ? `text-warning` : ``);
const meta = (due: number, atRisk: number): string => (atRisk === 0 ? `${due} due` : `${due} due · ${atRisk} a risk being carried right now`);

// One unlabelled group: a heading over the only group in the rail names a distinction that is not being made.
const groups = computed<NavGroup<(typeof repos)[number]>[]>(() => [{ key: `repos`, items: [...repos] }]);

// Asked of the split above, not of the screen: the board beside this rail is only as wide as the workspace pane.
const compact = useCompact();

// The same model as options. `description` carries the count the rail shows in its right column.
const options = computed<PickerOptions<string>>(() => [
    { options: [{ value: ``, label: `All repositories`, description: String(total.value), icon: `wrench` }] },
    {
        options: repos.map((entry) => ({
            value: entry.repo,
            label: repoName(entry.repo),
            description: String(entry.due),
            icon: `folder`,
        })),
    },
]);
// Picker models a string, and `` is its spelling of "no filter".
const picked = computed<string>({ get: () => selected.value ?? ``, set: (value) => (selected.value = value === `` ? undefined : value) });
</script>

<template>
    <Picker v-if="compact" v-model="picked" :options="options" aria-label="Repository" header="Repository" class="w-full text-xs" />

    <NavRail v-else :groups="groups">
        <!-- Not a member of any group, so it cannot be filtered or grouped away: "all" is the state the rail
             returns to, and a row you cannot get back to is a filter you cannot clear. -->
        <template #pinned>
            <Row
                as="button"
                density="dense"
                icon="wrench"
                title="All repositories"
                :selected="selected === undefined"
                class="rounded-md"
                @click="selected = undefined"
            >
                <template #meta>
                    <span v-tooltip.bottom="meta(total, carrying)" :class="tone(carrying)">{{ total }}</span>
                </template>
            </Row>
        </template>

        <template #row="{ item: entry }">
            <Row
                :key="entry.repo"
                as="button"
                density="dense"
                icon="folder"
                :title="repoName(entry.repo)"
                :selected="selected === entry.repo"
                class="rounded-md"
                @click="selected = entry.repo"
            >
                <template #meta>
                    <span v-tooltip.bottom="meta(entry.due, entry.carrying)" :class="tone(entry.carrying)">{{ entry.due }}</span>
                </template>
            </Row>
        </template>
    </NavRail>
</template>
