<!-- The workspace's repositories as tiles: press one to open it as its own tree, or New project to start one. -->
<script setup lang="ts">
import { appLink, Button, type FigureAccent, Icon, Notice, Page, PageHeader, seriesColor, ui, useAsyncAction } from "@intentic/extension-ui";
import { computed, nextTick, ref, useTemplateRef } from "vue";
import { host } from "./host.js";
import { freeProjectName, previewPath, slugOf, WORKSPACE_PATH } from "./projects.js";
import { useProjects } from "./useProjects.js";
import { t } from "./i18n.js";

const api = host();
const { tiles, ids, isLoading, create } = useProjects();

// Every destination is an anchor with an address. A tile makes its project the shell's scope (every area narrows to
// it) and opens the workspace, which roots itself there; See it running opens the Preview area on the project's target.
const linkTo = (path: string) => appLink(api.href(path), () => api.navigate(path));
const openProject = (id: string) =>
    appLink(api.href(WORKSPACE_PATH), () => {
        api.workspace.setProject(id);
        api.navigate(WORKSPACE_PATH);
    });
// Which project the shell is looking at, read live so the dashboard's own tiles say so.
const current = computed(() => api.workspace.project());
const showAll = (): void => api.workspace.setProject(undefined);
const noneYet = computed(() => !isLoading.value && tiles.value.length === 0);

// Fill, rim and letters all mixed from one colour: the tint alone disappears on the dark scheme's card.
const plate = (accent: FigureAccent): Record<string, string> => {
    const colour = seriesColor(accent);
    return {
        color: colour,
        backgroundColor: `color-mix(in oklab, ${colour} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${colour} 35%, transparent)`,
    };
};

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
            :title="t(`projectsView.projects`)"
            :description="current === undefined ? t(`projectsView.everyProjectRepositoryIn`) : t(`projectsView.workingInFilesAgents`, { current })"
        >
            <template v-if="current !== undefined" #actions>
                <Button size="small" severity="secondary" @click="showAll"
                    ><Icon name="th-large" class="mr-1" />{{ t(`projectsView.allProjects`) }}</Button
                >
            </template>
        </PageHeader>

        <!-- The grid counts columns off the pane it is drawn in, not the window: this view shares the screen. -->
        <div class="@container">
            <div class="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3">
                <template v-if="isLoading">
                    <div v-for="row in 3" :key="row" class="flex min-h-28 flex-col gap-3 rounded-xl border border-line bg-card p-4">
                        <div class="flex items-center gap-3">
                            <span class="skeleton size-9 shrink-0"></span>
                            <span class="skeleton h-3 w-1/2"></span>
                        </div>
                        <span class="skeleton h-3 w-full"></span>
                        <span class="skeleton h-3 w-2/3"></span>
                    </div>
                </template>

                <div
                    v-for="tile in tiles"
                    :key="tile.id"
                    class="group/tile relative flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors focus-within:ring-2 focus-within:ring-link"
                    :class="tile.id === current ? `border-link` : `border-line hover:border-line-strong hover:bg-content/3`"
                >
                    <!-- The tile's own press covers the whole frame, so See it running can stay a link of its own inside it. -->
                    <a
                        v-bind="openProject(tile.id)"
                        class="absolute inset-0 rounded-xl"
                        :aria-label="t(`projectsView.open`, { name: tile.name })"
                        :aria-current="tile.id === current ? `true` : undefined"
                    ></a>

                    <div class="flex items-start gap-3">
                        <!-- Decoration, not information: the name it stands for is read out beside it. -->
                        <span
                            class="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold uppercase"
                            aria-hidden="true"
                            :style="plate(tile.accent)"
                            >{{ tile.monogram }}</span
                        >
                        <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                                <span
                                    class="min-w-0 truncate text-sm font-semibold text-content transition-colors group-hover/tile:text-link"
                                    :title="tile.id"
                                    >{{ tile.name }}</span
                                >
                                <span
                                    v-if="tile.id === current"
                                    class="shrink-0 rounded-full bg-link/10 px-2 py-0.5 text-2xs font-medium text-link"
                                    >{{ t(`projectsView.open2`) }}</span
                                >
                            </div>
                            <span v-if="tile.id !== tile.name" class="block truncate text-2xs text-subtle">{{ tile.id }}</span>
                        </div>
                    </div>

                    <!-- Two lines whether or not there are two, so a row of tiles is one height and not four. -->
                    <p v-if="tile.summary !== ``" class="line-clamp-2 min-h-8 text-xs text-muted">{{ tile.summary }}</p>
                    <p v-else class="min-h-8 text-xs text-subtle">{{ t(`projectsView.noDescriptionInReadme`) }}</p>

                    <div v-if="tile.hasPanel" class="mt-auto border-t border-line-subtle pt-2">
                        <a v-bind="linkTo(previewPath(tile.id))" :class="ui.linkButton(`relative z-1 my-0 min-h-0`)"
                            ><Icon name="play" />{{ t(`projectsView.seeRunning`) }}</a
                        >
                    </div>
                </div>

                <!-- The dashboard's one press that makes something, and the whole page when there is nothing else on it. -->
                <button
                    v-if="!naming"
                    type="button"
                    :class="
                        ui.addTile(
                            `group/tile min-h-28 w-full flex-col items-center justify-center gap-2 rounded-xl p-4 text-center`,
                            noneYet ? `@xl:col-span-2 @3xl:col-span-3` : ``,
                        )
                    "
                    @click="startNaming"
                >
                    <span class="flex size-9 items-center justify-center rounded-lg bg-primary-500/10 text-link"><Icon name="plus" /></span>
                    <span class="text-sm font-semibold text-content transition-colors group-hover/tile:text-link">{{
                        noneYet ? t(`projectsView.startFirstProject`) : t(`projectsView.newProject`)
                    }}</span>
                    <span class="max-w-read-xs text-2xs text-muted">{{
                        noneYet ? t(`projectsView.projectRepositoryInWorkspace`) : t(`projectsView.freshRepositoryReadyAgent`)
                    }}</span>
                </button>
                <div
                    v-else
                    class="flex min-h-28 flex-col justify-center gap-2 rounded-xl border border-dashed border-line-strong p-4"
                    :class="noneYet ? `@xl:col-span-2 @3xl:col-span-3` : ``"
                >
                    <form class="flex flex-col gap-2" @submit.prevent="createProject">
                        <label class="text-2xs font-semibold text-content" for="projects-new-name">{{ t(`projectsView.name`) }}</label>
                        <input
                            id="projects-new-name"
                            ref="field"
                            v-model="name"
                            type="text"
                            :disabled="creating.busy.value"
                            :class="ui.inputSm()"
                            autocomplete="off"
                            @keydown.escape="cancelNaming"
                        />
                        <p v-if="slug !== `` && slug !== name.trim()" class="text-2xs text-subtle">{{ t(`projectsView.folder`, { slug }) }}</p>
                        <Notice v-if="creating.notice.value" :of="creating.notice.value" />
                        <div class="flex items-center gap-2">
                            <Button size="small" type="submit" :disabled="!canCreate">
                                <Icon :name="creating.busy.value ? `spinner` : `plus`" :spin="creating.busy.value" class="mr-1" />{{
                                    creating.busy.value ? t(`projectsView.starting`) : t(`projectsView.create`)
                                }}
                            </Button>
                            <Button size="small" severity="secondary" :text="true" :label="t(`projectsView.cancel`)" @click="cancelNaming" />
                        </div>
                    </form>
                </div>
            </div>
        </div>
    </Page>
</template>
