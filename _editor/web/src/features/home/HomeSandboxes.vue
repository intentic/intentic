<script setup lang="ts">
import { computed, ref, TransitionGroup } from "vue";
import type { MenuItem } from "primevue/menuitem";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { Beacon, ContextMenu, SandboxLogo, ui } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useRole } from "../../client/sandbox/useRole";
import { tileAction } from "../../models/home/homeFacts";
import { arrangedSandboxes, sandboxOrder } from "../../models/home/sandboxOrder";
import { movedOrder, useSortableDrag } from "../../components/sortable/sortableDrag";
import SortableLift from "../../components/sortable/SortableLift.vue";
import { useRequestAddSandbox, warmAddSandbox } from "../../models/sandbox/addSandbox";
import { useHomeAttention } from "../../models/home/useHomeAttention";
import { processAskedBy } from "../../models/processes/processAddress";
import { homeEntryPath, sandboxEntryPath } from "../../models/sandbox/sandboxScreen";
import { GUEST_SECTION } from "../../models/sandbox/sandboxNav";
import { useAuth } from "../../client/auth/useAuth";
import { HOME_PATH } from "../../lib/routes/firstScreens";
import { signInAt } from "../../lib/routes/signIn";
import { page, routeSandbox, toHome } from "../../lib/routes/links";
import { masterRail } from "../../models/home/masterRail";
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
// The switcher's own list in the switcher's own order (sandboxOrder.ts `arrangedSandboxes`), never the account's raw
// rows: a setup never finished has no daemon to open a home conversation on, and a desktop folder window's own row is no
// sandbox at all. The sandbox Home is making (newSandbox.ts) is its own tile until its run ends, not a second one beside it.
const making = computed(() => newSandbox.value?.here.add.created.value?.id);
const boxes = computed(() => arrangedSandboxes(sandbox.sandboxes.value).filter((box) => box.id !== making.value));
// A tile carried along the rail lifts off it and follows the pointer, its place an empty dashed slot the others make way
// for (sortableDrag.ts); where it is let go is kept, for the switcher's rows as well.
const list = ref<HTMLElement | null>(null);
const drag = useSortableDrag({
    list: () => list.value,
    ids: () => boxes.value.map((box) => box.id),
    commit: (ids) => (sandboxOrder.value = ids),
});
const lifted = computed(() => boxes.value.find((box) => box.id === drag.carried.value));
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
// (`/home/<sandbox>/settings`): the rail stays, the tile stays lit, and Back or a press on any tile returns to a chat.
// A guest's door names the one section it may open (sandboxNav.ts GUEST_SECTION). The address names the sandbox, which
// selects it (router/shellGates.ts).
const openSettings = (id: string): void => {
    const box = boxes.value.find((candidate) => candidate.id === id);
    if (box === undefined) {
        return;
    }
    seenReady(id);
    void router.push(toHome(id, page.sandboxSettings(box.role === `guest` ? GUEST_SECTION : undefined)));
};
// Into the sandbox, as a double-click goes: the menu's way for a keyboard, and the place a reader learns the double-click.
// Inside it for real, where it was last left, even when that was its Models (lib/routes/homeDetour.ts shows those in
// place only in Home's frame).
const enter = (id: string): void => {
    seenReady(id);
    void router.push(sandboxEntryPath(id));
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
// Around any page of a sandbox in Home's frame, the sandbox its address names is the selected one; on Home's own page
// with none named yet, the one open.
const selected = (id: string): boolean =>
    masterRail.value &&
    (routeSandbox(route) ?? (route.name === `home` ? sandbox.activeSandboxId.value : undefined)) === id &&
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
    if (action === `enter`) {
        enter(id);
    } else if (phone) {
        void router.push(toHome(id));
    } else {
        // The section Home was asked to show of every sandbox, of this one; else its home conversation. Replaced, as
        // a look along the rail; the address names the sandbox, which selects it (router/shellGates.ts).
        void router.replace(homeEntryPath(id));
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
                :to="toHome(undefined, page.account())"
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
        <TransitionGroup move-class="motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out">
            <!-- The carried tile's own place is the slot it will land in: empty and dashed, inside the tile's box so the
                 rail's scrolling frame never clips it. -->
            <button
                v-for="box in drawn"
                :key="box.id"
                type="button"
                data-sortable-item
                class="icon-rail-tile ui-row-select ui-row-select-horizontal relative flex items-center justify-center rounded-lg"
                :class="
                    drag.carried.value === box.id
                        ? 'pointer-events-none'
                        : { 'opacity-40': readings.get(box.id)?.unreachable, 'ui-row-select-on': selected(box.id) }
                "
                :aria-label="labelOf(box.id, box.name)"
                :aria-current="selected(box.id) ? 'true' : undefined"
                v-tooltip.right="drag.carried.value === undefined && { title: box.name, note: noteOf(box.id) }"
                @pointerdown="drag.press($event, box.id)"
                @click="choose(box.id, 'click')"
                @keydown.enter.prevent="choose(box.id, 'enter')"
                @contextmenu="openTileMenu($event, box.id)"
            >
                <span
                    v-if="drag.carried.value === box.id"
                    class="absolute inset-1 rounded-lg border-2 border-dashed border-primary-500/70 bg-primary-500/10"
                    aria-hidden="true"
                ></span>
                <template v-else>
                    <SandboxLogo :image="box.image ?? null" :name="box.name" class="pointer-events-none rounded-lg" />
                    <ViewBadgeChip :badge="badgeOf(box.id)" class="icon-rail-mark absolute right-0.5 top-0.5" />
                    <TileMark v-if="runOf(box.id)" name="spinner" spin :class="[RUNNING_MARK_CLASS, `icon-rail-mark absolute bottom-0.5 right-0.5`]" />
                </template>
            </button>
        </TransitionGroup>
        <!-- The tile itself, held above the rail: raised and shadowed, the rail's own ground behind a logo drawn on nothing. -->
        <SortableLift :box="drag.lift.value">
            <span v-if="lifted" class="flex size-full items-center justify-center overflow-hidden rounded-lg bg-card text-lg shadow-xl ring-1 ring-line-strong">
                <SandboxLogo :image="lifted.image ?? null" :name="lifted.name" class="rounded-lg" />
            </span>
        </SortableLift>
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
