<script setup lang="ts">
import { Button, EmptyState, freshness, Notice, StatusBadge, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref } from "vue";
import { askLocalApp, localFace } from "../app/environments/local";
import { localHost, NOTHING_FOUND } from "../app/environments/localHost";
import { type OfferedProject, offeredProjects, toolNames } from "./foundProjects";

// WHAT AN EMPTY FOLDER SAYS, in the pane its documents would open in: first of all the folder the app starts in
// (`~/intentic/local`), which is empty on every first launch. In the main window that first launch offers the folders
// this computer already works in instead: the ones opened here before, then the ones its AI tools and editors name
// (the app's found.rs, read on this computer and sent nowhere), each opened in this window's place as "Open a folder…"
// opens one. Below them, or alone when there is nothing to offer, what the folder is and the ways to fill it. Nothing
// about sandboxes or agents: the rail's foot has that, and an opened folder has "Work on this with an agent".

const t = useT();
const face = localFace();
const host = localHost();

// A reader who said they do not want the list is not offered it again, on any launch.
const HIDDEN_KEY = `intentic.local.foundProjectsHidden`;
const hidden = ref(localStorage.getItem(HIDDEN_KEY) === `yes`);
const offered = ref<readonly OfferedProject[]>([]);
// Only the main window offers them: a folder window is one the reader opened on purpose, to fill.
const offering = computed(() => face?.home === true && !hidden.value && offered.value.length > 0);

// One of the app's answers, or `fallback` with what went wrong on the console.
const readOr = async <Value,>(what: string, read: () => Promise<Value>, fallback: Value): Promise<Value> => {
    try {
        return await read();
    } catch (error) {
        console.warn(`[local] ${what} could not be read`, error);
        return fallback;
    }
};

onMounted(async () => {
    if (face?.home !== true || !host.native) {
        return;
    }
    // Each list is a nicety: one the app cannot read leaves the page as it was, never broken, and says why on the console.
    const [places, found, facts] = await Promise.all([
        readOr(`the recent folders`, () => host.places(), []),
        readOr(`what this computer's tools found`, () => host.found(), NOTHING_FOUND),
        readOr(`this install's facts`, () => host.facts(), undefined),
    ]);
    offered.value = offeredProjects(places, found.projects, [face.path, facts?.homeFolder ?? ``]);
});

const hide = (): void => {
    localStorage.setItem(HIDDEN_KEY, `yes`);
    hidden.value = true;
};
const unhide = (): void => {
    localStorage.removeItem(HIDDEN_KEY);
    hidden.value = false;
};

// Where a row came from, as one line: opened here, or the tools that worked in it, and when last.
const origin = (project: OfferedProject): string => {
    const from = project.openedHere ? t(`local.foundProjects.openedHere`) : toolNames(project.sources);
    return project.at === undefined ? from : `${from} · ${freshness(project.at)}`;
};

const opening = ref<string | undefined>(undefined);
const rowFailure = ref<{ readonly path: string; readonly message: string } | undefined>(undefined);
const openProject = async (project: OfferedProject): Promise<void> => {
    opening.value = project.path;
    rowFailure.value = undefined;
    try {
        // The window reloads onto the folder; nothing after this runs on a success.
        await host.point(project.path);
    } catch (error) {
        rowFailure.value = { path: project.path, message: error instanceof Error ? error.message : String(error) };
    } finally {
        opening.value = undefined;
    }
};

const failure = ref<string | undefined>(undefined);
const pickFolder = async (): Promise<void> => {
    failure.value = undefined;
    try {
        await host.pickFolder();
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    }
};
</script>

<template>
    <div v-if="offering" class="flex h-full flex-col items-center overflow-y-auto px-6 py-10">
        <div class="flex w-full max-w-xl flex-col gap-4">
            <div class="flex flex-col items-center gap-1.5 text-center">
                <span class="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-600/10 text-link">
                    <Icon name="folder-open" class="text-2xl" />
                </span>
                <p class="text-base font-semibold text-content">{{ t(`local.foundProjects.title`) }}</p>
                <p class="max-w-md text-xs text-muted">{{ t(`local.foundProjects.lead`) }}</p>
            </div>

            <ul class="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line bg-canvas" data-test="found-projects">
                <li v-for="project in offered" :key="project.path" class="flex items-center gap-3 px-3 py-2.5">
                    <Icon :name="project.sandbox ? `robot` : `folder`" class="shrink-0 text-muted" />
                    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="flex min-w-0 items-center gap-1.5">
                            <span class="truncate text-sm font-medium text-content">{{ project.name }}</span>
                            <span v-if="project.wsl" class="shrink-0 rounded bg-overlay px-1 py-px text-[0.6rem] text-subtle">{{
                                t(`local.foundProjects.inWsl`, { distro: project.wsl })
                            }}</span>
                            <StatusBadge v-if="project.sandbox" variant="success" size="xs" class="shrink-0" :label="t(`local.foundProjects.hasSandbox`)" />
                        </span>
                        <span class="truncate font-mono text-2xs text-subtle" v-tooltip.bottom="project.path">{{ project.shown }}</span>
                        <span class="truncate text-2xs text-muted">{{ origin(project) }}</span>
                        <span v-if="rowFailure?.path === project.path" class="text-2xs text-danger">{{ rowFailure.message }}</span>
                    </div>
                    <Button
                        :label="t(`local.foundProjects.open`)"
                        size="small"
                        tier="boring"
                        :loading="opening === project.path"
                        :disabled="opening !== undefined && opening !== project.path"
                        @click="openProject(project)"
                    />
                </li>
            </ul>

            <p class="flex flex-wrap items-center justify-center gap-x-1.5 text-center text-2xs text-subtle">
                <Icon name="lock" class="shrink-0" />
                <span>{{ t(`local.foundProjects.privacy`) }}</span>
                <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" @click="hide">{{ t(`local.foundProjects.hide`) }}</button>
            </p>

            <div class="flex flex-col items-center gap-2 border-t border-line pt-4 text-center">
                <p class="text-xs text-muted">{{ t(`local.foundProjects.orThisFolder`, { name: face?.name ?? `` }) }}</p>
                <div class="flex flex-wrap items-center justify-center gap-2">
                    <Button :label="t(`local.emptyFolder.openFolder`)" size="small" tier="boring" @click="pickFolder">
                        <template #icon><Icon name="folder-open" /></template>
                    </Button>
                    <Button :label="t(`local.emptyFolder.showInFileManager`)" size="small" tier="boring" @click="askLocalApp(`reveal`)">
                        <template #icon><Icon name="external-link" /></template>
                    </Button>
                </div>
                <Notice v-if="failure" tone="danger" class="max-w-md text-2xs">{{ failure }}</Notice>
            </div>
        </div>
    </div>

    <EmptyState v-else size="page" :title="t(`local.emptyFolder.title`)" class="h-full">
        <template #icon>
            <span class="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-600/10 text-link">
                <Icon name="folder-open" class="text-2xl" />
            </span>
        </template>
        <template #line>
            {{ t(`local.emptyFolder.lead`, { name: face?.name ?? `` }) }}
            <span v-if="face" class="mt-1.5 block truncate font-mono text-2xs text-subtle" v-tooltip.bottom="face.path">{{ face.path }}</span>
        </template>
        <template #actions>
            <Button :label="t(`local.emptyFolder.openFolder`)" size="small" @click="pickFolder">
                <template #icon><Icon name="folder-open" /></template>
            </Button>
            <Button :label="t(`local.emptyFolder.showInFileManager`)" size="small" tier="boring" @click="askLocalApp(`reveal`)">
                <template #icon><Icon name="external-link" /></template>
            </Button>
        </template>
        <Notice v-if="failure" tone="danger" class="max-w-md text-2xs">{{ failure }}</Notice>
        <!-- The list put away, and the way back to it: a hide is a preference, not a loss. -->
        <button v-if="hidden && offered.length > 0" type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" @click="unhide">
            {{ t(`local.foundProjects.show`) }}
        </button>
    </EmptyState>
</template>
