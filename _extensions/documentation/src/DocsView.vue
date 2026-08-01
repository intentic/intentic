<!-- The Documentation area. One component serves both surfaces: the rail's workspace-wide tile (which picks a
     repo) and the Workspace tree's per-repo panel (which arrives with `repo` already bound by the host).

     The reading experience is the point, so the layout gives the page the room and keeps the machinery — runs,
     staleness counts, publishing — to a strip and a sidebar. Everything shown here is a file that exists; there is
     no documentation service and no server-side state to be out of step with. -->
<script setup lang="ts">
import { Button, cmp, Icon, PageHeader, Segmented, Select } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { acknowledgeStaged } from "./attention.js";
import DocsNav from "./DocsNav.vue";
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

/* WHICH DOCUMENT IS OPEN LIVES IN THE URL, so a page can be linked to.
 *
 * Derived from the query, never mirrored into a ref: a ref would need one watcher to follow the URL and another
 * to write it, and those two fight — the classic symptom being Back moving the URL while the view stays put. With
 * the URL as the only source, Back and forward work for nothing, and a reload lands where you were.
 *
 * `repo` is here too (a link to another repo's docs is as useful as one to a page), but the published/draft toggle
 * is NOT: a draft is one person's unreviewed work in progress, so a link carrying "show me your draft" would
 * either mislead the recipient or show them nothing. */
const query = computed(() => api.route.query());
const repo = computed(() => pinned ?? query.value[`repo`] ?? repos.value[0] ?? ``);
const label = computed(() => (repo.value === `` ? `the workspace root` : repo.value));
// undefined ⇒ the repository's own overview page, which is where a reader should land.
const page = computed(() => query.value[`doc`]);

// Pushed, not replaced: moving to another document is exactly what Back should undo. Selecting the overview drops
// the key rather than writing an empty one, so the tidy URL is the one you get by default.
const openPage = (dir: string | undefined): void => api.route.setQuery({ doc: dir }, { push: true });
// Replaced, and it clears the page: a document path only means something inside its own repository.
const chooseRepo = (next: string): void => api.route.setQuery({ repo: next, doc: undefined });

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

const packageQuery = usePackage(page);

const index = computed(() => set.value?.index);
const entries = computed(() => index.value?.entries ?? []);
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
    <!-- FILLS THE AREA AND OWNS ITS SCROLLING. The shell's router-view wrapper is itself a scroll container, so a
         view that just grows makes the header, the menu and the page scroll together as one tall column — which is
         what happened here: reaching a package near the bottom of a 54-entry menu scrolled the document away too.
         `h-full` + `overflow-hidden` stops the outer scroller from ever having anything to scroll, and the two
         columns below each take their own. Same shape as the preview extension's full-bleed panel. -->
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
        <!-- The head does not scroll: the title, the repo picker and the state of a run stay put while you read. -->
        <div class="shrink-0 px-6 pt-6">
            <PageHeader title="Documentation" :description="`Plain-language orientation for ${label}, written by agents and reviewed by you.`">
                <template #actions>
                    <Select
                        v-if="pinned === undefined && repos.length > 1"
                        :model-value="repo"
                        :options="repos"
                        size="small"
                        :placeholder="`Repository`"
                        @update:model-value="chooseRepo"
                    />
                    <Segmented v-if="hasStaged" v-model="source" :options="SOURCES" />
                    <button type="button" :class="cmp.buttonPrimary()" @click="generateOpen = true">Generate</button>
                </template>
            </PageHeader>

            <!-- A live run is the one piece of machinery that earns space at the top: it is the answer to "why is
                 this page not here yet". Progress is read off the documents on disk, not from a counter. -->
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

            <!-- The draft banner. Publishing is a deliberate act with a named consequence, so the button says what
                 it will do and the count of unrelated changes is on the confirmation, not hidden. -->
            <div
                v-if="source === `staged` && hasStaged"
                class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-primary-600/40 bg-primary-600/10 px-3 py-2 text-xs"
            >
                <Icon name="file-edit" class="shrink-0 text-link" />
                <span class="text-content">This is a draft. Nothing is in the repository until you publish it.</span>
                <div class="ml-auto flex items-center gap-2">
                    <Button size="small" severity="secondary" text label="Discard" @click="discard(repo).then(() => (source = `published`))" />
                    <button type="button" :class="cmp.buttonPrimary()" @click="openPublish">Publish to {{ label }}</button>
                </div>
            </div>
        </div>

        <div v-if="isLoading" class="flex min-h-0 flex-1 items-center justify-center text-muted"><Icon name="spinner" class="text-lg" spin /></div>

        <!-- The empty state is an invitation, not an error: a repo with no documents is the ordinary starting point
             and this view is where the first set gets made. -->
        <div v-else-if="set?.repoDoc === undefined && set?.prose === undefined" class="min-h-0 flex-1 overflow-y-auto px-6 pb-6 scrollbar-thin">
            <div :class="cmp.emptyState()">
                <p class="text-sm">{{ label }} has no documentation yet.</p>
                <p class="mt-1 text-xs text-muted">
                    One agent will map the repository — its components, its vocabulary, what to read first — and then a further agent documents each
                    package. You review the result before anything is committed.
                </p>
                <button type="button" :class="cmp.buttonPrimary(`mt-3`)" @click="generateOpen = true">Generate documentation</button>
            </div>
        </div>

        <!-- Two scroll areas, side by side: a 54-entry contents list and a long document have no reason to share
             one scrollbar, and sharing it means you cannot keep your place in either. Coverage, filtering and the
             grouping all live inside <DocsNav>; this view only says which page is open. -->
        <div v-else class="flex min-h-0 flex-1 gap-6 px-6 pb-6">
            <DocsNav :components="set?.repoDoc?.components ?? []" :index="index" :page="page" @open="openPage" />

            <!-- KEYED BY PAGE, so each document mounts fresh. Once the document has its own scrollbar, a reused
                 instance keeps the last page's scroll position and you arrive halfway down a page you have never
                 seen. Remounting also gives every figure a clean fit-on-init, which is what a new document wants. -->
            <DocPage
                v-if="page === undefined"
                key="overview"
                :prose="set?.prose"
                :anchors="[]"
                :provenance="set?.repoDoc?.provenance"
                :staleness="undefined"
            />
            <DocPage
                v-else
                :key="page"
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
                    <span class="font-mono">docs/architecture/</span> and committed<span v-if="publishState.branch !== ``">
                        on {{ publishState.branch }}</span
                    >.
                </p>
                <p
                    v-if="publishState.foreign.length > 0"
                    class="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-2xs"
                >
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                    <span>
                        This repository has {{ publishState.foreign.length }} other changed file{{ publishState.foreign.length === 1 ? `` : `s` }}.
                        Any of them you have already staged will be included in this commit.
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
    </div>
</template>
