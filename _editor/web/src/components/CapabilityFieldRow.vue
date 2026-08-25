<!-- ONE FIELD OF A CAPABILITY'S FORM, in whichever of its two shapes the field earns (see inlineField(): a
     switch or a short picker answers beside its label, everything else stacks), with the one line under the box
     that says the most useful true thing right now. The page owns every decision (what is alarmed, what was
     pasted, what a blob was read as) and hands the verdicts down as props; this component only draws them, so
     the main fields and the Advanced group render one field the same way without the template existing twice. -->
<script setup lang="ts">
import type { CapabilityField } from "@intentic/extension-manifest";
import { SegmentedControl, StatusBadge, ui } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import type { ConfSummary } from "../pages/capabilities/normalize";

const { field, values } = defineProps<{
    field: CapabilityField;
    /** The form's live answers: the row reads and writes its own key, reactivity is the caller's object. */
    values: Record<string, string>;
    inline: boolean;
    placeholder?: string | undefined;
    /** The red treatment: a malformed value, or a required box still empty after a refused submit. */
    alarm?: string | undefined;
    /** The muted "Required." for an empty box merely tabbed past. */
    quiet?: boolean;
    /** The green check for a value a rule can vouch for. */
    checked?: boolean;
    /** The container-reachable rewrite of a URL that points at localhost, offered as a one-click fix. */
    urlFix?: string | undefined;
    /** The one-line account of what a recognised paste was unpacked into. */
    note?: string | undefined;
    /** What a config blob was read as (WireGuard), warning when it is recognisably broken. */
    summary?: ConfSummary | undefined;
}>();

const emit = defineEmits<{ edited: []; pasted: [event: ClipboardEvent]; left: []; fix: [] }>();
</script>

<template>
    <!-- AN ANSWERED QUESTION SITS BESIDE ITS LABEL, NOT UNDER IT: see inlineField() for where the line is
         drawn and why it is drawn on the width of the answers rather than on their number. -->
    <label v-if="inline" class="flex items-start justify-between gap-4">
        <span class="min-w-0">
            <span class="ui-field-label">{{ field.label }}</span>
            <StatusBadge v-if="field.rebuild" variant="neutral" size="xs" label="needs rebuild" class="ml-1.5 align-middle" />
            <span v-if="field.hint" class="mt-0.5 block text-2xs text-muted">{{ field.hint }}</span>
        </span>
        <ToggleSwitch
            v-if="field.boolean"
            class="ui-switch-sm mt-0.5 shrink-0"
            :model-value="values[field.key] === 'on'"
            :aria-label="field.label"
            @update:model-value="(value: boolean) => (values[field.key] = value ? 'on' : 'off')"
        />
        <SegmentedControl
            v-else
            class="shrink-0"
            :model-value="values[field.key] ?? ''"
            :options="[...(field.options ?? [])]"
            @update:model-value="values[field.key] = $event"
        />
    </label>
    <label v-else class="ui-field">
        <span class="ui-field-label">
            {{ field.label }}{{ field.optional ? " (optional)" : "" }}
            <StatusBadge v-if="field.rebuild" variant="neutral" size="xs" label="needs rebuild" class="ml-1.5 align-middle" />
            <!-- The check a rule can vouch for (a URL that parses, a full sha, a port in range), on the label
                 where the eye returns after a paste. -->
            <Icon v-if="checked" name="check-circle" class="ml-1 align-middle text-2xs text-success" />
        </span>
        <SegmentedControl
            v-if="field.options"
            wrap
            :model-value="values[field.key] ?? ''"
            :options="[...field.options]"
            @update:model-value="values[field.key] = $event"
        />
        <textarea
            v-else-if="field.multiline"
            v-model="values[field.key]"
            :placeholder="placeholder"
            rows="6"
            spellcheck="false"
            :class="[ui.input('font-mono resize-y'), alarm ? 'ui-field-input-error' : '']"
            @input="emit('edited')"
            @paste="emit('pasted', $event)"
            @blur="emit('left')"
        />
        <input
            v-else
            v-model="values[field.key]"
            :type="field.secret ? 'password' : 'text'"
            :autocomplete="field.secret ? 'off' : undefined"
            :placeholder="placeholder"
            :class="[ui.input(), alarm ? 'ui-field-input-error' : '']"
            @input="emit('edited')"
            @paste="emit('pasted', $event)"
            @blur="emit('left')"
        />
        <!-- What sits under the box, one line, by severity: a real refusal in red; the localhost trap's
             one-click fix; a quiet "Required" for a box merely tabbed past; the account of what a paste was
             unpacked into; what a config blob was read as; the field's own hint. -->
        <span v-if="alarm" class="ui-field-error">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ alarm }}
        </span>
        <!-- The fix is a LINK, underlined, because the sentence beside it is a diagnosis and this is the act:
             at the same weight and colour as the warning it sits in, it reads as more of the warning. -->
        <span v-else-if="urlFix" class="flex flex-wrap items-center gap-x-1.5 text-2xs text-warning">
            <Icon name="exclamation-triangle" class="text-2xs" />
            The sandbox is a container: localhost points at the sandbox itself.
            <button type="button" :class="ui.linkButton(`text-2xs underline`)" @click.prevent="emit('fix')">Use host.docker.internal</button>
        </span>
        <span v-else-if="quiet" class="text-2xs text-subtle">Required.</span>
        <span v-else-if="note" class="flex items-center gap-1 text-2xs text-success">
            <Icon name="check-circle" class="text-2xs" />
            {{ note }}
        </span>
        <span v-else-if="summary" class="flex items-center gap-1 text-2xs" :class="summary.warning ? 'text-warning' : 'text-muted'">
            <Icon :name="summary.warning ? 'exclamation-triangle' : 'check-circle'" class="text-2xs" :class="summary.warning ? '' : 'text-success'" />
            {{ summary.text }}
        </span>
        <span v-else-if="field.hint" class="text-2xs text-muted">{{ field.hint }}</span>
    </label>
</template>
