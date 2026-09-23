<script setup lang="ts">
import { Button } from "@intentic/ui";
import { ref } from "vue";
import { type Audience, useAudience } from "../app/useAudience";
import { autoLandRule, autoVersionRule } from "../features/sandbox/environment/rules";
import { useRules } from "../features/sandbox/environment/useRules";
import { useRole } from "../features/sandbox/secrets/useRole";
import { useT } from "@intentic/ui/i18n";

// The one question the app asks about the person looking, put where a newcomer first stands (the empty workspace
// pane) and asked once per browser. Either answer is one click from the other in Settings, and the card names
// exactly what the answer changes so nobody fears it changes their files. A maker's answer also proposes the two
// sandbox rules their contract rests on (work applies on its own, and is versioned), when they may write rules at all.

const t = useT();

const { setAudience } = useAudience();
const { canShip } = useRole();
const { upsert } = useRules();

// On by default: the maker's contract is "it edits my thing and I can always go back", which these two rules are.
const applyOnOwn = ref(true);

const answer = (value: Audience): void => {
    setAudience(value);
    if (value === `maker` && canShip.value && applyOnOwn.value) {
        upsert(autoLandRule());
        upsert(autoVersionRule());
    }
};
</script>

<template>
    <div class="flex w-full max-w-md flex-col gap-3 rounded-xl border border-line bg-card p-4 text-left">
        <div class="flex flex-col gap-1">
            <p class="text-sm font-semibold text-content">{{ t(`common.audienceAsk.howWorkHere`) }}</p>
            <p class="text-xs text-muted">
                {{ t(`common.audienceAsk.picksWordsAppUses`) }}
            </p>
        </div>
        <div class="flex flex-wrap gap-2">
            <Button size="small" :label="t(`shared.iWriteCode`)" @click="answer('developer')" />
            <Button size="small" severity="secondary" :label="t(`common.audienceAsk.iDontWriteCode`)" @click="answer('maker')" />
        </div>
        <!-- Only a maintainer can write the rules; a collaborator's answer changes their own screen and nothing else. -->
        <label v-if="canShip" class="flex cursor-pointer items-start gap-2 text-2xs text-muted">
            <input v-model="applyOnOwn" type="checkbox" class="mt-0.5 shrink-0 accent-primary-600" />
            <span>{{ t(`common.audienceAsk.dontWriteCodeAssistants`) }}</span>
        </label>
    </div>
</template>
