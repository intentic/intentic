<!-- One line of the dock over the composer: its glyph in the state's colour, what it is, a detail under it, and its presses at the end. -->
<script lang="ts">
/** What a line's glyph says at a glance: the agent waits on the reader, done, under way, a risk, a failure, or a fact. */
export type DockTone = `ask` | `done` | `busy` | `warning` | `danger` | `quiet`;
</script>

<script setup lang="ts">
import type { IconName } from "@intentic/ui";

// EVERY LINE OVER THE COMPOSER IS THIS ONE SHAPE, whoever draws it: an ask, a land, a commit, a stopped turn. Before it
// each drew its own box, and two of them side by side disagreed on everything a reader compares: the presses under the
// words in one and beside them in the other, the bright one first in one and last in the other, two type sizes, two
// frames. Now the glyph stands in the card's mark column (chat.css `--chat-card-*`), so a card the dock carries whole
// lines up with the lines around it; the words read first, then the presses, the bright one last, at the end of the
// line. On a narrow pane the presses go under the words and share out its width, at thumb height.

const INK = {
    ask: `text-accent`,
    done: `text-success`,
    busy: `text-link`,
    warning: `text-warning`,
    danger: `text-danger`,
    quiet: `text-subtle`,
} as const satisfies Record<DockTone, string>;

const {
    icon = `circle`,
    tone = `quiet`,
    spin = false,
    kind,
    title,
    prose = false,
    opens,
} = defineProps<{
    /** The glyph, unless the `mark` slot draws a face in its place. */
    icon?: IconName;
    tone?: DockTone;
    spin?: boolean;
    /** What sort of thing this is, in a word, before its name ("Plan"), where the name alone does not say. */
    kind?: string;
    title: string;
    /** Whether the title is a sentence that wraps in full (a stopped turn's why), rather than a name that truncates. */
    prose?: boolean;
    /** What pressing the title does, as its hover says it ("Show in chat"); absent, the title is plain words. */
    opens?: string;
}>();
const emit = defineEmits<{ open: [] }>();
</script>

<template>
    <div class="chat-dock-row text-2xs" :data-dock-tone="tone">
        <div class="flex min-h-10.5 items-center gap-x-3 gap-y-2.5 py-2 pr-2 pl-(--chat-card-inset) @max-md:flex-col @max-md:items-stretch">
            <div class="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                <!-- The glyph in a box the title's first line tall, so it stands on that line however many the title wraps to. -->
                <div class="flex min-w-0 items-start gap-(--chat-card-gap)">
                    <span class="flex h-4 w-(--chat-card-mark) shrink-0 items-center justify-center" aria-hidden="true">
                        <!-- A face where who it is matters more than what (someone asking to read the chat), else the glyph. -->
                        <slot name="mark"><Icon :name="icon" :spin="spin" class="text-sm" :class="INK[tone]" /></slot>
                    </span>
                    <p class="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs">
                        <span v-if="kind" class="shrink-0 font-medium text-muted">{{ kind }}</span>
                        <!-- A title that goes somewhere is dotted under at rest, so it reads as pressable without a box. -->
                        <button
                            v-if="opens"
                            type="button"
                            class="min-w-0 rounded-sm text-left font-semibold text-content underline decoration-subtle decoration-dotted underline-offset-3 transition hover:decoration-current hover:decoration-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
                            :class="!prose && `truncate`"
                            v-tooltip.top="{ title: opens }"
                            @click="emit(`open`)"
                        >
                            {{ title }}
                        </button>
                        <span v-else-if="prose" class="min-w-0 font-semibold text-content">{{ title }}</span>
                        <span v-else class="min-w-0 truncate font-semibold text-content" v-tooltip.top.overflow="title">{{ title }}</span>
                        <span v-if="$slots[`meta`]" class="flex shrink-0 items-baseline gap-1.5 text-2xs text-muted tabular-nums"><slot name="meta" /></span>
                    </p>
                    <!-- A fold or the like: on the title's line at any width, standing over its padding rather than growing it. -->
                    <span v-if="$slots[`tail`]" class="-my-1 flex shrink-0 items-center"><slot name="tail" /></span>
                </div>
                <div v-if="$slots[`detail`]" class="min-w-0 pl-[calc(var(--chat-card-mark)+var(--chat-card-gap))] text-muted"><slot name="detail" /></div>
            </div>
            <!-- On a narrow pane the presses go under the words, each growing from its own width to fill the line (a wrapped one, the
                 land press, too), all but a caret marked `data-dock-tight` that belongs to the press before it. -->
            <div v-if="$slots[`actions`]" class="flex shrink-0 items-center gap-1.5 @max-md:[&_.p-button:not([data-dock-tight])]:flex-auto @max-md:[&>*:not([data-dock-tight])]:flex-auto">
                <slot name="actions" />
            </div>
        </div>
        <!-- What the line opens onto: on the title's edge, then its own presses at the foot, the bright one last. -->
        <!-- `empty:hidden`: a caller hands its body in unconditionally, and one whose every part is off draws no gap. -->
        <div v-if="$slots[`default`]" class="pr-(--chat-card-inset) pb-2 pl-(--chat-card-text) empty:hidden"><slot /></div>
        <div
            v-if="$slots[`foot`]"
            class="flex items-center justify-end gap-1.5 pr-2 pb-2 pl-(--chat-card-text) @max-md:pl-(--chat-card-inset) @max-md:[&_.p-button:not([data-dock-tight])]:flex-auto @max-md:[&>*:not([data-dock-tight])]:flex-auto"
        >
            <slot name="foot" />
        </div>
    </div>
</template>
