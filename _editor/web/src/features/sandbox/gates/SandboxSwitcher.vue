<script setup lang="ts">
import type { Disposable } from "@intentic/extension-api";
import { SANDBOX_RECOVERY_DAYS as RECOVERY_DAYS, type SandboxSummary } from "@intentic/api-contract";
import {
    AnchoredOverlay,
    browserOwnsClick,
    Button,
    Code,
    commandLang,
    ConfirmDialog,
    Notice,
    osOptions,
    SegmentedControl,
    useOsPreference,
} from "@intentic/ui";
import { sandboxSubdomain } from "@intentic/sandbox-contract";
import { computed, onMounted, onUnmounted, ref, watch, type WatchStopHandle } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { SANDBOX } from "../../../shell/commands/categories";
import { commandShortcut, registerCommand } from "../../../shell/commands/useCommands";
import ViewBadgeChip from "../../../core-views/ViewBadgeChip.vue";
import { RUNNING_MARK_CLASS } from "../../../core-views/viewBadge";
import TileMark from "../../../shell/rail/TileMark.vue";
import { restartRunning } from "../live/sandboxRestart";
import { sandboxHubPath } from "../sandboxNav";
import { useRole } from "../secrets/useRole";
import { type SandboxAttentionItem, useSandboxAttention } from "../overview/sandboxAttention";
import { sandboxIdFromToken } from "../session/sandboxIdFromToken";
import { sandboxAvailabilityVisual } from "../overview/availability";
import { placementOf, type SandboxPlacement } from "../overview/placement";
import { useSandboxPlacement } from "../overview/useSandboxPlacement";
import { attentionByBox, subscribe as watchOtherBoxes } from "../live/fleetAcross";
import { connectedSandboxes, unfinishedSandboxes } from "../live/roster";
import { useSandboxAvailability } from "../overview/useSandboxAvailability";
import { useSandbox } from "../client/useSandbox";
import { daysLeft } from "../client/trashWindow";
import { useSandboxTrash } from "../client/useSandboxTrash";
import { useWorkspaceTree } from "../../workspace/explorer/useWorkspaceTree";
import { manageDeviceSandbox, useHostRunning } from "../devices/useDevices";
import { bashCommand, psCommand } from "../../../app/environments/scriptCommand";
import { useT } from "@intentic/ui/i18n";

// Rail control to switch between the user's sandboxes or add another; selecting one re-points every sandbox-backed
// view and the liveness probe at the chosen daemon. Settings, access and everything else about the active sandbox
// live on the tabbed /sandbox hub, opened from here.

const t = useT();

const sandbox = useSandbox();
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const availabilityVisual = computed(() => sandboxAvailabilityVisual(availability.value));
const router = useRouter();
const route = useRoute();
// Everything the sandbox needs from its owner: a badge from `needs`, plus rows for `needs` and `notes`.
const { needs: attention, notes: attentionNotes, badge: attentionBadge } = useSandboxAttention();
const { cmdOs } = useOsPreference();
// WORK THAT ENDS BY REPLACING THIS SANDBOX, while it is still running. Not on the attention badge, which counts what
// the sandbox needs from its owner: this needs nothing, interrupts nothing yet, and is over in minutes — a standing
// badge for it would teach the reader to stop reading the badge. A mark of its own, on its own corner, saying only
// that something is moving. What it will do is said when it does it, by the lane.
const restarting = computed(() => restartRunning(sandbox.activeSandboxId.value));

// A guest's door to the hub names the one section it may open; every other tier opens on the hub's own default.
const { isGuest } = useRole();
const hubPath = computed(() => sandboxHubPath(isGuest.value));

// WHERE THIS SANDBOX RUNS: Intentic's cloud, a machine of the owner's, or somebody else's. A standing fact, never an
// errand, so it takes the tile's one free corner as a quiet mark rather than a plated badge — and its sentence rides
// the control's own label, because a glyph alone cannot be the only place a reader can learn this.
const placement = useSandboxPlacement();

// One label for the whole control, badge included, since a tooltip on the badge would nest inside this one.
const switcherLabel = computed(() => {
    const name = sandbox.active.value?.name ?? `Sandboxes`;
    const tooltip = attentionBadge.value?.tooltip;
    const status =
        availability.value === `live` || availability.value === `stale` ? undefined : `Sandbox ${availabilityVisual.value.label.toLowerCase()}`;
    return [name, placement.value?.detail, status, restarting.value, tooltip].filter((part) => part !== undefined).join(` · `);
});

// A short retry keeps the healthy dot; changing colour is itself the alarm being avoided.
const connectionDotClass = computed(() => availabilityVisual.value.dotClass);
const connectionLabel = computed(() => availabilityVisual.value.label.toLowerCase());

const ROW_TONE: Record<SandboxAttentionItem["tone"], string> = {
    info: `text-link`,
    warning: `text-warning`,
};

// Anchored rather than PrimeVue's Popover, so one overlay alone decides where a panel goes.
const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);

// Reads these counts only while the popover is open, since the control is mounted for the whole session; a second
// open within the freshness window paints instantly from the store's last read.
let releaseBoxes: (() => void) | undefined;
watch(open, (showing) => {
    if (showing) {
        releaseBoxes ??= watchOtherBoxes();
        return;
    }
    releaseBoxes?.();
    releaseBoxes = undefined;
});
onUnmounted(() => {
    releaseBoxes?.();
    releaseBoxes = undefined;
});

// A sandbox that never reported in has no daemon, so switching to it can only paint a connecting gate that never
// resolves; those rows are unfinished errands with their own section, not places to switch to.
const switchable = computed(() => connectedSandboxes(sandbox.sandboxes.value));
const unfinished = computed(() => unfinishedSandboxes(sandbox.sandboxes.value));

// How much is waiting in every other sandbox; absent for the active row since its badge is already on the rail.
// An unanswered box gets undefined, drawn as a dash, never a zero.
const attentionFor = (option: SandboxSummary): number | undefined =>
    option.id === sandbox.activeSandboxId.value ? undefined : attentionByBox.value.get(option.id);

// Whether this row has ever answered, separating "0" from "-"; a single number can't carry both.
const answered = (option: SandboxSummary): boolean => attentionFor(option) !== undefined;

// The same fact per row, and the ACTIVE row borrows the refined one above rather than deriving its own: the tile and
// the row it opens onto are the same sandbox, and a glyph that changed between them would read as two answers.
const placementFor = (option: SandboxSummary): SandboxPlacement =>
    option.id === sandbox.activeSandboxId.value && placement.value !== undefined ? placement.value : placementOf(option);

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

// Resumes this row's setup rather than offering a blank create form.
const resumeSetup = (option: SandboxSummary) => ({ path: `/setup`, query: { sandbox: option.id } });

// Sandboxes deleted from this account that the platform is still holding. Below the live rows and the unfinished
// ones, since these are not places to go either — but unlike an unfinished setup, this section disappears on its
// own, and the day count is the only reason it is urgent.
const trash = useSandboxTrash();

const restoreDeleted = async (trashId: string): Promise<void> => {
    const restored = await trash.restore(trashId);
    if (restored === undefined) {
        return;
    }
    open.value = false;
    sandbox.select(restored.id);
};

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
                return option === undefined ? `Switch to Slot ${at + 1}` : `Switch to ${option.name}`;
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

onMounted(() => {
    if (sandbox.sandboxes.value.length === 0) {
        void sandbox.list();
    }
    stopSync = watch(switchable, syncSwitchCommands, { immediate: true });
});

onUnmounted(() => {
    stopSync?.();
    stopSync = undefined;
    release();
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

// Follows the shared OS preference, since the host may be Windows where the POSIX one-liner can't run.
const cleanupCommand = computed(() => {
    const slug = cleanupSlug.value;
    if (slug === undefined) {
        return undefined;
    }
    return cmdOs.value === `windows` ? psCommand(`cleanupPs1`, ``, `-Slug ${slug} -Yes`) : bashCommand(`cleanup`, ``, `${slug} -y`);
});

// The machine running this sandbox, when it is one of the owner's connected devices: then deleting the container
// out there is a checkbox here, and the cleanup command above is only for a machine nothing can reach.
const cleanupHost = useHostRunning(() => cleanupSlug.value);
const alsoDeleteThere = ref(false);
const deletingThere = ref(false);
const thereFailed = ref<string | undefined>(undefined);

const askRemove = (option: SandboxSummary): void => {
    open.value = false;
    // Never carried over from the last dialog: this box destroys files, so it starts unticked every time.
    alsoDeleteThere.value = false;
    thereFailed.value = undefined;
    pending.value = option;
};

const confirmRemove = async (): Promise<void> => {
    const target = pending.value;
    if (target === undefined) {
        return;
    }
    const slug = cleanupSlug.value;
    const hostId = cleanupHost.value;
    // The device first, and the dialog stays open while it runs: a failure out there leaves the account row in place
    // to retry from, rather than dropping the only handle on a container nobody deleted.
    if (alsoDeleteThere.value && hostId !== undefined && slug !== undefined) {
        deletingThere.value = true;
        thereFailed.value = undefined;
        try {
            // Deleting the box serving this page kills the daemon relaying the call, so the stream dies instead of
            // answering; that is the removal landing, and only a refusal the device sent still counts as a failure.
            await manageDeviceSandbox(hostId, slug, `remove`, { severing: target.id === sandbox.activeSandboxId.value });
        } catch (error) {
            thereFailed.value = error instanceof Error ? error.message : String(error);
            return;
        } finally {
            deletingThere.value = false;
        }
    }
    pending.value = undefined;
    const removal = sandbox.remove(target.id);
    // remove() drops the row synchronously before its first await, so the empty check is valid here.
    if (sandbox.sandboxes.value.length === 0) {
        void router.push(`/setup`);
    }
    await removal;
};
</script>

<template>
    <!-- The rail's top control: a live chip for the active sandbox, click to switch. -->
    <span class="relative flex">
        <button
            ref="trigger"
            type="button"
            class="sandbox-switcher flex items-center justify-center overflow-hidden rounded-lg border border-line transition-colors hover:border-line-strong hover:bg-overlay hover:text-content"
            :class="route.path.startsWith('/sandbox') ? 'bg-primary-600/15 text-link' : 'bg-card text-muted'"
            :aria-label="t(`sandbox.sandboxSwitcher.switchSandbox`, { switcherLabel })"
            v-tooltip.right="switcherLabel"
            :aria-expanded="open"
            @click="open = !open"
        >
            <img v-if="sandbox.active.value?.image" :src="sandbox.active.value.image" alt="" class="h-full w-full object-cover" />
            <span v-else-if="sandbox.active.value?.name" class="text-base font-semibold uppercase text-content">{{
                sandbox.active.value.name.charAt(0)
            }}</span>
            <Icon name="server" v-else class="text-lg" />
        </button>
        <!-- WHERE IT RUNS, in the tile's one remaining corner. A plate, where the running mark below is a bare glyph:
             this one sits over whatever picture the owner uploaded, and a glyph alone on a photo is unreadable. The
             plate is the tile's own ground, so it reads as a notch cut into the logo rather than a second badge. Ink
             is `text-subtle` on purpose — a fact that is always true must never carry the weight of an errand.
             aria-hidden: the sentence is already in the button's label above, and a second voice would say it twice. -->
        <span
            v-if="placement"
            class="sandbox-switcher-mark pointer-events-none absolute left-0.5 top-0.5 inline-flex h-[1.6em] w-[1.6em] items-center justify-center rounded-full bg-[color:var(--ui-tile-ground)] leading-none text-subtle"
            aria-hidden="true"
        >
            <!-- The badge's own plate and glyph measures across the tile, so the two top corners weigh the same; only
                 the ink differs, which is the whole difference between an errand and a standing fact. -->
            <Icon :name="placement.icon" class="text-[0.9em]" />
        </span>
        <!-- One corner badge: a count when the amount is the message, a glyph otherwise; aria-hidden as redundant. -->
        <!-- Inside the tile, on the same corner and at the same size as every badge on the rail below it: this is
             the same object saying the same kind of thing, and hanging it outside made it look like a different one. -->
        <ViewBadgeChip :badge="attentionBadge" class="sandbox-switcher-mark pointer-events-none absolute right-0.5 top-0.5" aria-hidden="true" />
        <!-- The rail's running mark, in the one corner this tile has spare: its bottom right is the connection dot, which is
     a different kind of thing and the one thing here that must never be crowded. The sentence rides the control's own
     label, since a tooltip on a mark inside a tooltipped button nests inside it. -->
        <TileMark
            v-if="restarting !== undefined"
            name="spinner"
            spin
            :class="[RUNNING_MARK_CLASS, `sandbox-switcher-mark pointer-events-none absolute bottom-0.5 left-0.5`]"
        />
        <span
            class="pointer-events-none absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[color:var(--ui-tile-ground)]"
            :class="connectionDotClass"
        ></span>
    </span>

    <!-- Zeroed padding: PrimeVue's popover padding reads as a frame around rows with their own inset. -->
    <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="right" cross="start">
        <div class="flex w-60 flex-col gap-0.5 p-1">
            <!-- The badge's detail: one row per pending item, routing to the hub tab that resolves it. -->
            <template v-if="attention.length > 0">
                <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.sandboxSwitcher.needs`) }}</div>
                <RouterLink
                    v-for="item in attention"
                    :key="item.message"
                    :to="item.to"
                    class="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5"
                    @click="dismiss"
                >
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center" :class="ROW_TONE[item.tone]">
                        <Icon :name="item.icon" class="text-xs" />
                    </span>
                    <span class="min-w-0 flex-1 text-content">{{ item.message }}</span>
                    <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                </RouterLink>
                <div class="my-1 border-t border-line"></div>
            </template>

            <!-- Things simply true (a contended port, a newer image): found on arrival, not advertised by the badge. -->
            <template v-if="attentionNotes.length > 0">
                <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">
                    {{ t(`sandbox.sandboxSwitcher.worthKnowing`) }}
                </div>
                <RouterLink
                    v-for="item in attentionNotes"
                    :key="item.message"
                    :to="item.to"
                    class="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5"
                    @click="dismiss"
                >
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center text-subtle">
                        <Icon :name="item.icon" class="text-xs" />
                    </span>
                    <span class="min-w-0 flex-1 text-muted">{{ item.message }}</span>
                    <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                </RouterLink>
                <div class="my-1 border-t border-line"></div>
            </template>

            <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.sandboxSwitcher.sandboxes`) }}</div>

            <button
                v-for="(option, at) in switchable"
                :key="option.id"
                type="button"
                class="group flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors"
                :class="option.id === sandbox.activeSandboxId.value ? 'bg-primary-600/15' : 'hover:bg-content/5'"
                @click="pick(option)"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-card text-muted">
                    <img v-if="option.image" :src="option.image" alt="" class="h-full w-full object-cover" />
                    <Icon name="server" v-else class="text-xs" />
                </span>
                <span class="min-w-0 flex-1 truncate" :class="option.id === sandbox.activeSandboxId.value ? 'text-link' : 'text-content'">{{
                    option.name
                }}</span>
                <!-- Where that one runs, beside its name: the reason to switch to a box is often which machine it is
                     on. Not on a row that already carries the "Shared" pill, where the two would say one thing twice
                     and the second of them costs the name the width it truncates at. -->
                <Icon
                    v-if="placementFor(option).kind !== 'shared'"
                    :name="placementFor(option).icon"
                    class="shrink-0 text-2xs text-subtle"
                    v-tooltip.top="placementFor(option).detail"
                    :aria-label="placementFor(option).detail"
                />
                <span
                    v-if="option.id === sandbox.activeSandboxId.value"
                    class="shrink-0 h-1.5 w-1.5 rounded-full"
                    :class="connectionDotClass"
                    v-tooltip.top="connectionLabel"
                ></span>
                <!-- What's waiting in that sandbox; nothing waiting draws nothing, an unanswered box draws a dash. -->
                <span
                    v-else-if="answered(option) && attentionFor(option)! > 0"
                    class="ui-status-pill shrink-0 bg-warning/15 text-2xs font-semibold leading-4 text-warning"
                    v-tooltip.top="t(`sandbox.sandboxSwitcher.waitingIn`, { option: attentionFor(option), name: option.name })"
                    >{{ attentionFor(option) }}</span
                >
                <span
                    v-else-if="!answered(option)"
                    class="shrink-0 px-1 text-2xs leading-4 text-subtle"
                    v-tooltip.top="t(`sandbox.sandboxSwitcher.isntAnsweringWhatsWaiting`, { name: option.name })"
                    :aria-label="t(`sandbox.sandboxSwitcher.notAnswering`)"
                    >&ndash;</span
                >
                <span v-if="option.role !== 'owner'" class="ui-status-pill shrink-0 bg-content/10 text-2xs font-medium text-subtle">{{
                    t(`sandbox.sandboxSwitcher.shared`)
                }}</span>
                <!-- Which digit this row is, the only place the chord can be learned; fades under the trash icon's hover. -->
                <kbd
                    v-if="slotChord(at)"
                    class="shrink-0 rounded border border-line px-1 font-mono text-2xs font-normal leading-4 text-subtle transition-opacity group-hover:opacity-0"
                    >{{ slotChord(at) }}</kbd
                >
                <Icon
                    name="trash"
                    @click.stop="askRemove(option)"
                    v-tooltip.top="option.role === 'owner' ? t(`sandbox.sandboxSwitcher.removeAccount`) : t(`sandbox.sandboxSwitcher.leave`)"
                    class="shrink-0 text-xs opacity-0 transition-opacity hover:text-danger group-hover:opacity-60"
                />
            </button>

            <RouterLink
                to="/setup"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5"
                @click="dismiss"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center">
                    <Icon name="plus" class="text-base text-muted" />
                </span>
                {{ t(`sandbox.sandboxSwitcher.addSandbox`) }}
            </RouterLink>

            <!-- Setups that were never finished, as their own section below Add sandbox, since they're errands, not places to go. -->
            <template v-if="unfinished.length > 0">
                <div class="my-1 border-t border-line"></div>
                <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">
                    {{ t(`sandbox.sandboxSwitcher.unfinishedSetup`) }}
                </div>
                <RouterLink
                    v-for="option in unfinished"
                    :key="option.id"
                    :to="resumeSetup(option)"
                    class="group flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5"
                    @click="dismiss"
                >
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center text-subtle">
                        <Icon name="wrench" class="text-xs" />
                    </span>
                    <span class="min-w-0 flex-1 truncate text-muted">{{ t(`sandbox.sandboxSwitcher.finishSettingUp`, { name: option.name }) }}</span>
                    <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle transition-opacity group-hover:opacity-0" />
                    <!-- In flow, not overlaid, so hovering never shifts the text; `.prevent` stops the anchor firing too. -->
                    <Icon
                        name="trash"
                        @click.prevent.stop="askRemove(option)"
                        v-tooltip.top="option.role === 'owner' ? t(`sandbox.sandboxSwitcher.removeAccount`) : t(`sandbox.sandboxSwitcher.leave`)"
                        class="shrink-0 text-xs opacity-0 transition-opacity hover:text-danger group-hover:opacity-60"
                    />
                </RouterLink>
            </template>

            <!-- Deleted sandboxes the platform is still holding. Drawn only while something is recoverable, so the
                 section is its own countdown: it is here, then one day it is not. -->
            <template v-if="trash.recoverable.value.length > 0">
                <div class="my-1 border-t border-line"></div>
                <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">
                    {{ t(`sandbox.sandboxSwitcher.recentlyDeleted`) }}
                </div>
                <div
                    v-for="row in trash.recoverable.value"
                    :key="row.id"
                    class="group flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5"
                >
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center text-subtle">
                        <Icon name="trash" class="text-xs" />
                    </span>
                    <span class="min-w-0 flex-1 truncate text-muted">{{ row.name }}</span>
                    <span class="shrink-0 text-2xs text-subtle">{{
                        t(`sandbox.sandboxSwitcher.daysLeftToRestore`, { count: daysLeft(row.purgeAfter) }, daysLeft(row.purgeAfter))
                    }}</span>
                    <Button
                        size="small"
                        severity="secondary"
                        text
                        :label="t(`sandbox.sandboxSwitcher.restore`)"
                        :loading="trash.restoring.value === row.id"
                        :disabled="trash.restoring.value !== undefined"
                        @click="void restoreDeleted(row.id)"
                    />
                </div>
                <Notice v-if="trash.failed.value" tone="danger" class="mt-1 text-2xs">{{ trash.failed.value }}</Notice>
            </template>

            <div class="my-1 border-t border-line"></div>

            <!-- The sandbox management hub has no rail tile; this chip is its home, and every attention row lands here too. -->
            <RouterLink
                :to="hubPath"
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
        :confirm-label="pending?.role === 'owner' ? t(`ui.action.remove`) : t(`sandbox.sandboxSwitcher.leave`)"
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
        <!-- The promise the deletion actually makes, on the owner's own rows only: a member leaving takes nothing
             with them, so there is nothing to bring back. The two lanes differ in what comes back — a hosted
             machine keeps its disk, an own-machine sandbox comes back as a name with a new address. -->
        <p v-if="pending?.role === 'owner'" class="mt-2 text-sm text-muted">
            {{
                pending.hosted !== null
                    ? t(`sandbox.sandboxSwitcher.restorableHostedDays`, { count: RECOVERY_DAYS }, RECOVERY_DAYS)
                    : t(`sandbox.sandboxSwitcher.restorableOwnDays`, { count: RECOVERY_DAYS }, RECOVERY_DAYS)
            }}
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
                <SegmentedControl class="mt-2" v-model="cmdOs" :options="osOptions()" />
                <Code
                    class="mt-1.5"
                    :code="cleanupCommand"
                    :lang="commandLang(cmdOs)"
                    :label="t(`sandbox.sandboxSwitcher.cleanupCommand`)"
                    :wrap="true"
                />
            </template>
        </template>
    </ConfirmDialog>
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
