<!-- The Documentation area. One component serves both surfaces: the rail's workspace-wide tile (which picks a
     repo) and the Workspace tree's per-repo panel (which arrives with `repo` already bound by the host).

     The reading experience is the point, so the layout gives the page the room and keeps the machinery — runs,
     staleness counts, publishing — to a strip and a sidebar. Everything shown here is a file that exists; there is
     no documentation service and no server-side state to be out of step with. -->
<script setup lang="ts">
import { Button, cmp, Icon, Page, PageHeader, RowGroup, Segmented, Select } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { acknowledgeStaged } from "./attention.js";
import DocPage from "./DocPage.vue";
import GenerateDialog from "./GenerateDialog.vue";
import { host } from "./host.js";
import { useDocs, type DocSource } from "./useDocs.js";
import { usePublish, type Preflight } from "./usePublish.js";
import { useRuns } from "./useRuns.js";

// Bound by the host for a `directory` activation; absent for the rail's singleton, which picks its own.
const { repo: pinned } = defineProps<{ repo?: string }>();

const api = host();

const repos = computed(() => api.workspace.repos().map((facts) => facts.repo));
const chosen = ref<string>(pinned ?? repos.value[0] ?? ``);
const repo = computed(() => pinned ?? chosen.value);
const label = computed(() => (repo.value === `` ? `the workspace root` : repo.value));

const source = ref<DocSource>(`published`);
const SOURCES = [
    { label: `Published`, value: `published` as DocSource, title: `Committed in the repository` },
    { label: `Draft`, value: `staged` as DocSource, title: `Generated, not yet published` },
];

const { set, isLoading, hasStaged, usePackage, refresh } = useDocs(repo, source);
const { rows, start, advance, stop } = useRuns(repo);
const { preflight, publish, discard } = usePublish();

/* A fresh draft is what the rail badged, so opening the area should show it — otherwise the user is told something
 * is waiting and then shown the old version of it. Switching happens once per repo, not on every change of
 * `hasStaged`, so a publish (which clears the draft) does not fight the user back to a tree that no longer exists. */
const offered = ref<string | undefined>(undefined);
watch(
    [hasStaged, repo],
    ([staged, at]) => {
        if (staged && offered.value !== at) {
            offered.value = at;
            source.value = `staged`;
        }
    },
    { immediate: true },
);

// Reviewing IS the acknowledgement — the badge clears when the draft has actually been looked at, not when the
// area was opened for some other repo.
watch([source, repo, hasStaged], ([which, at, staged]) => {
    if (which === `staged` && staged) {
        void acknowledgeStaged(at);
    }
});

// Selected page: undefined means the repository's own page, which is where a reader should land.
const page = ref<string | undefined>(undefined);
watch(repo, () => (page.value = undefined));
const packageQuery = usePackage(page);

const index = computed(() => set.value?.index);
const entries = computed(() => index.value?.entries ?? []);
const staleCount = computed(() => entries.value.filter((entry) => entry.stale).length);
const activeRun = computed(() => rows.value.find((row) => row.running));

// Advancing a run is idempotent and derived, so it is safe to attempt whenever the fleet or the draft moves — see
// useRuns. This is what carries a run from its map phase into the fan-out without any stored phase to corrupt.
watch(
    () => [rows.value.map((row) => `${row.manifest.runId}:${row.mapDone}:${row.done}`).join(`|`)],
    () => void advance(),
);

const generateOpen = ref(false);
const publishState = ref<Preflight | undefined>(undefined);
const publishing = ref(false);

const openPublish = async (): Promise<void> => {
    publishState.value = await preflight(repo.value);
};
const confirmPublish = async (): Promise<void> => {
    const state = publishState.value;
    if (state === undefined) {
        return;
    }
    publishing.value = true;
    try {
        await publish(repo.value, state.tails);
        publishState.value = undefined;
        source.value = `published`;
        offered.value = undefined;
        refresh();
    } finally {
        publishing.value = false;
    }
};

const onStart = (dirs: readonly string[]): void => {
    void start({
        repo: repo.value,
        label: label.value,
        // An explicit subset only when the user narrowed it; otherwise the map discovers the scope.
        ...(dirs.length === 0 ? {} : { packages: dirs }),
    });
};

const openAgent = (id: string): void => api.navigate(`/agents/${id}`);
</script>

<template>
    <Page width="full">
        <PageHeader title="Documentation" :description="`Plain-language orientation for ${label}, written by agents and reviewed by you.`">
            <template #actions>
                <Select
                    v-if="pinned === undefined && repos.length > 1"
                    v-model="chosen"
                    :options="repos"
                    size="small"
                    :placeholder="`Repository`"
                />
                <Segmented v-if="hasStaged" v-model="source" :options="SOURCES" />
                <button type="button" :class="cmp.buttonPrimary()" @click="generateOpen = true">Generate</button>
            </template>
        </PageHeader>

        <!-- A live run is the one piece of machinery that earns space at the top: it is the answer to "why is this
             page not here yet". Progress is read off the documents on disk, not from a counter. -->
        <div v-if="activeRun !== undefined" class="mb-4 flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-xs">
            <Icon name="spinner" spin class="shrink-0 text-link" />
            <span class="text-content">
                {{ activeRun.mapDone ? `Documenting packages` : `Reading the repository and drawing its map` }}
                — {{ activeRun.done }}<span v-if="activeRun.total !== undefined"> of {{ activeRun.total }}</span> written
            </span>
            <div class="ml-auto flex items-center gap-1">
                <Button
                    v-for="agent in activeRun.agents.slice(0, 6)"
                    :key="agent.id"
                    size="small"
                    severity="secondary"
                    text
                    :label="agent.id.split(`-`).slice(2).join(`-`) || `map`"
                    @click="openAgent(agent.id)"
                />
                <Button size="small" severity="secondary" outlined label="Stop" @click="stop(activeRun.manifest.runId)" />
            </div>
        </div>

        <!-- The draft banner. Publishing is a deliberate act with a named consequence, so the button says what it
             will do and the count of unrelated changes is on the confirmation, not hidden. -->
        <div v-if="source === `staged` && hasStaged" class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-primary-600/40 bg-primary-600/10 px-3 py-2 text-xs">
            <Icon name="file-edit" class="shrink-0 text-link" />
            <span class="text-content">This is a draft. Nothing is in the repository until you publish it.</span>
            <div class="ml-auto flex items-center gap-2">
                <Button size="small" severity="secondary" text label="Discard" @click="discard(repo).then(() => (source = `published`))" />
                <button type="button" :class="cmp.buttonPrimary()" @click="openPublish">Publish to {{ label }}</button>
            </div>
        </div>

        <div v-if="isLoading" class="flex flex-1 items-center justify-center py-16 text-muted"><Icon name="spinner" class="text-lg" spin /></div>

        <!-- The empty state is an invitation, not an error: a repo with no documents is the ordinary starting point
             and this view is where the first set gets made. -->
        <div v-else-if="set?.repoDoc === undefined && set?.prose === undefined" :class="cmp.emptyState()">
            <p class="text-sm">{{ label }} has no documentation yet.</p>
            <p class="mt-1 text-xs text-muted">
                One agent will map the repository — its components, its vocabulary, what to read first — and then a
                further agent documents each package. You review the result before anything is committed.
            </p>
            <button type="button" :class="cmp.buttonPrimary(`mt-3`)" @click="generateOpen = true">Generate documentation</button>
        </div>

        <div v-else class="flex min-h-0 flex-1 gap-6">
            <!-- The contents column: the repo page first, then packages grouped by the component the map assigned
                 them to, which is the whole point of having had a map phase. -->
            <nav class="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto">
                <RowGroup>
                    <button
                        type="button"
                        class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-canvas"
                        :class="page === undefined ? `bg-canvas font-medium text-content` : `text-muted`"
                        @click="page = undefined"
                    >
                        <Icon name="align-left" class="shrink-0" />
                        <span class="truncate">Overview</span>
                    </button>
                </RowGroup>

                <RowGroup
                    v-for="component in set?.repoDoc?.components ?? []"
                    :key="component.id"
                    :label="component.name"
                    :count="component.packages.length"
                >
                    <button
                        v-for="dir in component.packages"
                        :key="dir"
                        type="button"
                        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-canvas"
                        :class="page === dir ? `bg-canvas` : ``"
                        @click="page = dir"
                    >
                        <span class="min-w-0 flex-1 truncate font-mono text-2xs" :class="page === dir ? `text-content` : `text-muted`">{{ dir }}</span>
                        <Icon
                            v-if="entries.find((entry) => entry.dir === dir)?.stale === true"
                            name="exclamation-triangle"
                            class="shrink-0 text-2xs text-warning"
                        />
                    </button>
                </RowGroup>

                <!-- Coverage lives HERE, as a number beside what it describes — never on the rail, where a count
                     that is lit every day would train the eye to skip the tile. -->
                <div v-if="index !== undefined" class="flex flex-col gap-1 px-1 text-2xs text-subtle">
                    <span>{{ entries.length }} documented<span v-if="staleCount > 0">, {{ staleCount }} may be out of date</span></span>
                    <span v-if="index.undocumented.length > 0">{{ index.undocumented.length }} package{{ index.undocumented.length === 1 ? `` : `s` }} not documented</span>
                    <span v-if="index.orphans.length > 0" class="text-warning">{{ index.orphans.length }} document{{ index.orphans.length === 1 ? `` : `s` }} for packages that are gone</span>
                </div>
            </nav>

            <DocPage
                v-if="page === undefined"
                :prose="set?.prose"
                :anchors="[]"
                :provenance="set?.repoDoc?.provenance"
                :staleness="undefined"
            />
            <DocPage
                v-else
                :prose="packageQuery.data.value?.prose"
                :anchors="packageQuery.data.value?.doc?.keyFiles ?? []"
                :provenance="packageQuery.data.value?.doc?.provenance"
                :staleness="entries.find((entry) => entry.dir === page)"
            />
        </div>

        <GenerateDialog
            v-model="generateOpen"
            :label="label"
            :packages="[...entries.map((entry) => entry.dir), ...(index?.undocumented ?? [])].sort()"
            :index="index"
            @start="onStart"
        />

        <!-- Publishing writes files and commits them, so the confirmation names both the number of files and the
             one thing the wire cannot rule out: anything already staged in this repo rides along. -->
        <div v-if="publishState !== undefined" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div class="flex w-full max-w-md flex-col gap-3 rounded-xl border border-line bg-overlay p-4">
                <h2 class="text-sm font-semibold">Publish to {{ label }}</h2>
                <p class="text-xs text-muted">
                    {{ publishState.tails.length }} file{{ publishState.tails.length === 1 ? `` : `s` }} will be written under
                    <span class="font-mono">docs/architecture/</span> and committed<span v-if="publishState.branch !== ``"> on {{ publishState.branch }}</span>.
                </p>
                <p v-if="publishState.foreign.length > 0" class="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-2xs">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                    <span>
                        This repository has {{ publishState.foreign.length }} other changed file{{ publishState.foreign.length === 1 ? `` : `s` }}. Any of
                        them you have already staged will be included in this commit.
                    </span>
                </p>
                <div class="flex justify-end gap-2">
                    <Button size="small" severity="secondary" text label="Cancel" :disabled="publishing" @click="publishState = undefined" />
                    <button type="button" :class="cmp.buttonPrimary()" :disabled="publishing" @click="confirmPublish">
                        {{ publishing ? `Publishing…` : `Publish` }}
                    </button>
                </div>
            </div>
        </div>
    </Page>
</template>
