<script setup lang="ts">
import TourMark from "../../tour/TourMark.vue";
import type { SandboxSummary } from "@intentic/api-contract";
import { AnchoredOverlay, Notice, SandboxLogo, SectionHeader, StatusBadge, type Tip, useHoverMenu } from "@intentic/ui";
import { computed, type ComputedRef, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { commandShortcut } from "../../../workbench/commands/useCommands";
import { RUNNING_MARK_CLASS } from "../../../workbench/views/viewBadge";
import TileMark from "../../../components/TileMark.vue";
import { restartRunning } from "../../../models/sandbox/live/sandboxRestart";
import { sandboxHubPath } from "../../../models/sandbox/sandboxNav";
import { landOnAfterSwitch } from "../../../models/sandbox/sandboxScreen";
import { sandboxAvailabilityVisual } from "../overview/availability";
import { placementOf, type SandboxPlacement } from "../overview/placement";
import { useSandboxPlacement } from "../overview/useSandboxPlacement";
import { attentionByBox, otherBoxes, subscribe as watchOtherBoxes } from "../../../models/sandbox/live/fleetAcross";
import { switchableSandboxes } from "../../../models/sandbox/live/roster";
import { useRequestAddSandbox, warmAddSandbox } from "../../../models/sandbox/addSandbox";
import { useSandboxAvailability } from "../overview/useSandboxAvailability";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useWorkspaceTree } from "../../../models/workspace/tree/useWorkspaceTree";
import { operationRunning } from "../../../workbench/operations/operations";
import { announceDesktopRoster, desktopApp, openThisComputer } from "../../../app/environments/desktop";
import { localFace } from "../../../app/environments/local";
import { useAuth } from "../../../client/auth/useAuth";
import { useFolderPlace } from "./switcherPlace";
import { answerNote } from "./switcherRows";
import { removalKey } from "./removal/removalPlan";
import { slotChord, useSwitchCommands } from "./useSwitchCommands";
import { useT } from "@intentic/ui/i18n";

// Shared workspace/local-window place switcher: a pick retargets sandbox views/probes; the active sandbox hub is opened from here.
// Hover dwell opens, the pointer corridor preserves it, and a press pins it; keep sandbox rows in stable positions.
// Local windows use the app's platform proxy and omit daemon attention/reachability and the workspace-only hub.
// Setup/news/action badges belong to gettingStarted/SandboxErrands.vue, leaving this menu focused on choosing a place.

const t = useT();

const sandbox = useSandbox();
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const availabilityVisual = computed(() => sandboxAvailabilityVisual(availability.value));
const router = useRouter();
const route = useRoute();
// WORK THAT ENDS BY REPLACING THIS SANDBOX, while it is still running. Not on the attention badge (now on the
// getting-started ring), which counts what the sandbox needs from its owner: this needs nothing, interrupts nothing yet, and is over in minutes — a standing
// badge for it would teach the reader to stop reading the badge. A mark of its own, on its own corner, saying only
// that something is moving. What it will do is said when it does it, by the lane.
const restarting = computed(() => restartRunning(sandbox.activeSandboxId.value));

// WHERE THIS SANDBOX RUNS: Intentic's cloud, a machine of the owner's, or somebody else's. Drawn as one mark with the
// connection's state — the glyph says which machine, its ink says whether that machine answers — because both are
// facts about the same link and two corners saying it was twice the tile for one sentence. That sentence rides the
// control's own label, because a glyph alone cannot be the only place a reader can learn this.
// A local window stands on a folder, not a sandbox, and its sidecar has no device registry to ask, so it reads none.
const placement: ComputedRef<SandboxPlacement | undefined> = localFace() === undefined ? useSandboxPlacement() : computed(() => undefined);

// One label for the whole control, its marks included, since a tooltip on a mark would nest inside this one.
const switcherLabel = computed(() => {
    const name = sandbox.active.value?.name ?? t(`sandbox.sandboxSwitcher.sandboxes`);
    const status =
        availability.value === `live` || availability.value === `stale`
            ? undefined
            : t(`sandbox.sandboxSwitcher.sandboxState`, { state: availabilityVisual.value.label.toLowerCase() });
    return [name, placement.value?.detail, status, restarting.value].filter((part) => part !== undefined).join(` · `);
});

// Live, or a retry too short to mention: the connection says nothing anywhere until it is something else.
const quiet = computed(() => availability.value === `live` || availability.value === `stale`);

// A short retry keeps the healthy ink; changing colour is itself the alarm being avoided.
const connectionInkClass = computed(() => availabilityVisual.value.inkClass);
const connectionLabel = computed(() => availabilityVisual.value.label.toLowerCase());

// A local window stands on its folder, so none of the account's sandboxes is the one on screen there.
const isActive = (option: SandboxSummary): boolean => !local && option.id === sandbox.activeSandboxId.value;

// Anchored rather than PrimeVue's Popover, so one overlay alone decides where a panel goes.
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const menu = useHoverMenu(panel);
const open = menu.open;
const pressed = menu.pressed;
// The local window's own half (switcherPlace.ts): opening a sandbox through the app, the sign-in, a failure by its row.
const {
    folder,
    local,
    failure,
    openFromFolder,
    openSettingsFromFolder,
    openHome,
    signedOut,
    signingIn,
    signIn,
    addSandbox: addFromFolder,
} = useFolderPlace(open);

// Reads these counts only while the popover is open, since the control is mounted for the whole session; a second
// open within the freshness window paints instantly from the store's last read. A pointer resting on the logo starts
// the read before the dwell is out, so the counts are usually there by the time the panel is.
let releaseBoxes: (() => void) | undefined;
// Never from a local window, whose page those daemons refuse: every row would read as not answering.
watch(
    () => !local && (open.value || menu.hovering.value),
    (wanted) => {
        if (wanted) {
            releaseBoxes ??= watchOtherBoxes();
            // Its "Add sandbox" lands on a dialog whose chunk is fetched now, not after the press (addSandbox.ts).
            warmAddSandbox();
            return;
        }
        releaseBoxes?.();
        releaseBoxes = undefined;
    },
);
onUnmounted(() => {
    releaseBoxes?.();
    releaseBoxes = undefined;
});

// A sandbox that never reported in has no daemon, so switching to it can only paint a connecting gate that never
// resolves; those rows are unfinished errands on the getting-started ring, not places to switch to.
// A local window's own folder is in the list too (it is the "sandbox" that window shows) and is not a place to switch to.
// Both rules are roster.ts `switchableSandboxes`, which the home rail and the phone's menu draw from as well.
const switchable = computed(() => switchableSandboxes(sandbox.sandboxes.value));

// How much is waiting in every other sandbox; absent for the active row since its badge is already on the rail.
// An unanswered box gets undefined, which draws nothing rather than a zero.
const attentionFor = (option: SandboxSummary): number | undefined => (isActive(option) ? undefined : attentionByBox.value.get(option.id));

// A box whose last read went unanswered. Said in words on its row, because "is it even up" is the question a reader
// asks before switching to it. A box still on its first read says nothing yet: a hover-raised panel opens on that
// moment every time, and a word that flickers away a beat later teaches the reader not to read it.
const silent = (option: SandboxSummary): boolean =>
    !isActive(option) && otherBoxes.value.some((box) => box.sandbox.id === option.id && box.state === `unreachable`);

// The same fact per row, and the ACTIVE row borrows the refined one above rather than deriving its own: the tile and
// the row it opens onto are the same sandbox, and a glyph that changed between them would read as two answers.
const placementFor = (option: SandboxSummary): SandboxPlacement =>
    isActive(option) && placement.value !== undefined ? placement.value : placementOf(option);

// THE ROW'S SECOND LINE: where it runs, then whatever else is true of it, each fact in its own ink so a warning colours
// only the words that warn. On the ACTIVE row it is what the logo's own marks say (the hover card the logo used to
// carry): its connection when that is anything but fine, and the work replacing it while that runs, which outranks
// everything else there is to say.
interface NotePart {
    readonly text: string;
    readonly ink?: string;
}
// A row whose removal is running says so, so it is not mistaken for a sandbox to switch to or remove a second time.
const beingRemoved = (option: SandboxSummary): boolean => operationRunning(removalKey(option.id));

const rowNote = (option: SandboxSummary): readonly NotePart[] => {
    if (beingRemoved(option)) {
        return [{ text: t(`sandbox.removeSandbox.rowRemoving`), ink: RUNNING_MARK_CLASS }];
    }
    if (isActive(option) && restarting.value !== undefined) {
        return [{ text: restarting.value, ink: RUNNING_MARK_CLASS }];
    }
    const place = placementFor(option);
    const parts: (NotePart | undefined)[] = [
        { text: place.label },
        option.role !== `owner` && place.kind !== `shared` ? { text: t(`shared.shared`).toLocaleLowerCase() } : undefined,
        isActive(option) && !quiet.value ? { text: connectionLabel.value, ink: connectionInkClass.value } : undefined,
        answerNote(option.hosted?.state, silent(option)),
    ];
    return parts.filter((part) => part !== undefined);
};

// A row's place as its hover card; the active row adds whether its machine answers, since its glyph is inked by that.
const placementTip = (option: SandboxSummary): Tip => {
    const tip = placementFor(option).tip;
    return isActive(option)
        ? { ...tip, rows: [...(tip.rows ?? []), { label: t(`sandbox.sandboxSwitcher.status`), value: connectionLabel.value }] }
        : tip;
};

// Every add is made on Home on a desktop, in the dialog on a phone (models/sandbox/addSandbox.ts); a signed-out reader
// signs in first and comes back to the same ask.
const requestAddSandbox = useRequestAddSandbox();
const addHere = (): void => {
    open.value = false;
    requestAddSandbox();
};

const pick = (option: SandboxSummary): void => {
    if (local) {
        void openFromFolder(option.id);
        return;
    }
    open.value = false;
    sandbox.select(option.id);
};

// A SANDBOX'S SETTINGS, from its own row: the cog beside it, so the list says whose settings they are, and another
// sandbox's are one press away instead of a switch and a second trip through this panel. Removing or leaving one is
// in there, at the foot of its Overview, rather than a trash on the row a pointer sweeps past on its way to switching.
// A guest's door names the one section it may open (sandboxHubPath); every other tier opens on the hub's own default.
// Another sandbox's lands there through the switch itself (sandboxScreen.ts), whose landing would replace a push.
const openSettings = (option: SandboxSummary): void => {
    const path = sandboxHubPath(option.role === `guest`);
    if (local) {
        void openSettingsFromFolder(option.id, path);
        return;
    }
    open.value = false;
    if (isActive(option)) {
        void router.push(path);
        return;
    }
    landOnAfterSwitch(option.id, path);
    sandbox.select(option.id);
};

// THIS COMPUTER, the desktop app's other face: its own window on a folder of this computer, with This device beside it
// (the app's local shell). The app swaps the two in one frame. An app older than the local shell opens its
// own card for the same link, which is this computer too.
const inDesktopApp = desktopApp() !== undefined && !local;
const toThisComputer = (): void => {
    open.value = false;
    openThisComputer();
};

// The app's local windows list these same sandboxes in their own switcher and show this account at their rail's foot,
// and can learn either only from this page (desktop.ts `announceDesktopRoster`): told on mount and again whenever a
// row, its mark or the account changes.
const { user } = useAuth();
if (inDesktopApp) {
    watch(
        () =>
            [
                switchable.value.map((option) => ({
                    id: option.id,
                    name: option.name,
                    place: placementFor(option).kind,
                    shared: option.role !== `owner`,
                })),
                user.value === null ? undefined : { email: user.value.email, name: user.value.name, image: user.value.image },
            ] as const,
        ([rows, account]) => announceDesktopRoster(rows, account),
        { immediate: true },
    );
}

// A local window asks for its list itself (switcherPlace.ts).
onMounted(() => {
    if (!local && sandbox.sandboxes.value.length === 0) {
        void sandbox.list();
    }
});

// Alt+0 for this computer inside the app, Alt+1…9 for the sandboxes under it (useSwitchCommands.ts).
useSwitchCommands(switchable, pick, inDesktopApp ? toThisComputer : undefined);
</script>

<template>
    <!-- The rail's top control: a live chip for the active sandbox, click to switch. -->
    <span class="relative flex">
        <!-- No tooltip: resting here opens the panel itself, on the side a tooltip would take, and the facts the
             tooltip carried are the active row's second line. The joined sentence stays the accessible name. -->
        <button
            ref="trigger"
            type="button"
            class="sandbox-switcher icon-rail-tile ui-row-select ui-row-select-horizontal flex items-center justify-center overflow-hidden rounded-lg"
            :class="[
                route.path === '/sandbox' || route.path.startsWith('/sandbox/') ? 'ui-row-select-on text-link' : 'text-muted hover:text-content',
                open && 'opacity-80',
            ]"
            :aria-label="
                folder ? t(`local.placeSwitcher.switchPlace`, { name: folder.name }) : t(`sandbox.sandboxSwitcher.switchSandbox`, { switcherLabel })
            "
            aria-haspopup="dialog"
            :aria-expanded="open"
            v-on="menu.trigger"
        >
            <!-- This computer has one mark, whichever folder the local window shows. -->
            <span class="flex size-full items-center justify-center overflow-hidden rounded-md [&_span]:text-inherit">
                <Icon v-if="folder" name="desktop" class="icon-rail-glyph" aria-hidden="true" />
                <SandboxLogo v-else :image="sandbox.active.value?.image ?? null" :name="sandbox.active.value?.name" />
            </span>
        </button>
        <!-- WHERE IT RUNS AND WHETHER IT ANSWERS, on the bottom-left corner: bottom-right is where every icon on the
             rail shows its running mark, so that corner belongs to the spinner below. The glyph
             is the machine, its ink the connection: quiet whenever the answer is neither "online" nor "wrong", so a
             fact that is always true carries an errand's weight only when there is one. A plate, where the running
             mark is a bare glyph: this one sits over whatever picture the owner uploaded, and a glyph alone on a photo
             is unreadable. The plate is the tile's own ground, so it reads as a notch cut into the logo rather than a
             second badge. No active sandbox is no link to report, so the corner stays empty rather than guessing.
             aria-hidden: both sentences are already in the button's label above. -->
        <span
            v-if="placement"
            class="sandbox-switcher-mark pointer-events-none absolute bottom-0.5 left-0.5 inline-flex h-[1.6em] w-[1.6em] items-center justify-center rounded-full bg-[color:var(--ui-tile-ground)] leading-none"
            :class="connectionInkClass"
            aria-hidden="true"
        >
            <!-- Plate and glyph measure as every rail badge does, so the corners weigh the same; only the ink differs. -->
            <Icon :name="placement.icon" class="text-[0.9em]" />
        </span>
        <!-- Getting started's way to connecting a model: the sandbox's own settings start here. Its hint leads to them. -->
        <TourMark v-if="!local" step="models" place="rail" still side="right" class="absolute left-0.5 top-0.5" />
        <!-- The rail's running mark, on the bottom-right corner as on every other rail icon: it is an errand in flight,
     where the two beside it are standing facts, and the one thing here that must never be crowded. The sentence rides the control's own label,
     since a tooltip on a mark inside a tooltipped button nests inside it. -->
        <TileMark
            v-if="restarting !== undefined"
            name="spinner"
            spin
            :class="[RUNNING_MARK_CLASS, `sandbox-switcher-mark pointer-events-none absolute bottom-0.5 right-0.5`]"
        />
    </span>

    <!-- Zeroed padding: PrimeVue's popover padding reads as a frame around rows with their own inset. Focus goes back
         to the logo only when a press opened it: a panel the pointer raised never took the keyboard's place. -->
    <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="right" cross="start" :restore-focus="pressed" menu>
        <div ref="panel" class="flex min-h-0 w-80 max-w-[calc(100vw-5rem)] flex-col gap-0.5 overflow-y-auto overscroll-contain p-1" v-on="menu.panel">
            <!-- The app's other face, a place of the same rank as the sandboxes and first, as the local window's switcher
                 lists it: this computer's own folder, no sandbox needed. Always there and always one row, so the
                 sandboxes growing under it never move it. No arrow: the app shows it in this window's own frame, as
                 picking a sandbox does. -->
            <template v-if="inDesktopApp">
                <button
                    type="button"
                    data-menu-row
                    class="group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-content/5"
                    @click="toThisComputer"
                >
                    <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-content/5 text-muted">
                        <Icon name="desktop" class="text-sm" />
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate font-medium text-content">{{ t(`sandbox.sandboxSwitcher.thisComputer`) }}</span>
                        <span class="truncate text-2xs text-subtle">{{ t(`sandbox.sandboxSwitcher.thisComputerNote`) }}</span>
                    </span>
                    <kbd
                        v-if="commandShortcut(`sandbox.thisComputer`)"
                        class="shrink-0 rounded border border-line px-1 font-mono text-2xs font-normal leading-4 text-subtle"
                        >{{ commandShortcut(`sandbox.thisComputer`) }}</kbd
                    >
                </button>
                <div class="my-1 border-t border-line-subtle"></div>
            </template>
            <!-- In a local window, the same place heads the panel as where this window already is: the folder it shows
                 and its path. Not a row to pick, being the place on screen. -->
            <template v-else-if="folder">
                <div class="ui-row-select-on flex items-center gap-2.5 rounded-md px-2 py-1.5 text-xs" aria-current="true">
                    <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-content/5 text-link">
                        <Icon name="desktop" class="text-sm" />
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate font-medium text-link">{{ folder.name }}</span>
                        <span class="truncate font-mono text-2xs text-subtle" :title="folder.path">{{ folder.path }}</span>
                    </span>
                </div>
                <div class="my-1 border-t border-line-subtle"></div>
            </template>

            <SectionHeader :label="t(`shared.sandboxes`)" density="dense" class="px-2 py-1.5">
                <!-- The way out to the master view (features/home/), every sandbox at once: a small mark on the header of
                     the list it zooms out of, quiet until looked for. -->
                <template #actions>
                    <component
                        :is="local ? `button` : RouterLink"
                        v-bind="local ? { type: `button` } : { to: `/home` }"
                        class="flex h-5 w-5 items-center justify-center rounded text-subtle transition-colors hover:bg-content/5 hover:text-content"
                        :aria-label="t(`home.open`)"
                        v-tooltip.top="t(`home.open`)"
                        @click="openHome"
                    >
                        <Icon name="th-large" class="text-2xs" />
                    </component>
                </template>
            </SectionHeader>
            <Notice v-if="failure?.id === `:home`" tone="danger" class="mx-2 mb-1 text-2xs">{{ failure.message }}</Notice>

            <!-- A local window with nobody signed in: what agents need, and the sign-in that brings the workspace. -->
            <template v-if="signedOut">
                <button
                    type="button"
                    data-menu-row
                    class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-content/5"
                    @click="signIn"
                >
                    <span class="flex h-7 w-7 shrink-0 items-center justify-center text-muted">
                        <Icon :name="signingIn ? `spinner` : `robot`" :spin="signingIn" class="text-sm" />
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate text-content">{{ t(`local.placeSwitcher.putAgentsToWork`) }}</span>
                        <span class="truncate text-2xs text-subtle">{{ t(`local.placeSwitcher.signInLead`) }}</span>
                    </span>
                    <Icon name="sign-in" class="shrink-0 text-2xs text-subtle" />
                </button>
                <div v-if="failure?.id === `:sign-in`" class="px-2 pb-1">
                    <Notice tone="danger" class="text-2xs">{{ failure.message }}</Notice>
                </div>
            </template>
            <template v-else>
                <!-- Two lines a row: the name, and where it runs with whatever else is true of it (rowNote). The logo is the
                 row's height, so a reader finds a box by its picture before reading a word. -->
                <template v-for="(option, at) in switchable" :key="option.id">
                    <!-- The row and its cog are siblings, so the cog is a button of its own a keyboard can reach, laid over
                         the row's trailing slot rather than nested inside the row's own button. -->
                    <div class="group relative flex flex-col">
                        <button
                            type="button"
                            data-menu-row
                            :data-current="isActive(option) || undefined"
                            :aria-current="isActive(option) || undefined"
                            class="ui-row-select flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs"
                            :class="{ 'ui-row-select-on': isActive(option) }"
                            @click="pick(option)"
                        >
                            <SandboxLogo :size="28" :image="option.image ?? null" :name="option.name" />
                            <span class="flex min-w-0 flex-1 flex-col">
                                <span class="truncate font-medium" :class="isActive(option) ? 'text-link' : 'text-content'">{{ option.name }}</span>
                                <!-- Where that one runs, the reason to switch to a box being often which machine it is on. On the
                         ACTIVE row the glyph is the tile's mark exactly, the same glyph inked by the connection; on every
                         other row it is the placement alone. While the work replacing it runs, its spinner stands in. -->
                                <span class="flex min-w-0 items-center gap-1 text-2xs text-subtle">
                                    <Icon
                                        v-if="isActive(option) && restarting !== undefined"
                                        name="spinner"
                                        spin
                                        class="shrink-0"
                                        :class="RUNNING_MARK_CLASS"
                                    />
                                    <!-- The hover card is the glyph's alone: on the whole line it rose under every pointer sweeping
                             down the list, over the row above. -->
                                    <Icon
                                        v-else
                                        :name="placementFor(option).icon"
                                        class="shrink-0"
                                        :class="isActive(option) ? connectionInkClass : undefined"
                                        v-tooltip.top="placementTip(option)"
                                        :aria-label="
                                            isActive(option) ? `${placementFor(option).detail} · ${connectionLabel}` : placementFor(option).detail
                                        "
                                    />
                                    <span class="truncate">
                                        <template v-for="(part, index) in rowNote(option)" :key="index">
                                            <template v-if="index > 0"> · </template><span :class="part.ink">{{ part.text }}</span>
                                        </template>
                                    </span>
                                </span>
                            </span>
                            <!-- What's waiting in that sandbox; nothing waiting, or not known yet, draws nothing. The active row is
                     never either: its own badge is on the logo, so it reports no count to read. -->
                            <StatusBadge
                                v-if="(attentionFor(option) ?? 0) > 0"
                                variant="warning"
                                size="xs"
                                class="shrink-0 leading-4"
                                v-tooltip.top="t(`sandbox.sandboxSwitcher.needsYou`)"
                                >{{ attentionFor(option) }}</StatusBadge
                            >
                            <!-- Which digit this row is, the only place the chord can be learned. The cog below takes its place
                             while the row is pointed at or has the keyboard, and always on the active row, whose chord
                             would switch to where the reader already is. -->
                            <span class="flex min-w-9 shrink-0 items-center justify-end">
                                <kbd
                                    v-if="slotChord(at) && !isActive(option)"
                                    class="rounded border border-line px-1 font-mono text-2xs font-normal leading-4 text-subtle transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
                                    >{{ slotChord(at) }}</kbd
                                >
                            </span>
                        </button>
                        <!-- THE ROW'S SETTINGS, its one action: removing or leaving it is in there (the foot of its Overview),
                         not a trash a pointer meets on its way to switching. On the row the reader is in it stays in
                         sight, the way to this sandbox's own settings; on every other row it shows with the row's
                         attention, and switches there in the same press. -->
                        <button
                            v-if="!beingRemoved(option)"
                            type="button"
                            class="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-subtle transition-[opacity,color,background-color] hover:bg-content/10 hover:text-content focus-visible:opacity-100"
                            :class="isActive(option) ? undefined : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'"
                            :aria-label="t(`sandbox.sandboxSwitcher.settingsOf`, { name: option.name })"
                            v-tooltip.top="t(`shared.settings`)"
                            @click="openSettings(option)"
                        >
                            <Icon name="cog" class="text-sm" />
                        </button>
                    </div>
                    <!-- A local window opens the workspace on the row, which can fail where the app says why. -->
                    <div v-if="failure?.id === option.id" class="px-2 pb-1">
                        <Notice tone="danger" class="text-2xs">{{ failure.message }}</Notice>
                    </div>
                </template>

                <!-- The first and every later sandbox use the same dialog over this place. -->
                <button
                    type="button"
                    data-menu-row
                    class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs text-content transition-colors hover:bg-content/5"
                    @click="(event: MouseEvent) => (local ? addFromFolder(event) : addHere())"
                >
                    <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-dashed border-line text-muted">
                        <Icon name="plus" class="text-sm" />
                    </span>
                    <span class="min-w-0 flex-1">{{ t(`sandbox.words.addSandbox`) }}</span>
                </button>
            </template>
        </div>
    </AnchoredOverlay>
</template>

<style scoped>
/* The fallback matches the rail's own sizing, so the chip holds its size across text sizes regardless. */
.sandbox-switcher {
    width: var(--icon-rail-tile-size, calc(2.75rem / var(--ui-scale)));
    height: var(--icon-rail-tile-size, calc(2.75rem / var(--ui-scale)));
}

/* Same reading for the corner badge: the rail's mark size when this sits in the rail, its own copy of the number when it doesn't. */
.sandbox-switcher-mark {
    font-size: var(--icon-rail-mark-size, calc(0.625rem / var(--ui-scale)));
}
</style>
