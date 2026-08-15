<script setup lang="ts">
import { type IconName, Picker, type PickerOptions } from "@intentic/extension-ui";
import { computed } from "vue";
import { DIRECT, SCHEDULE, type Source } from "./episodes";

/* WHO CALLED — the view's source filter, and the reason the feed can stay finite.
 *
 * This is bounded by how many things can reach the agent (connections + you), never by how much they send. That
 * is the whole answer to "5 connections calling plenty of times an hour": the list stays the same six entries
 * while the traffic behind it grows without limit, and picking one is what makes the timeline finite.
 *
 * It is also where the category split lives. CONNECTIONS is everything outside the browser that wakes the agent;
 * DIRECT is you, typing. Keeping them as separate labelled groups rather than one flat list is what stops the
 * surface from claiming to be about Discord while showing a thousand rows of the user's own work.
 *
 * ONE FORM, AND IT IS THE PICKER. This was a 16rem index column on desktop and a Picker on a phone. Activity is
 * a SECTION of the sandbox hub now, and the hub already spends a column on its own index — a second one butted
 * against it would read as two rails competing for the same job, and a reader would have to work out which of
 * them moves what. So the compact form is the only form, and it rides the feed's filter bar beside the time
 * window: WHO, WHEN and free text, three controls narrowing one list, in one instrument.
 *
 * GATEWAY HEALTH RIDES THE DESCRIPTION, because a Picker row is one line of text and has nowhere to put the
 * coloured dot the column used to carry. Nothing is lost that mattered: the dot said a connection is not up, and
 * the words say it in the one place a reader is already looking for this source. The selected source's own
 * error and idle reason still render above the feed, which is where they can actually be read. */

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
// disconnected is, because the daemon resolves the deliberate case to idle before this ever sees it. `ready` is
// the resting state and says nothing: a phrase on every healthy row is a phrase nobody reads.
const GATEWAY_WORDS: Readonly<Record<NonNullable<Source["gateway"]>, string | undefined>> = {
    ready: undefined,
    connecting: `connecting…`,
    // Not a synonym for "connecting": nothing here resolves by waiting — a person has to type a code into a
    // phone, and the word has to send them looking for the card that holds it.
    pairing: `waiting to be linked`,
    disconnected: `not connected`,
    idle: `idle`,
};

// The counts a reader picks a source ON, plus whatever is wrong with it. Assembled as parts so a healthy source
// with no failures reads as a bare number rather than a number and two empty separators.
const describe = (source: Source): string =>
    [String(source.episodes), source.failed > 0 ? `${source.failed} failed` : undefined, GATEWAY_WORDS[source.gateway ?? `ready`]]
        .filter((part) => part !== undefined)
        .join(` · `);

const groups = computed<PickerOptions<string>>(() => [
    // Not a member of any group, so it cannot be grouped away: "all" is the state the filter returns to, and an
    // option you cannot get back to is a filter you cannot clear.
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

// Picker models a string, and `` is its spelling of "no filter".
const picked = computed<string>({ get: () => selected.value ?? ``, set: (value) => (selected.value = value === `` ? undefined : value) });
</script>

<template>
    <Picker v-model="picked" :options="groups" aria-label="Activity source" header="Source" class="min-w-36 text-xs" />
</template>
