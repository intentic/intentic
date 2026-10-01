<script setup lang="ts">
import { AnchoredOverlay, ConfirmDialog, formatDateTime, freshness, Notice, SandboxLogo, type Tip, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { askLocalApp, localFace } from "../app/environments/local";
import { type LocalFacts, type LocalPlace, type LocalSandbox, localHost } from "../app/environments/localHost";
import { placementOfKind } from "../features/sandbox/overview/placement";
import { formatChord, isApplePlatform } from "../shell/commands/keybindings";
import { sandboxSlot, sandboxSlotChord } from "./localKeys";
import { externalDirtyPaths } from "../features/workspace/files/externalDirty";
import { useEditBuffers } from "../features/workspace/files/useEditBuffers";
import { nameOf, openedAtMs, otherPlaces, whereOf } from "./places";

// THE PLACE CHIP: the top of a local window's rail, where the sandbox shell keeps its sandbox switcher, and the same
// control. It says which folder of this computer the window shows, and opens onto every other place, in the order the
// sandbox switcher lists them too: this computer first (the folders and documents it opened lately, any other one by the
// system's own dialog, and its settings on its heading), then each of the account's sandboxes. A folder picked here takes this window's place (the
// app re-points the window, localHost.ts `point`); a document opens where the app puts it, beside the folder that holds
// it; a sandbox opens the workspace on it, which in the main window takes this window's place too.
//
// The sandboxes are the ones the workspace last told the app about (localHost.ts `roster`): this page cannot ask
// the platform. So a row carries what came with it (a name, where it runs, whether it is shared) and no count or state,
// which would be as old as the workspace's last look. Until the workspace has said, the row is the workspace itself.

const t = useT();
const host = localHost();
const face = localFace();

const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);

// The main window is the one the workspace swaps in for; from any other, a sandbox opens in that window, not this one.
const inMainWindow = face?.home === true;

// The window's folder, as the chip and its first row name it. A document opened on its own names its folder too: the
// chip is about the place, the tab row about the document.
const name = computed(() => face?.name ?? t(`shared.files`));
const where = computed(() => (face === undefined ? `` : face.path));
const chipTip = computed((): Tip => ({ title: name.value, note: where.value }));

// Read each time the chip opens: the windows it opened are where the reader has been meanwhile. Only the newest read
// writes, so one answering late cannot put back a list the reader has since changed.
const places = ref<readonly LocalPlace[]>([]);
const facts = ref<LocalFacts | undefined>(undefined);
const sandboxes = ref<readonly LocalSandbox[]>([]);
let reads = 0;
const reload = async (): Promise<void> => {
    reads += 1;
    const read = reads;
    try {
        const [listed, known, roster] = await Promise.all([host.places(), host.facts(), host.roster()]);
        if (read === reads) {
            places.value = listed;
            facts.value = known;
            sandboxes.value = roster.sandboxes;
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

// A sandbox is the workspace opened on it (router/sandboxArrival.ts), which says so when the account no longer lists it.
const sandboxKey = (box: LocalSandbox): string => `sandbox:${box.id}`;
const pickSandbox = (box: LocalSandbox): void =>
    void attempt(sandboxKey(box), () => host.openWorkspace(`/?${new URLSearchParams({ sandbox: box.id }).toString()}`));
const addSandbox = (): void => void attempt(`:add`, () => host.openWorkspace(`/setup`));

// Alt+1…9 from anywhere in the window, as in the workspace: the list is read fresh, so the digit names the sandbox the
// workspace last listed in that place even while this menu has never been opened.
const isMac = isApplePlatform();
const slotLabel = (at: number): string | undefined => {
    const chord = sandboxSlotChord(at);
    return chord === undefined ? undefined : formatChord(chord, isMac);
};
const pickSlot = async (at: number): Promise<void> => {
    try {
        sandboxes.value = (await host.roster()).sandboxes;
    } catch (error) {
        console.error(`[local] the sandboxes could not be read:`, error);
        return;
    }
    const box = sandboxes.value[at];
    if (box !== undefined) {
        pickSandbox(box);
    }
};
const onKeydown = (event: KeyboardEvent): void => {
    const at = sandboxSlot(event, isMac);
    if (at === undefined) {
        return;
    }
    event.preventDefault();
    void pickSlot(at);
};
onMounted(() => window.addEventListener(`keydown`, onKeydown));
onUnmounted(() => window.removeEventListener(`keydown`, onKeydown));

const rowClass = `group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5`;
// Open folder and Open file share one line: a pair of the same verb, and the list under them grows with the sandboxes.
const halfRowClass = `flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5`;
const failedAt = (...paths: readonly string[]): string | undefined => (failure.value !== undefined && paths.includes(failure.value.path) ? failure.value.message : undefined);
// Each said under the rows it is about: a dialog's under the two that open one, the workspace's under the sandboxes.
const pickFailure = computed(() => failedAt(`:folder`, `:file`));
const agentsFailure = computed(() => failedAt(`:agents`, `:add`));
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
            <!-- This computer's own heading, and its settings beside it (This device's screen, the app's view): the one
                 machine has one name here, and its settings sit with it as Sandbox settings sit with a sandbox. -->
            <div class="flex items-center gap-1 px-2 py-1">
                <span class="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-wide text-subtle">{{
                    t(`local.placeSwitcher.onThisComputer`)
                }}</span>
                <RouterLink
                    v-for="view in host.views"
                    :key="view.path"
                    :to="`/${view.path}`"
                    :class="ui.iconButton(`h-5 w-5 rounded text-subtle`)"
                    :aria-label="view.title()"
                    v-tooltip.top="{ title: view.title(), note: t(`local.placeSwitcher.computerSettingsNote`) }"
                    @click="open = false"
                >
                    <Icon name="cog" class="text-xs" />
                </RouterLink>
            </div>

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

            <!-- Any other place, by the system's own dialog: a folder in this window's place, a document in a window of its own. -->
            <div class="flex gap-0.5">
                <button type="button" :class="halfRowClass" @click="pickFolder">
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center text-muted">
                        <Icon :name="working === `:folder` ? `spinner` : `folder-open`" :spin="working === `:folder`" class="text-sm" />
                    </span>
                    <span class="min-w-0 flex-1 truncate text-content">{{ t(`local.placeSwitcher.openFolder`) }}</span>
                </button>
                <button type="button" :class="halfRowClass" @click="pickFile">
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center text-muted">
                        <Icon :name="working === `:file` ? `spinner` : `file`" :spin="working === `:file`" class="text-sm" />
                    </span>
                    <span class="min-w-0 flex-1 truncate text-content">{{ t(`local.placeSwitcher.openFile`) }}</span>
                </button>
            </div>
            <div v-if="pickFailure !== undefined" class="px-2 pb-1">
                <Notice tone="danger" class="text-2xs">{{ pickFailure }}</Notice>
            </div>

            <div class="my-1 border-t border-line"></div>

            <!-- The other kind of place: the account's sandboxes, where agents work, each opening the workspace on itself. -->
            <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`shared.sandboxes`) }}</div>
            <template v-if="facts?.accountSeen === true">
                <template v-for="(box, at) in sandboxes" :key="box.id">
                    <button type="button" :class="rowClass" @click="pickSandbox(box)">
                        <span v-if="working === sandboxKey(box)" class="flex h-5 w-5 shrink-0 items-center justify-center text-subtle">
                            <Icon name="spinner" spin class="text-xs" />
                        </span>
                        <SandboxLogo v-else :size="20" :name="box.name" />
                        <span class="min-w-0 flex-1 truncate text-content">{{ box.name }}</span>
                        <!-- Where it runs, as the workspace's switcher marks the same row: dropped where the Shared pill already says it. -->
                        <Icon
                            v-if="!box.shared || placementOfKind(box.place).kind !== `shared`"
                            :name="placementOfKind(box.place).icon"
                            class="shrink-0 text-2xs text-subtle"
                            v-tooltip.top="placementOfKind(box.place).tip"
                            :aria-label="placementOfKind(box.place).detail"
                        />
                        <span v-if="box.shared" class="ui-status-pill shrink-0 bg-content/10 text-2xs font-medium text-subtle">{{ t(`shared.shared`) }}</span>
                        <!-- The same chord as the workspace's row for this sandbox, the only place it can be learned here. -->
                        <kbd v-if="slotLabel(at)" class="shrink-0 rounded border border-line px-1 font-mono text-2xs font-normal leading-4 text-subtle">{{
                            slotLabel(at)
                        }}</kbd>
                        <!-- Only where the workspace opens in another window: from the main one it takes this one's place. -->
                        <Icon v-if="!inMainWindow" name="arrow-up-right" class="shrink-0 text-2xs text-subtle" />
                    </button>
                    <div v-if="failedAt(sandboxKey(box)) !== undefined" class="px-2 pb-1">
                        <Notice tone="danger" class="text-2xs">{{ failedAt(sandboxKey(box)) }}</Notice>
                    </div>
                </template>
                <!-- The workspace has not told the app its sandboxes yet (an install updated since it was last open): the workspace itself, which knows them. -->
                <button v-if="sandboxes.length === 0" type="button" :class="rowClass" @click="toAgents">
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center text-muted">
                        <Icon :name="working === `:agents` ? `spinner` : `robot`" :spin="working === `:agents`" class="text-sm" />
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate text-content">{{ t(`local.placeSwitcher.workspace`) }}</span>
                        <span class="truncate text-2xs text-subtle">{{ t(`local.placeSwitcher.workspaceLead`) }}</span>
                    </span>
                    <Icon name="arrow-up-right" class="shrink-0 text-2xs text-subtle" />
                </button>
                <button type="button" :class="rowClass" @click="addSandbox">
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center text-muted">
                        <Icon :name="working === `:add` ? `spinner` : `plus`" :spin="working === `:add`" class="text-sm" />
                    </span>
                    <span class="min-w-0 flex-1 truncate text-content">{{ t(`sandbox.words.addSandbox`) }}</span>
                </button>
            </template>
            <!-- No account on this install yet: what agents need, and the sign-in that brings the workspace. -->
            <button v-else type="button" :class="rowClass" @click="toAgents">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center text-muted">
                    <Icon :name="working === `:agents` ? `spinner` : `robot`" :spin="working === `:agents`" class="text-sm" />
                </span>
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-content">{{ t(`local.placeSwitcher.putAgentsToWork`) }}</span>
                    <span class="truncate text-2xs text-subtle">{{ t(`local.placeSwitcher.signInLead`) }}</span>
                </span>
                <Icon name="sign-in" class="shrink-0 text-2xs text-subtle" />
            </button>
            <div v-if="agentsFailure !== undefined" class="px-2 pb-1">
                <Notice tone="danger" class="text-2xs">{{ agentsFailure }}</Notice>
            </div>

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
