<script setup lang="ts">
import type { PickedModel } from "@intentic/extension-api";
import { AgentRunButton, ui, Icon, useAgentRunPick } from "@intentic/extension-ui";
import { computed } from "vue";
import { host } from "./host";

/* THE RUN CONTROL: a pill that floats over the list it acts on, inside the page's own column.
 *
 * IT HAS BEEN TWO WRONG THINGS FIRST, and each was wrong in a way worth writing down.
 *
 * A DOCKED BAR: full-bleed, bordered, permanently present, ignoring the page column everything above it obeyed
 * and lining up with the shell's own account avatar, so the two read as one status bar. It was there to never be
 * scrolled away from: the right instinct, and it paid for that with a second layer of app chrome in a view that
 * is otherwise an ordinary page.
 *
 * THE HEADER'S ACTION CLUSTER: no chrome, consistent with every other view, and it put four controls in the row
 * beside the h1, so a warning long enough to be worth reading squashed the title, and Run left the screen the
 * moment you scrolled into the twenty-one stories it was about to run.
 *
 * So: STICKY, `bottom-4`, INSIDE the page. Sticky rather than docked is the whole difference, the pill's flow
 * position is the end of the page, so it is a normal element that happens to stay reachable, it inherits the
 * page's width constraint and centring (which is what makes it read as belonging to the list rather than to the
 * window), and it reserves its own space at the bottom of the scroll instead of covering the last row forever.
 * Rounded and shadowed because it floats: a hairline rectangle at the foot of a scroller reads as a docked bar
 * again, and the point is that this is over the content, not under it.
 *
 * WHAT THE PILL SAYS, left to right, is the sentence "N stories, on this model, are about to cost N sessions:
 * except this is in the way". The scope is on the button (`Run all 21 stories`), because a button that states its
 * own scope needs no separate readout and can never disagree with one. The model is the caret ON that button,
 * so the two operands of the multiplication cannot be separated. What is left: the product, or the reason
 * there won't be one, is the one line to their left, and it is either/or: once something is blocking the run,
 * the price is not what the user has to act on.
 *
 * THE MODEL WAS A CHIP OF ITS OWN HERE FIRST, and this view was the only place in the app that had one, which
 * is precisely why it is now the shared <AgentRunButton> instead. Four other surfaces start the same kind of
 * run and none of them could choose at all; unifying them on this view's good idea was worth giving up its
 * bespoke spelling of it.
 *
 * NOTHING TICKED MEANS EVERYTHING, which is what the run dialog's preselect-them-all default meant. So there is
 * no mode to enter, no empty state, and the button always says exactly what pressing it will do.
 *
 * THE GATE is the reason any of this is stated: a run costs one agent session per story, and a story pointed at
 * nothing produces a session that spends minutes discovering the app is down and then writes a blocked report.
 * The view owns the gate (it owns the ticks and the addresses); this states it and refuses to run. */

const { chosen, total, narrowed, blocked, canRun } = defineProps<{
    // How many stories pressing Run will walk. Resolved by the view, which owns the ticks.
    chosen: number;
    // How many there are, so the button can say "all 21" rather than "21" and mean something by it.
    total: number;
    // Whether anything is ticked at all. Distinct from `chosen < total`: ticking every row by hand is still a
    // narrowed list, and Clear must stay reachable from it.
    narrowed: boolean;
    // The first thing standing between this scope and a run, already worded: undefined when nothing is.
    blocked?: string | undefined;
    canRun: boolean;
}>();
const emit = defineEmits<{ submit: [PickedModel]; clear: [] }>();

/* WHO RUNS IT: the sandbox's agent-run list (Sandbox ▸ Agent ▸ Models), the same setting every other
 * surface-started run spends, with the caret overriding it for this run alone.
 *
 * THE CHIP THIS ROW USED TO OWN IS GONE, and that is the point of the change rather than a side effect of it.
 * It was the only surface in the app where you could choose, so the four that could not (both Fix buttons,
 * Maintenance, Documentation) each grew a tooltip apologising for it. One control now, on all of them, and the
 * differences that remain here are the ones that are actually about acceptance: the run costs a session PER
 * STORY, which is what the line to its left is for. */
const fixModel = useAgentRunPick(() => host().models);

const storyCount = (howMany: number): string => `${howMany} ${howMany === 1 ? `story` : `stories`}`;

// What Run will spend, in the number the button doesn't already show: one session per story is the whole
// multiplication, and a fan-out of frontier sessions is the most expensive press in this app.
const spend = computed<string>(() => `${chosen} ${chosen === 1 ? `session` : `sessions`}, one per story`);
</script>

<template>
    <!-- `sticky bottom-4` in the page's flow, centred and only as wide as it needs to be. The wrapper is what
         sticks; the pill inside it is what is seen, so the floating element never spans the column and never
         intercepts a click on a row beside it. -->
    <div class="pointer-events-none sticky bottom-4 z-10 mt-4 flex justify-center">
        <!-- Translucent with a blur behind it, because rows scroll UNDER this: opaque would be a moving hole in
             the list, and fully transparent would leave the text unreadable over a story title. -->
        <div
            class="pointer-events-auto flex max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-1 rounded-full border border-line bg-card/95 py-1.5 pl-4 pr-1.5 shadow-lg backdrop-blur"
        >
            <!-- Capped and truncating, because this is the one part with no fixed length. The whole sentence
                 stays one hover away. -->
            <span v-if="blocked" class="flex min-w-0 items-center gap-1.5 text-2xs text-warning" v-tooltip.top="blocked">
                <Icon name="exclamation-triangle" class="shrink-0" />
                <span class="max-w-72 truncate">{{ blocked }}</span>
            </span>
            <span v-else-if="chosen > 0" class="text-2xs text-muted">{{ spend }}</span>

            <button v-if="narrowed" type="button" :class="ui.linkButton(`text-2xs text-muted hover:text-content`)" @click="emit(`clear`)">
                Clear
            </button>

            <!-- The app's one run button, here as everywhere else: the scope on the label, the model behind the
                 caret. `rounded` is dropped: the two halves need square inner edges to read as one control,
                 and a pill inside a pill was never doing any work. -->
            <AgentRunButton
                :label="`Run ${narrowed ? storyCount(chosen) : `all ${storyCount(total)}`}`"
                icon="play"
                :model-label="fixModel.model.value.label"
                :overridden="fixModel.overridden.value"
                :disabled="!canRun"
                hint="Every test session runs on this model: one session per story"
                @run="emit(`submit`, fixModel.model.value as PickedModel)"
                @pick="fixModel.choose"
            />
        </div>
    </div>
</template>
