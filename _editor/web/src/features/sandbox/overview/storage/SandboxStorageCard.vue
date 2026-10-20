<script setup lang="ts">
import type { StorageCategoryId, StorageCategoryUsage } from "@intentic/sandbox-contract/schemas/metrics";
import { Button, Card, ConfirmDialog, Meter, Notice, type NoticeModel } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatBytes, formatDateTime, timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { NEAR_LIMIT } from "../../../../models/sandbox/liveMetrics";
import { storageCategoryLabel, storageCategoryText } from "./storageCategories";
import { cleanOffer, freeableBytes, shareOfCounted, splitCategories, uncountedBytes } from "./storageView";
import { useSandboxStorage } from "./useSandboxStorage";

// What is filling this sandbox's disk, by what the space is for, with a way to free what may go. A scan is asked for,
// never started by opening the page: it reads every file on the volumes, and the last one stays on screen meanwhile.
// Dense on purpose: one line per category (name, bar, size, action) in shared columns, the largest few listed and the
// small tail folded behind one row, and each category's explanation kept for its tooltip and its opened detail.

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
    return { ...volume, percent: Math.min(100, used * 100), near: used >= NEAR_LIMIT };
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
const freeable = computed(() => (scan.value === undefined ? 0 : freeableBytes(scan.value)));
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
    <Card v-if="storage.available.value" data-setting="overview-disk" class="@container/storage flex min-w-0 flex-col gap-3">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div class="flex min-w-0 items-center gap-2">
                <Icon name="database" class="shrink-0 text-link" />
                <!-- Baseline-aligned: the heading and its status are set in two sizes, and centring their boxes leaves the
                     smaller line floating above the larger one's baseline. -->
                <div class="flex min-w-0 items-baseline gap-2">
                    <h3 class="text-sm font-medium text-content">{{ t(`sandbox.sandboxStorageCard.heading`) }}</h3>
                    <span v-if="scanning" class="truncate text-2xs text-subtle">{{ t(`sandbox.sandboxStorageCard.measuring`) }}</span>
                    <span
                        v-else-if="scan"
                        class="truncate text-2xs"
                        :class="stale ? `text-warning` : `text-subtle`"
                        v-tooltip.top="
                            stale
                                ? { title: formatDateTime(scan.finishedAt), note: t(`sandbox.sandboxStorageCard.staleNote`) }
                                : formatDateTime(scan.finishedAt)
                        "
                    >
                        <Icon v-if="stale" name="history" class="mr-1" />{{
                            t(`sandbox.sandboxStorageCard.measured`, { when: timeAgo(scan.finishedAt, { now, days: true }) })
                        }}
                    </span>
                </div>
            </div>
            <div class="ml-auto flex items-center gap-2">
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
            </div>
        </div>

        <Notice
            v-if="storage.readError.value"
            :of="{ tone: `danger`, title: t(`sandbox.sandboxStorageCard.couldntRead`), detail: storage.readError.value }"
        />
        <Notice v-if="storage.scanNotice.value" :of="storage.scanNotice.value" />
        <Notice v-if="storage.cleanNotice.value" :of="storage.cleanNotice.value" />
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
            <RouterLink to="/sandbox/personas?repositories=true" class="text-xs text-link hover:underline">{{
                t(`sandbox.sandboxStorageCard.chooseRepositories`)
            }}</RouterLink>
        </div>

        <p v-if="!scan && !scanning" class="text-xs leading-relaxed text-muted">{{ t(`sandbox.sandboxStorageCard.intro`) }}</p>
        <p v-else-if="!scan" class="text-xs leading-relaxed text-muted">{{ t(`sandbox.sandboxStorageCard.firstScan`) }}</p>

        <!-- The previous measurement stays readable while the next one runs, dimmed so nobody acts on it as current. -->
        <div v-if="scan" class="flex flex-col gap-3 transition-opacity" :class="scanning ? `opacity-60` : ``">
            <div v-if="disk" class="flex flex-col gap-1">
                <!-- THE DISK FILLS, THEN WHAT FILLS IT: the total grows from empty and each category's share after it, top to
                     bottom, so the ranking of what takes the space is seen forming rather than handed over whole; a rescan
                     or a clean glides each to its new size (Meter `grow`). -->
                <Meter
                    :value="disk.percent / 100"
                    :tone="disk.near ? `warning` : `accent`"
                    size="md"
                    grow
                    :label="t(`sandbox.sandboxStorageCard.heading`)"
                    :valuetext="t(`sandbox.sandboxStorageCard.diskUsed`, { used: formatBytes(disk.usedBytes), total: formatBytes(disk.totalBytes) })"
                />
                <div class="flex flex-wrap items-baseline justify-between gap-x-3 text-2xs tabular-nums">
                    <p :class="disk.near ? `text-warning` : `text-muted`">
                        {{ t(`sandbox.sandboxStorageCard.diskUsed`, { used: formatBytes(disk.usedBytes), total: formatBytes(disk.totalBytes) }) }}
                    </p>
                    <p v-if="freeable > 0" class="text-subtle">{{ t(`sandbox.sandboxStorageCard.freeable`, { bytes: formatBytes(freeable) }) }}</p>
                </div>
            </div>

            <p v-if="scan.outcome === `partial`" class="text-2xs text-warning">{{ t(`sandbox.sandboxStorageCard.partial`) }}</p>

            <!-- Shared columns stay aligned. A narrow card gives names and sizes their own line, with bars and actions below. -->
            <ul class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 @sm/storage:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
                <li
                    v-for="(row, index) in shown"
                    :key="row.category.id"
                    class="col-span-full grid min-h-9 grid-cols-subgrid items-center gap-y-1 border-t border-line-subtle py-2 first:border-t-0 @sm/storage:gap-y-0 @sm/storage:py-1"
                >
                    <button
                        type="button"
                        class="col-start-1 row-start-1 flex min-w-0 cursor-pointer items-center gap-1.5 text-left"
                        :aria-expanded="open.has(row.category.id)"
                        @click="toggle(row.category.id)"
                    >
                        <Icon :name="open.has(row.category.id) ? `chevron-down` : `chevron-right`" class="shrink-0 text-2xs text-subtle" />
                        <span class="min-w-0 break-words text-xs font-medium text-content">{{ row.text.label }}</span>
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
                            tier="boring"
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
                    <!-- Opened, a row says why the space is held and shows its largest parts: the evidence for its size. -->
                    <div v-if="open.has(row.category.id)" class="col-span-full flex flex-col gap-1.5 pt-1 pb-2 pl-4">
                        <p class="text-2xs leading-relaxed text-muted">{{ row.text.reason }}</p>
                        <ul v-if="row.category.items.length > 0" class="flex flex-col gap-0.5">
                            <li v-for="item in row.category.items" :key="item.path" class="flex min-w-0 items-center gap-3 text-2xs">
                                <span class="min-w-0 flex-1 truncate font-mono text-muted" v-tooltip.top.overflow="item.path">{{ item.path }}</span>
                                <span class="shrink-0 tabular-nums text-subtle">{{ formatBytes(item.bytes) }}</span>
                            </li>
                        </ul>
                    </div>
                </li>

                <li v-if="split.rest.length > 0" class="col-span-full grid min-h-9 grid-cols-subgrid items-center border-t border-line-subtle py-1">
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
                    class="col-span-full grid min-h-9 grid-cols-subgrid items-center border-t border-line-subtle py-1 text-2xs text-subtle"
                    v-tooltip.top="{
                        title: t(`sandbox.sandboxStorageCard.otherUsage`),
                        note: t(`sandbox.sandboxStorageCard.systemProgramsFilesystem`),
                    }"
                >
                    <span class="min-w-0 break-words pl-4 @sm/storage:col-span-2">{{ t(`sandbox.sandboxStorageCard.uncounted`) }}</span>
                    <span class="text-right tabular-nums">{{ formatBytes(uncounted) }}</span>
                </li>
            </ul>

            <p v-if="scan.unreadable > 0" class="text-2xs text-subtle">
                {{ t(`sandbox.sandboxStorageCard.unreadable`, { count: scan.unreadable }, scan.unreadable) }}
            </p>
        </div>

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
    </Card>
</template>
