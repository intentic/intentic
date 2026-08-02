<script setup lang="ts">
import { Icon, type IconName, type NavGroup, NavRail, Picker, type PickerOptions, Row, useDevice } from "@intentic/extension-ui";
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

const groups = computed<NavGroup<Source>[]>(() =>
    [
        { key: `connections`, label: `Connections`, items: sources.filter((source) => source.group === `connections`) },
        { key: `direct`, label: `Direct`, items: sources.filter((source) => source.group === `direct`) },
    ].filter((group) => group.items.length > 0),
);

const { mobile } = useDevice();

// The same model as options. `description` carries the counts the rail shows in its right column.
const options = computed<PickerOptions<string>>(() => [
    { options: [{ value: ``, label: `All sources`, description: String(total), icon: `wave-pulse` }] },
    ...groups.value.map((group) => ({
        label: group.label,
        options: group.items.map((source) => ({
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

    <NavRail v-else :groups="groups">
        <!-- Not a member of any group, so it cannot be filtered or grouped away: "all" is the state the rail
             returns to, and a row you cannot get back to is a filter you cannot clear. -->
        <template #pinned>
            <Row
                as="button"
                density="dense"
                icon="wave-pulse"
                title="All sources"
                :selected="selected === undefined"
                class="rounded-md"
                @click="selected = undefined"
            >
                <template #meta>
                    <span>{{ total }}</span>
                    <span v-if="failed > 0" v-tooltip.bottom="`${failed} failed`" class="text-danger">{{ failed }}✕</span>
                </template>
            </Row>
        </template>

        <template #row="{ item: source }">
            <Row
                :key="source.key"
                as="button"
                density="dense"
                :icon="iconOf(source.key)"
                :title="source.label"
                :selected="selected === source.key"
                class="rounded-md"
                @click="selected = source.key"
            >
                <template #meta>
                    <!-- Live gateway state, only for a source the daemon actually holds a connection for. The
                         span carries the tooltip because Icon forwards unknown attributes onto the svg. -->
                    <span v-if="source.gateway" v-tooltip.bottom="GATEWAY_TITLES[source.gateway]" class="leading-none">
                        <Icon name="circle-fill" :class="DOT[source.gateway]" />
                    </span>
                    <span>{{ source.episodes }}</span>
                    <span v-if="source.failed > 0" v-tooltip.bottom="`${source.failed} failed`" class="text-danger">{{ source.failed }}✕</span>
                </template>
            </Row>
        </template>
    </NavRail>
</template>
