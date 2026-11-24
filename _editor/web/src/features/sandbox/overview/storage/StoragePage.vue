<script setup lang="ts">
import { Button, ConfirmDialog, Icon, Meter, Notice, SectionHeader } from "@intentic/ui";
import { formatBytes, formatCount, formatPercent } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { GROUP_SWATCH, groupOf, mapTiles } from "./diskMap";
import { diskGroupLabel, storageCategoryLabel, storageCategoryText } from "./storageCategories";
import { SMALLER, type StoragePageKey } from "./storageSide";
import { cleanOffer, shareOfCounted } from "./storageView";
import StorageCheckouts from "./StorageCheckouts.vue";
import { useSandboxStorage } from "./useSandboxStorage";

// One tile of the Disk card's map as a page (2026-11-24): a tab of the side panel beside the Overview (SideStorage.vue),
// a sheet over it on a phone (SandboxStorageCard). It says what the category holds and why the space is held, shows the
// evidence for its size (its largest parts, or for the checkouts every conversation's own, with their presses), and
// offers its clean where the daemon allows one; a category that costs something to clean asks first. The "smaller" tile's
// page lists the categories folded into it, each a press away from its own page.

const t = useT();

const { category, host = `side` } = defineProps<{
    /** Fixed for the page's life: a tab is keyed by it. */
    category: StoragePageKey;
    /** What holds the page: a side tab scrolls on its own and titles it; a sheet has its own title bar and scroller. */
    host?: `side` | `sheet`;
}>();

const emit = defineEmits<{ open: [category: StoragePageKey] }>();

const storage = useSandboxStorage();
const scan = computed(() => storage.report.value?.scan);
const usage = computed(() => (category === SMALLER ? undefined : scan.value?.categories.find((entry) => entry.id === category)));
const text = computed(() => (usage.value === undefined ? undefined : storageCategoryText(usage.value)));
const offer = computed(() => (usage.value === undefined ? undefined : cleanOffer(usage.value)));
const title = computed(() => (category === SMALLER ? t(`sandbox.storagePage.smaller`) : storageCategoryLabel(category)));

const smaller = computed(() => {
    if (category !== SMALLER || scan.value === undefined) {
        return [];
    }
    const folded = mapTiles(scan.value.categories).find((tile) => tile.kind === `smaller`);
    const ids = new Set(folded?.kind === `smaller` ? folded.ids : []);
    return scan.value.categories.filter((entry) => ids.has(entry.id));
});

const largest = computed(() => Math.max(1, ...(usage.value?.items ?? []).map((item) => item.bytes)));
const checkouts = computed(() => (category === `checkouts` ? (storage.report.value?.checkouts ?? []) : []));

const busy = computed(() => storage.scanning.value || storage.cleaningCategory.value !== undefined);
const cleanLabel = computed(() =>
    usage.value?.cleanableBytes === undefined
        ? t(`sandbox.sandboxStorageCard.clean`)
        : t(`sandbox.sandboxStorageCard.free`, { bytes: formatBytes(usage.value.cleanableBytes) }),
);
// This page's own clean, said here as well as on the card.
const cleanedHere = computed(() => {
    const results = storage.cleaned.value;
    return results?.length === 1 && results[0]?.category === category ? storage.cleanedNotice.value : undefined;
});

// A category that costs something to clean waits here for the reader to read what.
const asking = ref(false);
const press = (): Promise<void> | undefined => {
    if (usage.value === undefined || offer.value?.kind !== `clean`) {
        return undefined;
    }
    if (offer.value.confirm) {
        asking.value = true;
        return undefined;
    }
    return storage.clean([usage.value.id]);
};
const confirm = async (): Promise<void> => {
    asking.value = false;
    if (usage.value !== undefined) {
        await storage.clean([usage.value.id]);
    }
};
</script>

<template>
    <!-- Its own scroller only as a side tab: in a sheet the sheet's body scrolls. -->
    <div :class="host === `side` ? `h-full overflow-y-auto` : ``" :data-storage-page="category">
        <div class="mx-auto flex max-w-3xl flex-col gap-4 transition-opacity" :class="[host === `side` ? `px-5 py-4` : ``, storage.scanning.value ? `opacity-60` : ``]">
            <header class="flex items-start gap-3">
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <h1 v-if="host === `side`" class="truncate text-lg font-semibold text-content">{{ title }}</h1>
                    <p v-if="usage && scan" class="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                        <span class="size-2.5 shrink-0 rounded-xs" :class="GROUP_SWATCH[groupOf(usage)]" aria-hidden="true" />
                        <span>{{ diskGroupLabel(groupOf(usage)) }}</span>
                        <span aria-hidden="true">·</span>
                        <span class="tabular-nums">{{ t(`sandbox.storagePage.share`, { percent: formatPercent(shareOfCounted(usage.bytes, scan)) }) }}</span>
                        <span aria-hidden="true">·</span>
                        <span class="tabular-nums">{{ t(`sandbox.storagePage.files`, { count: formatCount(usage.files) }, usage.files) }}</span>
                    </p>
                </div>
                <span v-if="usage" class="shrink-0 text-lg tabular-nums text-content">{{ formatBytes(usage.bytes) }}</span>
            </header>

            <p v-if="!scan" class="text-sm text-muted">{{ t(`sandbox.sandboxStorageCard.intro`) }}</p>
            <p v-else-if="category !== SMALLER && !usage" class="text-sm text-muted">{{ t(`sandbox.storagePage.gone`) }}</p>

            <template v-if="usage && text">
                <p class="text-sm leading-relaxed text-muted">{{ text.reason }}</p>

                <Notice v-if="storage.cleanNotice.value && storage.cleaningCategory.value === undefined" :of="storage.cleanNotice.value" />
                <Notice v-if="cleanedHere" :of="cleanedHere" />

                <div v-if="offer?.kind === `clean`" class="flex flex-wrap items-center gap-3">
                    <Button
                        size="small"
                        tier="boring"
                        :label="cleanLabel"
                        :loading="storage.cleaningCategory.value === usage.id"
                        :disabled="busy"
                        data-storage-clean
                        @click="press"
                    >
                        <template #icon><Icon name="eraser" /></template>
                    </Button>
                </div>
                <p v-else-if="offer?.kind === `waiting`" class="text-xs text-subtle">{{ t(`sandbox.storagePage.waiting`) }}</p>

                <StorageCheckouts
                    v-if="checkouts.length > 0"
                    :rows="checkouts"
                    :pressing="storage.pressingCheckout.value"
                    :disabled="busy"
                    @press="storage.pressCheckouts"
                />
                <Notice v-if="storage.pressNotice.value" :of="storage.pressNotice.value" />

                <!-- The evidence for its size: where the space is, largest first. -->
                <section v-if="checkouts.length === 0 && usage.items.length > 0" class="flex flex-col gap-2">
                    <SectionHeader :label="t(`sandbox.storagePage.largest`)" :heading="2" density="dense" />
                    <ul class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1.5">
                        <li v-for="item in usage.items" :key="item.path" class="col-span-full grid grid-cols-subgrid items-center text-xs">
                            <span class="min-w-0 truncate font-mono text-content" v-tooltip.top.overflow="item.path">{{ item.path }}</span>
                            <Meter :value="item.bytes / largest" tone="muted" class="w-16" />
                            <span class="text-right tabular-nums text-muted">{{ formatBytes(item.bytes) }}</span>
                        </li>
                    </ul>
                </section>
            </template>

            <!-- The categories the map folded into one tile, each a press away from its own page. -->
            <ul v-if="smaller.length > 0" class="flex flex-col">
                <li v-for="entry in smaller" :key="entry.id" class="border-t border-line-subtle first:border-t-0">
                    <button
                        type="button"
                        class="flex w-full cursor-pointer items-center gap-2.5 py-2 text-left text-sm text-content hover:text-link"
                        :data-storage-smaller="entry.id"
                        @click="emit(`open`, entry.id)"
                    >
                        <span class="size-2.5 shrink-0 rounded-xs" :class="GROUP_SWATCH[groupOf(entry)]" aria-hidden="true" />
                        <span class="min-w-0 flex-1 truncate">{{ storageCategoryLabel(entry.id) }}</span>
                        <span class="text-xs tabular-nums text-muted">{{ formatBytes(entry.bytes) }}</span>
                        <Icon name="chevron-right" class="text-2xs text-subtle" aria-hidden="true" />
                    </button>
                </li>
            </ul>
        </div>

        <ConfirmDialog
            :open="asking"
            :header="t(`sandbox.sandboxStorageCard.confirmHeader`, { category: title })"
            :description="text?.reason"
            header-icon="eraser"
            :confirm-label="cleanLabel"
            size="md"
            @cancel="asking = false"
            @confirm="confirm"
        >
            <p>{{ text?.warning }}</p>
        </ConfirmDialog>
    </div>
</template>
