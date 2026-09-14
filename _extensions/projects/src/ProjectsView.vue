<!-- The workspace's repositories as tiles: press one to open it as its own tree, or New project to start one. -->
<script setup lang="ts">
import { appLink, Button, Icon, Notice, Page, PageHeader, SkeletonRows, ui, useAsyncAction } from "@intentic/extension-ui";
import { computed, nextTick, ref, useTemplateRef } from "vue";
import { host } from "./host.js";
import { freeProjectName, previewPath, slugOf, WORKSPACE_PATH } from "./projects.js";
import { useProjects } from "./useProjects.js";

const api = host();
const { tiles, ids, isLoading, create } = useProjects();

// Every destination is an anchor with an address. A tile makes its project the shell's scope (every area narrows to
// it) and opens the workspace, which roots itself there; See it opens the Preview area on the project's own target.
const linkTo = (path: string) => appLink(api.href(path), () => api.navigate(path));
const openProject = (id: string) =>
    appLink(api.href(WORKSPACE_PATH), () => {
        api.workspace.setProject(id);
        api.navigate(WORKSPACE_PATH);
    });
// Which project the shell is looking at, read live so the dashboard's own tiles say so.
const current = computed(() => api.workspace.project());
const showAll = (): void => api.workspace.setProject(undefined);

// New project: one press opens the name, already filled with a free one; Enter or a second press makes it and opens
// it. The field exists so the name can be changed before the folder exists, since a folder is harder to rename after.
const naming = ref(false);
const name = ref(``);
const field = useTemplateRef<HTMLInputElement>(`field`);
const creating = useAsyncAction();
const startNaming = async (): Promise<void> => {
    name.value = freeProjectName(ids.value);
    naming.value = true;
    await nextTick();
    field.value?.select();
};
const slug = computed(() => slugOf(name.value));
const canCreate = computed(() => slug.value !== `` && !ids.value.includes(slug.value) && !creating.busy.value);
const createProject = (): void => {
    if (!canCreate.value) {
        return;
    }
    void creating.run(async () => {
        const made = await create(slug.value);
        naming.value = false;
        api.workspace.setProject(made);
        api.navigate(WORKSPACE_PATH);
    }, `Could not start the project.`);
};
const cancelNaming = (): void => {
    naming.value = false;
    creating.notice.value = undefined;
};
</script>

<template>
    <Page width="wide">
        <PageHeader
            title="Projects"
            :description="
                current === undefined
                    ? `Each of these is a repository in the workspace. Open one and everything, the files, the agents, the checks, narrows to it.`
                    : `Everything is narrowed to ${current}: its files, its agents, its checks. Open another, or show all.`
            "
        >
            <template v-if="current !== undefined" #actions>
                <Button size="small" severity="secondary" @click="showAll"><Icon name="th-large" class="mr-1" />All projects</Button>
            </template>
        </PageHeader>
        <SkeletonRows v-if="isLoading" :rows="3" />
        <div v-else class="flex flex-wrap gap-3">
            <a
                v-for="tile in tiles"
                :key="tile.id"
                v-bind="openProject(tile.id)"
                class="group flex min-h-32 w-72 grow flex-col gap-2 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-overlay"
                :class="tile.id === current ? `border-link` : `border-line hover:border-line-strong`"
                :aria-current="tile.id === current ? `true` : undefined"
            >
                <div class="flex items-start gap-2">
                    <Icon name="folder-open" class="mt-0.5 shrink-0 text-lg text-link" />
                    <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm font-semibold text-content" :title="tile.id"
                            >{{ tile.name }}<span v-if="tile.id === current" class="ml-2 text-2xs font-normal text-link">open</span></span
                        >
                        <span v-if="tile.id !== tile.name" class="block truncate text-2xs text-subtle">{{ tile.id }}</span>
                    </span>
                </div>
                <p class="line-clamp-3 flex-1 text-xs text-muted">{{ tile.summary === `` ? `No description yet. Its README's first paragraph goes here.` : tile.summary }}</p>
                <!-- A nested anchor is not allowed, so See it sits beside the tile's own press as a sibling link drawn inside its frame. -->
                <span v-if="tile.hasPanel" class="flex items-center gap-2 text-2xs text-subtle">
                    <Icon name="eye" class="shrink-0" />
                    Can be looked at running
                </span>
            </a>

            <!-- The dashboard's one press that makes something: a tile of its own, dashed until it has a name. -->
            <div class="flex min-h-32 w-72 grow flex-col justify-center gap-2 rounded-xl border border-dashed border-line p-4">
                <template v-if="naming">
                    <form class="flex flex-col gap-2" @submit.prevent="createProject">
                        <label class="text-2xs font-semibold text-content" for="projects-new-name">Name</label>
                        <input
                            id="projects-new-name"
                            ref="field"
                            v-model="name"
                            type="text"
                            :disabled="creating.busy.value"
                            class="ui-field-box ui-field-sm"
                            autocomplete="off"
                            @keydown.escape="cancelNaming"
                        />
                        <p v-if="slug !== `` && slug !== name.trim()" class="text-2xs text-subtle">Folder: {{ slug }}</p>
                        <Notice v-if="creating.notice.value" :of="creating.notice.value" />
                        <div class="flex items-center gap-2">
                            <Button size="small" type="submit" :disabled="!canCreate">
                                <Icon :name="creating.busy.value ? `spinner` : `plus`" :spin="creating.busy.value" class="mr-1" />{{ creating.busy.value ? `Starting…` : `Create` }}
                            </Button>
                            <Button size="small" severity="secondary" :text="true" label="Cancel" @click="cancelNaming" />
                        </div>
                    </form>
                </template>
                <button v-else type="button" :class="ui.textAction(`flex-col items-center gap-2 self-center py-2`)" @click="startNaming">
                    <Icon name="plus-circle" class="text-2xl text-link" />
                    <span class="text-sm font-semibold text-content">New project</span>
                    <span class="text-2xs text-muted">A fresh repository in the workspace, ready for an assistant.</span>
                </button>
            </div>
        </div>

        <!-- See it links, as a list under the grid rather than nested in the tiles, for the projects that run. -->
        <ul v-if="tiles.some((tile) => tile.hasPanel)" class="mt-6 flex flex-wrap gap-3">
            <li v-for="tile in tiles.filter((candidate) => candidate.hasPanel)" :key="tile.id">
                <a v-bind="linkTo(previewPath(tile.id))" :class="ui.linkButton()"><Icon name="eye" />See {{ tile.name }} running</a>
            </li>
        </ul>
    </Page>
</template>
