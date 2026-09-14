<script setup lang="ts">
import { Button } from "@intentic/ui";
import { ref } from "vue";
import { type Audience, useAudience } from "../app/useAudience";
import { AUTO_LAND_RULE, AUTO_VERSION_RULE } from "../features/sandbox/environment/rules";
import { useRules } from "../features/sandbox/environment/useRules";
import { useRole } from "../features/sandbox/secrets/useRole";

// The one question the app asks about the person looking, put where a newcomer first stands (the empty workspace
// pane) and asked once per browser. Either answer is one click from the other in Settings, and the card names
// exactly what the answer changes so nobody fears it changes their files. A maker's answer also proposes the two
// sandbox rules their contract rests on (work applies on its own, and is versioned), when they may write rules at all.

const { setAudience } = useAudience();
const { canShip } = useRole();
const { upsert } = useRules();

// On by default: the maker's contract is "it edits my thing and I can always go back", which these two rules are.
const applyOnOwn = ref(true);

const answer = (value: Audience): void => {
    setAudience(value);
    if (value === `maker` && canShip.value && applyOnOwn.value) {
        upsert(AUTO_LAND_RULE);
        upsert(AUTO_VERSION_RULE);
    }
};
</script>

<template>
    <div class="flex w-full max-w-md flex-col gap-3 rounded-xl border border-line bg-card p-4 text-left">
        <div class="flex flex-col gap-1">
            <p class="text-sm font-semibold text-content">How will you work here?</p>
            <p class="text-xs text-muted">
                Picks the words the app uses and what its home page is. Nothing about your files or your agents changes, and you can switch in
                Settings any time.
            </p>
        </div>
        <div class="flex flex-wrap gap-2">
            <Button size="small" label="I write code" @click="answer('developer')" />
            <Button size="small" severity="secondary" label="I don't write code" @click="answer('maker')" />
        </div>
        <!-- Only a maintainer can write the rules; a collaborator's answer changes their own screen and nothing else. -->
        <label v-if="canShip" class="flex cursor-pointer items-start gap-2 text-2xs text-muted">
            <input v-model="applyOnOwn" type="checkbox" class="mt-0.5 shrink-0 accent-primary-600" />
            <span>If you don't write code: the assistant's changes apply on their own and every change is saved as a version. You can always go back.</span>
        </label>
    </div>
</template>
