<!-- A tile's form, drawn wherever it is open: under the new connection's row, inside a connection's own row, or as a
     one-per-sandbox tile's whole page. Its buttons close it at the foot of its own content, never stuck over it. -->
<script setup lang="ts">
import type { CapabilityCatalogEntry, AddCapabilityInput } from "@intentic/capability-catalog";
import type { CapabilityRecommendation, CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { Button, Notice, type NoticeModel, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { startAgent } from "../../../models/fleet/agentActions";
import { advancedLabel, inlineField } from "../../../models/capabilities/form";
import CapabilityFieldRow from "../../../parts/capabilities/CapabilityFieldRow.vue";
import FieldHint from "../../../parts/capabilities/FieldHint.vue";
import HubTakeOffer from "../../../parts/sandbox/HubTakeOffer.vue";
import type { HubWant } from "@intentic/sandbox-contract/schemas/connection-hub";
import CapabilityFormStatus from "../CapabilityFormStatus.vue";
import { addsByItself, type CapabilityForm, takenNameWords } from "../capabilityForm";
import { type FormSlotContext, slotsOf } from "../kinds/kindSlots";
import type { useCapabilityProbe } from "../capabilityProbe";
import type { useCapabilitySubmit } from "../capabilitySubmit";
import { auditPrompt } from "../model/audit";
import type { useFieldStandIns } from "../model/fieldStandIns";
import { picksVersion } from "../model/refs";
import CapabilityContext from "./CapabilityContext.vue";
import FieldStandIn from "./FieldStandIn.vue";
import GitRefField from "./GitRefField.vue";

const t = useT();

const {
    entry,
    editing,
    sole,
    form,
    probe,
    standIns,
    saving,
    hosted = false,
    save,
    cancellable = false,
    guide = false,
} = defineProps<{
    entry: CapabilityCatalogEntry;
    /** The connection the form is over; undefined while it adds one. */
    editing: CapabilitySummary | undefined;
    /** A one-per-sandbox tile's one connection, which the fleet's Allow writes over. */
    sole?: CapabilitySummary | undefined;
    /** Every tile, for naming the one that already holds a taken name. */
    entries: readonly CapabilityCatalogEntry[];
    form: CapabilityForm;
    probe: ReturnType<typeof useCapabilityProbe>;
    standIns: ReturnType<typeof useFieldStandIns>;
    saving: ReturnType<typeof useCapabilitySubmit>;
    /** The fleet's Allow writes the card itself, with the page's add. */
    save: (input: AddCapabilityInput) => Promise<void>;
    hosted?: boolean;
    /** Why the scan badged this tile, while the form adds or edits its connection. */
    recommendation?: CapabilityRecommendation | undefined;
    dismissing?: boolean;
    /** Saved on the owner's computer from another sandbox: taken from there instead of filled in. */
    hubWant?: HubWant | undefined;
    /** There is a list to go back to, so Cancel closes this form's row. */
    cancellable?: boolean;
    /** The tile's guide and what it adds at the form's top, where the form is the page (a one-per-sandbox tile), on a pane too narrow for the side column. */
    guide?: boolean;
}>();

// `notice` carries null when the part that raised one takes it back.
const emit = defineEmits<{ notice: [NoticeModel | null]; dismiss: []; cancel: [] }>();

// Stable for the page's life: each is one ref the page created once, so taking them out of the composable keeps them live.
const { name, nameEdited, savedName, namePreview, nameHeld, nameProblem, values, attempted, shaking, pasteNotes, advancedOpen } = form;
const { probeResult, finishName, finishField, onFieldInput, onFieldPaste, fieldAlarm, fieldQuiet, fieldChecked, fieldUrlFix, applyUrlFix } = form;
const { fieldConfSummary, fieldPlaceholder, mainFields, advancedFields, versionToken, formSummary, liveEffects } = form;
const { auditable, updateFrom, submitLabel, changed } = form;
const { probing, canProbe, runProbe, meter: probeMeter } = probe;
const { submit, submitting, meter: submitMeter } = saving;

// The parts the tile's kind adds to its form, drawn with what they act on.
const parts = computed(() => {
    const slots = slotsOf(entry.kind);
    const context: FormSlotContext = { entry, editing, sole, form, save, submit, hosted, notice: (notice) => emit(`notice`, notice) };
    return { lead: slots.formLead?.(context), addLead: slots.addLead?.(context), extra: slots.formExtra?.(context) };
});

// Has an agent read the pinned code, or what an update changes, before the install is approved.
const startAudit = (): void => void startAgent(auditPrompt(name.value, values, updateFrom.value));

// An open connection that works and is as it was stored has nothing to save: the press comes once a value changes, or
// when the connection is not working, where saving it again is how it is retried.
const offersSave = computed(() => editing === undefined || changed.value || editing.status.state !== `active`);
// Cancel throws away what was typed: offered by a new connection's row, and by an open one once something changed.
const offersCancel = computed(() => cancellable && (editing === undefined || changed.value));
</script>

<template>
    <form class="flex flex-col gap-3" @submit.prevent="submit">
        <!-- Narrow panes only: above @3xl the page's side column carries the same guide beside the form. -->
        <CapabilityContext v-if="guide" :entry="entry" :values="values" :effects="liveEffects" class="@3xl:hidden" />

        <!-- What the tile's kind leads its form with (kindSlots.ts): FortiClient's own file to fill it from, the fleet's
             Allow. Keyed on the tile so switching tiles clears it. -->
        <component v-if="parts.lead" :is="parts.lead.is" :key="entry.id" v-bind="parts.lead.props" />
        <!-- Ways to fill a new connection's form by doing rather than typing: each fills the fields below it (a linked
             sandbox's pairing, a plugin registry's browse). -->
        <template v-if="editing === undefined">
            <component v-if="parts.addLead" :is="parts.addLead.is" :key="entry.id" v-bind="parts.addLead.props" />
            <HubTakeOffer v-if="hubWant" :want="hubWant" />
        </template>

        <!-- No name box while editing or on a singleton tile: renaming moves state a form can't (the row's Rename), so a
             second box here would be a lossy shortcut for it. -->
        <label v-if="!entry.singleton && editing === undefined" class="ui-field">
            <span class="ui-field-label">
                {{ t(`shared.name`) }}
                <FieldHint :label="t(`shared.name`)" :text="t(`capabilities.capabilities.whatAgentCallConnection`)" />
            </span>
            <input
                v-model="name"
                placeholder="my-tool"
                :class="[ui.input(), nameHeld.taken || (attempted && nameProblem) ? 'ui-field-error-box' : '']"
                @input="nameEdited = true"
                @blur="finishName"
            />
            <!-- A taken name is refused, not saved over, whichever tile holds it: this form holds the tile's defaults, which
                 would overwrite a live connection's settings (or its kind and platform). -->
            <span v-if="nameHeld.taken" class="ui-field-error">
                <Icon name="exclamation-triangle" class="text-2xs" />
                {{ takenNameWords(savedName, nameHeld, entries) }}
            </span>
            <span v-else-if="attempted && nameProblem" class="ui-field-error">
                <Icon name="exclamation-triangle" class="text-2xs" />
                {{ nameProblem }}
            </span>
            <!-- Shows the repair (spaces/punctuation to hyphens) rather than applying it silently; blur commits it. -->
            <span v-else-if="namePreview" class="mt-1 flex items-center gap-1 text-2xs text-muted">
                <Icon name="check" class="text-2xs text-success" />
                {{ t(`capabilities.capabilities.saved`) }} <span class="font-mono text-content">{{ namePreview }}</span>
            </span>
        </label>

        <!-- What the tile's kind adds before its fields: a device's access as a posture, a hosted machine's GPU note. -->
        <component v-if="parts.extra" :is="parts.extra.is" v-bind="parts.extra.props" />
        <!-- Main fields first, rarely-changed ones folded behind Advanced. -->
        <template v-for="field in mainFields(entry)" :key="field.key">
            <!-- An extension pins a commit, so that box is answered from the repository rather than typed into. -->
            <GitRefField
                v-if="picksVersion(entry, field)"
                :field="field"
                :values="values"
                :url="values['url'] ?? ''"
                :token="versionToken"
                :keeping="editing?.id"
                :alarm="fieldAlarm(field)"
                @left="finishField(field)"
            />
            <!-- A box answered by doing rather than typing: a key, a sign-in, the card a repository is read with. -->
            <FieldStandIn v-else-if="standIns.of(field)" v-bind="standIns.of(field)!" @left="finishField(field)" @paste="standIns.paste()" />
            <CapabilityFieldRow
                v-else
                :field="field"
                :values="values"
                :inline="inlineField(field)"
                :placeholder="fieldPlaceholder(field)"
                :alarm="fieldAlarm(field)"
                :quiet="fieldQuiet(field)"
                :checked="fieldChecked(field)"
                :url-fix="fieldUrlFix(field)"
                :note="pasteNotes[field.key]"
                :summary="fieldConfSummary(field)"
                @edited="onFieldInput(field)"
                @pasted="onFieldPaste(field, $event)"
                @left="finishField(field)"
                @fix="applyUrlFix(field)"
            />
        </template>
        <template v-if="advancedFields(entry).length > 0">
            <button type="button" :class="ui.textButton({ tone: `quiet` })" @click="advancedOpen = !advancedOpen">
                <Icon :name="advancedOpen ? 'chevron-down' : 'chevron-right'" class="text-2xs" />
                {{ advancedLabel(entry) }}
            </button>
            <template v-if="advancedOpen">
                <CapabilityFieldRow
                    v-for="field in advancedFields(entry)"
                    :key="field.key"
                    :field="field"
                    :values="values"
                    :inline="inlineField(field)"
                    :placeholder="fieldPlaceholder(field)"
                    :alarm="fieldAlarm(field)"
                    :quiet="fieldQuiet(field)"
                    :checked="fieldChecked(field)"
                    :url-fix="fieldUrlFix(field)"
                    :note="pasteNotes[field.key]"
                    :summary="fieldConfSummary(field)"
                    @edited="onFieldInput(field)"
                    @pasted="onFieldPaste(field, $event)"
                    @left="finishField(field)"
                    @fix="applyUrlFix(field)"
                />
            </template>
        </template>
        <!-- The sentence the answers add up to, computed live so it matches what submit actually agrees to. -->
        <p v-if="formSummary" class="flex items-start gap-2 text-xs text-muted">
            <Icon name="info-circle" class="shrink-0 text-2xs text-subtle" />
            {{ formSummary }}
        </p>

        <!-- Why the grid badged this one: the claim plus the evidence that produced it, which "Not needed" dismisses. -->
        <Notice v-if="recommendation" tone="info">
            <div class="flex items-start gap-3">
                <div class="min-w-0 flex-1">
                    <div>{{ t(`capabilities.capabilities.recommended`, { reason: recommendation.reason }) }}</div>
                    <div class="mt-0.5 truncate font-mono text-2xs text-subtle">{{ recommendation.evidence }}</div>
                </div>
                <Button :label="t(`capabilities.capabilities.notNeeded`)" size="small" tier="quiet" :loading="dismissing" @click="emit(`dismiss`)" />
            </div>
        </Notice>

        <!-- What the probe said, and the save or test still running (CapabilityFormStatus). -->
        <CapabilityFormStatus :probe-result="probeResult" :submit-meter="submitMeter" :probe-meter="probeMeter" />

        <!-- The form's last line, after everything it acts on, so nothing it holds is ever under it. A card whose own press
             adds it (a pairing, Allow) shows the by-hand Add only once that way is taken. -->
        <div
            v-if="!addsByItself(entry, editing, advancedOpen, values)"
            :class="['flex flex-wrap items-center justify-end gap-2 pt-1', shaking ? 'ui-shake' : '']"
            @animationend="shaking = false"
        >
            <!-- The read sits beside the approval, since that's when it matters. -->
            <button v-if="auditable" type="button" :class="ui.textButton({ size: `xs` }, `mr-auto`)" @click="startAudit">
                {{ updateFrom !== undefined ? t(`capabilities.capabilities.agentReadWhatChanged`) : t(`capabilities.capabilities.agentReadFirstWhat`) }}
            </button>
            <Button v-if="offersCancel" :label="t(`ui.action.cancel`)" size="small" tier="quiet" @click="emit(`cancel`)" />
            <!-- Testing is optional and stays secondary to Save; hidden once a tile has answered that no test exists (canProbe). -->
            <Button v-if="canProbe" :label="t(`capabilities.capabilities.test`)" size="small" tier="boring" :loading="probing" @click="runProbe">
                <template #icon><Icon name="wave-pulse" /></template>
            </Button>
            <Button v-if="offersSave" tier="accent" type="submit" size="small" :label="submitLabel" :loading="submitting">
                <template #icon><Icon name="check" /></template>
            </Button>
        </div>
    </form>
</template>
