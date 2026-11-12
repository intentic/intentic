<script setup lang="ts">
import type { StorageCategoryId, StorageCategoryUsage } from "@intentic/sandbox-contract/schemas/metrics";
import { Button, ConfirmDialog, DisclosureRow, Meter, Notice, Row, RowGroup, RowNote, type NoticeModel } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatBytes, formatDateTime, timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, inject, ref, watch } from "vue";
import { routeLocationKey } from "vue-router";
import { NEAR_LIMIT } from "../../../../models/sandbox/liveMetrics";
import { storageCategoryLabel, storageCategoryText } from "./storageCategories";
import { cleanOffer, shareOfCounted, splitCategories, uncountedBytes } from "./storageView";
import { useSandboxStorage } from "./useSandboxStorage";
import { STORAGE_ANCHOR } from "./storageAnchor";
import StorageCheckouts from "./StorageCheckouts.vue";
import { here, page } from "../../../../lib/routes/links";

// How full this sandbox's disk is and what one press would free, with the breakdown of what fills it folded behind one
// row. Most visits ask "am I running out, and can I get space back?", so that is all the group shows at rest: the volume
// as one bar, then a row for each category that can be cleaned now. What fills the rest (every category, the space the
// scan could not place, each conversation's checkout) is a diagnosis for a tight disk, so it opens by itself when the
// disk is nearly full, the history disk is low, or a disk warning linked here. A scan is asked for, never started by
// opening the page: it reads every file on the volumes, and the last one stays on screen meanwhile.

const t = useT();
const storage = useSandboxStorage();
const scan = computed(() => storage.report.value?.scan);
const scanning = storage.scanning;
const historyDisk = computed(() => storage.report.value?.historyDisk);
// Nested repos only: a persona can leave one of those out of its conversations, while the workspace's own repo is the
// directory every other one mounts into and is always carried, so the remedy this warning names does not reach it.
const largeCheckouts = computed(() => (storage.report.value?.repositoryCheckouts ?? []).filter((repo) => repo.repo !== `root` && repo.bytes >= 1024 ** 3));

// A measurement is kept across restarts, so it can be days old: past a day the age is said in the warning tone, since
// sizes that old are a guide to where the space went rather than what the disk holds now.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const now = useNow(() => scan.value !== undefined && !scanning.value, 60_000);
const stale = computed(() => scan.value !== undefined && now.value - scan.value.finishedAt >= STALE_AFTER_MS);

// One button that is Scan at rest and Stop while a scan runs, so the action stays where the eye already is and the row
// never grows a second button. The handler returns nothing on purpose: a returned promise would press-lock the button
// for the whole scan, and Stop is that same button. A press landing in the first moments of a scan is the tail of a
// double-click on Scan, not a decision to stop, so it is dropped.
const STOP_ARMS_AFTER_MS = 600;
let scanStartedAt = 0;
watch(scanning, (running) => {
    if (running) {
        scanStartedAt = Date.now();
    }
});
const scanLabel = computed(() => (scan.value ? t(`sandbox.sandboxStorageCard.scanAgain`) : t(`sandbox.sandboxStorageCard.scan`)));
const pressScan = (): void => {
    if (!scanning.value) {
        void storage.scan();
    } else if (Date.now() - scanStartedAt >= STOP_ARMS_AFTER_MS) {
        storage.cancel();
    }
};

const disk = computed(() => {
    const volume = scan.value?.disk;
    if (volume === undefined || volume.totalBytes <= 0) {
        return undefined;
    }
    const used = volume.usedBytes / volume.totalBytes;
    return { ...volume, freeBytes: Math.max(0, volume.totalBytes - volume.usedBytes), percent: Math.min(100, used * 100), near: used >= NEAR_LIMIT };
});

const rows = computed(() => {
    const measured = scan.value;
    if (measured === undefined) {
        return [];
    }
    return measured.categories.map((category) => ({
        category,
        text: storageCategoryText(category),
        offer: cleanOffer(category),
        share: shareOfCounted(category.bytes, measured),
    }));
});
const split = computed(() => splitCategories(rows.value));
const showRest = ref(false);
const shown = computed(() => (showRest.value ? rows.value : split.value.lead));
const restBytes = computed(() => split.value.rest.reduce((total, row) => total + row.category.bytes, 0));
// What can be given back now, the only categories the group lists at rest: the few that give back the most, each with its
// own press. The rest stay one press away in the breakdown, beside their sizes. A store that cannot name its figure ranks
// by its size, the most a prune could return.
const QUICK_CLEANS = 3;
const cleanable = computed(() =>
    rows.value
        .filter((row) => row.offer.kind === `clean`)
        .toSorted((a, b) => (b.category.cleanableBytes ?? b.category.bytes) - (a.category.cleanableBytes ?? a.category.bytes))
        .slice(0, QUICK_CLEANS),
);

// The breakdown opens by itself when it is the answer to the reader's question: a disk nearly full, a history disk below
// its floor, or a disk warning elsewhere that linked straight here. Once opened, it stays as the reader leaves it.
// Optional: a test that mounts the Overview without a router has no route, and nothing linked it here.
const route = inject(routeLocationKey, undefined);
const showDetails = ref(false);
const tight = computed(() => disk.value?.near === true || historyDisk.value?.low === true || route?.hash === `#${STORAGE_ANCHOR}`);
watch(
    tight,
    (isTight) => {
        if (isTight) {
            showDetails.value = true;
        }
    },
    { immediate: true },
);
const uncounted = computed(() => (scan.value === undefined ? undefined : uncountedBytes(scan.value)));

// Which rows show their largest parts; the list below a row is the evidence for its size.
const open = ref(new Set<StorageCategoryId>());
const toggle = (id: StorageCategoryId): void => {
    const next = new Set(open.value);
    if (!next.delete(id)) {
        next.add(id);
    }
    open.value = next;
};

// A `confirm` category waits here for the owner to read what cleaning it costs; a `safe` one cleans on the press.
const asking = ref<StorageCategoryUsage>();
const asked = computed(() => (asking.value === undefined ? undefined : storageCategoryText(asking.value)));
const press = (category: StorageCategoryUsage): Promise<void> | undefined => {
    const offer = cleanOffer(category);
    if (offer.kind === `clean` && offer.confirm) {
        asking.value = category;
        return undefined;
    }
    return storage.clean(category.id, storageCategoryLabel(category.id));
};
const confirm = async (): Promise<void> => {
    const category = asking.value;
    asking.value = undefined;
    if (category !== undefined) {
        await storage.clean(category.id, storageCategoryLabel(category.id));
    }
};

const cleanLabel = (category: StorageCategoryUsage): string =>
    category.cleanableBytes === undefined
        ? t(`sandbox.sandboxStorageCard.clean`)
        : t(`sandbox.sandboxStorageCard.free`, { bytes: formatBytes(category.cleanableBytes) });

// What the last clean did, said once and in words: what it gave back, and what it deliberately left.
const cleanedNotice = computed<NoticeModel | undefined>(() => {
    const result = storage.cleaned.value;
    if (result === undefined) {
        return undefined;
    }
    const details = [
        ...(result.kept === 0 ? [] : [t(`sandbox.sandboxStorageCard.keptItems`, { count: result.kept }, result.kept)]),
        ...(result.failed === 0 ? [] : [t(`sandbox.sandboxStorageCard.failedItems`, { count: result.failed }, result.failed)]),
    ];
    return {
        tone: result.failed === 0 ? `info` : `warning`,
        title: t(`sandbox.sandboxStorageCard.freed`, { bytes: formatBytes(result.freedBytes), category: storageCategoryLabel(result.category) }),
        ...(details.length === 0 ? {} : { detail: details.join(` `) }),
    };
});
</script>

<template>
    <RowGroup
        v-if="storage.available.value"
        :id="STORAGE_ANCHOR"
        tabindex="-1"
        data-setting="overview-disk"
        class="@container/storage outline-none"
        :label="t(`sandbox.sandboxStorageCard.heading`)"
    >
        <template #info>
            <span v-if="scanning" class="truncate text-2xs text-subtle">{{ t(`sandbox.sandboxStorageCard.measuring`) }}</span>
            <span
                v-else-if="scan"
                class="truncate text-2xs"
                :class="stale ? `text-warning` : `text-subtle`"
                v-tooltip.top="
                    stale ? { title: formatDateTime(scan.finishedAt), note: t(`sandbox.sandboxStorageCard.staleNote`) } : formatDateTime(scan.finishedAt)
                "
            >
                {{ t(`sandbox.sandboxStorageCard.measured`, { when: timeAgo(scan.finishedAt, { now, days: true }) }) }}
            </span>
        </template>
        <template #actions>
            <!-- Both faces share one grid cell, so the button is as wide as the wider of them and swapping them moves
                 nothing on the row; they cross-fade, the leaving one shrinking a touch as the arriving one settles. -->
            <Button
                size="small"
                tier="boring"
                :aria-label="scanning ? t(`sandbox.sandboxStorageCard.stop`) : scanLabel"
                :disabled="!scanning && storage.cleaningCategory.value !== undefined"
                @click="pressScan"
            >
                <span class="grid">
                    <span
                        class="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5 transition duration-200 ease-out motion-reduce:transition-none"
                        :class="scanning ? `scale-90 opacity-0` : `scale-100 opacity-100`"
                        aria-hidden="true"
                    >
                        <Icon name="refresh" />{{ scanLabel }}
                    </span>
                    <span
                        class="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5 transition duration-200 ease-out motion-reduce:transition-none"
                        :class="scanning ? `scale-100 opacity-100` : `scale-90 opacity-0`"
                        aria-hidden="true"
                    >
                        <!-- A stop square inside the turning ring: what it is doing and what pressing it does, in one glyph. -->
                        <span class="relative inline-flex size-[1em] items-center justify-center">
                            <Icon v-if="scanning" name="spinner" spin class="absolute inset-0" />
                            <!-- allow(tailwind): softens the corners of the scan button's stop square
                                 (size-[0.3em], about 4px at text-sm) inside its spinner, as UpdateWhatsNew's
                                 lozenge does: --radius-2xs is 2px, half the side, which turns the square into a
                                 dot and the stop glyph into a record one. -->
                            <span class="size-[0.3em] rounded-[1px] bg-current" />
                        </span>
                        {{ t(`sandbox.sandboxStorageCard.stop`) }}
                    </span>
                </span>
            </Button>
        </template>

        <!-- What is wrong, or what just happened, about the disk as a whole: above its rows, never read as one of them. -->
        <template
            v-if="
                storage.readError.value ||
                storage.scanNotice.value ||
                storage.cleanNotice.value ||
                storage.pressNotice.value ||
                cleanedNotice ||
                historyDisk?.low ||
                largeCheckouts.length > 0
            "
            #lead
        >
            <Notice
                v-if="storage.readError.value"
                :of="{ tone: `danger`, title: t(`sandbox.sandboxStorageCard.couldntRead`), detail: storage.readError.value }"
            />
            <Notice v-if="storage.scanNotice.value" :of="storage.scanNotice.value" />
            <Notice v-if="storage.cleanNotice.value" :of="storage.cleanNotice.value" />
            <Notice v-if="storage.pressNotice.value" :of="storage.pressNotice.value" />
            <Notice v-if="cleanedNotice" :of="cleanedNotice" />
            <Notice
                v-if="historyDisk?.low"
                :of="{
                    tone: `warning`,
                    title: t(`sandbox.sandboxStorageCard.historyLow`, {
                        free: formatBytes(historyDisk.freeBytes),
                        floor: formatBytes(historyDisk.floorBytes),
                    }),
                }"
            />
            <div v-for="repo in largeCheckouts" :key="repo.repo" class="flex flex-col gap-1">
                <Notice
                    :of="{ tone: `warning`, title: t(`sandbox.sandboxStorageCard.largeCheckout`, { repo: repo.repo, bytes: formatBytes(repo.bytes) }) }"
                />
                <RouterLink :to="here(page.sandboxSettings(`personas`, { query: { repositories: `true` } }))" class="text-xs text-link hover:underline">{{
                    t(`sandbox.sandboxStorageCard.chooseRepositories`)
                }}</RouterLink>
            </div>
        </template>

        <RowNote v-if="!scan">
            {{ scanning ? t(`sandbox.sandboxStorageCard.firstScan`) : t(`sandbox.sandboxStorageCard.intro`) }}
        </RowNote>

        <!-- The previous measurement stays readable while the next one runs, dimmed so nobody acts on it as current. -->
        <template v-else>
            <RowNote variant="block">
                <div class="flex flex-col gap-1.5 transition-opacity" :class="scanning ? `opacity-60` : ``">
                    <template v-if="disk">
                        <!-- THE DISK FILLS, THEN WHAT FILLS IT: the total grows from empty and, opened, each category's share
                             after it; a rescan or a clean glides each to its new size (Meter `grow`). -->
                        <Meter
                            :value="disk.percent / 100"
                            :tone="disk.near ? `warning` : `accent`"
                            size="md"
                            grow
                            :label="t(`sandbox.sandboxStorageCard.heading`)"
                            :valuetext="t(`sandbox.sandboxStorageCard.diskUsed`, { used: formatBytes(disk.usedBytes), total: formatBytes(disk.totalBytes) })"
                        />
                        <div class="flex flex-wrap items-baseline justify-between gap-x-3 text-xs tabular-nums">
                            <p :class="disk.near ? `text-warning` : `text-content`">
                                {{ t(`sandbox.sandboxStorageCard.diskUsed`, { used: formatBytes(disk.usedBytes), total: formatBytes(disk.totalBytes) }) }}
                            </p>
                            <p class="text-muted">{{ t(`sandbox.sandboxStorageCard.diskFree`, { bytes: formatBytes(disk.freeBytes) }) }}</p>
                        </div>
                    </template>
                    <p v-if="scan.outcome === `partial`" class="text-2xs text-warning">{{ t(`sandbox.sandboxStorageCard.partial`) }}</p>
                </div>
            </RowNote>

            <!-- What one press gives back, a row each; a confirm category asks first (ConfirmDialog below). -->
            <Row v-for="row in cleanable" :key="row.category.id" :title="row.text.label" :class="scanning ? `opacity-60` : ``">
                <template #meta>{{ formatBytes(row.category.bytes) }}</template>
                <template #control>
                    <Button
                        :label="cleanLabel(row.category)"
                        size="small"
                        tier="boring"
                        :loading="storage.cleaningCategory.value === row.category.id"
                        :disabled="scanning || (storage.cleaningCategory.value !== undefined && storage.cleaningCategory.value !== row.category.id)"
                        @click="press(row.category)"
                    >
                        <template #icon><Icon name="eraser" /></template>
                    </Button>
                </template>
            </Row>

            <DisclosureRow v-model:open="showDetails" body="drawer" :title="t(`sandbox.sandboxStorageCard.details`)">
                <template #below>
                    <div class="flex flex-col gap-3 transition-opacity" :class="scanning ? `opacity-60` : ``">
                        <!-- Shared columns stay aligned. A narrow group gives names and sizes their own line, with bars below.
                             The last column is the rows' chevron, where every row in the app keeps it. -->
                        <ul class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 @sm/storage:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto]">
                            <li
                                v-for="(row, index) in shown"
                                :key="row.category.id"
                                class="col-span-full grid min-h-8 grid-cols-subgrid items-center gap-y-1 border-t border-line-subtle py-1.5 first:border-t-0 @sm/storage:gap-y-0 @sm/storage:py-1"
                            >
                                <button
                                    type="button"
                                    class="col-start-1 row-start-1 flex min-w-0 cursor-pointer items-center gap-1.5 text-left"
                                    :aria-expanded="open.has(row.category.id)"
                                    @click="toggle(row.category.id)"
                                >
                                    <span class="min-w-0 break-words text-xs text-content">{{ row.text.label }}</span>
                                </button>
                                <Meter
                                    :value="row.share / 100"
                                    grow
                                    :grow-step="index + 1"
                                    class="col-start-1 row-start-2 w-full @sm/storage:col-start-2 @sm/storage:row-start-1 @sm/storage:w-24"
                                />
                                <span class="col-start-2 row-start-1 text-right text-xs tabular-nums text-content @sm/storage:col-start-3">{{
                                    formatBytes(row.category.bytes)
                                }}</span>
                                <div class="col-start-2 row-start-2 flex justify-end @sm/storage:col-start-4 @sm/storage:row-start-1">
                                    <Button
                                        v-if="row.offer.kind === `clean`"
                                        :label="cleanLabel(row.category)"
                                        size="small"
                                        tier="quiet"
                                        :loading="storage.cleaningCategory.value === row.category.id"
                                        :disabled="
                                            scanning || (storage.cleaningCategory.value !== undefined && storage.cleaningCategory.value !== row.category.id)
                                        "
                                        @click="press(row.category)"
                                    >
                                        <template #icon><Icon name="eraser" /></template>
                                    </Button>
                                    <span
                                        v-else-if="row.offer.kind === `waiting`"
                                        class="text-2xs text-subtle"
                                        v-tooltip.top="{
                                            title: t(`sandbox.sandboxStorageCard.tooRecent`),
                                            note: t(`sandbox.sandboxStorageCard.changedTodayOrInUse`),
                                        }"
                                    >
                                        {{ t(`sandbox.sandboxStorageCard.waiting`) }}
                                    </span>
                                </div>
                                <!-- The name button is the keyboard's way in; this is the same toggle for a pointer at the row's end. -->
                                <button
                                    type="button"
                                    tabindex="-1"
                                    aria-hidden="true"
                                    class="col-start-3 row-start-1 flex cursor-pointer items-center justify-end text-subtle transition-colors hover:text-content @sm/storage:col-start-5"
                                    @click="toggle(row.category.id)"
                                >
                                    <Icon name="chevron-right" class="text-2xs transition-transform" :class="open.has(row.category.id) ? `rotate-90` : ``" />
                                </button>
                                <!-- Opened, a row says why the space is held and shows its largest parts: the evidence for its size. -->
                                <div v-if="open.has(row.category.id)" class="col-span-full flex flex-col gap-1.5 pt-1 pb-2">
                                    <p class="text-2xs leading-relaxed text-muted">{{ row.text.reason }}</p>
                                    <ul v-if="row.category.items.length > 0" class="flex flex-col gap-0.5">
                                        <li v-for="item in row.category.items" :key="item.path" class="flex min-w-0 items-center gap-3 text-2xs">
                                            <span class="min-w-0 flex-1 truncate font-mono text-muted" v-tooltip.top.overflow="item.path">{{ item.path }}</span>
                                            <span class="shrink-0 tabular-nums text-subtle">{{ formatBytes(item.bytes) }}</span>
                                        </li>
                                    </ul>
                                </div>
                            </li>

                            <li
                                v-if="split.rest.length > 0"
                                class="col-span-full grid min-h-8 grid-cols-subgrid items-center border-t border-line-subtle py-1"
                            >
                                <button
                                    type="button"
                                    class="flex min-w-0 cursor-pointer items-center gap-1.5 text-left text-xs text-muted hover:text-content @sm/storage:col-span-2"
                                    :aria-expanded="showRest"
                                    @click="showRest = !showRest"
                                >
                                    <Icon :name="showRest ? `chevron-up` : `chevron-down`" class="shrink-0 text-2xs text-subtle" />
                                    <span class="truncate">
                                        {{
                                            showRest
                                                ? t(`sandbox.sandboxStorageCard.fewer`)
                                                : t(`sandbox.sandboxStorageCard.more`, { count: split.rest.length }, split.rest.length)
                                        }}
                                    </span>
                                </button>
                                <span v-if="!showRest" class="text-right text-xs tabular-nums text-muted">{{ formatBytes(restBytes) }}</span>
                            </li>

                            <li
                                v-if="uncounted"
                                class="col-span-full grid min-h-8 grid-cols-subgrid items-center border-t border-line-subtle py-1 text-2xs text-subtle"
                                v-tooltip.top="{
                                    title: t(`sandbox.sandboxStorageCard.otherUsage`),
                                    note: t(`sandbox.sandboxStorageCard.systemProgramsFilesystem`),
                                }"
                            >
                                <span class="min-w-0 break-words @sm/storage:col-span-2">{{ t(`sandbox.sandboxStorageCard.uncounted`) }}</span>
                                <span class="text-right tabular-nums">{{ formatBytes(uncounted) }}</span>
                            </li>
                        </ul>

                        <p v-if="scan.unreadable > 0" class="text-2xs text-subtle">
                            {{ t(`sandbox.sandboxStorageCard.unreadable`, { count: scan.unreadable }, scan.unreadable) }}
                        </p>

                        <!-- The checkouts category taken apart by conversation, each with its own presses. -->
                        <StorageCheckouts
                            :rows="storage.report.value?.checkouts ?? []"
                            :pressing="storage.pressingCheckout.value"
                            :disabled="scanning || storage.cleaningCategory.value !== undefined"
                            @press="storage.pressCheckouts"
                        />
                    </div>
                </template>
            </DisclosureRow>
        </template>

        <ConfirmDialog
            :open="asking !== undefined"
            :header="t(`sandbox.sandboxStorageCard.confirmHeader`, { category: asked?.label ?? `` })"
            :description="asked?.reason"
            header-icon="eraser"
            :confirm-label="
                asking?.cleanableBytes === undefined
                    ? t(`sandbox.sandboxStorageCard.clean`)
                    : t(`sandbox.sandboxStorageCard.free`, { bytes: formatBytes(asking.cleanableBytes) })
            "
            size="md"
            @cancel="asking = undefined"
            @confirm="confirm"
        >
            <p>{{ asked?.warning }}</p>
        </ConfirmDialog>
    </RowGroup>
</template>
