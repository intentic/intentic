import type { IconName } from "@intentic/ui";
import type { ViewBadge } from "@intentic/extension-api";
import { useNow } from "@intentic/ui/async";
import { computed, type ComputedRef } from "vue";
import { roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { providerAccounts, translatorAccounts } from "../../../models/providers/providerAccounts";
import { acpProviders, endpointProviders } from "../../../models/providers/providerCatalog";
import { accessKnown, providerReady } from "../../../models/providers/access";
import { useMissingSecretCount } from "../../../models/capabilities/useSecrets";
import { useRole } from "../../../client/sandbox/useRole";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useSyncHealth } from "../../../models/sandbox/devices/useDevices";
import { useEnvironment } from "../../../models/sandbox/environment/useEnvironment";
import { buildUnderWay, hostedBuildPhase } from "../environment/rebuild/hostedBuildPhase";
import { REBUILD_ANCHOR } from "../environment/rebuildAnchor";
import { useHostedBuild } from "../secrets/useHostedBuild";
import { useSandboxVersion } from "../../../models/sandbox/useSandboxVersion";
import { UPDATE_ACTION_ANCHOR } from "../../../models/sandbox/updateAnchor";
import { useSandboxBackup } from "./backup/useSandboxBackup";
import { PUBLISH_ANCHOR } from "../access/publishAnchor";
import { useUnbackedWork } from "./backup/useUnbackedWork";
import { t } from "@intentic/ui/i18n";
import { modelsHref } from "../../../lib/routes/modelsPath";
import { here, page } from "../../../lib/routes/links";
import { useExtensions } from "../../../models/extensions/useExtensions";
import { useAccessRequests } from "../../../client/sandbox/access/accessRequest";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";
import type { DiskPressure } from "@intentic/sandbox-contract/schemas/metrics";
import { formatBytes } from "@intentic/ui/format";
import { STORAGE_ANCHOR } from "./storage/storageAnchor";
import { storageCategoryLabel } from "./storage/storageCategories";
import { diskPressing, freePercent } from "./storage/diskPressureView";
import { useDiskPressure } from "./storage/useDiskPressure";

// What the active sandbox needs from its owner, versus what's merely true of it: one list, split by `kind`, read
// by the getting-started ring on the desktop rail (gettingStarted/SandboxErrands.vue) and the mobile menu so they agree.
// Lives as a badge on that tile, not a dismissible bar, since
// none of these is urgent and each is a standing condition rather than an event.

// Whether anything can run a turn: a stored provider account, a translator subscription, an ACP agent, or a ready
// endpoint — the free trial is one, and `providerReady` is what spends its allowance down to not-ready.
// Waits on `accessKnown`, not the account half alone: that half lands first, and on its own this told a reader
// with a working trial that the agent could not run at all, which is the same beat access.ts already names for
// the chat's own gate.
const noAccountConnected = computed(
    () =>
        accessKnown.value &&
        acpProviders.value.length === 0 &&
        !endpointProviders.value.some((endpoint) => providerReady(endpoint.id)) &&
        !Object.values(providerAccounts.value).some((accounts) => accounts.length > 0) &&
        !Object.values(translatorAccounts.value).some((subscriptions) => subscriptions.length > 0),
);

export interface SandboxAttentionItem {
    // Glyph for this item's popover row, and the chip's badge when it's the top one.
    readonly icon: IconName;
    // `warning` is a debt that will bite; `info` is optional. Never `danger`: unfinished, not broken.
    readonly tone: "warning" | "info";
    // Whether this may badge the chip: a `needs` can, a `note` can't (a standing condition badging forever teaches
    // the reader to ignore it).
    readonly kind: "needs" | "note";
    // Stands alone in a popover row, and reads as a clause when the chip's tooltip joins several. No trailing period.
    readonly message: string;
    // Tab that resolves it, in the reader's own frame and sandbox; several items can share one.
    readonly to: string;
    // Set only when the amount is the message (e.g. how many secrets are missing).
    readonly count?: number;
    // Lets a `note` badge the chip when no `needs` does; only a staged update qualifies today, since acting on it is
    // one click.
    readonly badges?: boolean;
    // A press a surface may offer beside the row itself, where it is safe to take from there: the rebuild, only where
    // useRebuildOffer says so, and the disk's clean of settled checkouts' build output. The row's link stays either way.
    readonly action?: "rebuild" | "clean";
}

// Both update notes point at the update card's button rather than at the page (updateAnchor.ts).
const updateAction = (): string => here(page.sandboxSettings(undefined, { hash: UPDATE_ACTION_ANCHOR }));
// The rebuild's rows point at the Environment card's rebuild step, which scrolls to and focuses it (rebuildAnchor.ts).
const rebuildStep = (): string => here(page.sandboxSettings(`environment`, { hash: REBUILD_ANCHOR }));

// An available update stays a quiet note (still downloading in the background); once staged it may badge the
// chip (`badges`), since applying it is now one click and a half-minute restart.
const updateItems = (available: boolean, staged: boolean): SandboxAttentionItem[] => {
    if (!available) {
        return [];
    }
    if (staged) {
        return [
            {
                icon: `arrow-circle-up`,
                tone: `info`,
                message: t(`sandbox.sandboxAttention.sandboxUpdateReadyTo`),
                to: updateAction(),
                kind: `note`,
                badges: true,
            },
        ];
    }
    return [
        { icon: `arrow-circle-up`, tone: `info`, message: t(`sandbox.sandboxAttention.newSandboxVersionAvailable`), to: updateAction(), kind: `note` },
    ];
};

// People who asked the owner for more access, from where they were refused (Access ▸ People lists them): the owner's
// alone to answer, so it may badge the chip, worded as the count of who is waiting.
const accessRequestItems = (count: number): SandboxAttentionItem[] =>
    count === 0
        ? []
        : [{ icon: `users`, tone: `info`, message: t(`sandbox.sandboxAttention.peopleAskForAccess`, { count }, count), to: here(page.sandboxSettings(`access`)), kind: `needs`, count }];

// A hosted sandbox's build, which the platform runs for minutes: "Rebuild needed" over a build already under way
// asked an hour of its reader for something they had already done, or that nobody needed to do. Ticks only while a
// finished build of the waiting recipe is in its swap's window, the one phase that ends on the clock
// (hostedBuildPhase.ts): past it, the row asks for the rebuild again rather than calling it under way.
const useRebuildUnderWay = (pending: ReturnType<typeof useEnvironment>[`pending`]): ComputedRef<boolean> => {
    const { active } = useSandbox();
    const { build, applied } = useHostedBuild(() => (active.value?.hosted ? active.value.id : undefined));
    const now = useNow(() => build.value?.state === `built` && build.value.hash === pending.value?.hash, 60_000);
    return computed(() => {
        const recipe = pending.value;
        return recipe !== undefined && buildUnderWay(hostedBuildPhase(build.value, applied.value, recipe.hash, now.value));
    });
};

// GPU work the daemon paused after the computer it runs on reported a GPU reset (settings `gpu.pausedFor`), first since
// a GPU hang can freeze that computer: only the owner's resume on the Overview's GPU row (SandboxGpuRow.vue) lifts it.
const gpuPausedItems = (paused: boolean): SandboxAttentionItem[] =>
    paused ? [{ icon: `exclamation-triangle`, tone: `warning`, message: t(`sandbox.sandboxAttention.gpuPaused`), to: here(page.sandboxSettings()), kind: `needs` }] : [];
// The history volume under 10% free (system/resources/storage/disk-pressure.ts): how much is left, what the sandbox
// already removed, and what holds the most, with the press that removes the rest of the settled build output. Worst
// first in the list: a full disk fails every turn's writes, the land's rebase included.
const diskItems = (pressure: DiskPressure | undefined): SandboxAttentionItem[] => {
    if (!diskPressing(pressure)) {
        return [];
    }
    const free = t(`sandbox.sandboxAttention.diskLow`, { free: formatBytes(pressure.freeBytes), percent: freePercent(pressure) });
    const reaped =
        pressure.reaped === undefined || pressure.reaped.bytes === 0
            ? ``
            : `; ${t(`sandbox.sandboxAttention.diskReaped`, { bytes: formatBytes(pressure.reaped.bytes), count: pressure.reaped.checkouts }, pressure.reaped.checkouts)}`;
    const biggest = pressure.using[0];
    const using =
        biggest === undefined ? `` : `; ${t(`sandbox.sandboxAttention.diskUsing`, { category: storageCategoryLabel(biggest.id), bytes: formatBytes(biggest.bytes) })}`;
    return [{ icon: `database`, tone: `warning`, message: `${free}${reaped}${using}`, to: here(page.sandboxSettings(undefined, { hash: STORAGE_ANCHOR })), kind: `needs`, action: `clean` }];
};

export function useSandboxAttention() {
    const { isGuest, role } = useRole();
    const { pending, proposal } = useEnvironment();
    // Extensions an agent wrote into this workspace, which run nothing until a maintainer approves the powers they ask
    // for. They were a row in the Needs you inbox until 2026-10-12; the Extensions tab is where the yes is given.
    const { pending: waitingExtensions } = useExtensions();
    const rebuilding = useRebuildUnderWay(pending);
    const { updateAvailable, updateStaged } = useSandboxVersion();
    const { missingRequiredCount } = useMissingSecretCount();
    const { stoppedOn, heldPorts } = useSyncHealth();
    // The two ways this sandbox's work can exist in exactly one place: no copy on a computer of the owner's, and no
    // repository it could be pushed to. Both are standing conditions with a tab that resolves them, which is what
    // makes them rows here rather than events.
    const { unbacked: noCopyOffBox } = useSandboxBackup();
    const { unbacked: noRepoRemote } = useUnbackedWork();
    // People waiting on the owner's answer to what they asked for, from where they were refused: the owner's alone to
    // grant, so read and counted only on the owner's own page.
    const { requests: accessRequests } = useAccessRequests(computed(() => role.value === `owner`));
    const { settings } = useSandboxSettings();
    const { pressure: diskPressure } = useDiskPressure();

    // Declared worst-first: the head sets the badge, the rest fills the popover. A row is its condition and its
    // item side by side rather than a spread ternary, so adding one is a line and reading the order is a column.
    // No-account is about the sandbox as a whole, not one conversation's missing provider (composer's connect gate).
    const items = computed<readonly SandboxAttentionItem[]>(() => {
        // Nothing here is a guest's errand: every row resolves on a hub tab the daemon refuses it, and a badge over a
        // door that will not open is a debt it can never pay down.
        if (isGuest.value) {
            return [];
        }
        const rows: { when: boolean; item: SandboxAttentionItem }[] = [
            {
                when: noAccountConnected.value,
                item: {
                    icon: `sparkles`,
                    tone: `warning`,
                    message: t(`sandbox.sandboxAttention.noAiAccountConnected`),
                    to: modelsHref(),
                    kind: `needs`,
                },
            },
            {
                when: pending.value !== undefined && !rebuilding.value,
                item: {
                    icon: `exclamation-triangle`,
                    tone: `warning`,
                    message: t(`sandbox.sandboxAttention.rebuildNeededToFinish`),
                    to: rebuildStep(),
                    kind: `needs`,
                    action: `rebuild`,
                },
            },
            // The same condition while the platform works on it: nothing owed, so a note, still pointing at the step,
            // which says since when.
            {
                when: rebuilding.value,
                item: {
                    icon: `box`,
                    tone: `info`,
                    message: t(`sandbox.sandboxAttention.environmentBuilding`),
                    to: rebuildStep(),
                    kind: `note`,
                },
            },
            {
                when: proposal.value !== undefined,
                item: {
                    icon: `exclamation-triangle`,
                    tone: `warning`,
                    message: t(`sandbox.sandboxAttention.agentProposedChangeTo`),
                    to: here(page.sandboxSettings(`environment`)),
                    kind: `needs`,
                },
            },
            // The same kind of yes, for code rather than an image: below maintainer the daemon refuses the press.
            {
                when: waitingExtensions.value.length > 0 && roleAtLeast(role.value, `maintainer`),
                item: {
                    icon: `sliders-h`,
                    tone: `warning`,
                    message: t(`sandbox.sandboxAttention.extensionsWaiting`, { count: waitingExtensions.value.length }, waitingExtensions.value.length),
                    to: here(page.sandboxSettings(`extensions`)),
                    count: waitingExtensions.value.length,
                    kind: `needs`,
                },
            },
            // Outranks secrets below since it fails silently: the card still reads "Enabled" while edits simply stop
            // syncing.
            {
                when: stoppedOn.value.length > 0,
                item: {
                    icon: `desktop`,
                    tone: `warning`,
                    message: t(`sandbox.sandboxAttention.desktopSyncStopped`, { devices: stoppedOn.value.join(`, `) }),
                    to: here(page.devices()),
                    kind: `needs`,
                },
            },
            {
                when: missingRequiredCount.value > 0,
                item: {
                    icon: `key`,
                    tone: `warning`,
                    message: t(`sandbox.sandboxAttention.requiredSecretsMissing`, { count: missingRequiredCount.value }, missingRequiredCount.value),
                    to: here(page.sandboxSettings(`secrets`)),
                    count: missingRequiredCount.value,
                    kind: `needs`,
                },
            },
            // Work that exists in one place only. Both are `needs`: nothing is broken, but each is a debt that bites
            // exactly once and takes everything with it. The copy comes before the remote — turning sync on is a
            // toggle, connecting a repository is a decision — and both stay listed until the condition is untrue.
            {
                when: noCopyOffBox.value,
                item: {
                    icon: `desktop`,
                    tone: `warning`,
                    message: t(`sandbox.sandboxAttention.filesOnlyOnCloudMachine`),
                    to: here(page.devices()),
                    kind: `needs`,
                },
            },
            {
                when: noRepoRemote.value,
                item: {
                    icon: `code`,
                    tone: `warning`,
                    message: t(`sandbox.sandboxAttention.noRepositoryToPushTo`),
                    // The Publish row itself, which says what it needs and links to connecting it (MoveOutPanel.vue).
                    to: here(page.sandboxSettings(`environment`, { hash: PUBLISH_ANCHOR })),
                    kind: `needs`,
                },
            },
            // Neither is a debt: a port one of your own sandboxes took has a remedy on Devices whenever you want it; a
            // new version is nothing wrong until wanted, and the Overview card is the whole errand.
            // THIS USED TO COUNT EVERY PORT THAT MISSED LOCALHOST, which made a standing, correct outcome — a database
            // already running on that number here — a note and a badge that never went away. Only the ports another
            // paired sandbox took are counted now (`heldPorts`), which is the one case something can be done about.
            {
                when: heldPorts.value.length > 0,
                item: {
                    icon: `desktop`,
                    tone: `info`,
                    message: t(`sandbox.sandboxAttention.portsTaken`, { count: heldPorts.value.length }, heldPorts.value.length),
                    to: here(page.devices()),
                    count: heldPorts.value.length,
                    kind: `note`,
                },
            },
        ];
        return (
            diskItems(diskPressure.value)
                .concat(gpuPausedItems(settings.value?.gpu?.pausedFor !== undefined))
                .concat(rows.filter((row) => row.when).map((row) => row.item))
                // Split by whether the update is already downloaded (updateItems); then who waits on the owner's answer.
                .concat(updateItems(updateAvailable.value, updateStaged.value), accessRequestItems(accessRequests.value.length))
        );
    });

    // The two halves surfaces actually render; filed by `kind` rather than a second array to remember.
    const needs = computed<readonly SandboxAttentionItem[]>(() => items.value.filter((item) => item.kind === `needs`));
    const notes = computed<readonly SandboxAttentionItem[]>(() => items.value.filter((item) => item.kind === `note`));

    // One chip states one thing: the head `needs` sets shape and count/glyph, with every `needs` message joined in
    // the tooltip. Falls back to a `note` that earned `badges` only once no `needs` remains.
    const badge = computed<ViewBadge | undefined>(() => {
        const [head] = needs.value;
        if (head !== undefined) {
            return {
                ...(head.count === undefined ? { mark: head.icon } : { count: head.count }),
                tone: head.tone,
                tooltip: needs.value.map((item) => item.message).join(` · `),
            };
        }
        const ready = notes.value.find((item) => item.badges === true);
        if (ready === undefined) {
            return undefined;
        }
        return { mark: ready.icon, tone: ready.tone, tooltip: ready.message };
    });

    // No `items`: a surface reading the undivided list is the old heading bug again.
    return { needs, notes, badge };
}
