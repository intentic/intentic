<script setup lang="ts">
import { InfoHint, Row } from "@intentic-app/ui";

/* ONE connection row. Every credential the Agent tab can hold renders through this — a native provider account,
 * a translator subscription, the "you have none yet" placeholder and the "add another" invitation alike — so
 * they cannot drift into looking like different kinds of thing. They are not: each one answers "what am I
 * signed in with, and what can I do about it?".
 *
 * The anatomy, left to right, is fixed:
 *   · a status GLYPH in a fixed-width well (dot, or the plus of an add-row) — so every title starts on the
 *     same x, whatever the row is
 *   · the connection's NAME
 *   · its STATE, in the same small type, in the same place, for every provider ("not connected", the signed-in
 *     identity, "signing in…")
 *   · an optional (i) for the paragraph of mechanics that would otherwise be printed on screen
 *   · the ACTION, in #control — one of them, except on a credential that has gone bad, where repairing it and
 *     dropping it are genuinely two different answers
 *   · the live sign-in, in #below, inside this row's hairline rather than in a panel detached from it
 *
 * `state` drives only the glyph and the tone — never the layout — which is what lets a row change state
 * (missing → signing-in → connected) without anything moving. */

const { state, interactive = false } = defineProps<{
    title: string;
    // `unknown` is the honest first frame: the daemon hasn't answered, so the dot must not claim either way.
    state: `connected` | `reauth` | `missing` | `unknown` | `add`;
    // The state line beside the title (the signed-in identity, "not connected", "signing in…").
    note?: string;
    // Whether `note` is a live wait, which earns it a spinner — the one moving thing in the row.
    noteBusy?: boolean;
    // The half-sentence under the title: what this connection costs / what it runs / why it needs reconnecting.
    description?: string;
    tone?: `default` | `warning`;
    // The paragraph of mechanics, parked behind an (i) — printing one per row is what made this card a wall.
    about?: string;
    interactive?: boolean;
}>();

const DOT_TONE: Record<string, string> = {
    connected: `bg-success`,
    reauth: `bg-warning`,
    missing: `bg-content/25`,
    // Pulsing, because it is not a verdict: something is still being read.
    unknown: `animate-pulse bg-content/25`,
};
</script>

<template>
    <Row :interactive="interactive" :class="tone === `warning` ? `bg-warning/10` : ``">
        <template #title>
            <!-- Wraps rather than truncates: the connection KIND has to stay first (a Grok subscription row must
                 never read as the native account above it), with the identity beside it. -->
            <span class="flex min-w-0 flex-wrap items-center gap-x-2.5" :class="state === `add` ? `text-muted` : ``">
                <span class="flex w-[1.125rem] shrink-0 justify-center">
                    <Icon v-if="state === `add`" name="plus" class="text-2xs" />
                    <span v-else class="h-1.5 w-1.5 rounded-full" :class="DOT_TONE[state]" />
                </span>
                <span class="min-w-0 truncate">{{ title }}</span>
                <span v-if="note" class="flex items-center gap-1 text-2xs font-normal text-subtle">
                    <Icon v-if="noteBusy" name="spinner" spin />{{ note }}
                </span>
                <InfoHint v-if="about" :label="`About ${title}`">
                    <span class="block text-xs text-content">{{ about }}</span>
                </InfoHint>
            </span>
        </template>
        <!-- Indented to the title's x, not the glyph's — the description belongs to the name above it. -->
        <template v-if="description" #description>
            <span class="block pl-7" :class="tone === `warning` ? `text-warning` : ``">{{ description }}</span>
        </template>
        <template v-if="$slots[`control`]" #control><slot name="control" /></template>
        <template v-if="$slots[`below`]" #below><slot name="below" /></template>
    </Row>
</template>
