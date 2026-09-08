<!--
    One directory's documentation page opened in a Workspace tab beside its code. A separate component from DocsView, not a mode of it: DocsView
    tracks the open page in the `?doc=` query, which two open tabs would collide over, so this takes the page as a prop instead.
-->
<script setup lang="ts">
import { appLink, Button, ui, Icon, SegmentedControl, useLoadingReveal } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import DocPage from "./DocPage.vue";
import DocSkeleton from "./DocSkeleton.vue";
import { packageFigures } from "./figures.js";
import { host } from "./host.js";
import { splitRepo } from "./paths.js";
import { useDocs, type DocSource } from "./useDocs.js";

// Directory this tab explains, workspace-root-relative; the identity shared with the tree row and stored tab.
const { path } = defineProps<{ path: string }>();

const api = host();

// Repo owning the path, derived from the workspace's current repos, not stored on the tab.
const location = computed(() =>
    splitRepo(
        path,
        api.workspace.repos().map((facts) => facts.repo),
    ),
);
const repo = computed(() => location.value?.repo ?? ``);
// "" means the repository's own overview page (repo.md).
const dir = computed(() => (location.value === undefined || location.value.dir === `` ? undefined : location.value.dir));
const label = computed(() => (path === `` ? `the workspace root` : path));

const source = ref<DocSource>(`published`);
const SOURCES = [
    { label: `Published`, value: `published` as DocSource, title: `Committed in the repository` },
    { label: `Draft`, value: `staged` as DocSource, title: `Generated, not yet published` },
];

const { set, isLoading, hasStaged, usePackage } = useDocs(repo, source);
// Keyed on the directory, so switching directories starts a fresh wait instead of the last page's outline.
const outline = useLoadingReveal(
    isLoading,
    computed(() => `${repo.value}:${dir.value ?? ``}`),
);
const packageQuery = usePackage(dir);

// Flips to staged only when a page exists solely as a draft; published remains the default otherwise.
watch([hasStaged, set, packageQuery.data], ([staged, repoSet, page]) => {
    const published = dir.value === undefined ? repoSet?.prose !== undefined : page !== undefined;
    if (staged && !published && source.value === `published`) {
        source.value = `staged`;
    }
});

const entries = computed(() => set.value?.index?.entries ?? []);
const staleness = computed(() => entries.value.find((entry) => entry.dir === dir.value));

// Full documentation area link; `doc` is dropped for a repo overview so it lands there, not on an empty page.
const areaLink = computed(() => {
    const to = `/ext/documentation?repo=${encodeURIComponent(repo.value)}${dir.value === undefined ? `` : `&doc=${encodeURIComponent(dir.value)}`}`;
    return appLink(api.href(to), () => api.navigate(to));
});
</script>

<template>
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
        <!-- A thin strip, not a PageHeader: the tab strip already names the document. -->
        <div class="flex h-8 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
            <Icon name="question-circle" class="shrink-0 text-2xs text-subtle" />
            <span class="min-w-0 truncate font-mono text-2xs text-muted">{{ label }}</span>
            <div class="ml-auto flex shrink-0 items-center gap-2">
                <SegmentedControl v-if="hasStaged" v-model="source" :options="SOURCES" size="xs" />
                <Button size="small" severity="secondary" text label="All documentation" as="a" v-bind="areaLink" />
            </div>
        </div>

        <DocSkeleton v-if="isLoading && outline" />
        <div v-else-if="isLoading" class="min-h-0 flex-1" />

        <!-- An invitation, not an error, since undocumented is ordinary; it links to generation, not a scope choice. -->
        <div
            v-else-if="dir === undefined ? set?.prose === undefined : packageQuery.data.value === undefined"
            class="min-h-0 flex-1 overflow-y-auto p-6 scrollbar-thin"
        >
            <div :class="ui.emptyState()">
                <p class="text-sm">{{ label }} has no documentation yet.</p>
                <p class="mt-1 text-xs text-muted">An agent can read this directory and write a plain-language page about it, for you to review.</p>
                <Button size="small" label="Open Documentation" class="mt-3" as="a" v-bind="areaLink" />
            </div>
        </div>

        <!--
            No card here: this div IS the pane, so it matches the file-preview treatment, a centered measure with `ui-softscroll`. The scroll area
            belongs to the tab, keyed by directory, so switching packages remounts at the top.
        -->
        <div v-else class="ui-softscroll min-h-0 flex-1 overflow-y-auto bg-canvas px-6 py-5">
            <DocPage
                v-if="dir === undefined"
                key="overview"
                class="mx-auto max-w-3xl"
                :prose="set?.prose"
                :anchors="[]"
                :provenance="set?.repoDoc?.provenance"
                :repo="repo"
                :staleness="undefined"
            />
            <DocPage
                v-else
                :key="dir"
                class="mx-auto max-w-3xl"
                :prose="packageQuery.data.value"
                :figures="packageFigures(dir, set?.index, set?.repoDoc)"
                :anchors="staleness?.anchors ?? []"
                :repo="repo"
                :staleness="staleness"
            />
        </div>
    </div>
</template>
