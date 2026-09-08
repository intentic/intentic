<script setup lang="ts">
import Button from "../primitives/Button.vue";
import { type ComponentPublicInstance, computed, ref } from "vue";
import Icon from "../primitives/Icon.vue";
import type { AgentRunPicker } from "../../composables/useAgentRunPick.js";
import type { IconName } from "../../icons/iconSets.js";

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
 * AND THE CARET COSTS ONE CLICK TOO, WHICH IS THE HALF THAT WAS BROKEN. It used to open a panel that could only
 * be LEFT: choosing a model closed it, but choosing an account or a tier did not, so the way out of a finished
 * configuration was to click away and then press Fix a second time — two acts for one intention, with a
 * dismissal doing the work of an answer in between. The panel now ends in a bar carrying this button's own
 * label, so the press that finishes configuring the run is the press that starts it. Both halves therefore emit
 * the same `run`, and the call site cannot tell (or care) which one the user took.
 *
 * IT NAMES THE SPEND ONLY WHEN THAT IS NEWS, and the spend is the model AND the tier it thinks at. On the
 * standing setting the caret is a bare chevron and both live in its tooltip: a list of twenty red pipeline rows
 * each spelling out "Claude Sonnet 4.6 · High" is twenty copies of one fact nobody is reading. Once the user
 * picks something ELSE the label appears inline, because a deviation that is invisible is a deviation you forget
 * you made and then pay for. A pick that matches the standing order is not a deviation and says nothing, which
 * is what `overridden` compares for (useAgentRunPick).
 *
 * ONE PROP FOR THE WHOLE CHOICE, the picker itself, rather than the four derived values this used to take. Those
 * four (`modelLabel`, `effortLabel`, `overridden`, `@pick`) had to be wired from the same `useAgentRunPick` at
 * every call site and nothing checked that they were: a row could name one picker's model above another
 * picker's caret and look entirely correct while lying about what a click would spend. The picker is the unit;
 * passing it whole is what makes that unrepresentable.
 *
 * THE CARET HANDS ITS OWN ELEMENT to the picker rather than raising one. The picker is not a widget: it is a
 * live read of every connected provider's catalog and which credentials the sandbox holds, so it stays the
 * host's (useAgentRunPick's `ModelPicking` is the seam). Anchoring to the element matters in a popped-out panel,
 * where an overlay measured against the opener's window opens off the bottom edge.
 *
 * A HAIRLINE GAP, not a shared border. The two halves carry the same fill, so one pixel of page showing between
 * them reads as the divider, and it keeps reading as one on every severity and in both themes, which a border
 * colour picked against one of them does not. On the borderless `text` variant there is no fill, the gap
 * disappears, and two quiet controls beside each other is exactly right. */

const {
    label,
    picker,
    severity = undefined,
    size = `small`,
    text = false,
    icon = undefined,
    loading = false,
    disabled = false,
    hint = undefined,
} = defineProps<{
    // The primary half's words, and the verb the picker's own commit bar wears: the panel a caret opens is
    // closed by a button saying the same thing the button beside it says.
    label: string;
    /* WHAT THIS RUN OPENS ON AND HOW TO RE-POINT IT, whole (useAgentRunPick). It carries the resolved model, the
     * tier, whether either is a deviation, and the way to open the panel — every one of which this button either
     * shows or drives, and all of which have to agree with each other. */
    picker: AgentRunPicker;
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
const emit = defineEmits<{ run: [] }>();

// The caret's own DOM node, which is what the picker anchors to. PrimeVue's Button types its instance without
// `$el`, so the ref is taken as the generic public instance the runtime actually hands back.
const caret = ref<ComponentPublicInstance>();

const overridden = computed(() => picker.overridden.value);
const modelLabel = computed(() => picker.model.value.label);

/* THE MODEL, THE TIER AND THE RATE AS ONE PHRASE, since they are one fact about what the click costs and are
 * read together everywhere else in the app ("Sonnet 4.6 · High", the settings list's own line). A run with no
 * tier pinned is just the model: the provider's default is not news. Fast speed is, because it is bought at a
 * higher price, so it is the one knob of the three that earns a word here — extended thinking changes what the
 * turn does rather than what it costs, and lives in the panel that sets it. */
const spend = computed(() => {
    const choice = picker.model.value;
    return [choice.label, ...(choice.effortLabel === undefined ? [] : [choice.effortLabel]), ...(choice.fast === true ? [`Fast`] : [])].join(` · `);
});

/* WHAT THE CARET PROMISES, in the one place a caret can say anything. Two states, and they are genuinely
 * different: a run on the sandbox's standing order for this job, and a run the user has just re-pointed. There
 * is no third: a sandbox that has pinned nothing for this job resolves to the owner's own composer model, which
 * the host names for us, so the caret always has something true to say. */
const caretHint = computed(() =>
    overridden.value
        ? `This run only: ${spend.value}. Click to change it, or pick the sandbox default to go back.`
        : `Opens an isolated agent on ${spend.value}, the sandbox default. Click to configure this run and start it.`,
);

/* ONE ACT: configure the run, and start it. `choose` answers true when the user pressed the panel's own button,
 * which is the same press as the primary half's and therefore the same `run`. A dismissal answers false and
 * nothing happens — which is what Escape has always looked like and, until the panel grew a button of its own,
 * emphatically not what it did.
 *
 * IT RETURNS VOID, DELIBERATELY, and this is the one thing about it that is easy to get wrong. <Button> reads
 * its click listener off attrs and watches the RETURN VALUE: a handler that hands back a promise is a button
 * that locks and grows a spinner until it settles (see the header there). That is exactly right for a save and
 * exactly wrong here — the promise this returns is open for as long as the panel is, so the caret would lock and
 * spin under the very overlay it is anchoring, for the whole time the user spends configuring the run. */
const openPicker = (): void => {
    const el = caret.value?.$el as HTMLElement | undefined;
    if (el === undefined) {
        return;
    }
    void picker.choose(el, label).then((committed) => {
        if (committed) {
            emit(`run`);
        }
    });
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
            :aria-label="`Configure and start this run — ${spend}`"
            v-tooltip.top="caretHint"
            @click="openPicker"
        >
            <!-- The deviation, spelled out where the chevron alone would have been: the model AND the tier, since
                 a run re-pointed to Max on the model it was already on is a deviation that costs money and would
                 otherwise be invisible.
                 THE MODEL IS THE HALF THAT TRUNCATES, and the cap is on it alone. A model name is the one part
                 of this control with no fixed length ("GPT-5.6 Codex Mini High Fidelity"), while a tier is one
                 short word — and it is the half that is NEWS, since it was invisible before and is what the
                 caret was reached for. One capped string would have cut the tier off the end of every long
                 name. The whole of it stays one hover away on the tooltip above. -->
            <span class="flex items-center gap-1">
                <template v-if="overridden">
                    <Icon name="sparkles" class="shrink-0 text-2xs" />
                    <span class="max-w-[9rem] truncate text-2xs">{{ modelLabel }}</span>
                    <span v-if="picker.model.value.effortLabel !== undefined" class="shrink-0 text-2xs">· {{ picker.model.value.effortLabel }}</span>
                </template>
                <Icon name="chevron-down" class="shrink-0 text-2xs" />
            </span>
        </Button>
    </span>
</template>
