<!-- THIS COMPUTER'S RAIL, UNROLLED ONTO EVERY SANDBOX (models/home/masterRail.ts `localRailUnrolled`): what a desktop
     window on a folder of this computer holds in its rail then, drawn inside the shell's one `nav` (LocalShell.vue), which
     plays the change (shell/rail/railMorph.ts) as the workspace's rail plays its own. The same tiles the workspace's
     unrolled rail wears (features/home/HomeSandboxes.vue): This computer first, lit, being the place on screen, then the
     account's sandboxes in the order the workspace last told the app, then Add sandbox. A press on This computer folds the
     rail back onto it, as a press on the selected sandbox's tile does there; a press on a sandbox opens the workspace on
     it through the app, as Alt+1…9 do, since this window reaches no sandbox's daemon. Its menu opens one or its settings.
     The sections went into the bookmark at the rail's foot (LocalSectionPicker.vue). -->
<script setup lang="ts">
import type { SandboxSummary } from "@intentic/api-contract";
import { ContextMenu, SandboxLogo, type TooltipValue, ui } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import { useSandbox } from "../client/sandbox/useSandbox";
import { rowPlacement } from "../features/sandbox/overview/useSandboxPlacement";
import { useFolderPlace } from "../features/sandbox/gates/switcherPlace";
import { answerNote } from "../features/sandbox/gates/switcherRows";
import { answerOf, sleepingOn } from "../client/sandbox/wake/sandboxAnswer";
import { localRailUnrolled } from "../models/home/masterRail";
import { arrangedSandboxes } from "../models/home/sandboxOrder";
import { sandboxHubPath } from "../models/sandbox/sandboxNav";

const t = useT();
const sandbox = useSandbox();
// Mounted at each unrolling, so the account's sandboxes are asked for again each time (switcherPlace.ts).
const place = useFolderPlace();
const boxes = computed(() => arrangedSandboxes(sandbox.sandboxes.value, place.arranged.value));

const fold = (): void => {
    localRailUnrolled.value = false;
};
const thisComputerTip = computed<TooltipValue>(() => ({ title: t(`sandbox.sandboxSwitcher.thisComputer`), note: t(`home.clickToFold`) }));

// Where it runs, whose it is when not the reader's, and whether it sleeps, as the list says it (this window asks no
// sandbox whether it answers): what a row of the switcher said under the name.
const noteOf = (box: SandboxSummary): string => {
    const where = rowPlacement(box);
    return [
        where.label,
        box.role !== `owner` && where.kind !== `shared` ? t(`shared.shared`).toLocaleLowerCase() : undefined,
        answerNote(answerOf(box, undefined), sleepingOn(box))?.text,
    ]
        .filter((part) => part !== undefined)
        .join(` · `);
};

const openBox = (box: SandboxSummary): void => void place.openFromFolder(box.id);
const openSettings = (box: SandboxSummary): void => void place.openSettingsFromFolder(box.id, sandboxHubPath(box.role === `guest`));

// A tile's own menu, beside the rail at the tile's height, as Home's tiles open theirs: open it, or its settings. Never
// a reorder: this window can only wear the workspace's order, with no way to hand one back.
const tileMenu = ref<{ show: (event: Event) => void }>();
const menuBox = ref<SandboxSummary>();
const tileMenuItems = computed<MenuItem[]>(() => {
    const box = menuBox.value;
    return box === undefined
        ? []
        : [
              { label: t(`ui.action.open`), command: () => openBox(box) },
              { label: t(`shared.settings`), command: () => openSettings(box) },
          ];
});
const openTileMenu = (event: MouseEvent, box: SandboxSummary): void => {
    event.preventDefault();
    menuBox.value = box;
    const tile = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const rail = (tile?.closest(`nav`) ?? tile)?.getBoundingClientRect();
    const top = tile?.getBoundingClientRect().top;
    tileMenu.value?.show(rail === undefined || top === undefined ? event : new MouseEvent(`click`, { clientX: rail.right, clientY: top }));
};

const addLabel = computed(() => (place.signedOut.value ? t(`local.placeSwitcher.putAgentsToWork`) : t(`sandbox.words.addSandbox`)));
const addTip = computed<TooltipValue>(() =>
    place.signedOut.value ? { title: t(`local.placeSwitcher.putAgentsToWork`), note: t(`local.placeSwitcher.signInLead`) } : t(`sandbox.words.addSandbox`),
);
</script>

<template>
    <div role="group" :aria-label="t(`home.sandboxes`)" class="icon-rail-nav scrollbar-none flex flex-col items-center overflow-y-auto overscroll-contain">
        <button
            type="button"
            data-rail-key="place:this-computer"
            class="icon-rail-tile ui-row-select ui-row-select-horizontal ui-row-select-on flex shrink-0 items-center justify-center rounded-lg text-link"
            :aria-label="t(`sandbox.sandboxSwitcher.thisComputer`)"
            aria-current="true"
            v-tooltip.right="thisComputerTip"
            @click="fold"
        >
            <Icon name="desktop" class="icon-rail-glyph" aria-hidden="true" />
        </button>
        <button
            v-for="box in boxes"
            :key="box.id"
            type="button"
            :data-rail-key="`sandbox:${box.id}`"
            data-rail-into="sandboxes"
            class="icon-rail-tile ui-row-select ui-row-select-horizontal relative flex shrink-0 items-center justify-center rounded-lg"
            :aria-label="`${box.name} · ${noteOf(box)}`"
            v-tooltip.right="{ title: box.name, note: noteOf(box) }"
            @click="openBox(box)"
            @contextmenu="openTileMenu($event, box)"
        >
            <span class="icon-rail-picture pointer-events-none flex items-center justify-center overflow-hidden rounded-md">
                <SandboxLogo :image="box.image ?? null" :name="box.name" class="pointer-events-none rounded-md" />
            </span>
        </button>
        <button
            type="button"
            :class="ui.addTile(`icon-rail-tile shrink-0 rounded-lg hover:bg-overlay`)"
            data-rail-key="rail:add-sandbox"
            :aria-label="addLabel"
            v-tooltip.right="addTip"
            @click="place.addSandbox()"
        >
            <Icon name="box-plus" class="icon-rail-glyph" aria-hidden="true" />
        </button>
        <ContextMenu ref="tileMenu" :model="tileMenuItems" :min-width="11" />
    </div>
</template>
