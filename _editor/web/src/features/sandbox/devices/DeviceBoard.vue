<script setup lang="ts">
import { Button, Icon, InfoHint, Notice, type NoticeModel, RowGroup, RowNote, SearchBar, SkeletonRows, StatusTally } from "@intentic/ui";
import { computed, ref } from "vue";
import DeviceBoardCard from "./DeviceBoardCard.vue";
import { deviceTally, type MachineRow, rowMatches, showFilter } from "./deviceRows";
import { desktopApp } from "../../../app/environments/desktop";

// Device cards list paired machines, one per PC however many doors it has; controls live on each machine's page.

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
    <RowGroup label="Devices" :count="rows.length === 0 ? undefined : rows.length">
<!-- The other half of the Ports tab's cross-link: both are about "ports" in opposite directions (out to the internet there, in to this machine here). -->
        <template #info>
            <InfoHint label="Devices">
                <span class="block text-sm font-medium text-content">Your own machines</span>
                <span class="mt-1 block text-xs text-muted">
                    Every device paired with this sandbox: the folder it syncs, the ports it mirrors to your <b>localhost</b>, and the sandboxes
                    running on it.
                </span>
                <span class="mt-2 block text-xs text-muted">
                    A port that couldn't be mirrored shows under the sandbox that claimed it first. To expose a port to the public internet, use the
                    <b>Ports</b> tab.
                </span>
            </InfoHint>
        </template>

        <!-- Is anything wrong right now, answered before a card is parsed; then the one thing this screen does. -->
        <template #actions>
            <StatusTally v-if="!isLoading && rows.length > 0" :items="deviceTally(rows)" />
            <Button size="small" severity="secondary" label="Add a device" @click="emit(`add`)">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </template>

        <RowNote v-if="inDesktopApp" icon="desktop">
            This device's own sandboxes are also in <b>This device</b>, from the Intentic icon in your tray.
        </RowNote>

        <!-- Shown only once there's something to search; ports are matched too. -->
        <RowNote v-if="!isLoading && showFilter(rows)" variant="block">
            <SearchBar
                v-model="query"
                variant="field"
                placeholder="Filter by device, sandbox, folder or port"
                aria-label="Filter devices"
                :clearable="true"
            />
        </RowNote>

        <Notice v-if="notice" :of="notice" class="m-4" />
        <div v-else-if="isLoading" role="status" aria-busy="true">
            <template v-if="outline">
                <span class="sr-only">Reading your devices…</span>
                <SkeletonRows :rows="2" description />
            </template>
        </div>
        <RowNote v-else-if="rows.length === 0" variant="empty">
            No device is paired with this sandbox yet. Add one to work on it from your own editor, or connect a Linux/Windows PC from Capabilities to
            let the agent work there.
        </RowNote>

        <DeviceBoardCard v-for="row in shown" :key="row.key" :machine="row" :needle="needle" :own-slug="ownSlug" :read-at="readAt" />

        <!-- A filter that matched nothing says so, rather than leaving a group that looks empty by accident. -->
        <RowNote v-if="shown.length === 0 && rows.length > 0" variant="empty">No device or sandbox here matches "{{ query }}".</RowNote>
    </RowGroup>
</template>
