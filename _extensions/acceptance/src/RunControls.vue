<script setup lang="ts">
import type { PickedModel } from "@intentic/extension-api";
import { Button, cmp, Icon } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { host } from "./host";

/* THE RUN CONTROL — the page's primary action, in the page's own header, where every other view in this app
 * puts one.
 *
 * IT USED TO BE A BAR docked under the list: full-bleed, bordered, permanently present, ignoring the page column
 * everything above it obeyed and lining up with the shell's own account avatar so the two read as one status
 * bar. It was there to never be scrolled away from, and it bought that with a second layer of chrome in a view
 * that is otherwise an ordinary page. Header actions are what this app means by "the thing this page does" —
 * Refresh already sat there — so the run says it there too, and the area has no chrome of its own again.
 *
 * WHAT THE CLUSTER SAYS, left to right, is the sentence "N stories, on this model, are about to cost N
 * sessions — except this is in the way". The scope is on the button (`Run 21 stories`), because a button that
 * states its own scope needs no separate readout and can never disagree with one. The model sits immediately
 * beside it, so the two operands of the multiplication are read together. What is left — the product, or the
 * reason there won't be one — is the one line to their left, and it is either/or: once something is blocking the
 * run, the price is not what the user has to act on.
 *
 * NOTHING TICKED MEANS EVERYTHING, which is what the run dialog's preselect-them-all default meant. So there is
 * no mode to enter, no empty state, and the button is always live and always says exactly what pressing it will
 * do.
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
    // The first thing standing between this scope and a run, already worded — undefined when nothing is.
    blocked?: string | undefined;
    canRun: boolean;
}>();
const emit = defineEmits<{ submit: [PickedModel]; clear: [] }>();

/* WHO RUNS IT, and where that answer comes from before anybody touches the chip: the sandbox's agent-run model
 * (Sandbox ▸ Agent ▸ Models), the same setting every other surface-started run spends — resolved and named by
 * the host, so this view holds no catalog of its own. A hand pick wins from the instant it is made, which is
 * why this is one ref with a fallback rather than a watcher seeding it: a watcher would re-seed under the user
 * the moment the setting refetched, silently undoing a choice they had already made. */
const picked = ref<PickedModel>();
const model = computed<PickedModel>(() => picked.value ?? host().models.agentRun());

// The trigger the shell's picker hangs off — a popover on desktop, a sheet on mobile; the host decides.
const chip = ref<HTMLElement>();
const choose = async (): Promise<void> => {
    if (chip.value === undefined) {
        return;
    }
    const next = await host().models.pick({ anchor: chip.value, provider: model.value.provider, model: model.value.model });
    if (next !== undefined) {
        picked.value = next;
    }
};

const storyCount = (howMany: number): string => `${howMany} ${howMany === 1 ? `story` : `stories`}`;

// What Run will spend, in the number the button doesn't already show: one session per story is the whole
// multiplication, and a fan-out of frontier sessions is the most expensive press in this app.
const spend = computed<string>(() => `${chosen} ${chosen === 1 ? `session` : `sessions`}, one per story`);
</script>

<template>
    <!-- Wraps rather than truncates the cluster: on a narrow area the note drops to its own line and the button
         stays whole. A control that clips its own verb is the failure the old bar was rebuilt out of. -->
    <div class="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
        <!-- Capped and truncating, because this is the one part with no fixed length and the h1 beside it must
             not pay for a long repository name. The whole sentence stays one hover away. -->
        <span v-if="blocked" class="flex min-w-0 items-center gap-1.5 text-2xs text-warning" v-tooltip.bottom="blocked">
            <Icon name="exclamation-triangle" class="shrink-0" />
            <span class="max-w-[15rem] truncate">{{ blocked }}</span>
        </span>
        <span v-else-if="chosen > 0" class="text-2xs text-muted">{{ spend }}</span>

        <button v-if="narrowed" type="button" :class="cmp.linkButton(`text-2xs text-muted hover:text-content`)" @click="emit(`clear`)">Clear</button>

        <!-- A chip, not a button: it names a setting the run carries rather than doing anything. Quiet border,
             the app's own chip language (see TargetChip), so the one filled button in the header stays the one
             that spends money. -->
        <button
            ref="chip"
            type="button"
            class="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-content"
            v-tooltip.bottom="`Every test session runs on this model — one session per story`"
            :aria-label="`Model for this run: ${model.label}`"
            @click="choose"
        >
            <Icon name="sparkles" class="shrink-0 text-subtle" />
            <span class="max-w-[12rem] truncate">{{ model.label }}</span>
            <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
        </button>

        <Button
            :label="`Run ${narrowed ? storyCount(chosen) : `all ${storyCount(total)}`}`"
            size="small"
            :disabled="!canRun"
            @click="emit(`submit`, model)"
        >
            <template #icon><Icon name="play" /></template>
        </Button>
    </div>
</template>
