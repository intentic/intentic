<!-- The settings a reader changes most from here: the curator's rules, its switch after a poll, and the Nostr relays. The
     rest stay on the Extensions tab, where every setting of every extension is. -->
<script setup lang="ts">
import { Button, RowGroup, RowNote, ToggleSwitch, ui } from "@intentic/extension-ui";
import { ref, watch } from "vue";
import { host } from "./host";
import { t } from "./i18n.js";
import type { Settings } from "./wire";

const { settings, canWrite } = defineProps<{ settings: Settings; canWrite: boolean }>();
const emit = defineEmits<{ saved: [] }>();

const rules = ref(settings.curationRules);
const relays = ref(settings.nostrRelays);
const autoCurate = ref(settings.autoCurate);
const saving = ref(false);
watch(
    () => settings,
    (next) => {
        rules.value = next.curationRules;
        relays.value = next.nostrRelays;
        autoCurate.value = next.autoCurate;
    },
);

const save = async (): Promise<void> => {
    saving.value = true;
    try {
        const api = host();
        await api.settings.set(`curationRules`, rules.value);
        await api.settings.set(`nostrRelays`, relays.value);
        await api.settings.set(`autoCurate`, autoCurate.value);
        emit(`saved`);
    } finally {
        saving.value = false;
    }
};
</script>

<template>
    <RowGroup :label="t(`settings.title`)">
        <RowNote variant="block"><div class="flex flex-col gap-3">
            <label class="flex flex-col gap-1 text-xs">
                <span class="text-muted">{{ t(`settings.rules`) }}</span>
                <textarea v-model="rules" :class="ui.input({}, `min-h-32`)" :disabled="!canWrite" maxlength="10000" />
                <span class="text-2xs text-subtle">{{ t(`settings.rulesHint`) }}</span>
            </label>
            <label class="flex items-center gap-2 text-xs">
                <ToggleSwitch v-model="autoCurate" :disabled="!canWrite" />
                <span>{{ t(`settings.autoCurate`) }}</span>
            </label>
            <label class="flex flex-col gap-1 text-xs">
                <span class="text-muted">{{ t(`settings.relays`) }}</span>
                <textarea v-model="relays" :class="ui.input({}, `min-h-16 font-mono`)" :disabled="!canWrite" maxlength="2000" spellcheck="false" />
            </label>
            <div v-if="canWrite"><Button :label="t(`settings.save`)" size="small" tier="accent" :loading="saving" @click="save" /></div>
        </div></RowNote>
    </RowGroup>
</template>
