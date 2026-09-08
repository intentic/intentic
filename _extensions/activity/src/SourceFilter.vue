<script setup lang="ts">
import { type IconName, Picker, type PickerOptions } from "@intentic/extension-ui";
import { computed } from "vue";
import { DIRECT, SCHEDULE, type Source } from "./episodes";

// The feed's source filter: bounded by how many things can reach the agent, not by how much they send, so the list
// stays finite while traffic grows. Splits into CONNECTIONS (outside the browser) and DIRECT (you) as separate groups.
// A compact Picker riding the feed's filter bar alongside window and text; gateway health shows in each row's
// description.

const { sources, total, failed } = defineProps<{ sources: readonly Source[]; total: number; failed: number }>();
// undefined means every source; omits the query param rather than using a sentinel value.
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

// `idle` is deliberate (nothing asked it to connect), not a fault; `disconnected` is. `ready` shows nothing.
const GATEWAY_WORDS: Readonly<Record<NonNullable<Source["gateway"]>, string | undefined>> = {
    ready: undefined,
    connecting: `connecting…`,
    // Not "connecting": nothing resolves by waiting, someone has to type a code shown elsewhere.
    pairing: `waiting to be linked`,
    disconnected: `not connected`,
    idle: `idle`,
};

// Episode count plus whatever's wrong; built from parts so a healthy source reads as a bare number, not padded with
// empty separators.
const describe = (source: Source): string =>
    [String(source.episodes), source.failed > 0 ? `${source.failed} failed` : undefined, GATEWAY_WORDS[source.gateway ?? `ready`]]
        .filter((part) => part !== undefined)
        .join(` · `);

const groups = computed<PickerOptions<string>>(() => [
    // Ungrouped so it can't be filtered away: this is the state the filter always returns to.
    {
        options: [
            {
                value: ``,
                label: `All sources`,
                description: failed > 0 ? `${total} · ${failed} failed` : String(total),
                icon: `wave-pulse` as IconName,
            },
        ],
    },
    ...[
        { key: `connections`, label: `Connections`, items: sources.filter((source) => source.group === `connections`) },
        { key: `direct`, label: `Direct`, items: sources.filter((source) => source.group === `direct`) },
    ]
        .filter((group) => group.items.length > 0)
        .map((group) => ({
            label: group.label,
            options: group.items.map((source) => ({
                value: source.key,
                label: source.label,
                description: describe(source),
                icon: iconOf(source.key),
            })),
        })),
]);

// Picker only models strings; empty string is its spelling of no filter.
const picked = computed<string>({ get: () => selected.value ?? ``, set: (value) => (selected.value = value === `` ? undefined : value) });
</script>

<template>
    <Picker v-model="picked" :options="groups" aria-label="Activity source" header="Source" class="min-w-36 text-xs" />
</template>
