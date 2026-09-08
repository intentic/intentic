<!--
    Syntax-highlighted command on a permission card. The gate's flagged span gets a tinted, underlined mark; everything else keeps its normal Shiki
    colour at reduced opacity — no guessing at which arguments matter beyond what the gate flagged. Light/dark swap is handled by
    `.chat-command-block` in chat.css, not by this component.
-->
<script setup lang="ts">
import type { ProgramAsk } from "@intentic/sandbox-contract";
import { type CodeToken, CopyButton, Icon, ui, useHighlighter } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { commandLines } from "./commandPieces.js";

const { program } = defineProps<{ program: ProgramAsk }>();

// Lines before the block clamps; six covers an ordinary pipeline without crowding the card's buttons.
const CLAMP_LINES = 6;

const { tokenizeLine } = useHighlighter();
// One entry per line; undefined until the grammar loads (permanently, if none ships for this language).
const tokens = ref<readonly (readonly CodeToken[] | undefined)[] | undefined>(undefined);

// Tokenizing is async; `seq` guards against a stale result overwriting a newer one (same pattern as `<Code>`).
let seq = 0;
watch(
    () => [program.text, program.language] as const,
    ([text, language]) => {
        const id = ++seq;
        void Promise.all(text.split(`\n`).map((line) => tokenizeLine(line, language).catch(() => undefined))).then((lines) => {
            if (id === seq) {
                tokens.value = lines;
            }
        });
    },
    { immediate: true },
);

const lines = computed(() => commandLines(program.text, program.spans, tokens.value));

// Counted in lines, not pixels: every line here wraps, so height depends on the pane's width.
const expanded = ref(false);
const clamped = computed(() => !expanded.value && lines.value.length > CLAMP_LINES);
const shown = computed(() => (clamped.value ? lines.value.slice(0, CLAMP_LINES) : lines.value));
</script>

<template>
    <div class="flex flex-col gap-1.5">
        <div class="relative">
            <!--
                `pre-wrap`, not a scroller: a command being judged must show its tail, not hide it off the right edge.
                `break-all` wraps an unbreakable URL instead of widening the card; this is body-tier text, not the
                transcript's dimmer meta tier.
            -->
            <!--
                `pr-16` reserves room for the copy button, which floats over the top-right corner and would sit on top of a
                wrapped first line otherwise (same trick as `<Code>`, code.css's `ui-code-copyable`).
            -->
            <pre
                class="chat-command-block overflow-hidden rounded-md border border-line bg-canvas py-2 pr-16 pl-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
            ><code><template v-for="(line, index) in shown" :key="index"><span v-for="(piece, at) in line.pieces" :key="at" :style="piece.style" :class="piece.marked ? 'chat-command-mark' : 'chat-command-dim'">{{ piece.text }}</span>{{ index === shown.length - 1 ? "" : "\n" }}</template></code></pre>
            <!--
                Copies the whole program, never the clamped rendering: half a command is worse than none. A shortened
                card's excerpt already marks itself as partial; the full program is in the transcript.
            -->
            <!--
                Positioned in its own box: the button's own root is `relative` for its press spinner, so `absolute` has to
                come from here instead.
            -->
            <div class="absolute top-1.5 right-1.5 flex">
                <CopyButton :text="program.text" label="Copy" class="bg-canvas" />
            </div>
            <!-- The fade signals more content; a hard cut mid-command would read as a rendering fault. -->
            <div
                v-if="clamped"
                class="pointer-events-none absolute inset-x-px bottom-px h-6 rounded-b-md bg-linear-to-t from-canvas to-transparent"
            ></div>
        </div>
        <div class="flex items-center gap-3">
            <button
                v-if="lines.length > CLAMP_LINES"
                type="button"
                :class="ui.linkButton(`gap-1 text-2xs text-muted hover:text-content`)"
                @click="expanded = !expanded"
            >
                {{ expanded ? `Show less` : `Show all ${lines.length} lines` }}
                <Icon :name="expanded ? `chevron-up` : `chevron-down`" />
            </button>
            <!--
                Says there's more rather than ending mid-word; nothing to expand to here, since the rest was never sent (see
                the transcript). The excerpt always keeps the flagged fragment, so the title's subject is never what got cut.
            -->
            <span v-if="program.truncated" class="text-2xs text-subtle">{{
                program.spans.length > 0 ? `Shortened for this card, kept around the flagged part.` : `Shortened for this card.`
            }}</span>
        </div>
    </div>
</template>
