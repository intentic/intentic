<!-- THE PROGRAM ON A PERMISSION CARD: syntax-highlighted, with the fragment that held it carrying the emphasis
     and everything else stepped back.

     THE HIERARCHY IS THE POINT, and it is two decisions rather than one.

     Colour comes first, because a held command is regularly a hundred-plus characters of pipeline and flat
     monospace is the shape in which a reader cannot tell a path from a flag from a redirect without parsing it
     themselves. Every other code surface in this app is coloured; this one, the one attached to a decision,
     was the exception.

     Then the MARK, because colour alone cannot answer the question this card exists to ask. Syntax
     highlighting is about grammar, so `.env` is painted exactly like every other path in the line, and the
     four characters that caused the hold are invisible among the two hundred that did not. The gate's own
     offsets say which they are (commandPieces merges the two rulers), and here they get a tinted ground and an
     underline.

     The rest is DIMMED rather than recoloured: it keeps its real Shiki colour at reduced opacity, so the
     grammar still reads while the eye lands on the mark. Deliberately not a semantic guess at which arguments
     are "unimportant", there is no honest way to know that from a shell string, and a second colour system
     invented for it would fight the grammar it is drawn over. Flagged-versus-not is the split the daemon can
     actually defend, so it is the only one drawn.

     UNDERLINE AS WELL AS TINT, because the mark is the one thing on this card that must survive being read in
     greyscale, by someone who cannot distinguish the amber, or on a screen in sunlight. -->
<script setup lang="ts">
import type { ProgramAsk } from "@intentic/sandbox-contract";
import { type CodeToken, CopyButton, Icon, ui, useHighlighter } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { commandLines } from "./commandPieces.js";

const { program } = defineProps<{ program: ProgramAsk }>();

/* HOW MANY LINES BEFORE THE BLOCK CLAMPS ITSELF. A card is answered in a couple of seconds by someone who was
 * doing something else; a heredoc that runs to forty lines turns the card into the whole panel and pushes the
 * buttons off screen, which is worse than a fold for exactly the readers who are in a hurry. Six is enough for
 * every ordinary pipeline plus a wrap or two. */
const CLAMP_LINES = 6;

const { tokenizeLine } = useHighlighter();
// One entry per line, in order. Undefined until the grammar lands, and permanently for a language we ship none
// for; commandLines renders plain-but-marked from that, so the command is legible from the first frame.
const tokens = ref<readonly (readonly CodeToken[] | undefined)[] | undefined>(undefined);

/* Tokenizing is asynchronous (grammars are dynamically imported) and this card can be on screen before the
 * chunk resolves, so a stale result must never overwrite a newer one: `seq` is the guard, the same one <Code>
 * and ChatCodeBody use. A failed load leaves `tokens` undefined and the block plain, which is a colour we did
 * not get rather than a card we did not draw. */
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

// Whether there is anything behind the clamp. Counted in LINES rather than measured in pixels: unlike the
// design system's <Code>, every line here wraps rather than scrolling, so a long command's height depends on
// the pane width, and the honest promise a toggle can make is about the lines it is hiding.
const expanded = ref(false);
const clamped = computed(() => !expanded.value && lines.value.length > CLAMP_LINES);
const shown = computed(() => (clamped.value ? lines.value.slice(0, CLAMP_LINES) : lines.value));
</script>

<template>
    <div class="flex flex-col gap-1.5">
        <div class="relative">
            <!-- `pre-wrap` and not a scroller: a command is read to be judged, and a card that hides the tail of
                 the line off its right edge hides exactly the part people put the interesting arguments in.
                 `break-all` so an unbreakable 200-character URL wraps instead of setting the card's width.
                 THE BODY TIER, not the meta tier the transcript's other code chips take. This is the text the
                 card is asking about, and at 2xs under a dim it stopped being something anyone would actually
                 read before clicking Allow — which makes the whole card ceremony. -->
            <!-- `pr-16` is the copy button's own room, reserved by the block rather than left to chance: the
                 button floats over the top-right corner, and a wrapped first line ran straight under it. Same
                 trick the design system's <Code> uses (code.css, keyed off `ui-code-copyable`). -->
            <pre
                class="overflow-hidden rounded-md border border-line bg-canvas py-2 pr-16 pl-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
            ><code><template v-for="(line, index) in shown" :key="index"><span v-for="(piece, at) in line.pieces" :key="at" :style="piece.style" :class="piece.marked ? 'chat-command-mark' : 'chat-command-dim'">{{ piece.text }}</span>{{ index === shown.length - 1 ? "" : "\n" }}</template></code></pre>
            <!-- The copy always carries the FULL text, never the clamped rendering: someone copying a command
                 off this card is taking it somewhere to run or to read, and half of one is worse than none. -->
            <!-- Positioned by a box of its own: the button's root wears `relative` for its press spinner, and
                 an `absolute` handed to it from here is settled by Tailwind's utility order rather than by
                 this call site. -->
            <div class="absolute top-1.5 right-1.5 flex">
                <CopyButton :text="program.text" label="Copy" class="bg-canvas" />
            </div>
            <!-- The fade is what says "there is more": a hard cut mid-command reads as a rendering fault. -->
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
            <!-- The daemon cut the program at 400 characters, and says so rather than letting the card end
                 mid-word: a reader who cannot see the tail should know there IS a tail. There is nothing to
                 expand to here, the rest was never sent; it is in the transcript with the tool call. -->
            <span v-if="program.truncated" class="text-2xs text-subtle">Shortened for this card.</span>
        </div>
    </div>
</template>
