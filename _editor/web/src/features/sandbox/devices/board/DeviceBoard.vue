<script setup lang="ts">
import {
    Icon,
    Notice,
    type NoticeModel,
    PageAction,
    PageHeader,
    RowGroup,
    SearchBar,
    SkeletonRows,
    SkeletonSnapshot,
    ui,
    vSkeletonSource,
} from "@intentic/ui";
import { computed, ref } from "vue";
import DeviceBoardCard from "./DeviceBoardCard.vue";
import PhoneRows from "../phones/PhoneRows.vue";
import RecentlyDeleted from "../deleted/RecentlyDeleted.vue";
import { type MachineRow, rowMatches, showFilter } from "../deviceRows";
import { desktopApp } from "../../../../app/environments/desktop";
import { useT } from "@intentic/ui/i18n";

// The paired machines, one card per PC however many environments it has. The header is the Devices view's own, a rail
// view's title like every other; the cards under it are surfaces of their own, and controls live on each machine's page.

const t = useT();

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
    <PageHeader :title="t(`sandbox.words.devicesSection`)">
        <template #actions>
            <PageAction icon="plus" :label="t(`sandbox.words.addDevice`)" @click="emit(`add`)" />
        </template>
    </PageHeader>

    <!-- `flat`: the cards bring their own surfaces, and one drawn around them would nest a card in a card. -->
    <RowGroup flat undivided>
        <div class="flex flex-col gap-3">
            <p v-if="inDesktopApp" class="flex items-center gap-2 px-1 text-xs text-muted">
                <Icon name="desktop" class="shrink-0" aria-hidden="true" />
                <span>
                    {{ t(`sandbox.deviceBoard.devicesOwnSandboxesAlso`) }} <b>{{ t(`sandbox.deviceBoard.device`) }}</b
                    >{{ t(`sandbox.deviceBoard.intenticIconInTray`) }}
                </span>
            </p>

            <!-- Shown only once there's something to search; ports are matched too. A board control, so on no card. -->
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
                <!-- Drawn as the board last looked in this sandbox; until it has been seen once, the outline is a card like
                     the ones it stands in for, so the board does not jump when they land. -->
                <SkeletonSnapshot v-if="outline" of="sandbox.devices.board" :label="t(`sandbox.deviceBoard.readingDevices`)">
                    <RowGroup>
                        <span class="sr-only">{{ t(`sandbox.deviceBoard.readingDevices`) }}</span>
                        <SkeletonRows :rows="2" description />
                    </RowGroup>
                </SkeletonSnapshot>
            </div>
            <p v-else-if="rows.length === 0" v-skeleton-source="`sandbox.devices.board`" :class="ui.emptyState()">
                {{ t(`sandbox.deviceBoard.noDevicePairedSandbox`) }}
            </p>

            <!-- One box for the cards, so the next wait can draw them; spaced as the column it sits in. -->
            <div v-if="rows.length > 0" v-skeleton-source="`sandbox.devices.board`" class="flex flex-col gap-3">
                <!-- One column, as every sandbox list is: a card's rows read across, and a second column halves them. -->
                <DeviceBoardCard v-for="row in shown" :key="row.key" :machine="row" :needle="needle" :own-slug="ownSlug" :read-at="readAt" />

                <!-- A filter that matched nothing says so, rather than leaving a board that looks empty by accident. -->
                <p v-if="shown.length === 0" :class="ui.emptyState()" role="status">
                    {{ t(`sandbox.deviceBoard.noDeviceSandboxHere`, { query }) }}
                </p>
            </div>

            <!-- The owner's phones: no folders or sandboxes on them, so a row each rather than a machine's card. -->
            <PhoneRows />

            <!-- The account's deleted sandboxes, last: boxes that left this board, drawn only while one can come back. -->
            <RecentlyDeleted />
        </div>
    </RowGroup>
</template>
