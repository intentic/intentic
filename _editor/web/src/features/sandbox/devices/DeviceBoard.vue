<script setup lang="ts">
import { Button, Icon, Notice, type NoticeModel, SearchBar, SkeletonRows, ui } from "@intentic/ui";
import { computed, ref, useId } from "vue";
import DeviceBoardCard from "./DeviceBoardCard.vue";
import { type MachineRow, rowMatches, showFilter } from "./deviceRows";
import { desktopApp } from "../../../app/environments/desktop";
import { useT } from "@intentic/ui/i18n";

// One independent card per PC, however many environments it has. The toolbar belongs to the board;
// connection states and sandbox previews belong to their computer, with controls on its own page.

const t = useT();
const headingId = useId();

const { rows, isLoading, notice, outline, ownSlug, readAt } = defineProps<{
    rows: readonly MachineRow[];
    /** The first read only; a refetch must never blank an already-populated board. */
    isLoading: boolean;
    notice: NoticeModel | undefined;
    // The loading outline withholds the empty claim until the first read completes.
    outline: boolean;
    ownSlug: string | undefined;
    /** When this reading landed; every card is judged as of then, not as of now. */
    readAt: number;
}>();

const emit = defineEmits<{ add: [] }>();

// Lower-cased once here rather than per comparison; blank until typed, so an empty filter never narrows.
const query = ref(``);
const needle = computed(() => query.value.trim().toLowerCase());

const shown = computed<readonly MachineRow[]>(() => (needle.value === `` ? rows : rows.filter((row) => rowMatches(row, needle.value))));

// Desktop app reads its own device without a capability.
const inDesktopApp = desktopApp() !== undefined;
</script>

<template>
    <section :aria-labelledby="headingId" class="@container flex min-w-0 flex-col gap-4">
        <div class="flex flex-wrap items-center justify-between gap-3 px-1">
            <h2 :id="headingId" :class="ui.sectionLabel()">{{ t(`sandbox.words.devicesSection`) }}</h2>
            <Button size="small" severity="secondary" :label="t(`sandbox.words.addDevice`)" @click="emit(`add`)">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </div>

        <p v-if="inDesktopApp" class="flex items-start gap-2 px-1 text-xs text-muted">
            <Icon name="desktop" class="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
                {{ t(`sandbox.deviceBoard.devicesOwnSandboxesAlso`) }} <b>{{ t(`sandbox.deviceBoard.device`) }}</b
                >{{ t(`sandbox.deviceBoard.intenticIconInTray`) }}
            </span>
        </p>

        <!-- Search is a board control, not part of any computer's card; ports are matched too. -->
        <SearchBar
            v-if="!isLoading && showFilter(rows)"
            v-model="query"
            variant="field"
            :placeholder="t(`sandbox.deviceBoard.filterByDeviceSandbox`)"
            :aria-label="t(`sandbox.deviceBoard.filterDevices`)"
            :clearable="true"
        />

        <Notice v-if="notice" :of="notice" />
        <div v-else-if="isLoading" role="status" aria-busy="true">
            <template v-if="outline">
                <span class="sr-only">{{ t(`sandbox.deviceBoard.readingDevices`) }}</span>
                <div class="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
                    <div v-for="index in 2" :key="index" class="overflow-hidden rounded-xl border border-line-subtle bg-card">
                        <SkeletonRows :rows="2" description />
                    </div>
                </div>
            </template>
        </div>
        <p v-else-if="rows.length === 0" :class="ui.emptyState()">
            {{ t(`sandbox.deviceBoard.noDevicePairedSandbox`) }}
        </p>

        <!-- Columns follow this pane's width, not the window: a side panel must never squeeze two cards in. -->
        <div v-if="shown.length > 0" class="grid grid-cols-1 items-start gap-4 @3xl:grid-cols-2">
            <DeviceBoardCard v-for="row in shown" :key="row.key" :machine="row" :needle="needle" :own-slug="ownSlug" :read-at="readAt" />
        </div>

        <p v-if="shown.length === 0 && rows.length > 0" :class="ui.emptyState()" role="status">
            {{ t(`sandbox.deviceBoard.noDeviceSandboxHere`, { query }) }}
        </p>
    </section>
</template>
