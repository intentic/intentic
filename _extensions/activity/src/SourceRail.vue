<script setup lang="ts">
import { cmp, Icon, type IconName, Picker, type PickerOptions, useDevice } from "@intentic/extension-ui";
import { computed } from "vue";
import { DIRECT, SCHEDULE, type Source } from "./episodes";

/* WHO CALLED — the view's primary navigation, and the reason it can stay a list.
 *
 * This is bounded by how many things can reach the agent (connections + you), never by how much they send. That
 * is the whole answer to "5 connections calling plenty of times an hour": the rail stays the same six rows while
 * the traffic behind it grows without limit, and picking one row is what makes the timeline finite.
 *
 * It is also where the category split lives. CONNECTIONS is everything outside the browser that wakes the agent;
 * DIRECT is you, typing. Keeping them as separate labelled groups rather than one alphabetical list is what stops
 * the surface from claiming to be about Discord while showing a thousand rows of the user's own work.
 *
 * Desktop renders the rail; mobile renders the same model through a Picker (the app's standard touch swap — its
 * panel is a bottom sheet), because two panes side by side is not a phone layout. */

const { sources, total, failed } = defineProps<{ sources: readonly Source[]; total: number; failed: number }>();
// undefined = every source. Kept undefined rather than a sentinel so the URL simply omits the parameter.
const selected = defineModel<string | undefined>();

const SOURCE_ICONS: Readonly<Record<string, IconName>> = {
    discord: `comments`,
    slack: `comments`,
    webchat: `globe`,
    imap: `envelope`,
    [SCHEDULE]: `clock`,
    [DIRECT]: `user`,
};
const iconOf = (key: string): IconName => SOURCE_ICONS[key] ?? `comments`;

// idle is not a fault — it means the gateway is deliberately not connecting because no automation asked it to.
// disconnected is, because the daemon resolves the deliberate case to idle before this ever sees it.
const DOT: Readonly<Record<NonNullable<Source["gateway"]>, string>> = {
    ready: `text-success`,
    connecting: `text-warning`,
    disconnected: `text-danger`,
    idle: `text-subtle/50`,
};
const GATEWAY_TITLES: Readonly<Record<NonNullable<Source["gateway"]>, string>> = {
    ready: `Connected`,
    connecting: `Connecting…`,
    disconnected: `Not connected`,
    idle: `Idle — no enabled listener automation to connect for`,
};

const groups = computed(() => [
    { label: `Connections`, entries: sources.filter((source) => source.group === `connections`) },
    { label: `Direct`, entries: sources.filter((source) => source.group === `direct`) },
]);

const { mobile } = useDevice();

// The same model as options. `description` carries the counts the rail shows in its right column.
const options = computed<PickerOptions<string>>(() => [
    { options: [{ value: ``, label: `All sources`, description: String(total), icon: `wave-pulse` }] },
    ...groups.value
        .filter((group) => group.entries.length > 0)
        .map((group) => ({
            label: group.label,
            options: group.entries.map((source) => ({
                value: source.key,
                label: source.label,
                description: source.failed > 0 ? `${source.episodes} · ${source.failed} failed` : String(source.episodes),
                icon: iconOf(source.key),
            })),
        })),
]);
// Picker models a string, and `` is its spelling of "no filter".
const picked = computed<string>({ get: () => selected.value ?? ``, set: (value) => (selected.value = value === `` ? undefined : value) });
</script>

<template>
    <Picker v-if="mobile" v-model="picked" :options="options" aria-label="Activity source" header="Source" class="w-full text-xs" />

    <aside v-else class="flex w-52 shrink-0 flex-col gap-3 overflow-y-auto pr-1">
        <button
            type="button"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
            :class="selected === undefined ? `bg-overlay text-content` : `text-muted hover:bg-hover hover:text-content`"
            @click="selected = undefined"
        >
            <Icon name="wave-pulse" class="text-xs text-subtle" />
            <span class="min-w-0 flex-1 truncate font-medium">All sources</span>
            <span class="shrink-0 text-2xs text-subtle">{{ total }}</span>
            <span v-if="failed > 0" v-tooltip.bottom="`${failed} failed`" class="shrink-0 text-2xs text-danger">{{ failed }}✕</span>
        </button>

        <div v-for="group in groups" :key="group.label" v-show="group.entries.length > 0" class="flex flex-col gap-0.5">
            <h4 :class="cmp.sectionLabel('px-2')">{{ group.label }}</h4>
            <button
                v-for="source in group.entries"
                :key="source.key"
                type="button"
                class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
                :class="selected === source.key ? `bg-overlay text-content` : `text-muted hover:bg-hover hover:text-content`"
                @click="selected = source.key"
            >
                <Icon :name="iconOf(source.key)" class="shrink-0 text-xs text-subtle" />
                <span class="min-w-0 flex-1 truncate font-medium">{{ source.label }}</span>
                <!-- Live gateway state, only for a source the daemon actually holds a connection for. The span
                     carries the tooltip because Icon forwards unknown attributes onto the svg. -->
                <span v-if="source.gateway" v-tooltip.bottom="GATEWAY_TITLES[source.gateway]" class="shrink-0 leading-none">
                    <Icon name="circle-fill" class="text-2xs" :class="DOT[source.gateway]" />
                </span>
                <span class="shrink-0 text-2xs text-subtle">{{ source.episodes }}</span>
                <span v-if="source.failed > 0" v-tooltip.bottom="`${source.failed} failed`" class="shrink-0 text-2xs text-danger"
                    >{{ source.failed }}✕</span
                >
            </button>
        </div>
    </aside>
</template>
