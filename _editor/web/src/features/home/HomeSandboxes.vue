<script setup lang="ts">
import { computed, ref, TransitionGroup } from "vue";
import type { MenuItem } from "primevue/menuitem";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { Beacon, ContextMenu, SandboxLogo, ui } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useRole } from "../../client/sandbox/useRole";
import { orderedSandboxes, tileAction } from "../../models/home/homeFacts";
import { movedOrder, sandboxOrder } from "../../models/home/sandboxOrder";
import { useSandboxTileDrag } from "./sandboxTileDrag";
import { switchableSandboxes } from "../../models/sandbox/live/roster";
import { useRequestAddSandbox, warmAddSandbox } from "../../models/sandbox/addSandbox";
import { useHomeAttention } from "../../models/home/useHomeAttention";
import { processAskedBy } from "../../models/processes/processAddress";
import { sandboxEntryPath, sectionEntryPath } from "../../models/sandbox/sandboxScreen";
import { sandboxHubPath } from "../../models/sandbox/sandboxNav";
import { homeFrame, homeSection } from "../../lib/routes/homeSection";
import { useAuth } from "../../client/auth/useAuth";
import { HOME_PATH } from "../../lib/routes/firstScreens";
import { signInAt } from "../../lib/routes/signIn";
import { goInside } from "../../lib/routes/homeDetour";
import ViewBadgeChip from "../../workbench/views/ViewBadgeChip.vue";
import { RUNNING_MARK_CLASS } from "../../workbench/views/viewBadge";
import TileMark from "../../components/TileMark.vue";
import { useFaceProcesses } from "../../models/processes/faceProcesses";
import { sandboxRunOf } from "../../models/processes/processTiles";
import { processNote } from "../../models/processes/processWords";
import type { ViewBadge } from "@intentic/extension-api";
import HomeNoSandbox from "./HomeNoSandbox.vue";
import NewSandboxTile from "./newSandbox/NewSandboxTile.vue";
import { newSandbox, newSandboxPageShown, readySandboxes, seenReady } from "./newSandbox/newSandbox";

defineOptions({ inheritAttrs: false });
const { phone = false } = defineProps<{ phone?: boolean }>();
const t = useT();
const router = useRouter();
const sandbox = useSandbox();
const { homeOnly } = useRole();
const { user } = useAuth();
// The switcher's own list (roster.ts `switchableSandboxes`), never the account's raw rows: a setup never finished has no
// daemon to open a home conversation on, and a desktop folder window's own row is no sandbox at all.
// The sandbox Home is making (newSandbox.ts) is its own tile until its run ends, not a second one beside it.
const making = computed(() => newSandbox.value?.here.add.created.value?.id);
// In the reader's own order once they have dragged one into place (sandboxOrder.ts), else owned first and by name.
const boxes = computed(() =>
    orderedSandboxes(switchableSandboxes(sandbox.sandboxes.value), sandboxOrder.value).filter((box) => box.id !== making.value),
);
// A tile carried along the rail: the others make way for it (sandboxTileDrag.ts), and where it is let go is kept.
const list = ref<HTMLElement | null>(null);
const drag = useSandboxTileDrag({
    list: () => list.value,
    ids: () => boxes.value.map((box) => box.id),
    commit: (ids) => (sandboxOrder.value = ids),
});
const drawn = computed(() => {
    const preview = drag.preview.value;
    return preview === undefined ? boxes.value : preview.flatMap((id) => boxes.value.filter((box) => box.id === id));
});
// The same arrangement from a tile's own menu, for a keyboard (the menu key) and for going back to the order by name.
const tileMenu = ref<{ show: (event: Event) => void }>();
const menuIndex = ref(-1);
const moveBy = (step: number): void => {
    const ids = boxes.value.map((box) => box.id);
    sandboxOrder.value = movedOrder(ids, menuIndex.value, menuIndex.value + step);
};
// A sandbox's settings, straight from its tile, without entering it and finding the switcher's cog. Shown in Home's frame
// (lib/routes/home.ts isSandboxSettingsPath): the rail stays, the tile stays lit, and Back or a press on any tile returns
// to a chat. A guest's door names the one section it may open (sandboxNav.ts sandboxHubPath).
const openSettings = (id: string): void => {
    const box = boxes.value.find((candidate) => candidate.id === id);
    if (box === undefined) {
        return;
    }
    seenReady(id);
    sandbox.select(id);
    void router.push(sandboxHubPath(box.role === `guest`));
};
// Into the sandbox, as a double-click goes: the menu's way for a keyboard, and the place a reader learns the double-click.
const enter = (id: string): void => {
    seenReady(id);
    sandbox.select(id);
    void goInside(() => router.push(sandboxEntryPath(id)));
};
const withMenuId = (act: (id: string) => void): void => {
    const id = boxes.value[menuIndex.value]?.id;
    if (id !== undefined) {
        act(id);
    }
};
const tileMenuItems = computed<MenuItem[]>(() => [
    // A home-only guest has no sandbox to enter, so neither a way in nor settings to open in one.
    ...(homeOnly.value
        ? []
        : [
              { label: t(`ui.action.open`), command: () => withMenuId(enter) },
              { label: t(`shared.settings`), command: () => withMenuId(openSettings) },
              { separator: true },
          ]),
    { label: t(`home.moveTileUp`), disabled: menuIndex.value <= 0, command: () => moveBy(-1) },
    { label: t(`home.moveTileDown`), disabled: menuIndex.value >= boxes.value.length - 1, command: () => moveBy(1) },
    { separator: true },
    { label: t(`home.sortByName`), disabled: sandboxOrder.value.length === 0, command: () => (sandboxOrder.value = []) },
]);
// Beside the rail at the tile's height, as the shell's own tile menu opens (ShellDesktop.vue `showBesideRail`).
const openTileMenu = (event: MouseEvent, id: string): void => {
    event.preventDefault();
    menuIndex.value = boxes.value.findIndex((box) => box.id === id);
    const tile = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const rail = (tile?.closest(`nav`) ?? tile)?.getBoundingClientRect();
    const top = tile?.getBoundingClientRect().top;
    tileMenu.value?.show(rail === undefined || top === undefined ? event : new MouseEvent(`click`, { clientX: rail.right, clientY: top }));
};
// Before the first sandbox the + wears getting started's beacon, a quiet second way to the press the page itself leads
// with (HomeNoSandbox.vue). No coach mark beside it any more: the page says what it would have said, and a popover over
// a page that already asks for the same press is two voices for one thing.
const readings = useHomeAttention();
const badgeOf = (id: string): ViewBadge | undefined => {
    const count = readings.value.get(id)?.needsYou ?? 0;
    if (count > 0) {
        return { count, tooltip: t(`home.sandboxAttention`, { name: boxes.value.find((box) => box.id === id)?.name ?? ``, count }) };
    }
    // Made while its reader was in another sandbox's chat: it says it is ready until it is opened.
    return readySandboxes.value.has(id) ? { mark: `check`, tone: `info` } : undefined;
};
// A run about a sandbox that has its tile (its setup still finishing, a sync, a recreate) turns on that tile, with its line
// in the hover, rather than standing as a second tile with the same letters (processTiles.ts `foldedOnSandbox`).
const { list: processes } = useFaceProcesses();
const runOf = (id: string) => sandboxRunOf(processes.value, id);
const noteOf = (id: string): string => {
    const run = runOf(id);
    if (run !== undefined) {
        return processNote(run);
    }
    return readySandboxes.value.has(id) ? t(`home.newSandbox.ready`) : t(`home.doubleClickToEnter`);
};
// The tile of the sandbox whose chat the page shows; on a page of the person's own (settings), none is.
const route = useRoute();
// While the new sandbox's page, or a process's, stands in the chat's place, its tile is the selected one; the new
// sandbox's dialog over the chat leaves the chat's own tile selected.
// Around the section Home shows of every sandbox (lib/routes/homeSection.ts), the sandbox it is showing is the selected one.
const selected = (id: string): boolean =>
    (route.name === `home` || homeFrame.value !== undefined) &&
    sandbox.activeSandboxId.value === id &&
    !newSandboxPageShown(route, newSandbox.value) &&
    processAskedBy(route) === undefined;
const labelOf = (id: string, name: string): string => t(`home.sandboxAttention`, { name, count: readings.value.get(id)?.needsYou ?? `—` });
// The same add action everywhere: signed in opens the dialog here; signed out returns to it after sign-in.
const add = useRequestAddSandbox();
let last: { id: string; at: number } | undefined;
const choose = (id: string, input: `click` | `enter`): void => {
    const now = Date.now();
    // A home-only guest has no sandbox to enter: its home is the whole of what it reaches there.
    const action = homeOnly.value ? `select` : tileAction(input, last?.id === id, last === undefined ? Infinity : now - last.at);
    last = { id, at: now };
    seenReady(id);
    sandbox.select(id);
    if (action === `enter`) {
        // Into the sandbox, where it was last left: `/` alone is Home itself (lib/routes/firstScreens.ts). Inside for real,
        // even when that was its Models, which a press on Home would otherwise show in place (lib/routes/homeDetour.ts).
        void goInside(() => router.push(sandboxEntryPath(id)));
    } else if (phone) {
        void router.push(`/home/${encodeURIComponent(id)}`);
    } else {
        // The section Home was asked to show of every sandbox, of this one; else its home conversation.
        const section = homeOnly.value ? undefined : homeSection.value;
        void router.replace(section === undefined ? `/home` : sectionEntryPath(id, section));
    }
};
</script>

<template>
    <!-- On a phone, the master view IS this list: a page of its own. -->
    <nav v-if="phone" v-bind="$attrs" :aria-label="t(`home.sandboxes`)" class="flex h-full flex-col gap-3 overflow-y-auto bg-card p-3">
        <div class="flex items-center justify-between gap-2 px-2 py-1">
            <h1 class="py-2 text-lg font-semibold">{{ t(`home.title`) }}</h1>
            <!-- The phone's first screen has no rail, so the account's settings (sign-out included) are reached from here: the
                 account's own figure, as the desktop rail's foot wears it, since a cog on each row below is that sandbox's. -->
            <RouterLink
                v-if="user !== null"
                to="/settings"
                class="flex size-11 items-center justify-center rounded-xl text-muted hover:bg-content/5 hover:text-content"
                :aria-label="t(`shared.settings`)"
            >
                <Icon name="user" aria-hidden="true" />
            </RouterLink>
            <RouterLink v-else :to="signInAt(HOME_PATH)" class="rounded-lg px-3 py-2 text-sm text-link hover:bg-content/5">{{
                t(`home.firstRun.signIn`)
            }}</RouterLink>
        </div>
        <!-- A phone has no right-click, so a sandbox's settings are the cog at the end of its row, as in the switcher. -->
        <div
            v-for="box in boxes"
            :key="box.id"
            class="flex w-full shrink-0 items-center gap-1 rounded-xl"
            :class="{ 'opacity-40': readings.get(box.id)?.unreachable, 'ring-2 ring-link': selected(box.id) }"
        >
            <button
                type="button"
                class="relative flex min-w-0 flex-1 items-center gap-3 rounded-xl p-2 text-left hover:bg-content/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-link"
                :aria-label="labelOf(box.id, box.name)"
                :aria-current="selected(box.id) ? 'true' : undefined"
                @click="choose(box.id, 'click')"
                @keydown.enter.prevent="choose(box.id, 'enter')"
            >
                <SandboxLogo :size="36" :image="box.image ?? null" :name="box.name" />
                <span class="min-w-0 flex-1 truncate">{{ box.name }}</span>
                <ViewBadgeChip :badge="badgeOf(box.id)" class="text-[0.625rem]" />
            </button>
            <button
                v-if="!homeOnly"
                type="button"
                class="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-content/5 hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-link"
                :aria-label="t(`sandbox.sandboxSwitcher.settingsOf`, { name: box.name })"
                @click="openSettings(box.id)"
            >
                <Icon name="cog" aria-hidden="true" />
            </button>
        </div>
        <span class="relative flex shrink-0">
            <button
                type="button"
                class="flex min-h-11 flex-1 items-center gap-3 rounded-xl p-2 text-left text-muted hover:bg-content/5 hover:text-content"
                @click="add"
                @pointerenter="warmAddSandbox"
                @focus="warmAddSandbox"
            >
                <span class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-line-strong">
                    <Icon name="box-plus" aria-hidden="true" />
                </span>
                <span>{{ t(`sandbox.words.addSandbox`) }}</span>
            </button>
            <Beacon v-if="!boxes.length" size="sm" class="absolute left-9 top-1" />
        </span>
        <HomeNoSandbox v-if="!boxes.length" nested />
    </nav>
    <!-- On a desktop, the tiles of the shell's own rail (ShellDesktop.vue draws the rail around them, account included),
         worn like every other tile: the same size, selection and corner chip. Only what needs you is counted; a quiet box
         wears nothing, and one that has not answered is dimmed rather than counted. -->
    <div
        v-else
        ref="list"
        v-bind="$attrs"
        :aria-label="t(`home.sandboxes`)"
        role="group"
        class="icon-rail-nav scrollbar-none flex flex-col items-center overflow-y-auto overscroll-contain"
        :class="{ 'cursor-grabbing select-none': drag.carried.value !== undefined }"
    >
        <!-- Drag a tile to arrange them; the others slide aside rather than jump. -->
        <TransitionGroup move-class="motion-safe:transition-transform motion-safe:duration-150">
            <button
                v-for="box in drawn"
                :key="box.id"
                type="button"
                data-sandbox-tile
                class="icon-rail-tile ui-row-select ui-row-select-horizontal relative flex items-center justify-center rounded-lg"
                :class="{
                    'opacity-40': readings.get(box.id)?.unreachable,
                    'ui-row-select-on': selected(box.id),
                    'z-10 bg-card shadow-lg ring-2 ring-primary-500': drag.carried.value === box.id,
                }"
                :aria-label="labelOf(box.id, box.name)"
                :aria-current="selected(box.id) ? 'true' : undefined"
                v-tooltip.right="drag.carried.value === undefined && { title: box.name, note: noteOf(box.id) }"
                @pointerdown="drag.press($event, box.id)"
                @click="choose(box.id, 'click')"
                @keydown.enter.prevent="choose(box.id, 'enter')"
                @contextmenu="openTileMenu($event, box.id)"
            >
                <SandboxLogo :image="box.image ?? null" :name="box.name" class="pointer-events-none rounded-lg" />
                <ViewBadgeChip :badge="badgeOf(box.id)" class="icon-rail-mark absolute right-0.5 top-0.5" />
                <TileMark v-if="runOf(box.id)" name="spinner" spin :class="[RUNNING_MARK_CLASS, `icon-rail-mark absolute bottom-0.5 right-0.5`]" />
            </button>
        </TransitionGroup>
        <NewSandboxTile />
        <span class="relative flex shrink-0">
            <button
                type="button"
                :class="ui.addTile(`icon-rail-tile rounded-lg hover:bg-overlay`)"
                :aria-label="t(`sandbox.words.addSandbox`)"
                v-tooltip.right="t(`sandbox.words.addSandbox`)"
                @click="add"
                @pointerenter="warmAddSandbox"
                @focus="warmAddSandbox"
            >
                <Icon name="box-plus" class="icon-rail-glyph" aria-hidden="true" />
            </button>
            <Beacon v-if="!boxes.length && !making && !newSandbox" size="sm" class="absolute right-1 top-1" />
        </span>
        <ContextMenu ref="tileMenu" :model="tileMenuItems" :min-width="11" />
    </div>
</template>
