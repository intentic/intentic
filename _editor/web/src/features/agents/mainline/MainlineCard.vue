<script setup lang="ts">
import type { IconName } from "@intentic/ui";

// ONE CARD OF THE MAIN LINE'S BOARD, built the way the fleet board builds an agent card (AgentCard, HeldWakeCard): a mark
// in a ring, the name beside it with the one line that says how it stands under the name, the card's own control at the
// end of that row, and the body under them. The main line's cards are projects and records rather than conversations,
// so the mark is a glyph on a tinted disc instead of an identity tile, and the card itself opens nothing: what it names
// that can be opened (a conversation, a check's terminal) is a control of its own inside it or in the tray under it
// (LandTray).
//
// `live` is the fleet board's live weight (16px of padding, a 14px name), for what is in flight or wants a reader; a
// record takes the ledger's (14 and 12), as a finished agent's card does. `edge` tints the border with the card's tone,
// for the two that ask for the eye: a failing project, and what a push left.

export type CardTone = `neutral` | `link` | `danger` | `success` | `warning`;

const { tone = `neutral`, live = false, edge = false } = defineProps<{
    title: string;
    icon: IconName;
    tone?: CardTone;
    spin?: boolean;
    live?: boolean;
    edge?: boolean;
    // The name set in the commit's own face, for a record named by a sha.
    mono?: boolean;
}>();

// Disc and glyph per tone, from the tokens a status pill already speaks in, so a red card and a red pill agree.
const TONES = {
    neutral: { disc: `bg-content/8`, ink: `text-muted`, edge: `border-line` },
    link: { disc: `bg-primary-600/15`, ink: `text-link`, edge: `border-line` },
    danger: { disc: `bg-danger/15`, ink: `text-danger`, edge: `border-danger/40` },
    success: { disc: `bg-success/15`, ink: `text-success`, edge: `border-line` },
    warning: { disc: `bg-warning/15`, ink: `text-warning`, edge: `border-warning/35` },
} as const satisfies Record<CardTone, { readonly disc: string; readonly ink: string; readonly edge: string }>;
</script>

<template>
    <article
        class="flex w-full min-w-0 flex-col rounded-xl border bg-card text-left text-muted"
        :class="[live ? `gap-3 p-4` : `gap-2 p-3.5`, edge ? TONES[tone].edge : `border-line`]"
    >
        <div class="flex min-w-0 items-center gap-2.5">
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-(length:--ring-track) ring-inset ring-content/12">
                <span class="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full" :class="TONES[tone].disc">
                    <Icon :name="icon" :spin="spin" class="text-2xs" :class="TONES[tone].ink" />
                </span>
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <h3 class="min-w-0 truncate font-semibold text-content" :class="[live ? `text-sm leading-snug` : `text-xs`, mono ? `font-mono` : ``]">
                    {{ title }}
                </h3>
                <!-- How it stands, in one line under its name: failing since when, how many wait, what a push left. -->
                <div v-if="$slots[`meta`]" data-meta class="flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
                    <slot name="meta" />
                </div>
            </div>
            <!-- The card's own control or clock, where an agent card wears its pill. -->
            <slot name="trailing" />
        </div>
        <slot />
    </article>
</template>
