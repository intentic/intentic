<!-- The maker's home: one project at a time, with what it is, what waits, what changed, and its files. -->
<script setup lang="ts">
import {
    appLink,
    Button,
    ChangeStatusMark,
    Icon,
    type IconName,
    Notice,
    Page,
    PageHeader,
    Picker,
    type PickerOption,
    ProseField,
    Row,
    RowGroup,
    SkeletonRows,
    timeAgo,
    ui,
    useAsyncAction,
} from "@intentic/extension-ui";
import type { SnapshotChange } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import { type ContentKind, kindOf } from "./contentFiles.js";
import { host } from "./host.js";
import type { TimelineRow } from "./timeline.js";
import { useContentFiles, useProjects, useSummary } from "./useProjects.js";
import { useTimeline } from "./useTimeline.js";
import { newProjectBrief, newProjectConversationId, repoNameFromUrl, titleOf } from "./waysIn.js";

const api = host();

// Which project is open lives in the query, so a link to it survives a reload; with one project there is no choice.
const { projects, isLoading: projectsLoading, refresh: refreshProjects } = useProjects();
const query = computed(() => api.route.query());
const project = computed(() => projects.value.find((candidate) => candidate.id === query.value[`repo`]) ?? projects.value[0]);
const projectOptions = computed<PickerOption[]>(() => projects.value.map((candidate) => ({ value: candidate.id, label: candidate.name })));
// Replaced, not pushed: which project is open is a view state, and Back should leave the area rather than walk
// through projects.
const chooseProject = (id: string | undefined): void => {
    if (id !== undefined) {
        api.route.setQuery({ repo: id });
    }
};

const dir = computed(() => project.value?.dir);
const summary = useSummary(dir);
const { entries, isLoading: filesLoading, refresh: refreshFiles } = useContentFiles(dir);
const { days, waiting, isLoading: timelineLoading, changesOf, openChange, restore, refresh: refreshTimeline } = useTimeline();

// Where the page's verbs go: every one is a place the shell already has, drawn as a link so it has an address.
const linkTo = (path: string) => appLink(api.href(path), () => api.navigate(path));
// The Preview area's own target id for a repository (previewModel.repoTargetId), read off the query on arrival.
const previewPath = computed(() => `/preview?target=${encodeURIComponent(`repo:${project.value?.id ?? ``}`)}`);
const allFilesPath = computed(() => (dir.value === undefined || dir.value === `` ? `/workspace` : `/workspace/${dir.value}`));
const filePath = (path: string): string => `/workspace/${path.split(`/`).map(encodeURIComponent).join(`/`)}`;
const openAgent = (id: string): void => api.chat.openAgent(id);
// PageAction's own quiet rendering, as an anchor: an in-app destination is a link, never a button.
const QUIET = ui.iconButton(`h-8 w-8 text-base`);

const KIND_ICON: Record<ContentKind, IconName> = {
    folder: `folder`,
    document: `file`,
    image: `image`,
    media: `play`,
    sheet: `th-large`,
    page: `globe`,
    code: `code`,
};

// One open row at a time: its changed files, read when it opens.
const openRow = ref<string | undefined>(undefined);
const changes = ref<readonly SnapshotChange[]>([]);
const changesLoading = ref(false);
const toggleRow = (row: TimelineRow): void => {
    if (openRow.value === row.id) {
        openRow.value = undefined;
        return;
    }
    openRow.value = row.id;
    changes.value = [];
    changesLoading.value = true;
    void changesOf(row.id)
        .then((list) => {
            if (openRow.value === row.id) {
                changes.value = list;
            }
        })
        .finally(() => (changesLoading.value = false));
};
// The row's press reads "go back to before this", so the confirmation names the same moment.
const confirmBack = ref<string | undefined>(undefined);
const back = useAsyncAction();
const goBack = (id: string): void => {
    confirmBack.value = undefined;
    void back.run(async () => {
        await restore(id);
        await refreshFiles();
    }, `Could not go back to that version.`);
};

// The row's headline is the drafted sentence when a landing supplied one, with what was asked underneath.
const headline = (row: TimelineRow): string => row.subject ?? row.title;
const underline = (row: TimelineRow): string | undefined => (row.subject === undefined ? undefined : `You asked: ${row.title}`);
const ROW_ICON: Record<TimelineRow["kind"], IconName> = { assistant: `sparkles`, you: `user`, restored: `undo`, "before-restore": `shield` };

// The ways in. A new project is a turn on the shared tree (waysIn.ts says why); a clone is the daemon's own route.
const sentence = ref(``);
const starting = useAsyncAction();
const startProject = (): void => {
    const text = sentence.value.trim();
    if (text === ``) {
        return;
    }
    void starting.run(async () => {
        const conversationId = newProjectConversationId(Date.now());
        await api.sandbox.rpc.agent.run({ prompt: newProjectBrief(text), conversationId, title: titleOf(text) });
        sentence.value = ``;
        openAgent(conversationId);
    }, `Could not start the project.`);
};
const cloneUrl = ref(``);
const cloning = useAsyncAction();
const canClone = computed(() => repoNameFromUrl(cloneUrl.value) !== `` && !cloning.busy.value);
const cloneProject = (): void => {
    const url = cloneUrl.value.trim();
    const name = repoNameFromUrl(url);
    if (name === ``) {
        return;
    }
    void cloning.run(async () => {
        await api.sandbox.rpc.workspace.addRepo({ name, cloneUrl: url });
        cloneUrl.value = ``;
        await refreshProjects();
        chooseProject(name);
    }, `Could not open that repository.`);
};
// A workspace with nothing in it opens on the ways in rather than on an empty page with its verbs greyed out.
const empty = computed(() => !projectsLoading.value && projects.value.length === 0);

// The fleet and the tree both move while the page sits open; a project switch re-reads what the page shows for it.
watch(dir, () => {
    openRow.value = undefined;
    void refreshTimeline();
});
</script>

<template>
    <Page>
        <PageHeader :title="empty ? `Start something` : (project?.name ?? `Project`)" :description="empty ? `Nothing here yet. Describe what you want to make, open something you already have, or bring files in.` : summary">
            <template v-if="projects.length > 1" #info>
                <Picker :model-value="project?.id ?? ``" :options="projectOptions" aria-label="Project" variant="ghost" @update:model-value="chooseProject" />
            </template>
            <template v-if="!empty" #actions>
                <a
                    v-if="project?.hasPanel"
                    v-bind="linkTo(previewPath)"
                    :class="ui.linkButton(`gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium`)"
                    v-tooltip.bottom="'Open it running, the way a visitor would'"
                >
                    <Icon name="eye" />See it
                </a>
                <a v-bind="linkTo(`/sandbox/public`)" :class="QUIET" aria-label="Share" v-tooltip.bottom="'Share: what is out on the internet, and how to put something there'">
                    <Icon name="cloud-upload" />
                </a>
                <a v-bind="linkTo(`/sandbox/agent?section=instructions`)" :class="QUIET" aria-label="Instructions for your assistant" v-tooltip.bottom="'Instructions for your assistant'">
                    <Icon name="pencil" />
                </a>
                <a v-bind="linkTo(allFilesPath)" :class="QUIET" aria-label="All files" v-tooltip.bottom="'All files, tooling included'">
                    <Icon name="file-tree" />
                </a>
            </template>
        </PageHeader>

        <!-- Only while something is owed: an empty section would be a promise the page keeps making. -->
        <RowGroup v-if="waiting.length > 0" label="Waiting for you" class="mb-6">
            <Row v-for="item in waiting" :key="item.id" :title="item.title" :description="item.line" :tone="item.tone" icon="robot">
                <template #control>
                    <Button size="small" severity="secondary" label="Look" @click="openAgent(item.id)" />
                </template>
            </Row>
        </RowGroup>

        <template v-if="!empty">
            <RowGroup label="What's new" class="mb-6">
                <Notice v-if="back.notice.value" :of="back.notice.value" class="mx-3 my-2" />
                <SkeletonRows v-if="timelineLoading" :rows="3" />
                <p v-else-if="days.length === 0" class="px-3 py-3 text-xs text-muted">Nothing yet. Ask your assistant for something and it shows up here, with a way back.</p>
                <template v-for="day in days" :key="day.day">
                    <p class="px-3 pt-3 pb-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ day.day }}</p>
                    <Row
                        v-for="row in day.rows"
                        :key="row.id"
                        as="button"
                        :icon="ROW_ICON[row.kind]"
                        :title="headline(row)"
                        :description="underline(row)"
                        :selected="openRow === row.id"
                        chevron
                        @click="toggleRow(row)"
                    >
                        <template #meta>{{ timeAgo(row.at) }}</template>
                        <template v-if="openRow === row.id" #below>
                            <div class="flex flex-col gap-2" @click.stop>
                                <p v-if="changesLoading" class="text-2xs text-subtle">Reading what changed…</p>
                                <p v-else-if="changes.length === 0" class="text-2xs text-subtle">No file changed at this point.</p>
                                <ul v-else class="flex flex-col gap-0.5">
                                    <li v-for="change in changes" :key="`${change.scope}/${change.path}`">
                                        <button
                                            type="button"
                                            class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                                            @click="openChange(row.id, change)"
                                        >
                                            <ChangeStatusMark :status="change.status" />
                                            <span class="truncate">{{ change.scope === `root` ? change.path : `${change.scope}/${change.path}` }}</span>
                                        </button>
                                    </li>
                                </ul>
                                <div class="flex flex-wrap items-center gap-2">
                                    <template v-if="confirmBack === row.id">
                                        <span class="flex-1 text-2xs text-warning">Put every file back the way it was before this? What came after it goes away. A version of how things are now is saved first.</span>
                                        <Button size="small" severity="danger" label="Go back" :disabled="back.busy.value" @click="goBack(row.id)" />
                                        <Button size="small" severity="secondary" :text="true" label="Cancel" @click="confirmBack = undefined" />
                                    </template>
                                    <Button v-else size="small" severity="secondary" :disabled="back.busy.value" @click="confirmBack = row.id">
                                        <Icon name="undo" class="mr-1 text-2xs" />Go back to before this
                                    </Button>
                                </div>
                            </div>
                        </template>
                    </Row>
                </template>
            </RowGroup>

            <RowGroup label="Files" class="mb-6">
                <SkeletonRows v-if="filesLoading" :rows="4" />
                <p v-else-if="entries.length === 0" class="px-3 py-3 text-xs text-muted">No files yet.</p>
                <a v-for="entry in entries" :key="entry.path" v-bind="linkTo(filePath(entry.path))" class="block">
                    <Row interactive :icon="KIND_ICON[kindOf(entry)]" :title="entry.name" chevron />
                </a>
            </RowGroup>
        </template>

        <RowGroup :label="empty ? `Ways in` : `Start something new`">
            <Row icon="sparkles" title="New project" description="Say what you want to make. Your assistant sets it up and tells you what to look at.">
                <template #below>
                    <div class="flex flex-col gap-2" @click.stop>
                        <ProseField v-model="sentence" placeholder="A one page site for my bakery, with the menu and opening hours…" />
                        <Notice v-if="starting.notice.value" :of="starting.notice.value" />
                        <Button size="small" class="self-start" :disabled="sentence.trim() === `` || starting.busy.value" @click="startProject">
                            <Icon :name="starting.busy.value ? `spinner` : `sparkles`" :spin="starting.busy.value" class="mr-1" />{{ starting.busy.value ? `Starting…` : `Start` }}
                        </Button>
                    </div>
                </template>
            </Row>
            <Row icon="github" title="Open a project from GitHub" description="Paste the address of a repository you already have.">
                <template #below>
                    <form class="flex flex-wrap items-center gap-2" @click.stop @submit.prevent="cloneProject">
                        <input v-model="cloneUrl" type="text" :disabled="cloning.busy.value" placeholder="https://github.com/you/your-project" class="ui-field-box ui-field-sm min-w-0 flex-1" aria-label="Repository address" />
                        <Button size="small" type="submit" :disabled="!canClone">
                            <Icon :name="cloning.busy.value ? `spinner` : `arrow-down-left`" :spin="cloning.busy.value" class="mr-1" />{{ cloning.busy.value ? `Opening…` : `Open` }}
                        </Button>
                        <Notice v-if="cloning.notice.value" :of="cloning.notice.value" class="basis-full" />
                    </form>
                </template>
            </Row>
            <a v-bind="linkTo(`/workspace`)" class="block">
                <Row interactive icon="upload" title="Bring files in" description="Upload files or a folder from this computer." chevron />
            </a>
        </RowGroup>
    </Page>
</template>
