<!-- A secret's value, as its open row shows it: hidden until asked for, and every way to use it beside it (show, copy, replace, type into a window), each opening where it was pressed. -->
<script setup lang="ts">
import { Button, CopyButton, Notice, type NoticeModel, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { reveal } from "../../../../models/capabilities/useSecrets";
import { keyringSourceNote } from "./keyringWords";
import { useKeyrings } from "./useKeyrings";
import SecretField from "../../../../parts/capabilities/SecretField.vue";
import SecretFact from "./SecretFact.vue";
import SecretPopover from "./SecretPopover.vue";
import SecretTypeInto from "./SecretTypeInto.vue";
import { EDITABLE_VALUE, VALUE_NOTE } from "./secretLook";

const t = useT();

const {
    row,
    canReveal,
    canType,
    error = undefined,
} = defineProps<{
    row: SecretRow;
    /** A value exists and this reader may read it (the daemon reveals one to whoever runs secrets, a gated one to its approvers). */
    canReveal: boolean;
    /** A computer with a keyring answers, and the value is stored under a name Type into… takes. */
    canType: boolean;
    /** Why the last reveal was refused. */
    error?: NoticeModel | undefined;
}>();

// Held by the row, so the header's own buttons on a closed row open it straight onto the same place.
const revealed = defineModel<string | undefined>("revealed", { required: true });
const replacing = defineModel<boolean>("replacing", { required: true });
const typing = defineModel<boolean>("typing", { required: true });
const emit = defineEmits<{ reveal: [] }>();

const missing = computed(() => row.entry.status === `missing`);
// A keyring's own entry: the value stays on that computer, and the only thing to do with it here is type it there.
const machine = computed(() => row.entry.device?.machine);
// An SSH key or a PEM block needs a box with lines; most values are one line.
const multiline = ref(false);

// Which computers answer now, for the Type into… press to say whether it can type anywhere.
const { online } = useKeyrings();

// A value nobody has asked to see: a fixed row of dots, so its length says nothing about the secret's.
const MASKED = `••••••••`;
const MASK = `select-none font-mono text-sm tracking-wider text-subtle`;
const ICON_ACTION = ui.iconButton({ tone: `subtle` });

// What each panel hangs off: the press that opened it.
const replaceAnchor = ref<HTMLElement>();
const typeAnchor = ref<HTMLElement>();
</script>

<template>
    <SecretFact :label="t(`capabilities.secretEntryRow.value`)">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 py-0.5">
            <template v-if="missing">
                <span class="text-sm text-warning">{{ t(`capabilities.secretEntryRow.notSet`) }}</span>
                <span v-if="row.editable" ref="replaceAnchor" class="inline-flex">
                    <Button size="small" tier="accent" :label="t(`capabilities.secretEntryRow.setValue`)" @click="replacing = true" />
                </span>
            </template>
            <template v-else-if="machine !== undefined">
                <span class="text-sm text-content">{{ t(`capabilities.secretEntryRow.staysOn`, { machine }) }}</span>
            </template>
            <template v-else>
                <!-- The value itself once asked for, in full: wrapped rather than cut, since a key is read character by character. -->
                <code
                    v-if="revealed !== undefined"
                    class="block max-h-48 basis-full overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5 text-content"
                    data-secret-value
                    >{{ revealed }}</code
                >
                <!-- Hidden, the value is where it is replaced, as every other answer on the row is where it is changed. -->
                <button
                    v-else-if="row.editable"
                    ref="replaceAnchor"
                    v-tooltip.top="t(`capabilities.secretEntryRow.replaceValue`)"
                    type="button"
                    :class="EDITABLE_VALUE"
                    :aria-label="t(`capabilities.secretEntryRow.replaceValue`)"
                    @click="replacing = true"
                >
                    <span :class="MASK">{{ MASKED }}</span>
                </button>
                <span v-else :class="MASK" aria-hidden="true">{{ MASKED }}</span>
                <span v-if="canReveal" class="flex items-center gap-0.5">
                    <button
                        v-tooltip.top="revealed === undefined ? t(`capabilities.secretEntryRow.show`) : t(`capabilities.secretEntryRow.hide`)"
                        type="button"
                        :class="ICON_ACTION"
                        :aria-label="revealed === undefined ? t(`capabilities.secretEntryRow.revealValueWho`) : t(`capabilities.words.hideValue`)"
                        :aria-pressed="revealed !== undefined"
                        @click="emit(`reveal`)"
                    >
                        <Icon :name="revealed === undefined ? `eye` : `eye-slash`" class="text-xs" />
                    </button>
                    <CopyButton v-tooltip.top="t(`capabilities.secretEntryRow.copyValue`)" :text="() => revealed ?? reveal(row.entry.key)" />
                </span>
            </template>
            <button
                v-if="canType"
                ref="typeAnchor"
                v-tooltip.top="{
                    title: t(`capabilities.typeInto.title`),
                    note: online.length > 0 ? t(`capabilities.typeInto.tooltipNote`) : t(`capabilities.typeInto.noneOnlineShort`),
                }"
                type="button"
                :class="ICON_ACTION"
                :aria-label="t(`capabilities.typeInto.title`)"
                :aria-pressed="typing"
                @click="typing = !typing"
            >
                <Icon name="keyboard-tab" class="text-xs" />
            </button>
        </div>
        <span v-if="row.entry.device !== undefined" :class="VALUE_NOTE">{{ keyringSourceNote(row.entry.device.source) }}</span>
        <!-- A gated value is shown to its approvers alone, whoever else runs secrets. -->
        <span v-else-if="!missing && !canReveal" :class="VALUE_NOTE">{{
            row.entry.gate === undefined ? t(`capabilities.secretEntryRow.whoSees`) : t(`capabilities.secretEntryRow.approversSee`)
        }}</span>
        <Notice v-if="error" :of="error" class="mt-1" />

        <SecretPopover
            v-model="replacing"
            :anchor="replaceAnchor"
            :header="missing ? t(`capabilities.secretEntryRow.setValue`) : t(`capabilities.secretEntryRow.replaceValue`)"
            wide
            bare
            focus-field
        >
            <SecretField
                :secret-key="row.entry.key"
                :capability-id="row.entry.kind === `capability` ? row.entry.key : undefined"
                :multiline="multiline"
                no-hint
                cancellable
                @saved="replacing = false"
                @cancel="replacing = false"
            />
            <button type="button" :class="ui.textButton({ size: `xs` }, `self-start`)" @click="multiline = !multiline">
                {{ multiline ? t(`capabilities.secretEntryRow.singleLineValue`) : t(`capabilities.secretEntryRow.multiLineValueSsh`) }}
            </button>
        </SecretPopover>

        <SecretPopover v-model="typing" :anchor="typeAnchor" :header="t(`capabilities.typeInto.title`)" bare>
            <SecretTypeInto :row="row" />
        </SecretPopover>
    </SecretFact>
</template>
