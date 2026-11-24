<script setup lang="ts">
import { Button, Modal, Notice, RowGroup, RowNote, useDevice } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatBytes, formatDateTime, timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { here, page } from "../../../../lib/routes/links";
import { sideDocked } from "../../../../workbench/side/sideTabs";
import { revealSideView } from "../../../../workbench/side/sideViews";
import type { DiskTile } from "./diskMap";
import DiskMap from "./DiskMap.vue";
import DiskReclaim from "./DiskReclaim.vue";
import DiskRules from "./DiskRules.vue";
import { STORAGE_ANCHOR } from "./storageAnchor";
import { storageCategoryLabel } from "./storageCategories";
import StoragePage from "./StoragePage.vue";
import { pageKeyOf, SMALLER, STORAGE_SIDE_VIEW, type StoragePageKey, storageSideInput } from "./storageSide";
import { useSandboxStorage } from "./useSandboxStorage";

// How full this sandbox's disk is, what fills it, and how to get space back (2026-11-24). The disk is drawn to scale
// (DiskMap): the whole volume as a bar, the sandbox's own share of it opened into a map of tiles as big as what they
// hold, so "what fills it" is answered by looking rather than reading a list. A tile opens its page beside the card
// (StoragePage in the side panel, a sheet on a phone): why the space is held, its largest parts, its clean. Under the
// map, one row gets space back in one decision (DiskReclaim) and one says the rules that keep the disk from filling,
// each changed where it is read (DiskRules). A scan is asked for, never started by opening the page: it reads every
// file on the volumes, and the last one stays on screen meanwhile.

const t = useT();
const storage = useSandboxStorage();
const { mobile } = useDevice();
const scan = computed(() => storage.report.value?.scan);
const scanning = storage.scanning;
const historyDisk = computed(() => storage.report.value?.historyDisk);
// Nested repos only: a role can leave one of those out of its conversations, while the workspace's own repo is the
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

const cleaning = computed(() => storage.cleaningCategory.value !== undefined);

// The page a phone shows over the card, since it has no side panel to put one in.
const sheet = ref<StoragePageKey>();
const sheetTitle = computed(() => (sheet.value === undefined ? undefined : sheet.value === SMALLER ? t(`sandbox.storagePage.smaller`) : storageCategoryLabel(sheet.value)));
const open = (key: StoragePageKey): void => {
    if (sideDocked.value && !mobile.value) {
        revealSideView(STORAGE_SIDE_VIEW, storageSideInput(key));
        return;
    }
    sheet.value = key;
};
const openTile = (tile: DiskTile): void => open(pageKeyOf(tile));
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
                storage.cleanedNotice.value ||
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
            <Notice v-if="storage.cleanedNotice.value" :of="storage.cleanedNotice.value" />
            <Notice
                v-if="historyDisk?.low"
                :of="{
                    tone: `warning`,
                    title: `${t(`sandbox.sandboxStorageCard.historyLow`, {
                        free: formatBytes(historyDisk.freeBytes),
                        floor: formatBytes(historyDisk.floorBytes),
                    })}${historyDisk.limitedBy === undefined ? `` : ` ${t(`sandbox.sandboxAttention.diskHostLimit`, { drive: historyDisk.limitedBy.drive, free: formatBytes(historyDisk.limitedBy.driveFreeBytes) })}.`}`,
                }"
            />
            <div v-for="repo in largeCheckouts" :key="repo.repo" class="flex flex-col gap-1">
                <Notice
                    :of="{ tone: `warning`, title: t(`sandbox.sandboxStorageCard.largeCheckout`, { repo: repo.repo, bytes: formatBytes(repo.bytes) }) }"
                />
                <RouterLink :to="here(page.sandboxSettings(`roles`, { query: { repositories: `true` } }))" class="text-xs text-link hover:underline">{{
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
                <div class="flex flex-col gap-2 transition-opacity" :class="scanning ? `opacity-60` : ``">
                    <DiskMap :scan="scan" @open="openTile" />
                    <p v-if="scan.outcome === `partial`" class="text-2xs text-warning">{{ t(`sandbox.sandboxStorageCard.partial`) }}</p>
                    <p v-if="scan.unreadable > 0" class="text-2xs text-subtle">
                        {{ t(`sandbox.sandboxStorageCard.unreadable`, { count: scan.unreadable }, scan.unreadable) }}
                    </p>
                </div>
            </RowNote>
            <DiskReclaim :scan="scan" :busy="scanning || cleaning" :loading="cleaning" @clean="storage.clean" />
        </template>

        <DiskRules />

        <Modal :open="sheet !== undefined" size="full" :header="sheetTitle" @update:open="(value: boolean) => !value && (sheet = undefined)">
            <StoragePage v-if="sheet !== undefined" :key="sheet" :category="sheet" host="sheet" @open="open" />
        </Modal>
    </RowGroup>
</template>
