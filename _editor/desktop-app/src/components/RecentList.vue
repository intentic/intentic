<script setup lang="ts">
import { Button, formatDate, formatDateTime, formatDayMonth, Icon, Notice, Row, RowGroup, RowNote, SearchBar, StatusBadge, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref } from "vue";
import { localForgetRecent, localOpenPath, localRecents, type LocalRecent } from "../desktop";
import { nameOf, openedAtMs, recentRows, recentWhen, whereOf } from "../home";
import { useWhenShown } from "../whenShown";

// What was opened here before, newest first, to open again in one press (local.rs). Read again whenever the window
// comes back, since the windows it opened are where the reader has been in the meantime.

const t = useT();
const recents = ref<LocalRecent[]>([]);
// The clock every age is read against, moved on with each read, so "just now" does not stay just now for an hour.
const now = ref(Date.now());
const query = ref(``);
const shown = computed(() => recentRows(recents.value, query.value));

// The path being opened, which spins its row; the one failure there is, beside the row it is about; and the moved
// recent whose Remove is on offer.
const opening = ref<string | undefined>(undefined);
const failure = ref<{ path: string; message: string } | undefined>(undefined);
const offered = ref<string | undefined>(undefined);

// Only the newest read writes: one answering late would put back a list the reader has since changed.
let reads = 0;
const reload = async (): Promise<void> => {
    reads += 1;
    const read = reads;
    try {
        const listed = await localRecents();
        if (read === reads) {
            recents.value = listed;
            now.value = Date.now();
        }
    } catch (error) {
        console.error(`[home] the recents could not be read:`, error);
    }
};
onMounted(() => void reload());
useWhenShown(() => void reload());

// A moved recent opens nothing, so pressing it asks the one thing left to decide about it.
const press = async (recent: LocalRecent): Promise<void> => {
    if (!recent.exists) {
        offered.value = offered.value === recent.path ? undefined : recent.path;
        return;
    }
    if (opening.value === recent.path) {
        return;
    }
    failure.value = undefined;
    opening.value = recent.path;
    try {
        await localOpenPath(recent.path);
    } catch (error) {
        // The app's own sentence (local.rs), already written for the reader.
        failure.value = { path: recent.path, message: String(error) };
    } finally {
        if (opening.value === recent.path) {
            opening.value = undefined;
        }
    }
    await reload();
};

// Gone from the list at once, then read back: a forget that failed puts its row back, with the reason under it.
const forget = async (path: string): Promise<void> => {
    recents.value = recents.value.filter((recent) => recent.path !== path);
    offered.value = offered.value === path ? undefined : offered.value;
    try {
        await localForgetRecent(path);
    } catch (error) {
        failure.value = { path, message: String(error) };
    }
    await reload();
};

// Esc empties the filter and stops there: the window's own Esc closes the window (App.vue), and one press must not do both.
const clearQuery = (event: KeyboardEvent): void => {
    if (query.value === ``) {
        return;
    }
    event.stopPropagation();
    query.value = ``;
};

// The age in the row's own words, and the exact moment behind it for a hover.
const whenOf = (recent: LocalRecent): string => {
    const opened = openedAtMs(recent.openedAt);
    if (opened === undefined) {
        return ``;
    }
    const when = recentWhen(opened, now.value);
    switch (when.kind) {
        case `justNow`:
            return t(`desktop.home.justNow`);
        case `minutes`:
            return t(`desktop.home.minutesAgo`, { count: when.count });
        case `hours`:
            return t(`desktop.home.hoursAgo`, { count: when.count });
        case `yesterday`:
            return t(`desktop.home.yesterday`);
        case `date`:
            return when.thisYear ? formatDayMonth(when.at) : formatDate(when.at);
    }
};
const exactly = (recent: LocalRecent): string | undefined => {
    const opened = openedAtMs(recent.openedAt);
    return opened === undefined ? undefined : formatDateTime(opened);
};
</script>

<template>
    <RowGroup v-if="recents.length > 0" :label="t(`desktop.home.recent`)">
        <template v-if="shown.filterable" #actions>
            <div class="w-48" @keydown.esc.capture="clearQuery">
                <SearchBar v-model="query" variant="field" clearable :aria-label="t(`desktop.home.filterRecents`)" />
            </div>
        </template>
        <!-- Scrolls in itself once there is a filter to reach the rest with: the window is as tall as its page (fitWindow.ts), and a dozen rows would push what is under them off a laptop's screen. Short of six rows, so the one cut in half says there is more. -->
        <div class="divide-y divide-line-subtle" :class="shown.filterable ? `max-h-76 overflow-y-auto` : ``">
            <!-- The whole row opens: its header is the button a keyboard reaches, and a press on the time lands on the row itself. Only the × is a control of its own. -->
            <Row
                v-for="recent in shown.rows"
                :key="recent.path"
                :header-button="true"
                :interactive="true"
                :icon="opening === recent.path ? `spinner` : recent.folder ? `folder` : `file`"
                :spin="opening === recent.path"
                @header-click="press(recent)"
                @click="press(recent)"
            >
                <template #title>
                    <span class="block truncate" :class="recent.exists ? `` : `text-subtle`">{{ nameOf(recent.path) }}</span>
                </template>
                <template #description>
                    <span v-if="recent.exists" class="block truncate" v-tooltip.bottom="recent.path">{{ whereOf(recent.path) }}</span>
                    <span v-else class="block truncate text-subtle">{{ t(`desktop.home.movedOrDeleted`) }}</span>
                </template>
                <!-- Beside the time rather than the name: a pill is taller than a line of the name, and every row stays one height. -->
                <template #meta>
                    <StatusBadge v-if="recent.sandbox" variant="primary" size="xs" :label="t(`desktop.home.sandbox`)" />
                    <span :title="exactly(recent)">{{ whenOf(recent) }}</span>
                </template>
                <template #control>
                    <button
                        type="button"
                        :class="ui.iconButton()"
                        :aria-label="t(`desktop.home.forget`, { name: nameOf(recent.path) })"
                        v-tooltip.left="t(`desktop.home.forgetShort`)"
                        @click="forget(recent.path)"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                </template>
                <!-- Beside the row it is about, and not a press on the row: reading a failure must not open the thing again. -->
                <template v-if="failure?.path === recent.path || offered === recent.path" #below>
                    <div @click.stop>
                        <Notice v-if="failure?.path === recent.path" tone="danger" class="text-2xs">{{ failure.message }}</Notice>
                        <div v-else class="flex flex-wrap items-center gap-x-3 gap-y-2 text-2xs text-muted">
                            <span class="min-w-0 flex-1">{{ t(`desktop.home.goneOffer`) }}</span>
                            <Button size="small" severity="secondary" :label="t(`ui.action.remove`)" @click="forget(recent.path)" />
                        </div>
                    </div>
                </template>
            </Row>
            <RowNote v-if="shown.rows.length === 0">{{ t(`desktop.home.noMatch`, { query }) }}</RowNote>
        </div>
    </RowGroup>
</template>
