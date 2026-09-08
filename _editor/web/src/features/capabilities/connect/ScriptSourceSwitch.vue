<script setup lang="ts">
import { SegmentedControl } from "@intentic/ui";
import { environment } from "../../../app/environments/environment";
import { type ScriptSource, scriptSource } from "../../../app/environments/scriptCommand";

// Local-dev-only switch for which script delivery a paste-elsewhere command uses (scriptCommand.ts): a repo-path
// script only runs on the dev machine itself, so this only appears on commands meant to run elsewhere. One shared
// ref, so every command block follows the same choice.

const OPTIONS: { label: string; value: ScriptSource; title: string }[] = [
    { label: `Local`, value: `checkout`, title: `Runs the script from your checkout, only on a machine that has the repo` },
    { label: `Standard`, value: `published`, title: `Fetches the released script from intentic.dev, runs on any machine` },
];
</script>

<template>
    <div v-if="!environment.production" class="flex items-center gap-2 text-2xs text-warning">
        <span>Local dev: script source</span>
        <SegmentedControl v-model="scriptSource" :options="OPTIONS" size="xs" />
    </div>
</template>
