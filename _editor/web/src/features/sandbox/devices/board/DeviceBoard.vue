<script setup lang="ts">
import type { Loaded } from "@intentic/extension-api";
import { Await, FilterBar, Icon, Notice, type NoticeModel, PageAction, PageHeader, SegmentedControl, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import DeviceBoardCard from "./DeviceBoardCard.vue";
import PhoneRows from "../phones/PhoneRows.vue";
import LinkedSandboxRows from "../links/LinkedSandboxRows.vue";
import { fleetCounts, type MachineRow, type MachineStatus, machineVerdict, ownMachineFirst, rowMatches, showFilter } from "../../../../models/sandbox/devices/deviceRows";
import { desktopApp } from "../../../../app/environments/desktop";
import { useT } from "@intentic/ui/i18n";

// The paired machines, one tile per PC however many environments it has, in a grid that fills the width it is given: a
// fleet of eight read as eight full-width stacks of rows was a scroll, not a board. Above it, the fleet in three counts
// that double as the filter, so "is anything wrong" is answered before a tile is read. The header is the Devices view's
// own, a rail view's title like every other; controls live on each machine's page.

const t = useT();

const { rows, loaded, ownSlug, readAt } = defineProps<{
    rows: readonly MachineRow[];
    /** The list's read, which the board waits on: until it has answered, an empty board is a guess. */
    loaded: Loaded<unknown>;
    ownSlug: string | undefined;
    /** When this reading landed; every card is judged as of then, not as of now. */
    readAt: number;
}>();

const emit = defineEmits<{ add: [] }>();

// The list's failure, in the words of the screen that asked for it.
const unread = (detail: string): NoticeModel => ({ tone: `danger`, title: t(`sandbox.sandboxDevices.couldntListDevices`), detail });
const notice = computed(() => (loaded.state === `ready` && loaded.refreshError !== undefined ? unread(loaded.refreshError) : undefined));

// Lower-cased once here rather than per comparison; blank until typed, so an empty filter never narrows.
const query = ref(``);
const needle = computed(() => query.value.trim().toLowerCase());

// Which verdict the board is narrowed to; `all` until a count is pressed.
const status = ref<MachineStatus | `all`>(`all`);
const counts = computed(() => fleetCounts(rows, readAt));
// Each count is a pill, hidden at nought by the control itself; `all` carries the fleet's size.
const statusOptions = computed(() => [
    { value: `all` as const, label: t(`sandbox.deviceBoard.all`), badge: rows.length },
    { value: `live` as const, label: t(`sandbox.deviceBoard.live`), badge: counts.value.live },
    { value: `attention` as const, label: t(`sandbox.deviceBoard.attention`), badge: counts.value.attention },
    { value: `offline` as const, label: t(`sandbox.deviceBoard.offline`), badge: counts.value.offline },
]);
// The pills only say something once the fleet holds two states; a board all of one verdict has nothing to narrow.
const mixed = computed(() => Object.values(counts.value).filter((count) => count > 0).length > 1);

// The machine this sandbox runs on leads: its tile is marked only by a small logo, so its place says it too.
const shown = computed<readonly MachineRow[]>(() =>
    ownMachineFirst(
        rows.filter(
            (row) => (needle.value === `` || rowMatches(row, needle.value)) && (status.value === `all` || machineVerdict(row, readAt).status === status.value),
        ),
        ownSlug,
    ),
);
const statusWord = computed(() => statusOptions.value.find((option) => option.value === status.value)?.label.toLowerCase() ?? ``);

// Desktop app reads its own device without a capability.
const inDesktopApp = desktopApp() !== undefined;
</script>

<template>
    <PageHeader :title="t(`sandbox.words.devicesSection`)">
        <template #actions>
            <PageAction icon="plus" :label="t(`sandbox.words.addDevice`)" @click="emit(`add`)" />
        </template>
    </PageHeader>

    <!-- Same `gap-6` rhythm as other sandbox views (Extensions, Roles, …): one band per RowGroup, not nested in the fleet grid's `gap-3`. -->
    <div class="flex flex-col gap-6">
        <!-- The cards bring their own surfaces: nothing is drawn around them. -->
        <div class="flex flex-col gap-3">
            <p v-if="inDesktopApp" class="flex items-center gap-2 px-1 text-xs text-muted">
                <Icon name="desktop" class="shrink-0" aria-hidden="true" />
                <span>
                    {{ t(`sandbox.deviceBoard.devicesOwnSandboxesAlso`) }} <b>{{ t(`sandbox.deviceBoard.device`) }}</b
                    >{{ t(`sandbox.deviceBoard.intenticIconInTray`) }}
                </span>
            </p>

            <!-- Shown only once there's something to search; ports are matched too. The fleet's counts sit beside it as the
                 other half of the same narrowing, once there is more than one verdict to tell apart. Standing while the
                 board is read, as it does for the fleets that need one, so the tiles do not land under a field that drops in. -->
            <FilterBar
                v-if="showFilter(rows) || mixed || loaded.state === `waiting`"
                v-model="query"
                :placeholder="t(`sandbox.deviceBoard.filterByDeviceSandbox`)"
                :aria-label="t(`sandbox.deviceBoard.filterDevices`)"
                :clearable="true"
            >
                <template v-if="mixed" #controls>
                    <SegmentedControl v-model="status" :options="statusOptions" size="xs" :aria-label="t(`sandbox.deviceBoard.byState`)" />
                </template>
            </FilterBar>

            <Notice v-if="notice" :of="notice" />
            <!-- Drawn as the board last looked in this sandbox; until it has been seen once, two tiles in the board's own grid,
                 each a mark, a name over a facts line, and a verdict in the corner, so the board does not jump when they land. -->
            <Await :of="loaded" imprint="sandbox.devices.board" :label="t(`sandbox.deviceBoard.readingDevices`)">
                <template #fallback>
                    <div class="@container" role="status" aria-busy="true" :aria-label="t(`sandbox.deviceBoard.readingDevices`)">
                        <div class="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3" aria-hidden="true">
                            <div v-for="width in [`w-24`, `w-32`]" :key="width" class="flex items-start gap-3 rounded-xl bg-card px-4 pb-3 pt-4 shadow-sm">
                                <span class="skeleton block size-10 shrink-0 rounded-lg" />
                                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <span class="flex items-center justify-between gap-2">
                                        <span class="flex h-6 items-center"><span class="skeleton block h-3.5" :class="width" /></span>
                                        <span class="skeleton block h-4 w-12 shrink-0 rounded-full" />
                                    </span>
                                    <span class="flex h-[1lh] items-center text-xs"><span class="skeleton block h-2.5 w-44 max-w-full" /></span>
                                </span>
                            </div>
                        </div>
                    </div>
                </template>
                <template #failed="{ error }"><Notice :of="unread(error)" /></template>

                <p v-if="rows.length === 0" :class="ui.emptyState()">{{ t(`sandbox.deviceBoard.noDevicePairedSandbox`) }}</p>

                <!-- One box for the tiles. A grid on the board's width: one column on a phone or a narrow pane, two at the
                     page's width, three where the window gives the room. Rows of a grid share a height, so the figures
                     strip at each tile's foot lines up across the row. -->
                <div v-else class="@container">
                    <div class="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
                        <DeviceBoardCard
                            v-for="row in shown"
                            :key="row.key"
                            :machine="row"
                            :needle="needle"
                            :own-slug="ownSlug"
                            :read-at="readAt"
                        />
                    </div>

                    <!-- A filter that matched nothing says so, rather than leaving a board that looks empty by accident. -->
                    <p v-if="shown.length === 0" :class="ui.emptyState()" role="status">
                        {{
                            needle === ``
                                ? t(`sandbox.deviceBoard.noneAtState`, { state: statusWord })
                                : t(`sandbox.deviceBoard.noDeviceSandboxHere`, { query })
                        }}
                    </p>
                </div>
            </Await>
        </div>

        <!-- The owner's phones: no folders or sandboxes on them, so a row each rather than a machine's card. -->
        <PhoneRows />

        <!-- The owner's other sandboxes this one may hand tasks to: a row each, read off its link card. -->
        <LinkedSandboxRows />
    </div>
</template>
