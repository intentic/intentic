<script setup lang="ts">
import { AnchoredOverlay, formatDateTime, freshness, Icon, Notice, type Tip, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { askLocalApp, localFace } from "../app/environments/local";
import { type LocalPlace, localHost } from "../app/environments/localHost";
import { isApplePlatform } from "../workbench/commands/keybindings";
import { nameOf, openedAtMs, otherPlaces, whereOf } from "./places";

// THE FOLDER MENU: the folder's name at the head of its explorer, pressed for every other folder on this computer: any
// one by the system's own dialog, and the ones opened here lately, newest first. A folder takes this window's place (the
// app re-points the window, localHost.ts `point`), as Open Folder does in any editor, unless Ctrl (Cmd on macOS) is held,
// which gives it a window of its own.
//
// FOLDERS ONLY, never a document. A document opened on its own shows without its folder's tree and is gone once its tab
// closes, which reads as a file that vanished to anyone who does not already know editors. The menu teaches the one
// model that always holds (open the folder, find the file in it), and the folder page's date grouping (homeOrder.ts) is
// how the file just saved or downloaded is found there. A document handed over by the system (Open with Intentic, a
// double-click in the file manager) still opens: that is the system's own gesture, not a choice offered here.
//
// (2026-10-07) This list lived in the rail's place chip until the account came to the rail's foot (1d1e690d4b), which
// left the chip listing sandboxes only and an opened folder with no way to any other. It is here now, on the name a
// reader looks at when they ask "which folder is this", rather than back on the chip, which is about sandboxes.

const props = defineProps<{
    /** Runs `go` at once when this window can leave its folder without losing unsaved edits, else once the reader agrees. */
    leaving: (go: () => void) => void;
}>();

const t = useT();
const host = localHost();
const face = localFace();

const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);

const name = computed(() => face?.name ?? t(`shared.files`));
const chipTip = computed((): Tip => ({ title: name.value, note: face?.path ?? `` }));

// Read each time the menu opens: the windows it opened are where the reader has been meanwhile. Only the newest read
// writes, so one answering late cannot put back a list the reader has since changed.
const places = ref<readonly LocalPlace[]>([]);
let reads = 0;
const reload = async (): Promise<void> => {
    reads += 1;
    const read = reads;
    try {
        const listed = await host.places();
        if (read === reads) {
            places.value = listed;
        }
    } catch (error) {
        console.error(`[local] the recent places could not be read:`, error);
    }
};

const others = computed(() => otherPlaces(places.value, face?.path));
const whenOf = (place: LocalPlace): string => {
    const at = openedAtMs(place.openedAt);
    return at === undefined ? `` : freshness(at);
};
const exactly = (place: LocalPlace): string | undefined => {
    const at = openedAtMs(place.openedAt);
    return at === undefined ? undefined : formatDateTime(at);
};

// What went wrong, beside the row it is about: the app's own sentence (local.rs), already written for the reader. Kept
// while the menu is open, so a press that failed after the unsaved question reopens the menu onto its reason.
const failure = ref<{ readonly key: string; readonly message: string } | undefined>(undefined);
const offered = ref<string | undefined>(undefined);
watch(open, (isOpen) => {
    if (isOpen) {
        void reload();
        return;
    }
    failure.value = undefined;
    offered.value = undefined;
});

const working = ref<string | undefined>(undefined);
const attempt = async (key: string, act: () => Promise<void>): Promise<void> => {
    if (working.value !== undefined) {
        return;
    }
    failure.value = undefined;
    working.value = key;
    try {
        await act();
        open.value = false;
    } catch (error) {
        open.value = true;
        failure.value = { key, message: error instanceof Error ? error.message : String(error) };
    } finally {
        working.value = undefined;
    }
};

// TAKING THIS WINDOW'S PLACE LOSES WHAT IT HOLDS UNSAVED, so that is asked first (LocalFiles.vue), in the words a close
// uses. A page with no app behind it has no window to re-point: its dialog opens a window of its own, which loses nothing.
const replacing = (key: string, go: () => Promise<void>): void => {
    if (working.value !== undefined) {
        return;
    }
    if (!host.native) {
        void attempt(key, go);
        return;
    }
    let ran = false;
    props.leaving(() => {
        ran = true;
        void attempt(key, go);
    });
    // The question is up: the menu steps aside for it, and comes back only with a failure to say.
    if (!ran) {
        open.value = false;
    }
};

// The modifier that keeps this window as it is: Ctrl, or Cmd on macOS, as a browser opens a link in a new tab.
const isMac = isApplePlatform();
const besides = (event: MouseEvent | KeyboardEvent): boolean => (isMac ? event.metaKey : event.ctrlKey);
const newWindowHint = t(`local.folderMenu.newWindowHint`, { key: isMac ? `⌘` : `Ctrl` });

// A moved place opens nothing, so pressing it asks the one thing left to decide about it.
const press = (place: LocalPlace, event: MouseEvent | KeyboardEvent): void => {
    if (!place.exists) {
        offered.value = offered.value === place.path ? undefined : place.path;
        return;
    }
    if (!besides(event)) {
        replacing(place.path, () => host.point(place.path));
        return;
    }
    // A window of its own (raised instead, where a window already shows it).
    void attempt(place.path, () => host.open(place.path));
};

const forget = async (path: string): Promise<void> => {
    places.value = places.value.filter((place) => place.path !== path);
    offered.value = undefined;
    try {
        await host.forget(path);
    } catch (error) {
        failure.value = { key: path, message: error instanceof Error ? error.message : String(error) };
    }
    await reload();
};

// The system's folder dialog. Its link verb gives the folder chosen a window of its own (local.rs `pick`); the host's
// shows it here.
const pickFolder = (event: MouseEvent): void => {
    if (besides(event)) {
        void attempt(`:folder`, () => {
            askLocalApp(`open-folder`);
            return Promise.resolve();
        });
        return;
    }
    replacing(`:folder`, () => host.pickFolder());
};

const rowClass = `group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5`;
const pickFailure = computed(() => (failure.value?.key === `:folder` ? failure.value.message : undefined));
</script>

<template>
    <!-- The folder's name, pressed for the menu: the head of the explorer, where a reader looks to see which folder this is. -->
    <button
        ref="trigger"
        type="button"
        class="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors hover:bg-content/5"
        :class="open ? `bg-content/5` : ``"
        :aria-label="t(`local.folderMenu.switchFolder`, { name })"
        aria-haspopup="menu"
        :aria-expanded="open"
        v-tooltip.bottom="open ? undefined : chipTip"
        @click="open = !open"
    >
        <Icon name="folder" class="shrink-0 text-sm text-muted" />
        <span class="min-w-0 truncate text-xs font-medium">{{ name }}</span>
        <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
    </button>

    <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="bottom" cross="start" menu>
        <div class="flex w-80 flex-col gap-0.5 p-1">
            <!-- The folder this window shows, lit, with the whole path the header has no room for. -->
            <div class="flex items-center gap-2 rounded-md bg-primary-600/15 px-2 py-1 text-xs">
                <Icon :name="face?.file === undefined ? `folder-open` : `file`" class="shrink-0 text-sm text-link" />
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-link">{{ name }}</span>
                    <span class="truncate text-2xs text-subtle" v-tooltip.bottom="face?.path">{{ face?.path }}</span>
                </span>
            </div>

            <!-- Any other folder, by the system's own dialog, in this window's place. -->
            <button type="button" :class="rowClass" data-test="folder-menu-open-folder" @click="pickFolder">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center text-muted">
                    <Icon :name="working === `:folder` ? `spinner` : `folder-open`" :spin="working === `:folder`" class="text-sm" />
                </span>
                <span class="min-w-0 flex-1 truncate text-content">{{ t(`local.folderMenu.openFolder`) }}</span>
            </button>
            <div v-if="pickFailure !== undefined" class="px-2 pb-1">
                <Notice tone="danger" class="text-2xs">{{ pickFailure }}</Notice>
            </div>

            <!-- The other folders opened here lately, newest first. -->
            <template v-if="others.length > 0">
                <div class="my-1 border-t border-line-subtle"></div>
                <div class="px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`local.folderMenu.recent`) }}</div>
                <div class="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                    <template v-for="place in others" :key="place.path">
                        <div :class="rowClass" role="button" tabindex="0" @click="press(place, $event)" @keydown.enter.prevent="press(place, $event)">
                            <span class="flex h-5 w-5 shrink-0 items-center justify-center text-subtle">
                                <Icon :name="working === place.path ? `spinner` : `folder`" :spin="working === place.path" class="text-xs" />
                            </span>
                            <span class="flex min-w-0 flex-1 flex-col">
                                <span class="truncate" :class="place.exists ? `text-content` : `text-subtle`">{{ nameOf(place.path) }}</span>
                                <span class="truncate text-2xs text-subtle" v-tooltip.bottom="place.path">{{
                                    place.exists ? whereOf(place.path) : t(`local.folderMenu.movedOrDeleted`)
                                }}</span>
                            </span>
                            <span
                                v-if="place.sandbox"
                                class="ui-status-pill shrink-0 bg-primary-600/15 text-2xs font-medium text-link"
                                v-tooltip.top="{ title: t(`local.folderMenu.sandbox`), note: t(`local.folderMenu.hasSandbox`) }"
                                >{{ t(`local.folderMenu.sandbox`) }}</span
                            >
                            <!-- The age, until the pointer arrives with the one verb a row has of its own. -->
                            <span class="shrink-0 text-2xs text-subtle group-hover:hidden group-focus-within:hidden" :title="exactly(place)">{{
                                whenOf(place)
                            }}</span>
                            <button
                                type="button"
                                :class="ui.iconButton({ size: `xs`, tone: `subtle` }, `hidden group-hover:flex group-focus-within:flex`)"
                                :aria-label="t(`local.folderMenu.forget`, { name: nameOf(place.path) })"
                                v-tooltip.top="{ title: t(`ui.action.remove`), note: t(`local.folderMenu.forgetNote`) }"
                                @click.stop="forget(place.path)"
                            >
                                <Icon name="times" class="text-2xs" />
                            </button>
                        </div>
                        <!-- Beside the row it is about, never a press on it: reading a failure must not open the thing again. -->
                        <div v-if="failure?.key === place.path || offered === place.path" class="px-2 pb-1">
                            <Notice v-if="failure?.key === place.path" tone="danger" class="text-2xs">{{ failure.message }}</Notice>
                            <div v-else class="flex items-center gap-2 text-2xs text-muted">
                                <span class="min-w-0 flex-1">{{ t(`local.folderMenu.goneOffer`) }}</span>
                                <button type="button" class="shrink-0 text-link hover:underline" @click="forget(place.path)">
                                    {{ t(`ui.action.remove`) }}
                                </button>
                            </div>
                        </div>
                    </template>
                </div>
            </template>

            <!-- The one way to keep this window as it is, said where it applies. -->
            <p v-if="host.native" class="px-2 pb-0.5 pt-1 text-2xs text-subtle">{{ newWindowHint }}</p>
        </div>
    </AnchoredOverlay>
</template>
