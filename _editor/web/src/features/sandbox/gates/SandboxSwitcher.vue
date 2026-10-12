<script setup lang="ts">
import TourMark from "../../tour/TourMark.vue";
import type { Disposable } from "@intentic/extension-api";
import { SANDBOX_RECOVERY_DAYS as RECOVERY_DAYS, type SandboxSummary } from "@intentic/api-contract";
import {
    AnchoredOverlay,
    browserOwnsClick,
    ConfirmDialog,
    Notice,
    SandboxLogo,
    StatusBadge,
    type Tip,
    type CommandOs,
    useHoverMenu,
} from "@intentic/ui";
import { sandboxSubdomain } from "@intentic/sandbox-contract";
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type WatchStopHandle } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { SANDBOX } from "../../../workbench/commands/categories";
import { commandShortcut, registerCommand } from "../../../workbench/commands/useCommands";
import ViewBadgeChip from "../../../workbench/views/ViewBadgeChip.vue";
import { RUNNING_MARK_CLASS } from "../../../workbench/views/viewBadge";
import TileMark from "../../../components/TileMark.vue";
import { restartRunning } from "../live/sandboxRestart";
import { sandboxHubPath } from "../sandboxNav";
import { useRole } from "../../../client/sandbox/useRole";
import { type SandboxAttentionItem, useSandboxAttention } from "../overview/sandboxAttention";
import { sandboxIdFromToken } from "../session/sandboxIdFromToken";
import { sandboxAvailabilityVisual } from "../overview/availability";
import { placementOf, type SandboxPlacement } from "../overview/placement";
import { useSandboxPlacement } from "../overview/useSandboxPlacement";
import { attentionByBox, otherBoxes, subscribe as watchOtherBoxes } from "../live/fleetAcross";
import { connectedSandboxes, unfinishedSandboxes } from "../live/roster";
import { useSandboxAvailability } from "../overview/useSandboxAvailability";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useWorkspaceTree } from "../../workspace/explorer/useWorkspaceTree";
import { manageDeviceSandbox, useDevices, useHostRunning } from "../devices/useDevices";
import { beginDeviceWork, machineKeyOf } from "../devices/runners/deviceWork";
import { useOperation } from "../../../workbench/operations/operations";
import HostedRollbackDialog from "../overview/version/HostedRollbackDialog.vue";
import { oneLiner } from "../../../app/environments/scriptCommand";
import RunCommand from "../../../components/RunCommand.vue";
import { oneLinerFits } from "@intentic/constants";
import { announceDesktopRoster, DESKTOP_LAUNCHER_LINK, desktopApp, openDesktopLink } from "../../../app/environments/desktop";
import { useAuth } from "../../../client/auth/useAuth";
import { removalTakes } from "./switcherRows";
import { useT } from "@intentic/ui/i18n";

// Rail control to switch between the user's sandboxes or add another; selecting one re-points every sandbox-backed
// view and the liveness probe at the chosen daemon. Settings, access and everything else about the active sandbox
// live on the tabbed /sandbox hub, opened from here.
//
// RESTING ON THE LOGO OPENS IT, as a press does. Switching is the errand this corner is visited for, and it should
// not cost a press first. A pointer passing over raises nothing (the hover clock's dwell), the way across the rail
// to a lower row keeps it up (useHoverMenu's corridor), and a press pins it. The sandboxes come first and always stand
// in the same place, so the Nth one is the same reach every time. What concerns only the sandbox in use (what it
// needs, what is worth knowing, its settings) is gathered under them, beside its settings.

const t = useT();

const sandbox = useSandbox();
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const availabilityVisual = computed(() => sandboxAvailabilityVisual(availability.value));
const router = useRouter();
const route = useRoute();
// Everything the sandbox needs from its owner: a badge from `needs`, plus rows for `needs` and `notes`.
const { needs: attention, notes: attentionNotes, badge: attentionBadge } = useSandboxAttention();
// WORK THAT ENDS BY REPLACING THIS SANDBOX, while it is still running. Not on the attention badge, which counts what
// the sandbox needs from its owner: this needs nothing, interrupts nothing yet, and is over in minutes — a standing
// badge for it would teach the reader to stop reading the badge. A mark of its own, on its own corner, saying only
// that something is moving. What it will do is said when it does it, by the lane.
const restarting = computed(() => restartRunning(sandbox.activeSandboxId.value));

// A guest's door to the hub names the one section it may open; every other tier opens on the hub's own default.
const { isGuest } = useRole();
const hubPath = computed(() => sandboxHubPath(isGuest.value));

// WHERE THIS SANDBOX RUNS: Intentic's cloud, a machine of the owner's, or somebody else's. Drawn as one mark with the
// connection's state — the glyph says which machine, its ink says whether that machine answers — because both are
// facts about the same link and two corners saying it was twice the tile for one sentence. That sentence rides the
// control's own label, because a glyph alone cannot be the only place a reader can learn this.
const placement = useSandboxPlacement();

// One label for the whole control, badge included, since a tooltip on the badge would nest inside this one.
const switcherLabel = computed(() => {
    const name = sandbox.active.value?.name ?? t(`sandbox.sandboxSwitcher.sandboxes`);
    const tooltip = attentionBadge.value?.tooltip;
    const status =
        availability.value === `live` || availability.value === `stale` ? undefined : t(`sandbox.sandboxSwitcher.sandboxState`, { state: availabilityVisual.value.label.toLowerCase() });
    return [name, placement.value?.detail, status, restarting.value, tooltip].filter((part) => part !== undefined).join(` · `);
});

// Live, or a retry too short to mention: the connection says nothing anywhere until it is something else.
const quiet = computed(() => availability.value === `live` || availability.value === `stale`);

// A short retry keeps the healthy ink; changing colour is itself the alarm being avoided.
const connectionInkClass = computed(() => availabilityVisual.value.inkClass);
const connectionLabel = computed(() => availabilityVisual.value.label.toLowerCase());

const isActive = (option: SandboxSummary): boolean => option.id === sandbox.activeSandboxId.value;

const ROW_TONE: Record<SandboxAttentionItem["tone"], string> = {
    info: `text-link`,
    warning: `text-warning`,
};

// Anchored rather than PrimeVue's Popover, so one overlay alone decides where a panel goes.
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const menu = useHoverMenu(panel);
const open = menu.open;
const pressed = menu.pressed;

// Reads these counts only while the popover is open, since the control is mounted for the whole session; a second
// open within the freshness window paints instantly from the store's last read. A pointer resting on the logo starts
// the read before the dwell is out, so the counts are usually there by the time the panel is.
let releaseBoxes: (() => void) | undefined;
watch(
    () => open.value || menu.hovering.value,
    (wanted) => {
        if (wanted) {
            releaseBoxes ??= watchOtherBoxes();
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
// resolves; those rows are unfinished errands with their own section, not places to switch to.
const switchable = computed(() => connectedSandboxes(sandbox.sandboxes.value));
const unfinished = computed(() => unfinishedSandboxes(sandbox.sandboxes.value));

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
const rowNote = (option: SandboxSummary): readonly NotePart[] => {
    if (isActive(option) && restarting.value !== undefined) {
        return [{ text: restarting.value, ink: RUNNING_MARK_CLASS }];
    }
    const place = placementFor(option);
    const parts: (NotePart | undefined)[] = [
        { text: place.label },
        option.role !== `owner` && place.kind !== `shared` ? { text: t(`shared.shared`).toLocaleLowerCase() } : undefined,
        isActive(option) && !quiet.value ? { text: connectionLabel.value, ink: connectionInkClass.value } : undefined,
        silent(option) ? { text: t(`sandbox.sandboxSwitcher.notAnswering`).toLocaleLowerCase(), ink: `text-warning` } : undefined,
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

const pick = (option: SandboxSummary): void => {
    open.value = false;
    sandbox.select(option.id);
};

// Every row that goes somewhere is a real link, so Ctrl/⌘-click opens a tab instead of hijacking this one; rows
// that aren't places stay buttons, and a plain click alone closes the popover.
const dismiss = (event: MouseEvent): void => {
    if (!browserOwnsClick(event)) {
        open.value = false;
    }
};

// A row that points at a control rather than a page (`/sandbox#sandbox-update-action`, the update's own button) is an
// action: its link alone does nothing while that page is already open, which is where the reader clicked it five times.
// So once the page is there, the control is scrolled to and focused. Ctrl/⌘-click still just opens the tab.
const followRow = async (event: MouseEvent, to: string): Promise<void> => {
    dismiss(event);
    const anchor = to.split(`#`)[1];
    if (anchor === undefined || browserOwnsClick(event)) {
        return;
    }
    await router.push(to);
    await nextTick();
    const target = document.getElementById(anchor);
    target?.scrollIntoView({ block: `center`, behavior: `smooth` });
    target?.querySelector<HTMLElement>(`button:not([disabled])`)?.focus({ preventScroll: true });
};

// Resumes this row's setup rather than offering a blank create form.
const resumeSetup = (option: SandboxSummary) => ({ path: `/setup`, query: { sandbox: option.id } });

// THIS COMPUTER, the desktop app's other face: its own window on a folder of this computer, with This device beside it
// (the app's local shell). Offered only inside the app, whose workspace window this page then is; the app swaps the
// two in one frame, so this list names every place the window can show. An app older than the local shell opens its
// own card for the same link, which is this computer too.
const inDesktopApp = desktopApp() !== undefined;
const toThisComputer = (): void => {
    open.value = false;
    openDesktopLink(`${DESKTOP_LAUNCHER_LINK}?to=files`);
};

// The app's local windows list these same sandboxes in their own switcher and show this account at their rail's foot,
// and can learn either only from this page (desktop.ts `announceDesktopRoster`): told on mount and again whenever a
// row, its mark or the account changes.
const { user } = useAuth();
if (inDesktopApp) {
    watch(
        () =>
            [
                switchable.value.map((option) => ({ id: option.id, name: option.name, place: placementFor(option).kind, shared: option.role !== `owner` })),
                user.value === null ? undefined : { email: user.value.email, name: user.value.name, image: user.value.image },
            ] as const,
        ([rows, account]) => announceDesktopRoster(rows, account),
        { immediate: true },
    );
}

// Alt+1…9 picks the Nth switchable sandbox; a digit past the end does nothing rather than clamping.
const SWITCH_SLOTS = 9;
// Reads the chord from the registry rather than a literal "Alt+N", so a remap or unbind shows correctly.
const slotChord = (at: number): string | undefined => (at < SWITCH_SLOTS ? commandShortcut(`sandbox.switch${at + 1}`) : undefined);

let disposables: readonly Disposable[] = [];

const release = (): void => {
    for (const disposable of disposables) {
        disposable.dispose();
    }
    disposables = [];
};

// One command per box that exists, not per slot: an empty slot's command would be a palette row with nowhere to go.
// Re-registered as the roster changes, so a box added in another window is a chord here without a reload.
const syncSwitchCommands = (options: readonly SandboxSummary[]): void => {
    release();
    disposables = options.slice(0, SWITCH_SLOTS).map((_option, at) =>
        registerCommand({
            owner: `builtin`,
            command: `sandbox.switch${at + 1}`,
            // Getter, so the row names the box this chord lands on even as the roster reorders under it.
            get title(): string {
                const option = switchable.value[at];
                return option === undefined ? t(`sandbox.sandboxSwitcher.switchToSlot`, { slot: at + 1 }) : t(`sandbox.sandboxSwitcher.switchTo`, { name: option.name });
            },
            category: SANDBOX,
            icon: `server`,
            keybinding: `Alt+${at + 1}`,
            handler: (): void => {
                // The Nth switchable sandbox, in popover order; unfinished setups are excluded from it.
                const option = switchable.value[at];
                if (option !== undefined) {
                    pick(option);
                }
            },
        }),
    );
};

// Held rather than left to the component's scope, so the watcher stops in the same breath the commands are released.
let stopSync: WatchStopHandle | undefined;

// ALT+0 IS THIS COMPUTER, the place listed first, beside Alt+1…9 for the sandboxes under it; a local window binds the
// same digits to the same sandboxes (local/localKeys.ts). Only inside the app, the one place this computer is a place.
let thisComputerCommand: Disposable | undefined;

onMounted(() => {
    if (sandbox.sandboxes.value.length === 0) {
        void sandbox.list();
    }
    stopSync = watch(switchable, syncSwitchCommands, { immediate: true });
    if (inDesktopApp) {
        thisComputerCommand = registerCommand({
            owner: `builtin`,
            command: `sandbox.thisComputer`,
            // Getter, so the palette row follows a language switch.
            get title(): string {
                return t(`sandbox.sandboxSwitcher.switchToThisComputer`);
            },
            category: SANDBOX,
            icon: `desktop`,
            keybinding: `Alt+0`,
            handler: toThisComputer,
        });
    }
});

onUnmounted(() => {
    stopSync?.();
    stopSync = undefined;
    release();
    thisComputerCommand?.dispose();
    thisComputerCommand = undefined;
});

// The sandbox awaiting removal confirmation; removal is non-destructive, the daemon keeps running.
const pending = ref<SandboxSummary | undefined>(undefined);
const cleanupSlug = ref<string | undefined>(undefined);

// The container slug on the hosting machine: the hostname's first label, or a sha256(token)-derived fallback.
watch(pending, async (target) => {
    // Owner rows only, and an owner's row is the one that carries the token (a member's says null).
    if (target === undefined || target.role !== `owner` || target.token === null) {
        cleanupSlug.value = undefined;
        return;
    }
    if (target.daemonUrl !== null) {
        cleanupSlug.value = new URL(target.daemonUrl).hostname.split(`.`)[0] ?? ``;
        return;
    }
    cleanupSlug.value = sandboxSubdomain(await sandboxIdFromToken(target.token));
});

// The remove one-liner for the device it runs on (recoverable there for 7 days), in the shell the reader picks.
const cleanupCommand = computed(() => {
    const slug = cleanupSlug.value;
    if (slug === undefined || !oneLinerFits(`remove`, [slug])) {
        return undefined;
    }
    return (os: CommandOs): string => oneLiner(`remove`, [slug], os);
});

// The machine running this sandbox, when it is one of the owner's connected devices: then deleting the container
// out there is a checkbox here, and the cleanup command above is only for a machine nothing can reach.
const cleanupHost = useHostRunning(() => cleanupSlug.value);
const { devices } = useDevices({ poll: false });
const alsoDeleteThere = ref(false);
// Deleting the container out there takes tens of seconds and then drops the account row, so it is the removal's own
// run, per sandbox removed: closing the dialog mid-delete does not stop it, and the dialog opened again on the same
// sandbox holds its button and keeps a refusal the device sent.
const removal = useOperation(() => `gates/remove/${pending.value?.id ?? `none`}`);
const deletingThere = removal.busy;
// The device's own sentence, as the dialog has always said it.
const thereFailed = computed(() => {
    const failure = removal.failure.value;
    return failure === undefined ? undefined : (failure.detail ?? failure.title);
});

const askRemove = (option: SandboxSummary): void => {
    open.value = false;
    // Never carried over from the last dialog: this box destroys files, so it starts unticked every time.
    alsoDeleteThere.value = false;
    pending.value = option;
    if (!removal.busy.value) {
        removal.dismiss();
    }
};

// The hosted sandbox whose rollback is being asked about; the platform does it, so any row's can be, down or not.
const rollingBack = ref<SandboxSummary | undefined>(undefined);
const askRollBack = (option: SandboxSummary): void => {
    open.value = false;
    rollingBack.value = option;
};

// Drops the account row; with none left, the setup is where the reader goes next.
const removeRow = async (target: SandboxSummary): Promise<void> => {
    const dropped = sandbox.remove(target.id);
    // remove() drops the row synchronously before its first await, so the empty check is valid here.
    if (sandbox.sandboxes.value.length === 0) {
        void router.push(`/setup`);
    }
    await dropped;
};

const confirmRemove = async (): Promise<void> => {
    const target = pending.value;
    if (target === undefined || removal.busy.value) {
        return;
    }
    const slug = cleanupSlug.value;
    const hostId = cleanupHost.value;
    if (!alsoDeleteThere.value || hostId === undefined || slug === undefined) {
        pending.value = undefined;
        await removeRow(target);
        return;
    }
    // The device first, and the dialog stays open while it runs: a failure out there leaves the account row in place
    // to retry from, rather than dropping the only handle on a container nobody deleted.
    const device = devices.value.find((candidate) => candidate.hostId === hostId);
    const machine = device === undefined ? hostId : machineKeyOf(devices.value, device);
    const label = device?.label ?? hostId;
    const doing = t(`sandbox.deviceOps.workingRemove`, { name: target.name });
    const what = t(`sandbox.deviceOps.doingOn`, { doing, machine: label });
    const outcome = await removal.run({
        what,
        failed: t(`sandbox.sandboxSwitcher.couldntDeleteThere`, { machine: label }),
        task: async () => {
            // The machine's card and the Devices tile carry it while the reader looks elsewhere.
            const endMark = beginDeviceWork({ machine, sandboxes: [target.id], doing, what });
            try {
                // Deleting the box serving this page kills the daemon relaying the call, so the stream dies instead of
                // answering; that is the removal landing, and only a refusal the device sent still counts as a failure.
                await manageDeviceSandbox(hostId, slug, `remove`, { severing: target.id === sandbox.activeSandboxId.value });
            } finally {
                endMark();
            }
            // Part of the removal, not of the dialog: the row goes once the container has, dialog open or not.
            await removeRow(target);
        },
    });
    if (outcome?.state === `done` && pending.value?.id === target.id) {
        pending.value = undefined;
    }
};
</script>

<template>
    <!-- The rail's top control: a live chip for the active sandbox, click to switch. -->
    <span class="relative flex">
        <!-- No tooltip: resting here opens the panel itself, on the side a tooltip would take, and the facts the
             tooltip carried are the active row's second line. The joined sentence stays the accessible name. -->
        <button
            ref="trigger"
            type="button"
            class="sandbox-switcher flex items-center justify-center overflow-hidden transition-opacity hover:opacity-80"
            :class="[route.path.startsWith('/sandbox') ? 'text-link' : 'text-muted', open && 'opacity-80']"
            :aria-label="t(`sandbox.sandboxSwitcher.switchSandbox`, { switcherLabel })"
            aria-haspopup="dialog"
            :aria-expanded="open"
            v-on="menu.trigger"
        >
            <SandboxLogo :image="sandbox.active.value?.image ?? null" :name="sandbox.active.value?.name" />
        </button>
        <!-- WHERE IT RUNS AND WHETHER IT ANSWERS, one mark on the corner presence has always been read off. The glyph
             is the machine, its ink the connection: quiet whenever the answer is neither "online" nor "wrong", so a
             fact that is always true carries an errand's weight only when there is one. A plate, where the running
             mark is a bare glyph: this one sits over whatever picture the owner uploaded, and a glyph alone on a photo
             is unreadable. The plate is the tile's own ground, so it reads as a notch cut into the logo rather than a
             second badge. No active sandbox is no link to report, so the corner stays empty rather than guessing.
             aria-hidden: both sentences are already in the button's label above. -->
        <span
            v-if="placement"
            class="sandbox-switcher-mark pointer-events-none absolute bottom-0.5 right-0.5 inline-flex h-[1.6em] w-[1.6em] items-center justify-center rounded-full bg-[color:var(--ui-tile-ground)] leading-none"
            :class="connectionInkClass"
            aria-hidden="true"
        >
            <!-- Plate and glyph measure as the attention badge does, so the corners weigh the same; only the ink differs. -->
            <Icon :name="placement.icon" class="text-[0.9em]" />
        </span>
        <!-- One corner badge: a count when the amount is the message, a glyph otherwise; aria-hidden as redundant. -->
        <!-- Inside the tile, on the same corner and at the same size as every badge on the rail below it: this is
             the same object saying the same kind of thing, and hanging it outside made it look like a different one. -->
        <ViewBadgeChip :badge="attentionBadge" class="sandbox-switcher-mark pointer-events-none absolute right-0.5 top-0.5" aria-hidden="true" />
        <!-- Getting started's way to connecting a model: the sandbox's own settings start here. Its hint leads to them. -->
        <TourMark step="models" place="rail" still side="right" class="absolute left-0.5 top-0.5" />
        <!-- The rail's running mark, on a corner of its own: it is an errand in flight, where the two beside it are
     standing facts, and the one thing here that must never be crowded. The sentence rides the control's own label,
     since a tooltip on a mark inside a tooltipped button nests inside it. -->
        <TileMark
            v-if="restarting !== undefined"
            name="spinner"
            spin
            :class="[RUNNING_MARK_CLASS, `sandbox-switcher-mark pointer-events-none absolute bottom-0.5 left-0.5`]"
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

            <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`shared.sandboxes`) }}</div>

            <!-- Two lines a row: the name, and where it runs with whatever else is true of it (rowNote). The logo is the
                 row's height, so a reader finds a box by its picture before reading a word. -->
            <button
                v-for="(option, at) in switchable"
                :key="option.id"
                type="button"
                data-menu-row
                :data-current="isActive(option) || undefined"
                :aria-current="isActive(option) || undefined"
                class="group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors"
                :class="isActive(option) ? 'bg-primary-600/15' : 'hover:bg-content/5'"
                @click="pick(option)"
            >
                <SandboxLogo :size="28" :image="option.image ?? null" :name="option.name" />
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate font-medium" :class="isActive(option) ? 'text-link' : 'text-content'">{{ option.name }}</span>
                    <!-- Where that one runs, the reason to switch to a box being often which machine it is on. On the
                         ACTIVE row the glyph is the tile's mark exactly, the same glyph inked by the connection; on every
                         other row it is the placement alone. While the work replacing it runs, its spinner stands in. -->
                    <span class="flex min-w-0 items-center gap-1 text-2xs text-subtle">
                        <Icon v-if="isActive(option) && restarting !== undefined" name="spinner" spin class="shrink-0" :class="RUNNING_MARK_CLASS" />
                        <!-- The hover card is the glyph's alone: on the whole line it rose under every pointer sweeping
                             down the list, over the row above. -->
                        <Icon
                            v-else
                            :name="placementFor(option).icon"
                            class="shrink-0"
                            :class="isActive(option) ? connectionInkClass : undefined"
                            v-tooltip.top="placementTip(option)"
                            :aria-label="isActive(option) ? `${placementFor(option).detail} · ${connectionLabel}` : placementFor(option).detail"
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
                <!-- Which digit this row is, the only place the chord can be learned, and under it the row's own actions,
                     which take its place on hover. Laid over the chord rather than beside it, so the second line keeps
                     the room the actions only need while the pointer is on the row. -->
                <span class="relative flex min-w-9 shrink-0 items-center justify-end">
                    <kbd
                        v-if="slotChord(at)"
                        class="rounded border border-line px-1 font-mono text-2xs font-normal leading-4 text-subtle transition-opacity group-hover:opacity-0"
                        >{{ slotChord(at) }}</kbd
                    >
                    <span class="absolute inset-y-0 right-0 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                        <!-- The platform's way back for a hosted machine, here as well as on the update card because this
                             list answers while the sandbox itself doesn't. -->
                        <Icon
                            v-if="option.role === 'owner' && option.hosted?.canRollBack === true"
                            name="undo"
                            @click.stop="askRollBack(option)"
                            v-tooltip.top="{ title: t(`sandbox.sandboxSwitcher.rollBack`), note: t(`sandbox.sandboxSwitcher.undoLastUpdate`) }"
                            class="text-xs text-subtle transition-colors hover:text-content"
                        />
                        <Icon
                            name="trash"
                            @click.stop="askRemove(option)"
                            v-tooltip.top="option.role === 'owner' ? t(`ui.action.remove`) : t(`ui.action.leave`)"
                            class="text-xs text-subtle transition-colors hover:text-danger"
                        />
                    </span>
                </span>
            </button>

            <RouterLink
                to="/setup"
                data-menu-row
                class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs text-content transition-colors hover:bg-content/5"
                @click="dismiss"
            >
                <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-dashed border-line text-muted">
                    <Icon name="plus" class="text-sm" />
                </span>
                <span class="min-w-0 flex-1">{{ t(`sandbox.words.addSandbox`) }}</span>
            </RouterLink>

            <!-- Setups that were never finished, as their own section below Add sandbox, since they're errands, not places to go. -->
            <template v-if="unfinished.length > 0">
                <div class="my-1 border-t border-line-subtle"></div>
                <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">
                    {{ t(`shared.unfinishedSetup`) }}
                </div>
                <RouterLink
                    v-for="option in unfinished"
                    :key="option.id"
                    :to="resumeSetup(option)"
                    data-menu-row
                    class="group flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5"
                    @click="dismiss"
                >
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center text-subtle">
                        <Icon name="wrench" class="text-xs" />
                    </span>
                    <span class="min-w-0 flex-1 truncate text-muted">{{ t(`sandbox.words.finishSettingUp`, { name: option.name }) }}</span>
                    <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle transition-opacity group-hover:opacity-0" />
                    <!-- In flow, not overlaid, so hovering never shifts the text; `.prevent` stops the anchor firing too. -->
                    <Icon
                        name="trash"
                        @click.prevent.stop="askRemove(option)"
                        v-tooltip.top="option.role === 'owner' ? t(`ui.action.remove`) : t(`ui.action.leave`)"
                        class="shrink-0 text-xs opacity-0 transition hover:text-danger group-hover:opacity-60"
                    />
                </RouterLink>
            </template>

            <div class="my-1 border-t border-line-subtle"></div>

            <!-- THE SANDBOX IN USE, under the list: what it needs, what is worth knowing, and its settings, kept
                 together because they are about one box. Below the sandboxes rather than above them, so how much one box
                 needs never moves where the others are. -->
            <!-- The badge's detail: one row per pending item, routing to the hub tab that resolves it. -->
            <template v-if="attention.length > 0">
                <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`shared.needs`) }}</div>
                <RouterLink
                    v-for="item in attention"
                    :key="item.message"
                    :to="item.to"
                    data-menu-row
                    class="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5"
                    @click="dismiss"
                >
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center" :class="ROW_TONE[item.tone]">
                        <Icon :name="item.icon" class="text-xs" />
                    </span>
                    <span class="min-w-0 flex-1 text-content">{{ item.message }}</span>
                    <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                </RouterLink>
            </template>

            <!-- Things simply true (a contended port, a newer image): found on arrival, not advertised by the badge. -->
            <template v-if="attentionNotes.length > 0">
                <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">
                    {{ t(`shared.worthKnowing`) }}
                </div>
                <RouterLink
                    v-for="item in attentionNotes"
                    :key="item.message"
                    :to="item.to"
                    data-menu-row
                    class="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5"
                    @click="(event: MouseEvent) => followRow(event, item.to)"
                >
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center text-subtle">
                        <Icon :name="item.icon" class="text-xs" />
                    </span>
                    <span class="min-w-0 flex-1 text-muted">{{ item.message }}</span>
                    <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                </RouterLink>
            </template>
            <div v-if="attention.length > 0 || attentionNotes.length > 0" class="my-1 border-t border-line-subtle"></div>

            <!-- The sandbox management hub has no rail tile; this chip is its home, and every attention row lands here too. -->
            <RouterLink
                :to="hubPath"
                data-menu-row
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5"
                @click="dismiss"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center">
                    <Icon name="cog" class="text-base text-muted" />
                </span>
                {{ t(`sandbox.sandboxSwitcher.sandboxSettings`) }}
            </RouterLink>
        </div>
    </AnchoredOverlay>

    <ConfirmDialog
        :open="pending !== undefined"
        :header="pending?.role === 'owner' ? t(`sandbox.sandboxSwitcher.removeAccount2`) : t(`sandbox.sandboxSwitcher.leaveSandbox`)"
        :confirm-label="pending?.role === 'owner' ? t(`ui.action.remove`) : t(`ui.action.leave`)"
        confirm-icon="trash"
        :loading="deletingThere"
        @cancel="pending = undefined"
        @confirm="confirmRemove"
    >
        <p v-if="pending" class="text-sm text-content">
            {{
                pending.role === "owner"
                    ? pending.hosted !== null
                        ? t(`sandbox.sandboxSwitcher.removeHostedMachineDestroyed`, { name: pending.name })
                        : t(`sandbox.sandboxSwitcher.removeAccountEveryoneLoses`, { name: pending.name })
                    : t(`sandbox.sandboxSwitcher.leaveLoseAccessSandbox`, { name: pending.name })
            }}
        </p>
        <!-- What the reader set up lives in the sandbox, not the account, so it leaves with it (switcherRows.ts). -->
        <template v-if="pending && removalTakes(pending.role).length > 0">
            <p class="mt-2 text-sm text-content">{{ t(`sandbox.sandboxSwitcher.leavesWithIt`) }}</p>
            <ul class="mt-1 list-disc pl-5 text-sm text-muted">
                <li v-for="item in removalTakes(pending.role)" :key="item">{{ item }}</li>
            </ul>
        </template>
        <!-- The promise the deletion actually makes, on the owner's own rows only: a member leaving takes nothing
             with them, so there is nothing to bring back. The two lanes differ in what comes back — a hosted
             machine keeps its disk, an own-machine sandbox comes back as a name with a new address. -->
        <p v-if="pending?.role === 'owner'" class="mt-2 text-sm text-muted">
            {{
                pending.hosted !== null
                    ? t(`sandbox.sandboxSwitcher.restorableHostedDays`, { count: RECOVERY_DAYS }, RECOVERY_DAYS)
                    : t(`sandbox.sandboxSwitcher.restorableOwnDays`, { count: RECOVERY_DAYS }, RECOVERY_DAYS)
            }}
            {{ t(`sandbox.sandboxSwitcher.restoreWhere`) }}
        </p>
        <!-- The hosted lane is the only removal that destroys a machine; no cleanup command, since nothing else exists. -->
        <template v-if="pending?.role === 'owner' && pending.hosted === null && cleanupCommand !== undefined">
            <!-- The machine is one of the owner's connected devices, so this is a tick box rather than a command: the same removal the Devices tab's own button runs. -->
            <template v-if="cleanupHost !== undefined">
                <label class="mt-3 flex items-start gap-2 text-sm text-muted">
                    <!-- Same plain box the extension cards use; the kit has no checkbox component, on purpose. -->
                    <input v-model="alsoDeleteThere" type="checkbox" :disabled="deletingThere" class="mt-0.5" />
                    <span>
                        {{ t(`sandbox.sandboxSwitcher.alsoDelete`) }} <span class="font-medium text-content">{{ cleanupHost }}</span>
                        {{ t(`sandbox.sandboxSwitcher.containerFilesHistoryGone`) }}
                    </span>
                </label>
                <Notice v-if="thereFailed" tone="danger" class="mt-2 text-2xs">{{ thereFailed }}</Notice>
            </template>
            <template v-else>
                <p class="mt-3 text-sm text-muted">{{ t(`sandbox.sandboxSwitcher.toAlsoRemoveMachine`) }}</p>
                <RunCommand class="mt-2" :command="cleanupCommand" :label="t(`sandbox.sandboxSwitcher.cleanupCommand`)" />
            </template>
        </template>
    </ConfirmDialog>

    <HostedRollbackDialog :sandbox="rollingBack" @close="rollingBack = undefined" />
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
