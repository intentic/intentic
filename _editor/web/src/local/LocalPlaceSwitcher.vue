<script setup lang="ts">
import { AnchoredOverlay, ConfirmDialog, formatDateTime, freshness, Notice, SandboxLogo, type Tip, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { askLocalApp, localFace } from "../app/environments/local";
import { type LocalFacts, type LocalPlace, localHost } from "../app/environments/localHost";
import { externalDirtyPaths } from "../features/workspace/files/externalDirty";
import { useEditBuffers } from "../features/workspace/files/useEditBuffers";
import { nameOf, openedAtMs, otherPlaces, whereOf } from "./places";

// THE PLACE CHIP: the top of a local window's rail, where the sandbox shell keeps its sandbox switcher, and the same kind
// of control. It says which folder of this computer the window shows, and opens onto every other place: the folders and
// documents this computer opened lately, any other one by the system's own dialog, and the workspace where agents are.
// A folder picked here takes this window's place (the app re-points the window, localHost.ts `point`); a document opens
// where the app puts it, beside the folder that holds it.

const t = useT();
const host = localHost();
const face = localFace();

const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);

// The window's folder, as the chip and its first row name it. A document opened on its own names its folder too: the
// chip is about the place, the tab row about the document.
const name = computed(() => face?.name ?? t(`shared.files`));
const where = computed(() => (face === undefined ? `` : face.path));
const chipTip = computed((): Tip => ({ title: name.value, note: where.value }));

// Read each time the chip opens: the windows it opened are where the reader has been meanwhile. Only the newest read
// writes, so one answering late cannot put back a list the reader has since changed.
const places = ref<readonly LocalPlace[]>([]);
const facts = ref<LocalFacts | undefined>(undefined);
let reads = 0;
const reload = async (): Promise<void> => {
    reads += 1;
    const read = reads;
    try {
        const [listed, known] = await Promise.all([host.places(), host.facts()]);
        if (read === reads) {
            places.value = listed;
            facts.value = known;
        }
    } catch (error) {
        console.error(`[local] the recent places could not be read:`, error);
    }
};
watch(open, (isOpen) => {
    if (isOpen) {
        failure.value = undefined;
        void reload();
    }
});

const others = computed(() => otherPlaces(places.value, face?.path));
const whenOf = (place: LocalPlace): string => {
    const at = openedAtMs(place.openedAt);
    return at === undefined ? `` : freshness(at);
};
const exactly = (place: LocalPlace): string | undefined => {
    const at = openedAtMs(place.openedAt);
    return at === undefined ? undefined : formatDateTime(at);
};

// What went wrong, beside the row it is about: the app's own sentence (local.rs), already written for the reader.
const failure = ref<{ readonly path: string; readonly message: string } | undefined>(undefined);
const working = ref<string | undefined>(undefined);
const attempt = async (path: string, act: () => Promise<void>): Promise<void> => {
    if (working.value !== undefined) {
        return;
    }
    failure.value = undefined;
    working.value = path;
    try {
        await act();
        open.value = false;
    } catch (error) {
        failure.value = { path, message: error instanceof Error ? error.message : String(error) };
    } finally {
        working.value = undefined;
    }
};

// TAKING THIS WINDOW'S PLACE LOSES WHAT IT HOLDS UNSAVED, so that is asked first, in the words a closing tab uses.
const { dirtyPaths } = useEditBuffers();
const unsaved = computed(() => [...new Set([...dirtyPaths.value, ...externalDirtyPaths.value])].toSorted());
const held = ref<{ readonly path: string; readonly go: () => Promise<void> } | undefined>(undefined);
const replacing = (path: string, go: () => Promise<void>): void => {
    if (unsaved.value.length === 0) {
        void attempt(path, go);
        return;
    }
    held.value = { path, go };
};
const replaceAnyway = (): void => {
    const pending = held.value;
    held.value = undefined;
    if (pending !== undefined) {
        void attempt(pending.path, pending.go);
    }
};

// A moved place opens nothing, so pressing it asks the one thing left to decide about it.
const offered = ref<string | undefined>(undefined);
const press = (place: LocalPlace): void => {
    if (!place.exists) {
        offered.value = offered.value === place.path ? undefined : place.path;
        return;
    }
    if (place.folder) {
        replacing(place.path, () => host.point(place.path));
        return;
    }
    void attempt(place.path, () => host.open(place.path));
};
const forget = async (path: string): Promise<void> => {
    places.value = places.value.filter((place) => place.path !== path);
    offered.value = undefined;
    try {
        await host.forget(path);
    } catch (error) {
        failure.value = { path, message: error instanceof Error ? error.message : String(error) };
    }
    await reload();
};

const pickFolder = (): void => replacing(`:folder`, () => host.pickFolder());
const pickFile = (): void => void attempt(`:file`, () => host.pickFile());

// The way to agents, as the rail's foot offers it too: the workspace once this install has an account, else a sign-in.
const toAgents = (): void => void attempt(`:agents`, () => (facts.value?.accountSeen === true ? host.openWorkspace() : host.signIn()));

const rowClass = `group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5`;
</script>

<template>
    <!-- The rail's top control, the sandbox switcher's size and shape: the folder's letter, marked as a place on this computer. -->
    <span class="relative flex">
        <button
            ref="trigger"
            type="button"
            class="icon-rail-tile flex items-center justify-center overflow-hidden rounded-lg transition-opacity hover:opacity-80"
            :aria-label="t(`local.placeSwitcher.switchPlace`, { name })"
            :aria-expanded="open"
            v-tooltip.right="open ? undefined : chipTip"
            @click="open = !open"
        >
            <SandboxLogo :name="name" />
        </button>
        <span
            class="icon-rail-mark pointer-events-none absolute bottom-0.5 right-0.5 inline-flex h-[1.6em] w-[1.6em] items-center justify-center rounded-full bg-[color:var(--ui-tile-ground)] leading-none text-subtle"
            aria-hidden="true"
        >
            <Icon name="desktop" class="text-[0.9em]" />
        </span>
    </span>

    <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="right" cross="start">
        <div class="flex w-72 flex-col gap-0.5 p-1">
            <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`local.placeSwitcher.onThisComputer`) }}</div>

            <!-- The folder this window shows: lit, as the sandbox switcher lights the sandbox open, with its way to the file manager. -->
            <div class="flex items-center gap-2 rounded-md bg-primary-600/15 px-2 py-1 text-xs">
                <SandboxLogo :size="20" :name="name" />
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-link">{{ name }}</span>
                    <span class="truncate text-2xs text-subtle" v-tooltip.bottom="where">{{ where }}</span>
                </span>
                <button
                    type="button"
                    :class="ui.iconButton(`h-5 w-5 rounded text-subtle`)"
                    :aria-label="t(`local.placeSwitcher.showInFileManager`)"
                    v-tooltip.top="t(`local.placeSwitcher.reveal`)"
                    @click="askLocalApp(`reveal`)"
                >
                    <Icon name="external-link" class="text-xs" />
                </button>
            </div>

            <!-- What else this computer opened lately, newest first: a folder takes this window's place, a document opens beside its folder. -->
            <div v-if="others.length > 0" class="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                <template v-for="place in others" :key="place.path">
                    <div :class="rowClass" role="button" tabindex="0" @click="press(place)" @keydown.enter.prevent="press(place)">
                        <span class="flex h-5 w-5 shrink-0 items-center justify-center text-subtle">
                            <Icon
                                :name="working === place.path ? `spinner` : place.folder ? `folder` : `file`"
                                :spin="working === place.path"
                                class="text-xs"
                            />
                        </span>
                        <span class="flex min-w-0 flex-1 flex-col">
                            <span class="truncate" :class="place.exists ? `text-content` : `text-subtle`">{{ nameOf(place.path) }}</span>
                            <span class="truncate text-2xs text-subtle" v-tooltip.bottom="place.path">{{
                                place.exists ? whereOf(place.path) : t(`local.placeSwitcher.movedOrDeleted`)
                            }}</span>
                        </span>
                        <span
                            v-if="place.sandbox"
                            class="ui-status-pill shrink-0 bg-primary-600/15 text-2xs font-medium text-link"
                            v-tooltip.top="{ title: t(`local.placeSwitcher.sandbox`), note: t(`local.placeSwitcher.hasSandbox`) }"
                            >{{ t(`local.placeSwitcher.sandbox`) }}</span
                        >
                        <!-- The age, until the pointer arrives with the one verb a row has of its own. -->
                        <span class="shrink-0 text-2xs text-subtle group-hover:hidden group-focus-within:hidden" :title="exactly(place)">{{
                            whenOf(place)
                        }}</span>
                        <button
                            type="button"
                            :class="ui.iconButton(`h-5 w-5 rounded text-subtle hidden group-hover:flex group-focus-within:flex`)"
                            :aria-label="t(`local.placeSwitcher.forget`, { name: nameOf(place.path) })"
                            v-tooltip.top="{ title: t(`ui.action.remove`), note: t(`local.placeSwitcher.forgetNote`) }"
                            @click.stop="forget(place.path)"
                        >
                            <Icon name="times" class="text-2xs" />
                        </button>
                    </div>
                    <!-- Beside the row it is about, never a press on it: reading a failure must not open the thing again. -->
                    <div v-if="failure?.path === place.path || offered === place.path" class="px-2 pb-1">
                        <Notice v-if="failure?.path === place.path" tone="danger" class="text-2xs">{{ failure.message }}</Notice>
                        <div v-else class="flex items-center gap-2 text-2xs text-muted">
                            <span class="min-w-0 flex-1">{{ t(`local.placeSwitcher.goneOffer`) }}</span>
                            <button type="button" class="shrink-0 text-link hover:underline" @click="forget(place.path)">
                                {{ t(`ui.action.remove`) }}
                            </button>
                        </div>
                    </div>
                </template>
            </div>

            <!-- Any other place, by the system's own dialog. -->
            <button type="button" :class="rowClass" @click="pickFolder">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center text-muted">
                    <Icon :name="working === `:folder` ? `spinner` : `folder-open`" :spin="working === `:folder`" class="text-sm" />
                </span>
                <span class="min-w-0 flex-1 text-content">{{ t(`local.placeSwitcher.openFolder`) }}</span>
            </button>
            <button type="button" :class="rowClass" @click="pickFile">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center text-muted">
                    <Icon :name="working === `:file` ? `spinner` : `file`" :spin="working === `:file`" class="text-sm" />
                </span>
                <span class="min-w-0 flex-1 text-content">{{ t(`local.placeSwitcher.openFile`) }}</span>
            </button>
            <div v-if="failure !== undefined && failure.path.startsWith(`:`)" class="px-2 pb-1">
                <Notice tone="danger" class="text-2xs">{{ failure.message }}</Notice>
            </div>

            <div class="my-1 border-t border-line"></div>

            <!-- The other kind of place: the workspace, where agents work in sandboxes. Offered as a sign-in until this install has an account. -->
            <button type="button" :class="rowClass" @click="toAgents">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center text-muted">
                    <Icon :name="working === `:agents` ? `spinner` : `robot`" :spin="working === `:agents`" class="text-sm" />
                </span>
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-content">{{
                        facts?.accountSeen === true ? t(`local.placeSwitcher.workspace`) : t(`local.placeSwitcher.putAgentsToWork`)
                    }}</span>
                    <span class="truncate text-2xs text-subtle">{{
                        facts?.accountSeen === true ? t(`local.placeSwitcher.workspaceLead`) : t(`local.placeSwitcher.signInLead`)
                    }}</span>
                </span>
                <Icon :name="facts?.accountSeen === true ? `arrow-up-right` : `sign-in`" class="shrink-0 text-2xs text-subtle" />
            </button>
            <!-- This device, which the rail offers too: listed here so every place is in one list. -->
            <RouterLink v-for="view in host.views" :key="view.path" :to="`/${view.path}`" :class="rowClass" @click="open = false">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center text-muted">
                    <Icon name="desktop" class="text-sm" />
                </span>
                <span class="min-w-0 flex-1 truncate text-content">{{ view.title() }}</span>
                <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
            </RouterLink>
        </div>
    </AnchoredOverlay>

    <!-- Another folder takes this window's place, and whatever it holds unsaved goes with the folder it leaves. -->
    <ConfirmDialog
        :open="held !== undefined"
        :header="
            unsaved.length === 1
                ? t(`workspace.workspaceDesktop.discardUnsavedChanges`)
                : t(`workspace.workspaceDesktop.discardUnsavedChangesIn`, { count: unsaved.length })
        "
        :confirm-label="t(`local.placeSwitcher.switchAnyway`)"
        confirm-icon="folder-open"
        :items="unsaved"
        @cancel="held = undefined"
        @confirm="replaceAnyway"
    >
        <template #item="{ item }">
            <Icon name="circle-fill" class="shrink-0 text-[0.4rem] text-warning" />
            <span class="truncate text-content">{{ item }}</span>
        </template>
        <p class="mt-3 text-xs text-muted">{{ t(`local.placeSwitcher.switchingDiscardsUnsaved`) }}</p>
    </ConfirmDialog>
</template>
