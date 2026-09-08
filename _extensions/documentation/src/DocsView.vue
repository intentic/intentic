<!--
    Documentation area, serving both the rail's workspace-wide tile (picks its own repo) and the Workspace tree's per-repo panel (`repo` bound by the
    host). The page scrolls with the document; the contents list is `sticky`, not a separately paned or clamped column.
-->
<script setup lang="ts">
import {
    type AgentRunChoice,
    appLink,
    Button,
    ui,
    Icon,
    PageAction,
    ScrollFrame,
    Picker,
    type PickerOption,
    SegmentedControl,
    SplitView,
    useLoadingReveal,
} from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { acknowledgeStaged } from "./attention.js";
import { documentAt, refreshDocumentPresence } from "./docPresence.js";
import DocsNav from "./DocsNav.vue";
import DocPage from "./DocPage.vue";
import DocSkeleton from "./DocSkeleton.vue";
import { packageFigures } from "./figures.js";
import GenerateDialog from "./GenerateDialog.vue";
import { host } from "./host.js";
import { openingRepo, rememberRepo, rememberedRepo } from "./repoChoice.js";
import { useDocs, type DocSource } from "./useDocs.js";
import { usePublish, type Preflight } from "./usePublish.js";
import { useRuns } from "./useRuns.js";

// Bound by the host for a `directory` activation; absent for the rail's singleton, which picks its own.
const { repo: pinned } = defineProps<{ repo?: string }>();

const api = host();

const repos = computed(() => api.workspace.repos().map((facts) => facts.repo));
// Repo names are paths; shown `mono` so they read as machine names, not prose.
const repoOptions = computed<PickerOption[]>(() => repos.value.map((name) => ({ value: name, label: name, mono: true })));

// Which document is open lives in the query, never mirrored into a ref, so back/forward stay correct.
const query = computed(() => api.route.query());
// Last-opened repo, honored while the workspace still has it; a ref so re-emptying the URL updates it too.
const remembered = ref(rememberedRepo());
const repo = computed(() => pinned ?? query.value[`repo`] ?? openingRepo(repos.value, remembered.value, (name) => documentAt(name) !== undefined));
const label = computed(() => (repo.value === `` ? `the workspace root` : repo.value));
// undefined ⇒ the repository's own overview page.
const page = computed(() => query.value[`doc`]);

// Remembers only an explicit repo choice from the URL, never a fallback, which would freeze the first guess.
watch(
    () => query.value[`repo`],
    (chosen) => {
        if (pinned === undefined && chosen !== undefined) {
            remembered.value = chosen;
            rememberRepo(chosen);
        }
    },
    { immediate: true },
);

// Forces a fresh presence read when nothing else decides the opening repo, avoiding a shift once it lands.
if (pinned === undefined && remembered.value === undefined) {
    refreshDocumentPresence();
}

// Pushed, not replaced, so Back undoes moving to another document; selecting the overview drops the key rather than
// writing an empty one.
const openPage = (dir: string | undefined): void => api.route.setQuery({ doc: dir }, { push: true });
// Replaced (not pushed), and clears the page: a document path only makes sense within its own repo.
const chooseRepo = (next: string): void => api.route.setQuery({ repo: next, doc: undefined });

const source = ref<DocSource>(`published`);
const SOURCES = [
    { label: `Published`, value: `published` as DocSource, title: `Committed in the repository` },
    { label: `Draft`, value: `staged` as DocSource, title: `Generated, not yet published` },
];

const { set, isLoading, hasStaged, usePackage, refresh } = useDocs(repo, source);
// Drawn only once the wait has earned it, keyed on the repository being read.
const outline = useLoadingReveal(isLoading, repo);
const { rows, start, advance, stop } = useRuns(repo);
const { preflight, publish, discard } = usePublish();

// Switches to staged once per repo per new draft, not per `hasStaged` change, so publish can't pull it back.
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

// Viewing the draft is the acknowledgement; the badge clears only when actually looked at, not merely opened.
watch([source, repo, hasStaged], ([which, at, staged]) => {
    if (which === `staged` && staged) {
        void acknowledgeStaged(at);
    }
});

const packageQuery = usePackage(page);

const index = computed(() => set.value?.index);
const entries = computed(() => index.value?.entries ?? []);
const activeRun = computed(() => rows.value.find((row) => row.running));

// advance() is idempotent and safe on any fleet/draft change; carries a run from its map phase into the fan-out.
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

const onStart = (dirs: readonly string[], pick: AgentRunChoice | undefined): void => {
    void start({
        repo: repo.value,
        label: label.value,
        // An explicit subset only when the user narrowed it; otherwise the map discovers the scope.
        ...(dirs.length === 0 ? {} : { packages: dirs }),
        // The caret's choice, if used, recorded on the run so every later agent opens on the same model and tier.
        ...(pick === undefined
            ? {}
            : { pick: { agent: pick.provider, model: pick.model, ...(pick.effort === undefined ? {} : { effort: pick.effort }) } }),
    });
};

// Each running writer is an ordinary agent: its chip opens the conversation in the docked chat.
const agentLink = (id: string) => appLink(api.href(`/agents/${id}`), () => api.chat.openAgent(id));
</script>

<template>
    <SplitView title="Documentation" scroll="page" :scroll-key="`${repo}/${page ?? ``}`" mobile="swap" :detail-open="page !== undefined">
        <template #actions>
            <Picker
                v-if="pinned === undefined && repos.length > 1"
                :model-value="repo"
                :options="repoOptions"
                variant="ghost"
                aria-label="Repository"
                placeholder="Repository"
                @update:model-value="(next) => next !== undefined && chooseRepo(next)"
            />
            <SegmentedControl v-if="hasStaged" v-model="source" :options="SOURCES" />
            <PageAction icon="sparkles" label="Generate" primary @click="generateOpen = true" />
        </template>

        <template #strips>
            <!--
                The run strip's progress is read off documents on disk, not a counter. Both strips render as a wash, not a bordered box, so they
                don't compete with the title and document as separate panels.
            -->
            <div v-if="activeRun !== undefined" class="flex items-center gap-3 rounded-lg bg-content/4 px-3 py-2 text-xs">
                <Icon name="spinner" spin class="shrink-0 text-link" />
                <span class="text-content">
                    {{ activeRun.mapDone ? `Documenting packages` : `Reading the repository and drawing its map` }}
                    : {{ activeRun.done }}<span v-if="activeRun.total !== undefined"> of {{ activeRun.total }}</span> written
                </span>
                <div class="ml-auto flex items-center gap-1">
                    <Button
                        v-for="agent in activeRun.agents.slice(0, 6)"
                        :key="agent.id"
                        size="small"
                        severity="secondary"
                        text
                        :label="agent.id.split(`-`).slice(2).join(`-`) || `map`"
                        as="a"
                        v-bind="agentLink(agent.id)"
                    />
                    <Button size="small" severity="secondary" label="Stop" @click="stop(activeRun.manifest.runId)" />
                </div>
            </div>

            <!-- Publishing is deliberate: the button names the action, and unrelated changes are counted at confirmation. -->
            <div v-if="source === `staged` && hasStaged" class="flex flex-wrap items-center gap-3 rounded-lg bg-primary-600/10 px-3 py-2 text-xs">
                <Icon name="file-edit" class="shrink-0 text-link" />
                <span class="text-content">This is a draft. Nothing is in the repository until you publish it.</span>
                <div class="ml-auto flex items-center gap-2">
                    <Button size="small" severity="secondary" text label="Discard" @click="discard(repo).then(() => (source = `published`))" />
                    <Button size="small" :label="`Publish to ${label}`" @click="openPublish" />
                </div>
            </div>
        </template>

        <!--
            Coverage, filtering and grouping live in `<DocsNav>`; this view just tracks which page is open. The two scrollers are `<SplitView>`'s
            doing.
        -->
        <template #rail>
            <DocsNav :components="set?.repoDoc?.components ?? []" :index="index" :page="page" @open="openPage" />
        </template>

        <!--
            Shown only in the compact `swap` layout, where opening a page replaces the contents list and this is the only way back. Sits above the
            prose, in the frame, so it doesn't scroll away with the document.
        -->
        <template #detail="{ compact }">
            <button v-if="compact && page !== undefined" type="button" :class="ui.textAction(`mb-2 shrink-0`)" @click="openPage(undefined)">
                <Icon name="arrow-left" class="text-2xs" />
                Contents
            </button>

            <DocSkeleton v-if="isLoading && outline" />
            <!-- `min-h-figure`, not `flex-1`: there is no clamped parent to share, so `flex-1` would resolve to zero. -->
            <div v-else-if="isLoading" class="min-h-figure" />

            <!-- An invitation, not an error: no documents yet is the ordinary starting point, generated from here. -->
            <div v-else-if="set?.repoDoc === undefined && set?.prose === undefined">
                <div :class="ui.emptyState()">
                    <p class="text-sm">{{ label }} has no documentation yet.</p>
                    <p class="mt-1 text-xs text-muted">
                        One agent will map the repository: its components, its vocabulary, what to read first, and then a further agent documents each
                        package. You review the result before anything is committed.
                    </p>
                    <Button size="small" label="Generate documentation" class="mt-3" @click="generateOpen = true" />
                </div>
            </div>

            <!--
                The frame lives here, not in `<DocPage>`, since a Workspace tab wants no box. `:scroll="false"`: the page is now the scrollport;
                keyed by page only so figures re-init on their own container.
            -->
            <ScrollFrame v-else :key="page ?? `overview`" :scroll="false">
                <DocPage
                    v-if="page === undefined"
                    class="px-6 py-5"
                    :prose="set?.prose"
                    :anchors="[]"
                    :provenance="set?.repoDoc?.provenance"
                    :repo="repo"
                    :staleness="undefined"
                />
                <DocPage
                    v-else
                    class="px-6 py-5"
                    :prose="packageQuery.data.value"
                    :figures="packageFigures(page, index, set?.repoDoc)"
                    :anchors="entries.find((entry) => entry.dir === page)?.anchors ?? []"
                    :repo="repo"
                    :staleness="entries.find((entry) => entry.dir === page)"
                />
            </ScrollFrame>
        </template>

        <GenerateDialog
            v-model="generateOpen"
            :label="label"
            :packages="[...entries.map((entry) => entry.dir), ...(index?.undocumented ?? [])].sort()"
            :index="index"
            @start="onStart"
        />

        <!-- Confirmation names the file count and flags that anything already staged here rides along with the commit. -->
        <div v-if="publishState !== undefined" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div class="flex w-full max-w-md flex-col gap-3 rounded-xl border border-line bg-overlay p-4">
                <h2 class="text-sm font-semibold">Publish to {{ label }}</h2>
                <p class="text-xs text-muted">
                    <!-- A package page is written as its own README; only the map lands under `docs/architecture/`. -->
                    {{ publishState.tails.length }} file{{ publishState.tails.length === 1 ? `` : `s` }} will be written, each package's
                    <span class="font-mono">README.md</span> and the map under <span class="font-mono">docs/architecture/</span>, and committed<span
                        v-if="publishState.branch !== ``"
                    >
                        on {{ publishState.branch }}</span
                    >.
                </p>
                <p v-if="publishState.foreign.length > 0" class="flex items-start gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-2xs">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                    <span>
                        This repository has {{ publishState.foreign.length }} other changed file{{ publishState.foreign.length === 1 ? `` : `s` }}.
                        Any of them you have already staged will be included in this commit.
                    </span>
                </p>
                <div class="flex justify-end gap-2">
                    <Button size="small" severity="secondary" text label="Cancel" :disabled="publishing" @click="publishState = undefined" />
                    <Button size="small" :label="publishing ? `Publishing…` : `Publish`" :disabled="publishing" @click="confirmPublish" />
                </div>
            </div>
        </div>
    </SplitView>
</template>
