<script setup lang="ts">
import { type NavGroup, NavRail, Picker, type PickerGroup, type PickerOptions, Row, useCompact } from "@intentic/extension-ui";
import { computed } from "vue";
import { type RepoStanding, standingNote } from "./repoStandings";

/* WHICH REPOSITORY — the board's scope, and the reason a repository with nothing to report can stop costing a
 * card without disappearing.
 *
 * IT NARROWS, IT DOES NOT SELECT. "All repositories" is where the page opens and where it returns to, because
 * the first question a CI board answers is "is anything red anywhere" — a picker you have to walk repository by
 * repository to answer that is not a monitoring surface, it is a filing cabinet. That is the whole difference
 * from Documentation's repository dropdown: there you are always reading exactly one repository's pages, so a
 * dropdown is the shape of the job. Here the cross-repo view IS the job, and narrowing is the extra.
 *
 * WHY A COLUMN AND NOT A DROPDOWN, given it narrows: it has to show a per-repository count while you scan, which
 * is what makes "all" and "one" the same glance. A closed dropdown shows one repository's name and no numbers.
 *
 * ONE NUMBER PER ROW, and it is BROKEN BRANCHES — the same edge-not-level rule as the rail badge (ciStreaks), so
 * a repository three runs deep in one breakage says "1" and not "3". A repository that is fine says 0, and that
 * zero is worth printing: a board you cannot use to confirm there is nothing wrong is only half a board. The
 * second fact a row could carry — a webhook that never registered, so the numbers beside it may be stale — is
 * the number's COLOUR rather than a second number, and the tooltip is where the whole state is spelled out.
 *
 * The repositories with no runs at all are a labelled group at the bottom rather than rows mixed into the list:
 * an empty repository and a healthy one both show nothing, and the group heading is what tells them apart. */

const { standings } = defineProps<{ standings: readonly RepoStanding[] }>();
// undefined = every repository. Kept undefined rather than a sentinel so the URL simply omits the parameter.
const selected = defineModel<string | undefined>();

const failing = computed(() => standings.reduce((sum, standing) => sum + standing.failing, 0));

const reporting = computed(() => standings.filter((standing) => !standing.silent));
const silent = computed(() => standings.filter((standing) => standing.silent));

/* Only the quiet group is named. It is the one that needs explaining — it is the answer to "where did my
 * repository go" — while a heading over everything else would name a distinction nobody is making. */
const groups = computed<NavGroup<RepoStanding>[]>(() =>
    [
        { key: `reporting`, items: reporting.value },
        { key: `silent`, label: `No runs yet`, items: silent.value },
    ].filter((group) => group.items.length > 0),
);

// A number that is only worth printing where a zero MEANS something. In the silent group nothing has ever run,
// so "0 branches failing" would be a claim about a repository nobody has heard from.
const meta = (standing: RepoStanding): string => (standing.silent ? `` : String(standing.failing));
const tone = (standing: RepoStanding): string =>
    standing.failing > 0 ? `text-danger` : standing.repo.hookWarning === undefined ? `` : `text-warning`;

// Asked of the split above, not of the screen: the board beside this rail is only as wide as the workspace pane.
const compact = useCompact();

// The same model as options, with the row's number as the quiet right-hand annotation.
const options = computed<PickerOptions<string>>(() => {
    const option = (standing: RepoStanding): PickerGroup<string>[`options`][number] => ({
        value: standing.repo.repo,
        label: standing.repo.repo,
        description: meta(standing),
        icon: standing.repo.host,
        mono: true,
    });
    const built: PickerGroup<string>[] = [{ options: [{ value: ``, label: `All repositories`, description: String(failing.value), icon: `bolt` }] }];
    if (reporting.value.length > 0) {
        built.push({ options: reporting.value.map(option) });
    }
    if (silent.value.length > 0) {
        built.push({ label: `No runs yet`, options: silent.value.map(option) });
    }
    return built;
});
// Picker models a string, and `` is its spelling of "no filter".
const picked = computed<string>({ get: () => selected.value ?? ``, set: (value) => (selected.value = value === `` ? undefined : value) });

const everything = computed(() => (failing.value === 0 ? `Nothing failing anywhere` : `${failing.value} branches failing across the workspace`));
</script>

<template>
    <Picker v-if="compact" v-model="picked" :options="options" aria-label="Repository" header="Repository" class="w-full text-xs" />

    <NavRail v-else :groups="groups">
        <!-- Not a member of any group, so no grouping can push it out of reach: "all" is the state the rail
             returns to, and a row you cannot get back to is a filter you cannot clear. -->
        <template #pinned>
            <Row
                as="button"
                density="dense"
                icon="bolt"
                title="All repositories"
                :selected="selected === undefined"
                class="rounded-md"
                @click="selected = undefined"
            >
                <template #meta>
                    <span v-tooltip.bottom="everything" :class="failing > 0 ? `text-danger` : ``">{{ failing }}</span>
                </template>
            </Row>
        </template>

        <!-- The vendor glyph rather than a folder: which host a repository is on decides where its runs come
             from and where "open pipelines" lands, and it is free here — the sections below already carry it. -->
        <template #row="{ item: standing }">
            <Row
                :key="standing.repo.repo"
                as="button"
                density="dense"
                :icon="standing.repo.host"
                :title="standing.repo.repo"
                :selected="selected === standing.repo.repo"
                class="rounded-md"
                @click="selected = standing.repo.repo"
            >
                <template #meta>
                    <span v-tooltip.bottom="standingNote(standing)" :class="tone(standing)">{{ meta(standing) }}</span>
                </template>
            </Row>
        </template>
    </NavRail>
</template>
