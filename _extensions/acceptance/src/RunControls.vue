<script setup lang="ts">
import type { PickedModel } from "@intentic/extension-api";
import { AgentRunButton, ui, Icon, useAgentRunPick } from "@intentic/extension-ui";
import { computed } from "vue";
import { host } from "./host";

// A sticky pill (`bottom-4`, inside the page column), not a docked bar (a second layer of chrome) or a header action
// (squeezed the title, scrolled off-screen). States the run as "N stories on this model cost N sessions, or here's
// what's blocking it": scope is on the button label, model is its caret, and the line to the left is either the spend
// or the blocker, never both.

const { chosen, total, narrowed, blocked, canRun } = defineProps<{
    // How many stories pressing Run will walk; resolved by the view, which owns the ticks.
    chosen: number;
    // How many there are, so the button can say "all 21" rather than a bare number.
    total: number;
    // Whether anything is ticked, distinct from chosen < total: ticking every row by hand still counts as narrowed.
    narrowed: boolean;
    // The first thing blocking a run in this scope, already worded; undefined when nothing is.
    blocked?: string | undefined;
    canRun: boolean;
}>();
const emit = defineEmits<{ submit: [PickedModel]; clear: [] }>();

// Same agent-run model every surface-started run uses (Sandbox / Agent / Models), overridable here via the caret. Used
// to be a chip unique to this view; now the one control everywhere, since four other surfaces couldn't choose at all.
const fixModel = useAgentRunPick(() => host().models, `acceptance-run`);

const storyCount = (howMany: number): string => `${howMany} ${howMany === 1 ? `story` : `stories`}`;

// What Run will spend: one session per story, the most expensive press in this app when fanned out.
const spend = computed<string>(() => `${chosen} ${chosen === 1 ? `session` : `sessions`}, one per story`);
</script>

<template>
    <!-- Sticky wrapper only; the pill inside is what's seen, so the floating element never spans the column or intercepts a click on a row beside it. -->
    <div class="pointer-events-none sticky bottom-4 z-10 mt-4 flex justify-center">
        <!-- Translucent with blur, since rows scroll under this: opaque would look like a moving hole, transparent would be unreadable. -->
        <div
            class="pointer-events-auto flex max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-1 rounded-full border border-line bg-card/95 py-1.5 pl-4 pr-1.5 shadow-lg backdrop-blur"
        >
            <!-- Capped and truncating, the one part with no fixed length; the full text stays one hover away. -->
            <span v-if="blocked" class="flex min-w-0 items-center gap-1.5 text-2xs text-warning" v-tooltip.top="blocked">
                <Icon name="exclamation-triangle" class="shrink-0" />
                <span class="max-w-72 truncate">{{ blocked }}</span>
            </span>
            <span v-else-if="chosen > 0" class="text-2xs text-muted">{{ spend }}</span>

            <button v-if="narrowed" type="button" :class="ui.linkButton(`text-2xs text-muted hover:text-content`)" @click="emit(`clear`)">
                Clear
            </button>

            <!--
                The app's one run button: scope on the label, model behind the caret. `rounded` dropped, since the two halves need square inner edges
                to read as one control.
            -->
            <AgentRunButton
                :label="`Run ${narrowed ? storyCount(chosen) : `all ${storyCount(total)}`}`"
                icon="play"
                :picker="fixModel"
                :disabled="!canRun"
                hint="Every test session runs on this model: one session per story"
                @run="emit(`submit`, fixModel.model.value as PickedModel)"
            />
        </div>
    </div>
</template>
