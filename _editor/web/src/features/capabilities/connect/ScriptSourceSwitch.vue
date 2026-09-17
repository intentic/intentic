<script setup lang="ts">
import { SegmentedControl } from "@intentic/ui";
import { environment } from "../../../app/environments/environment";
import { type ScriptSource, scriptSource } from "../../../app/environments/scriptCommand";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

// Local-dev-only switch for which script delivery a paste-elsewhere command uses (scriptCommand.ts): a repo-path
// script only runs on the dev machine itself, so this only appears on commands meant to run elsewhere. One shared
// ref, so every command block follows the same choice.

const t = useT();

const OPTIONS = computed((): { label: string; value: ScriptSource; title: string }[] => [
    { label: t(`capabilities.scriptSourceSwitch.local`), value: `checkout`, title: t(`capabilities.scriptSourceSwitch.runsScriptCheckoutOnly`) },
    {
        label: t(`capabilities.scriptSourceSwitch.standard`),
        value: `published`,
        title: t(`capabilities.scriptSourceSwitch.fetchesReleasedScriptIntentic`),
    },
]);
</script>

<template>
    <div v-if="!environment.production" class="flex items-center gap-2 text-2xs text-warning">
        <span>{{ t(`capabilities.scriptSourceSwitch.localDevScriptSource`) }}</span>
        <SegmentedControl v-model="scriptSource" :options="OPTIONS" size="xs" />
    </div>
</template>
