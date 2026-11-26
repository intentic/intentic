<!-- Shared shell for cards that ask the user something. -->
<script lang="ts">
import type { Component, InjectionKey, Ref } from "vue";
// Shared shell for every card that asks the user something: header, slot, and the answers below. Every title sits at the
// body tier and carries its weight, whether it is a sentence or a name. Every inset comes from `.chat-card`'s own
// measures in chat.css, not from each card.
// A LIVE card wears its tone (the icon's colour, and the skin's accent on the title); a settled one is history and
// drops to the ink of the words around it, so the one card still waiting is the one that stands out.
export interface CardStatus {
    readonly label: string;
    readonly tone: "done" | "gone";
}

/**
 * Provided over cards whose reader may not answer them (a chat they follow but cannot drive): the one quiet line a live
 * card draws in place of its answers, saying who it waits on. Undefined, or not provided, draws the answers.
 */
export const CARD_ANSWERS_WITHHELD: InjectionKey<Readonly<Ref<string | undefined>>> = Symbol(`card-answers-withheld`);

/**
 * Provided by a host that wears the card as its own head (the dock above the composer, holding one ask): its presses,
 * drawn at the end of the card's header, so the host adds no second header over the card's. Undefined draws nothing.
 */
export const CARD_HEADER_TAIL: InjectionKey<Readonly<Ref<Component | undefined>>> = Symbol(`card-header-tail`);

/**
 * Provided by the same host: the title as a press that brings the row the card was asked in on screen, said by `label`
 * on hover, as every line of the dock opens its own (ChatDockRow). Only a live card's title presses.
 */
export interface CardTitlePress {
    readonly label: string;
    readonly press: () => void;
    /** What sort of ask it is, in a word before the title, as the host's folded line said it. */
    readonly kind?: string | undefined;
}
export const CARD_TITLE_PRESS: InjectionKey<Readonly<Ref<CardTitlePress | undefined>>> = Symbol(`card-title-press`);
</script>

<script setup lang="ts">
import { Icon, type IconName } from "@intentic/ui";
import { computed, inject } from "vue";

const {
    icon,
    iconClass = `text-accent`,
    title,
    status,
    prose = false,
    kind,
} = defineProps<{
    icon: IconName;
    // Icon's tone as a single Tailwind class; the set is small enough not to need an enum.
    iconClass?: string;
    title: string;
    // Absent while the card is still live; present freezes it.
    status?: CardStatus;
    // Whether the title is a sentence (wraps, body tier) rather than a name (truncates, one size up).
    prose?: boolean;
    // What sort of ask it is, in a quiet line over a title that names the thing itself (a subagent's task under "Start a
    // subagent"). It replaces the host's own word for the kind, which would only say it less exactly.
    kind?: string | undefined;
}>();

const injected = inject(CARD_ANSWERS_WITHHELD, undefined);
const tail = inject(CARD_HEADER_TAIL, undefined);
const titlePress = inject(CARD_TITLE_PRESS, undefined);
const opens = computed(() => (status === undefined ? titlePress?.value : undefined));
// The host's word for the kind goes before the title on its line; a card's own goes over it, and wins.
const inlineKind = computed(() => (kind === undefined ? opens.value?.kind : undefined));
// Only a live card waits on anybody; a settled one keeps its record either way.
const withheld = computed(() => (status === undefined ? injected?.value : undefined));
</script>

<template>
    <!-- `data-card-live` marks a card still waiting on its answer. -->
    <div
        class="chat-card w-full overflow-hidden"
        :class="status === undefined ? `chat-card-live` : `chat-card-settled`"
        :data-card-live="status === undefined ? `` : undefined"
    >
        <!-- The icon rides in the mark column every option row under it also uses, so the title and the labels start on one edge. -->
        <div class="chat-card-header text-xs" :class="prose ? `items-start` : `items-center`">
            <Icon :name="icon" class="text-sm" :class="status === undefined ? iconClass : `text-subtle`" />
            <!-- A prose title wraps in full; a name truncates, with the full text on hover. One size and weight for both:
                 which kind a title is was never something a reader could see, so it may not set how loud it is. -->
            <!-- Semibold, not medium: with no rim or ground left on a card, weight is what keeps the ask above the labels answering it. -->
            <!-- Dotted under at rest where it goes somewhere, as a dock line's title is (ChatDockRow). -->
            <div class="flex min-w-0 flex-col items-start gap-0.5">
                <span v-if="kind" class="max-w-full truncate text-2xs leading-snug text-muted" data-card-kind>{{ kind }}</span>
                <button
                    v-if="opens"
                    type="button"
                    class="chat-card-title max-w-full min-w-0 rounded-sm text-left text-xs font-semibold text-content underline decoration-subtle decoration-dotted underline-offset-3 transition hover:decoration-current hover:decoration-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
                    :class="!prose && `truncate`"
                    v-tooltip.top="{ title: opens.label }"
                    @click="opens.press()"
                >
                    <!-- `inline-block`: the dotted line under the title does not run on under the word before it. -->
                    <span v-if="inlineKind" class="mr-1.5 inline-block font-medium text-muted">{{ inlineKind }}</span>{{ title }}
                </button>
                <span v-else-if="prose" class="chat-card-title max-w-full min-w-0 text-xs font-semibold text-content">{{ title }}</span>
                <span v-else class="chat-card-title max-w-full min-w-0 truncate text-xs font-semibold text-content" v-tooltip.left.overflow="title">{{
                    title
                }}</span>
            </div>
            <!-- How it ended, as a note beside the title rather than a second heading: the label in the meta ink, and only
                 the glyph saying whether it went through. -->
            <span v-if="status" class="inline-flex shrink-0 items-center gap-1 text-2xs text-muted" :class="{ 'mt-0.5': prose }">
                <Icon :name="status.tone === `done` ? `check` : `times`" :class="status.tone === `done` ? `text-success` : `text-subtle`" />
                {{ status.label }}
            </span>
            <component :is="tail" v-if="tail" />
        </div>

        <slot />

        <!-- Answers row, rendered only when there are any; an empty strip would read as a missing element. A reader who may
             not answer gets who it waits on in its place, quiet, since following along is how this chat is for them. -->
        <div v-if="$slots[`actions`] && withheld" class="chat-card-row flex items-center gap-2 text-2xs text-muted" data-card-withheld>
            <Icon name="lock" aria-hidden="true" class="shrink-0" />{{ withheld }}
        </div>
        <!-- At the row's end, the bright answer last, as every line of the dock over the composer has its presses (ChatDockRow):
             a card the dock carries reads like the lines around it, and the same card up the transcript like itself. -->
        <div v-else-if="$slots[`actions`]" class="chat-card-row chat-card-actions flex flex-wrap items-center justify-end gap-2">
            <slot name="actions" />
        </div>
    </div>
</template>
