<!-- When a draft stops on its own, said in a line ("Never", "After its first fire", "On Nov 4, 09:00"); pressed, the panel where that is chosen. -->
<script setup lang="ts">
import { formatDateTime } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import PropertyPopover from "../properties/PropertyPopover.vue";
import PropertyRow from "../properties/PropertyRow.vue";
import { EDITABLE_VALUE } from "../properties/propertyLook";
import EndsFields from "../schedule/EndsFields.vue";
import type { AutomationFormState } from "../useAutomationForm";
import { t } from "../i18n.js";

const props = defineProps<{ state: AutomationFormState }>();
const { form, expiresAt, expiresError, touched, markTouched } = props.state;

const said = computed(() => {
    const dated = form.expiresAt !== `` && !Number.isNaN(expiresAt.value);
    if (form.stopAfterFirst && dated) {
        return t(`endsProperty.firstOrDate`, { at: formatDateTime(expiresAt.value) });
    }
    if (form.stopAfterFirst) {
        return t(`endsProperty.first`);
    }
    return dated ? t(`endsProperty.on`, { at: formatDateTime(expiresAt.value) }) : t(`endsProperty.never`);
});
const shownError = computed(() => (touched.has(`expiresAt`) ? expiresError.value : undefined));

const anchor = ref<HTMLElement>();
const open = ref(false);
let before = { stopAfterFirst: form.stopAfterFirst, expiresAt: form.expiresAt };
const begin = (): void => {
    before = { stopAfterFirst: form.stopAfterFirst, expiresAt: form.expiresAt };
    open.value = true;
};
const cancel = (): void => {
    Object.assign(form, before);
};
</script>

<template>
    <PropertyRow :label="t(`automationFields.endsOn`)">
        <button ref="anchor" type="button" :class="EDITABLE_VALUE" :aria-label="t(`endsProperty.change`, { now: said })" @click="begin">
            <span class="text-sm text-content">{{ said }}</span>
            <span v-if="shownError" class="text-xs text-danger">{{ shownError }}</span>
        </button>

        <PropertyPopover v-model="open" :anchor="anchor" :header="t(`automationFields.endsOn`)" @save="open = false" @cancel="cancel">
            <EndsFields
                v-model:stop-after-first="form.stopAfterFirst"
                v-model:expires-at="form.expiresAt"
                :at="expiresAt"
                :error="expiresError"
                @update:expires-at="markTouched(`expiresAt`)"
            />
        </PropertyPopover>
    </PropertyRow>
</template>
