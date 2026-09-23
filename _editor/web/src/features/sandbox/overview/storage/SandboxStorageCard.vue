<script setup lang="ts">
import type { StorageCategoryId, StorageCategoryUsage } from "@intentic/sandbox-contract";
import { Button, Card, ConfirmDialog, Notice, type NoticeModel } from "@intentic/ui";
import { formatBytes, formatDateTime, timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { NEAR_LIMIT } from "../../../agents/metrics/liveMetrics";
import { storageCategoryLabel, storageCategoryText } from "./storageCategories";
import { cleanOffer, shareOfDisk, uncountedBytes } from "./storageView";
import { useSandboxStorage } from "./useSandboxStorage";

// What is filling this sandbox's disk, by what the space is for, with a way to free what may go. A scan is asked for,
// never started by opening the page: it reads every file on the volumes, and the last one stays on screen meanwhile.

const t = useT();
const storage = useSandboxStorage();
const scan = computed(() => storage.report.value?.scan);
const scanning = storage.scanning;

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
        share: shareOfDisk(category.bytes, measured),
    }));
});
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
    <Card v-if="storage.available.value" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div class="flex min-w-0 items-center gap-2">
                <Icon name="database" class="shrink-0 text-link" />
                <h3 class="text-sm font-medium text-content">{{ t(`sandbox.sandboxStorageCard.heading`) }}</h3>
                <span v-if="scan && !scanning" class="truncate text-2xs text-subtle" v-tooltip.top="formatDateTime(scan.finishedAt)">
                    {{ t(`sandbox.sandboxStorageCard.measured`, { when: timeAgo(scan.finishedAt) }) }}
                </span>
                <span v-else-if="scanning" class="truncate text-2xs text-subtle">{{ t(`sandbox.sandboxStorageCard.measuring`) }}</span>
            </div>
            <div class="ml-auto flex items-center gap-2">
                <Button v-if="scanning" :label="t(`sandbox.sandboxStorageCard.stop`)" size="small" :text="true" severity="secondary" @click="storage.cancel()">
                    <template #icon><Icon name="stop" /></template>
                </Button>
                <Button
                    :label="scan ? t(`sandbox.sandboxStorageCard.scanAgain`) : t(`sandbox.sandboxStorageCard.scan`)"
                    size="small"
                    severity="secondary"
                    :loading="scanning"
                    :disabled="storage.cleaningCategory.value !== undefined"
                    @click="storage.scan()"
                >
                    <template #icon><Icon name="refresh" /></template>
                </Button>
            </div>
        </div>

        <Notice v-if="storage.readError.value" :of="{ tone: `danger`, title: t(`sandbox.sandboxStorageCard.couldntRead`), detail: storage.readError.value }" />
        <Notice v-if="storage.scanNotice.value" :of="storage.scanNotice.value" />
        <Notice v-if="storage.cleanNotice.value" :of="storage.cleanNotice.value" />
        <Notice v-if="cleanedNotice" :of="cleanedNotice" />

        <p v-if="!scan && !scanning" class="text-xs leading-relaxed text-muted">{{ t(`sandbox.sandboxStorageCard.intro`) }}</p>
        <p v-else-if="!scan" class="text-xs leading-relaxed text-muted">{{ t(`sandbox.sandboxStorageCard.firstScan`) }}</p>

        <!-- The previous measurement stays readable while the next one runs, dimmed so nobody acts on it as current. -->
        <div v-if="scan" class="flex flex-col gap-3 transition-opacity" :class="scanning ? `opacity-60` : ``">
            <div v-if="disk" class="flex flex-col gap-1">
                <!-- A meter: the fill carries how close the volume is to full, its track a lighter step of the same tone. -->
                <div
                    class="h-2 overflow-hidden rounded-full"
                    :class="disk.near ? `bg-warning/15` : `bg-primary-600/15`"
                    role="meter"
                    aria-valuemin="0"
                    :aria-valuemax="disk.totalBytes"
                    :aria-valuenow="disk.usedBytes"
                    :aria-valuetext="t(`sandbox.sandboxStorageCard.diskUsed`, { used: formatBytes(disk.usedBytes), total: formatBytes(disk.totalBytes) })"
                    :aria-label="t(`sandbox.sandboxStorageCard.heading`)"
                >
                    <div class="h-full rounded-full" :class="disk.near ? `bg-warning` : `bg-primary-600`" :style="{ width: `${disk.percent}%` }" />
                </div>
                <p class="text-2xs tabular-nums" :class="disk.near ? `text-warning` : `text-muted`">
                    {{ t(`sandbox.sandboxStorageCard.diskUsed`, { used: formatBytes(disk.usedBytes), total: formatBytes(disk.totalBytes) }) }}
                </p>
            </div>

            <p v-if="scan.outcome === `partial`" class="text-2xs text-warning">{{ t(`sandbox.sandboxStorageCard.partial`) }}</p>

            <ul class="flex flex-col divide-y divide-line-subtle">
                <li v-for="row in rows" :key="row.category.id" class="flex flex-col gap-1.5 py-2.5 first:pt-0">
                    <div class="flex items-center gap-3">
                        <button
                            type="button"
                            class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                            :aria-expanded="open.has(row.category.id)"
                            @click="toggle(row.category.id)"
                        >
                            <Icon :name="open.has(row.category.id) ? `chevron-down` : `chevron-right`" class="shrink-0 text-2xs text-subtle" />
                            <span class="truncate text-xs font-medium text-content">{{ row.text.label }}</span>
                        </button>
                        <span class="shrink-0 text-xs tabular-nums text-content">{{ formatBytes(row.category.bytes) }}</span>
                    </div>
                    <div class="h-1 overflow-hidden rounded-full bg-content/5" aria-hidden="true">
                        <div class="h-full rounded-full bg-primary-600/60" :style="{ width: `${row.share}%` }" />
                    </div>
                    <!-- The action sits under the size rather than beside it, so every row's size stays in one column. -->
                    <div class="flex items-start gap-3">
                        <p class="min-w-0 flex-1 text-2xs leading-relaxed text-muted">{{ row.text.reason }}</p>
                        <Button
                            v-if="row.offer.kind === `clean`"
                            :label="cleanLabel(row.category)"
                            size="small"
                            severity="secondary"
                            :loading="storage.cleaningCategory.value === row.category.id"
                            :disabled="scanning || (storage.cleaningCategory.value !== undefined && storage.cleaningCategory.value !== row.category.id)"
                            @click="press(row.category)"
                        >
                            <template #icon><Icon name="eraser" /></template>
                        </Button>
                        <span v-else-if="row.offer.kind === `waiting`" class="shrink-0 text-2xs text-subtle" v-tooltip.top="t(`sandbox.sandboxStorageCard.waitingHint`)">
                            {{ t(`sandbox.sandboxStorageCard.waiting`) }}
                        </span>
                    </div>
                    <ul v-if="open.has(row.category.id)" class="flex flex-col gap-0.5 pl-4">
                        <li v-for="item in row.category.items" :key="item.path" class="flex min-w-0 items-center gap-3 text-2xs">
                            <span class="min-w-0 flex-1 truncate font-mono text-muted" :title="item.path">{{ item.path }}</span>
                            <span class="shrink-0 tabular-nums text-subtle">{{ formatBytes(item.bytes) }}</span>
                        </li>
                    </ul>
                </li>
            </ul>

            <div v-if="uncounted" class="flex items-center gap-3 text-2xs text-subtle" v-tooltip.top="t(`sandbox.sandboxStorageCard.uncountedHint`)">
                <span class="min-w-0 flex-1 truncate">{{ t(`sandbox.sandboxStorageCard.uncounted`) }}</span>
                <span class="shrink-0 tabular-nums">{{ formatBytes(uncounted) }}</span>
            </div>
            <p v-if="scan.unreadable > 0" class="text-2xs text-subtle">
                {{ t(`sandbox.sandboxStorageCard.unreadable`, { count: scan.unreadable }, scan.unreadable) }}
            </p>
        </div>

        <ConfirmDialog
            :open="asking !== undefined"
            :header="t(`sandbox.sandboxStorageCard.confirmHeader`, { category: asked?.label ?? `` })"
            header-icon="eraser"
            :confirm-label="asking?.cleanableBytes === undefined ? t(`sandbox.sandboxStorageCard.clean`) : t(`sandbox.sandboxStorageCard.free`, { bytes: formatBytes(asking.cleanableBytes) })"
            size="md"
            @cancel="asking = undefined"
            @confirm="confirm"
        >
            <div class="flex flex-col gap-2 text-xs leading-relaxed">
                <p class="text-muted">{{ asked?.reason }}</p>
                <p class="text-content">{{ asked?.warning }}</p>
            </div>
        </ConfirmDialog>
    </Card>
</template>
