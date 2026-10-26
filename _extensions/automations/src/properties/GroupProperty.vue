<!-- Which shelf an automation is filed on: the group it names, or the one it falls on by itself, changed where it is shown. -->
<script setup lang="ts">
import type { Automation, AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { ui } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { useAutomations } from "../useAutomations";
import { useShelves } from "../shelves/useShelves";
import PropertyPopover from "./PropertyPopover.vue";
import PropertyRow from "./PropertyRow.vue";
import { EDITABLE_VALUE } from "./propertyLook";
import { useAutomationPatch } from "./useAutomationPatch";
import { t } from "../i18n.js";

const props = defineProps<{ automation: AutomationSummary }>();

// The shelf it sits on now, and why, so a reader can tell a group somebody typed from one it fell into.
const { automations } = useAutomations();
const { placeOf } = useShelves(automations);
const shelf = computed(() => placeOf(props.automation));
const why = computed<string | undefined>(() =>
    ({ group: undefined, chores: t(`groupProperty.byChore`), persona: t(`groupProperty.byPersona`), other: t(`groupProperty.byNothing`) })[shelf.value.kind],
);

// Every group already named, as one-press choices: filing two jobs together means the same word, and a near miss
// ("Marketting") would quietly make a second shelf.
const named = computed(() =>
    [...new Set(automations.value.flatMap((automation) => (automation.group === undefined ? [] : [automation.group.trim()])))].toSorted((a, b) =>
        a.localeCompare(b),
    ),
);

const anchor = ref<HTMLElement>();
const open = ref(false);
const draft = ref(``);
const { patch, error, saving } = useAutomationPatch(computed(() => props.automation));

const begin = (): void => {
    draft.value = props.automation.group ?? ``;
    error.value = undefined;
    open.value = true;
};

// Blank files it by itself again (grouping.ts): by persona, or with the chores. Enter reaches this as directly as Save
// does, so a held key must not write twice while the first write is out.
const submitting = ref(false);
const save = async (): Promise<void> => {
    if (submitting.value) {
        return;
    }
    submitting.value = true;
    const group = draft.value.trim();
    try {
        const saved = await patch((stored) => {
            const next: Automation = { ...stored, group };
            if (group === ``) {
                delete next.group;
            }
            return next;
        });
        if (saved) {
            open.value = false;
        }
    } finally {
        submitting.value = false;
    }
};
</script>

<template>
    <PropertyRow :label="t(`groupProperty.group`)">
        <button ref="anchor" type="button" :class="EDITABLE_VALUE" :aria-label="t(`groupProperty.change`, { now: shelf.label })" @click="begin">
            <span class="text-sm text-content">{{ shelf.label }}</span>
            <span v-if="why" class="text-xs text-subtle">{{ why }}</span>
        </button>

        <PropertyPopover v-model="open" :anchor="anchor" :header="t(`groupProperty.group`)" :saving="saving" :error="error" @save="save">
            <label class="ui-field">
                <span class="ui-field-label">{{ t(`groupProperty.group`) }}</span>
                <input v-model="draft" maxlength="40" :placeholder="t(`groupProperty.placeholder`)" :class="ui.input()" @keydown.enter.prevent="save" />
                <span class="text-xs text-subtle">{{ t(`groupProperty.hint`) }}</span>
            </label>
            <div v-if="named.length > 0" class="flex flex-wrap gap-1.5">
                <button
                    v-for="name in named"
                    :key="name"
                    type="button"
                    :class="ui.chip({ on: draft.trim().toLocaleLowerCase() === name.toLocaleLowerCase() })"
                    @click="draft = name"
                >
                    {{ name }}
                </button>
            </div>
        </PropertyPopover>
    </PropertyRow>
</template>
