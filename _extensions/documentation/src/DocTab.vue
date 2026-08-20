<!-- ONE DIRECTORY'S PAGE, OPENED IN THE WORKSPACE — the same document DocsView renders, next to the code it
     explains instead of in an area you have to navigate to. This is the whole point of the document contribution:
     the question "what is this package?" is asked while looking at the package.

     It is a DIFFERENT COMPONENT from DocsView rather than a mode of it, and the reason is the URL. DocsView keeps
     which page is open in the query (`?doc=`), which is right for a routed area and wrong here twice over: the
     route belongs to the Workspace, and two document tabs open at once would fight over one key. A tab's subject
     is the tab's own state, so this takes it as a prop and touches no query at all. -->
<script setup lang="ts">
import { appLink, Button, ui, Icon, SegmentedControl, useLoadingReveal } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import DocPage from "./DocPage.vue";
import DocSkeleton from "./DocSkeleton.vue";
import { packageFigures } from "./figures.js";
import { host } from "./host.js";
import { splitRepo } from "./paths.js";
import { useDocs, type DocSource } from "./useDocs.js";

// The directory this tab explains, workspace-root-relative — the identity the tree row and the stored tab share.
const { path } = defineProps<{ path: string }>();

const api = host();

// Which repository owns the path, and where inside it. Derived from the workspace's repos rather than carried on
// the tab, so a tab restored into a workspace whose repos have moved resolves against what is there now.
const location = computed(() =>
    splitRepo(
        path,
        api.workspace.repos().map((facts) => facts.repo),
    ),
);
const repo = computed(() => location.value?.repo ?? ``);
// "" ⇒ the repository's own overview page (repo.md), which is what a repo row's icon opens.
const dir = computed(() => (location.value === undefined || location.value.dir === `` ? undefined : location.value.dir));
const label = computed(() => (path === `` ? `the workspace root` : path));

const source = ref<DocSource>(`published`);
const SOURCES = [
    { label: `Published`, value: `published` as DocSource, title: `Committed in the repository` },
    { label: `Draft`, value: `staged` as DocSource, title: `Generated, not yet published` },
];

const { set, isLoading, hasStaged, usePackage } = useDocs(repo, source);
// Drawn only once the wait has earned it, and keyed on the directory so opening another one starts a fresh
// wait rather than holding the last page's outline over it.
const outline = useLoadingReveal(
    isLoading,
    computed(() => `${repo.value}:${dir.value ?? ``}`),
);
const packageQuery = usePackage(dir);

// A page that exists only as a draft has to show the draft, or the tab renders empty for the one document that is
// actually there. Published stays the default everywhere else — it is what the repository says.
watch([hasStaged, set, packageQuery.data], ([staged, repoSet, page]) => {
    const published = dir.value === undefined ? repoSet?.prose !== undefined : page !== undefined;
    if (staged && !published && source.value === `published`) {
        source.value = `staged`;
    }
});

const entries = computed(() => set.value?.index?.entries ?? []);
const staleness = computed(() => entries.value.find((entry) => entry.dir === dir.value));

// The full area, for everything this tab deliberately does not carry: the map, the other packages, generation,
// publishing. `doc` is dropped for a repo overview so the link lands on the overview rather than an empty page.
const areaLink = computed(() => {
    const to = `/ext/documentation?repo=${encodeURIComponent(repo.value)}${dir.value === undefined ? `` : `&doc=${encodeURIComponent(dir.value)}`}`;
    return appLink(api.href(to), () => api.navigate(to));
});
</script>

<template>
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
        <!-- A thin strip, not a PageHeader: this is a tab beside a file's tab, and a full page title on top of a
             document would say the same thing the tab strip already says. -->
        <div class="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
            <Icon name="question-circle" class="shrink-0 text-2xs text-subtle" />
            <span class="min-w-0 truncate font-mono text-2xs text-muted">{{ label }}</span>
            <div class="ml-auto flex shrink-0 items-center gap-2">
                <SegmentedControl v-if="hasStaged" v-model="source" :options="SOURCES" size="xs" />
                <Button size="small" severity="secondary" text label="All documentation" as="a" v-bind="areaLink" />
            </div>
        </div>

        <DocSkeleton v-if="isLoading && outline" />
        <div v-else-if="isLoading" class="min-h-0 flex-1" />

        <!-- Undocumented is the ordinary state of most directories, so it is an invitation rather than an error —
             and the invitation goes where generation actually lives, because a run needs a scope and choosing one
             is a decision this tab has no business taking. -->
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

        <!-- NO CARD HERE. In the routed area the document is a body beside a contents rail and takes the frame
             that says so; in a tab it IS the pane, and boxing it draws a lit border a few pixels inside the
             pane's own — a card in a card, paying for it twice in padding and handing the prose a narrower
             column than the same text has when the README beside it is opened as a file. So this reads exactly
             like that file preview: the canvas, a centred measure, and `ui-softscroll` — a whisper of a
             scrollbar until the pointer is in the column, which is right for a surface being read.

             The scroll area is the TAB's rather than the page's, and can be: the host keys a document tab by its
             directory, so another package is a fresh mount and arrives at the top on its own. -->
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
