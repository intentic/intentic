<script setup lang="ts">
import Button from "primevue/button";
import { type ComponentPublicInstance, computed, ref } from "vue";
import Icon from "./Icon.vue";
import type { IconName } from "../icons/iconSets.js";

/* THE BUTTON THAT STARTS AN AGENT FOR YOU: Fix with agent on a red pipeline, Ask the agent to fix on a broken
 * container, Run a chore, Run all 21 stories. One component, because they are one act, and until it existed the
 * app answered the same question three different ways: a one-click button whose tooltip merely NAMED the model
 * it was about to spend (pipelines, deployments, maintenance, documentation), a separate chip beside the button
 * (acceptance), and a full editable draft box (a failed pre-push check). The first of those had no way to
 * deviate at all, which is the complaint this component was written for: the one moment you want a bigger model
 * is the failure that just beat the standing one, and the answer was a trip to a settings page.
 *
 * A SPLIT BUTTON, so the common case keeps costing one click. The primary half does exactly what it did before
 *: starts the run on Sandbox ▸ Agent ▸ Models' standing list, and the caret is a second, quieter affordance
 * for the run that wants something else. That asymmetry is the design: pressing Fix should not become a
 * two-step decision because deviating is occasionally useful.
 *
 * IT NAMES THE MODEL ONLY WHEN THAT IS NEWS. On the standing setting the caret is a bare chevron and the model
 * lives in its tooltip: a list of twenty red pipeline rows each spelling out "Claude Sonnet 4.6" is twenty
 * copies of one fact nobody is reading. Once the user picks something else the label appears inline, because a
 * deviation that is invisible is a deviation you forget you made and then pay for.
 *
 * THE CARET HANDS BACK ITS OWN ELEMENT rather than raising the picker itself. The picker is not a widget: it
 * is a live read of every connected provider's catalog and which credentials the sandbox holds, so it stays
 * the host's (useAgentRunPick's `ModelPicking` is the seam). Anchoring to the element matters in a popped-out
 * panel, where an overlay measured against the opener's window opens off the bottom edge.
 *
 * A HAIRLINE GAP, not a shared border. The two halves carry the same fill, so one pixel of page showing between
 * them reads as the divider, and it keeps reading as one on every severity and in both themes, which a border
 * colour picked against one of them does not. On the borderless `text` variant there is no fill, the gap
 * disappears, and two quiet controls beside each other is exactly right. */

const {
    label,
    modelLabel,
    overridden = false,
    severity = undefined,
    size = `small`,
    text = false,
    icon = undefined,
    loading = false,
    disabled = false,
    hint = undefined,
} = defineProps<{
    label: string;
    // What the run will open on, already resolved by the caller (useAgentRunPick). Undefined ⇒ nothing pinned
    // and nothing picked, so there is nothing honest to promise and the caret says so instead of guessing.
    modelLabel?: string | undefined;
    // Whether that is the user's own pick rather than the sandbox's standing list.
    overridden?: boolean;
    severity?: string | undefined;
    size?: string;
    text?: boolean;
    icon?: IconName | undefined;
    loading?: boolean;
    disabled?: boolean;
    // The caller's own reason for the button, shown on the primary half. What the run costs is the caret's
    // business, so the two never fight over one tooltip.
    hint?: string | undefined;
}>();
const emit = defineEmits<{ run: []; pick: [HTMLElement] }>();

// The caret's own DOM node, which is what the picker anchors to. PrimeVue's Button types its instance without
// `$el`, so the ref is taken as the generic public instance the runtime actually hands back.
const caret = ref<ComponentPublicInstance>();

/* WHAT THE CARET PROMISES, in the one place a caret can say anything. Three states and they are genuinely
 * different: a run on the sandbox's standing order, a run the user has just re-pointed, and a sandbox that has
 * pinned nothing, where the honest answer is the composer's own model rather than a name this button invents. */
const caretHint = computed(() =>
    modelLabel === undefined
        ? `Opens on whatever your chat composer is set to. Click to run this one on a specific model.`
        : overridden
          ? `This run only: ${modelLabel}. Click to change it, or pick the sandbox default to go back.`
          : `Opens an isolated agent on ${modelLabel}, the sandbox default. Click to run this one on something else.`,
);

const openPicker = (): void => {
    const el = caret.value?.$el as HTMLElement | undefined;
    if (el !== undefined) {
        emit(`pick`, el);
    }
};
</script>

<template>
    <span class="inline-flex items-stretch gap-px">
        <!-- The inner edges are trimmed on the BORDERLESS variant only. With no fill to join them, the two lots
             of horizontal padding read as a gap between two separate controls rather than as one split button.
             A filled button needs no help, and taking its padding would sit the divider against the label. -->
        <Button
            :label="label"
            :size="size"
            :severity="severity"
            :text="text"
            :loading="loading"
            :disabled="disabled"
            :class="['rounded-r-none', text ? 'pr-1' : '']"
            v-tooltip.top="hint"
            @click="emit(`run`)"
        >
            <template v-if="icon" #icon><Icon :name="icon" /></template>
        </Button>
        <!-- Disabled with the primary half and never on its own: a caret that stayed live while the run it
             configures could not be started would let someone choose a model for a click that does nothing.
             It does NOT take the loading spinner, though: one spinner per action is the whole point of it. -->
        <Button
            ref="caret"
            :size="size"
            :severity="severity"
            :text="text"
            :disabled="disabled || loading"
            :class="['rounded-l-none', text ? 'pl-1 pr-1.5' : 'px-1.5']"
            :aria-label="modelLabel === undefined ? `Choose a model for this run` : `Model for this run: ${modelLabel}`"
            v-tooltip.top="caretHint"
            @click="openPicker"
        >
            <!-- The deviation, spelled out where the chevron alone would have been. Capped and truncating: a
                 model name is the one part of this control with no fixed length, and the whole of it stays one
                 hover away on the tooltip above. -->
            <span class="flex items-center gap-1">
                <template v-if="overridden && modelLabel !== undefined">
                    <Icon name="sparkles" class="shrink-0 text-2xs" />
                    <span class="max-w-[9rem] truncate text-2xs">{{ modelLabel }}</span>
                </template>
                <Icon name="chevron-down" class="shrink-0 text-2xs" />
            </span>
        </Button>
    </span>
</template>
