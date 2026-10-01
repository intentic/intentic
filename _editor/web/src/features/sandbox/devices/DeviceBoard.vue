<script setup lang="ts">
import { Button, Icon, Notice, type NoticeModel, RowGroup, SearchBar, SkeletonRows, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import DeviceBoardCard from "./DeviceBoardCard.vue";
import { type MachineRow, rowMatches, showFilter } from "./deviceRows";
import { desktopApp } from "../../../app/environments/desktop";
import { useT } from "@intentic/ui/i18n";

// The paired machines, one card per PC however many environments it has. The header is a group label like every
// other sandbox list's; the cards under it are surfaces of their own, and controls live on each machine's page.

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
    <!-- `flat`: the cards bring their own surfaces, and one drawn around them would nest a card in a card. -->
    <RowGroup :label="t(`sandbox.words.devicesSection`)" flat undivided>
        <template #actions>
            <Button size="small" severity="secondary" :label="t(`sandbox.words.addDevice`)" @click="emit(`add`)">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </template>

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
                <!-- The outline is a card like the ones it stands in for, so the board does not jump when they land. -->
                <RowGroup v-if="outline">
                    <span class="sr-only">{{ t(`sandbox.deviceBoard.readingDevices`) }}</span>
                    <SkeletonRows :rows="2" description />
                </RowGroup>
            </div>
            <p v-else-if="rows.length === 0" :class="ui.emptyState()">
                {{ t(`sandbox.deviceBoard.noDevicePairedSandbox`) }}
            </p>

            <!-- One column, as every sandbox list is: a card's rows read across, and a second column halves them. -->
            <DeviceBoardCard v-for="row in shown" :key="row.key" :machine="row" :needle="needle" :own-slug="ownSlug" :read-at="readAt" />

            <!-- A filter that matched nothing says so, rather than leaving a board that looks empty by accident. -->
            <p v-if="shown.length === 0 && rows.length > 0" :class="ui.emptyState()" role="status">
                {{ t(`sandbox.deviceBoard.noDeviceSandboxHere`, { query }) }}
            </p>
        </div>
    </RowGroup>
</template>
