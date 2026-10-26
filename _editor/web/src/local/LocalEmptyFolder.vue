<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { Button, EmptyState, formatDate, formatDateTime, formatDayMonth, Notice, RowGroup, StatusBadge, type Tip, timeAgo, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref, type Ref } from "vue";
import { askLocalApp, localFace } from "../app/environments/local";
import { type LocalRoster, localHost, NOTHING_FOUND } from "../app/environments/localHost";
import { type OfferedProject, offeredProjects, type ProjectPlace, projectPlaces, toolNames, whereOf } from "./foundProjects";

// WHAT AN EMPTY FOLDER SAYS, in the pane its documents would open in: first of all the folder the app starts in
// (`~/intentic/local`), which is empty on every first launch. In the main window that first launch offers the folders
// this computer already works in instead: the ones opened here before, then the ones its AI tools and editors name
// (the app's found.rs, read on this computer and sent nowhere), each opened in this window's place as "Open a folder…"
// opens one. One short row per folder, grouped by where it lives (Windows, each WSL distro), so two folders that read
// alike are never confused; where it came from rides the row's tip. When there is nothing to offer, or the reader put
// the list away, what the folder is and the ways to fill it. Of sandboxes, only whose a folder's is: "Has a sandbox"
// when it is the signed-in account's, "Other account" when it belongs to an account that is not signed in (its row
// opens into the ways on: switch to that account, open just the files, or unlink the folder from that sandbox), since a
// badge promising a sandbox the reader cannot open sent them into it to be refused (2026-10-25). The rail's foot has
// the rest, and an opened folder has "Work on this with an agent".

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

const roster: Ref<LocalRoster | undefined> = ref(undefined);
const read = async (): Promise<void> => {
    if (face?.home !== true || !host.native) {
        return;
    }
    // Each list is a nicety: one the app cannot read leaves the page as it was, never broken, and says why on the console.
    const [places, found, facts, said] = await Promise.all([
        readOr(`the recent folders`, () => host.places(), []),
        readOr(`what this computer's tools found`, () => host.found(), NOTHING_FOUND),
        readOr(`this install's facts`, () => host.facts(), undefined),
        readOr(`who is signed in`, () => host.roster(), undefined),
    ]);
    roster.value = said;
    offered.value = offeredProjects(places, found.projects, [face.path, facts?.homeFolder ?? ``]);
};
onMounted(read);

const hide = (): void => {
    localStorage.setItem(HIDDEN_KEY, `yes`);
    hidden.value = true;
};
const unhide = (): void => {
    localStorage.removeItem(HIDDEN_KEY);
    hidden.value = false;
};

const places = computed(() => projectPlaces(offered.value));
// A lone list of this computer's own folders needs no heading; anything in a distro says which one.
const labelled = computed(() => places.value.length > 1 || places.value.some((place) => place.wsl !== undefined));
const placeLabel = (place: ProjectPlace): string =>
    place.wsl === undefined ? t(`local.foundProjects.onWindows`) : t(`local.foundProjects.inWsl`, { distro: place.wsl });

const DAY_MS = 86_400_000;
// When a folder was last used, at column width: relative inside the week ("4m ago", "3d ago"), then the day, with the
// year only when it is not this one.
const when = (at: number): string => {
    if (Date.now() - at < 7 * DAY_MS) {
        return timeAgo(at, { days: true });
    }
    return new Date(at).getFullYear() === new Date().getFullYear() ? formatDayMonth(at) : formatDate(at);
};

// Whose a folder's sandbox is, in a word for its tip: nothing for the signed-in account's own, which the badge says.
const sandboxNote = (project: OfferedProject): string | undefined => {
    switch (project.holder) {
        case `other`:
            return project.owner === undefined
                ? t(`local.foundProjects.otherAccountUnknownTip`)
                : t(`local.foundProjects.otherAccountTip`, { owner: project.owner });
        case `signedOut`:
            return t(`local.foundProjects.signInToOpen`);
        default:
            return undefined;
    }
};

// The rest of a row, on hover: the whole path, whose its sandbox is, the tools that worked in it, and the exact moment.
const tipOf = (project: OfferedProject): Tip => {
    const sandbox = sandboxNote(project);
    return {
        title: project.shown,
        rows: [
            ...(sandbox === undefined ? [] : [{ label: t(`local.foundProjects.sandbox`), value: sandbox }]),
            ...(project.sources.length > 0 ? [{ label: t(`local.foundProjects.usedWith`), value: toolNames(project.sources) }] : []),
            ...(project.at === undefined ? [] : [{ label: t(`local.foundProjects.lastUsed`), value: formatDateTime(project.at) }]),
        ],
        note: project.openedHere ? t(`local.foundProjects.openedHere`) : undefined,
    };
};

// Up and Down walk the rows, across the groups, as they do in any list.
const list = ref<HTMLElement | undefined>(undefined);
const step = (by: number): void => {
    const rows = [...(list.value?.querySelectorAll<HTMLButtonElement>(`[data-found-row]`) ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[Math.min(Math.max(at + by, 0), rows.length - 1)]?.focus();
};

const opening = ref<string | undefined>(undefined);
const rowFailure = ref<{ readonly path: string; readonly message: string } | undefined>(undefined);
const openProject = async (project: OfferedProject): Promise<void> => {
    opening.value = project.path;
    rowFailure.value = undefined;
    try {
        // The window moves onto the folder in place (folderSwitch.ts), and this page goes with the folder it offered.
        await host.point(project.path);
    } catch (error) {
        rowFailure.value = { path: project.path, message: errorMessage(error) };
    } finally {
        opening.value = undefined;
    }
};

// A FOLDER ANOTHER ACCOUNT'S SANDBOX SYNCS: its row opens in place into what the reader can do about it, rather than
// into the folder, where its button could only refuse them. One row open at a time.
const expanded = ref<string | undefined>(undefined);
const pressRow = (project: OfferedProject): void => {
    if (project.holder !== `other`) {
        void openProject(project);
        return;
    }
    rowFailure.value = undefined;
    unlinkAsked.value = false;
    expanded.value = expanded.value === project.path ? undefined : project.path;
};

// Who is signed in now, for the sentence that says why this account cannot open it.
const signedInAs = computed(() => roster.value?.account?.email);
const otherLead = (project: OfferedProject): string => {
    if (project.owner === undefined) {
        return t(`local.foundProjects.otherLeadUnknown`);
    }
    return signedInAs.value === undefined
        ? t(`local.foundProjects.otherLeadNoCurrent`, { owner: project.owner })
        : t(`local.foundProjects.otherLead`, { owner: project.owner, current: signedInAs.value });
};

// Switching is a sign-in that asks which account (the app's `sign_in` with a switch), in the default browser: the row
// says to finish there rather than sitting as if nothing had been pressed.
const switching = ref<string | undefined>(undefined);
const handedOver = ref<string | undefined>(undefined);
const switchAccount = async (project: OfferedProject): Promise<void> => {
    switching.value = project.path;
    rowFailure.value = undefined;
    try {
        await host.signIn({ switchAccount: true });
        handedOver.value = project.path;
    } catch (error) {
        rowFailure.value = { path: project.path, message: errorMessage(error) };
    } finally {
        switching.value = undefined;
    }
};

// Unlinking asks once more on the row itself: the folder stops syncing with that sandbox, which keeps its own copy.
const unlinkAsked = ref(false);
const unlinking = ref(false);
const unlink = async (project: OfferedProject): Promise<void> => {
    if (!unlinkAsked.value) {
        unlinkAsked.value = true;
        return;
    }
    unlinking.value = true;
    rowFailure.value = undefined;
    try {
        await host.unlink(project.path);
        expanded.value = undefined;
        unlinkAsked.value = false;
        await read();
    } catch (error) {
        rowFailure.value = { path: project.path, message: errorMessage(error) };
    } finally {
        unlinking.value = false;
    }
};

const failure = ref<string | undefined>(undefined);
const pickFolder = async (): Promise<void> => {
    failure.value = undefined;
    try {
        await host.pickFolder();
    } catch (error) {
        failure.value = errorMessage(error);
    }
};
</script>

<template>
    <div v-if="offering" class="flex h-full flex-col items-center overflow-y-auto px-6 py-12">
        <div class="flex w-full max-w-2xl flex-col gap-6">
            <header class="flex items-center justify-between gap-4 px-1">
                <h1 class="text-lg font-semibold text-content">{{ t(`local.foundProjects.title`) }}</h1>
                <Button :label="t(`local.emptyFolder.openFolder`)" size="small" tier="boring" @click="pickFolder">
                    <template #icon><Icon name="folder-open" /></template>
                </Button>
            </header>
            <Notice v-if="failure" tone="danger" class="text-2xs">{{ failure }}</Notice>

            <div ref="list" class="flex flex-col gap-6" data-test="found-projects" @keydown.down.prevent="step(1)" @keydown.up.prevent="step(-1)">
                <RowGroup v-for="place in places" :key="place.wsl ?? ``" :label="labelled ? placeLabel(place) : undefined">
                    <div v-for="project in place.projects" :key="project.path" data-test="found-project">
                        <button
                            type="button"
                            data-found-row
                            class="ui-row-select group flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left disabled:cursor-default"
                            :disabled="opening !== undefined && opening !== project.path"
                            :aria-expanded="project.holder === `other` ? expanded === project.path : undefined"
                            v-tooltip.bottom="tipOf(project)"
                            @click="pressRow(project)"
                        >
                            <Icon :name="project.sandbox ? `robot` : `folder`" class="shrink-0 text-lg text-subtle group-hover:text-muted" />
                            <span class="flex min-w-0 flex-1 items-baseline gap-2.5">
                                <span class="max-w-[65%] shrink-0 truncate text-sm font-medium text-content">{{ project.name }}</span>
                                <span class="min-w-0 truncate text-xs text-subtle">{{ whereOf(project) }}</span>
                            </span>
                            <StatusBadge
                                v-if="project.holder === `other`"
                                variant="warning"
                                size="xs"
                                class="-my-1 shrink-0"
                                data-test="other-account"
                                :label="t(`local.foundProjects.otherAccount`)"
                            />
                            <StatusBadge v-else-if="project.holder === `signedOut`" variant="neutral" size="xs" class="-my-1 shrink-0" :label="t(`local.foundProjects.hasSandbox`)" />
                            <StatusBadge v-else-if="project.sandbox" variant="success" size="xs" class="-my-1 shrink-0" :label="t(`local.foundProjects.hasSandbox`)" />
                            <span v-if="project.at !== undefined" class="shrink-0 text-2xs tabular-nums text-subtle">{{ when(project.at) }}</span>
                            <Icon v-if="opening === project.path" name="spinner" spin class="shrink-0 text-xs text-muted" />
                            <Icon
                                v-else
                                :name="project.holder === `other` && expanded === project.path ? `chevron-down` : `chevron-right`"
                                class="shrink-0 text-2xs text-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                            />
                        </button>
                        <!-- Another account's: why this account cannot open it, and the ways on. -->
                        <div v-if="expanded === project.path" class="flex flex-col gap-2.5 pr-4 pb-3 pl-11.5 text-xs text-muted" data-test="other-account-panel">
                            <p>{{ handedOver === project.path ? t(`local.agentsTile.finishInBrowser`) : otherLead(project) }}</p>
                            <div class="flex flex-wrap items-center gap-2">
                                <Button
                                    tier="accent"
                                    :label="project.owner === undefined ? t(`local.foundProjects.switchAccount`) : t(`local.foundProjects.switchTo`, { owner: project.owner })"
                                    :loading="switching === project.path"
                                    size="small"
                                    data-test="switch-account"
                                    @click="switchAccount(project)"
                                >
                                    <template #icon><Icon name="sign-in" /></template>
                                </Button>
                                <Button :label="t(`local.foundProjects.openFiles`)" size="small" tier="boring" data-test="open-files" @click="openProject(project)">
                                    <template #icon><Icon name="folder-open" /></template>
                                </Button>
                                <button
                                    type="button"
                                    class="ml-auto"
                                    :class="ui.textButton({ tone: unlinkAsked ? `danger` : `subtle`, size: `xs` })"
                                    :disabled="unlinking"
                                    data-test="unlink"
                                    @click="unlink(project)"
                                >
                                    {{ unlinkAsked ? t(`local.foundProjects.unlinkConfirm`) : t(`local.foundProjects.unlink`) }}
                                </button>
                            </div>
                            <p v-if="unlinkAsked" class="text-2xs text-subtle">{{ t(`local.foundProjects.unlinkNote`) }}</p>
                        </div>
                        <p v-if="rowFailure?.path === project.path" class="pr-4 pb-2.5 pl-11.5 text-2xs text-danger">{{ rowFailure.message }}</p>
                    </div>
                </RowGroup>
            </div>

            <footer class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-2xs text-subtle">
                <span class="flex items-center gap-1.5">
                    <Icon name="lock" class="shrink-0" />
                    {{ t(`local.foundProjects.privacy`) }}
                </span>
                <button type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="hide">{{ t(`local.foundProjects.hide`) }}</button>
            </footer>
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
            <Button tier="accent" :label="t(`local.emptyFolder.openFolder`)" size="small" @click="pickFolder">
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
