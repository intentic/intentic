<script setup lang="ts">
import { AssistantFace, ASSISTANT_CHARACTERS, type AssistantCharacter, FACE_SIZES, ui } from "@intentic/ui";
import { ref } from "vue";

const selected = ref<AssistantCharacter>(`keeper`);
const animated = ref(true);
</script>

<template>
    <section id="assistants" aria-labelledby="assistants-title" class="flex scroll-mt-4 flex-col gap-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-col gap-1">
                <h2 id="assistants-title" :class="ui.sectionLabel()">Little guardians</h2>
                <p class="text-sm text-muted">Soft little companions. Lotus crowns, warm gold, and a personality of their own.</p>
            </div>
            <label class="flex cursor-pointer items-center gap-2 text-xs text-muted">
                <input v-model="animated" type="checkbox" class="accent-primary-600" />
                Gentle motion
            </label>
        </div>

        <div class="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-2">
            <button
                v-for="(companion, key) in ASSISTANT_CHARACTERS"
                :key
                type="button"
                :aria-label="companion.name"
                :aria-pressed="selected === key"
                class="ui-row-select relative flex flex-col items-center gap-2 rounded-xl border bg-card px-3 py-4"
                :class="selected === key ? `border-link ring-1 ring-link/20` : `border-line`"
                @click="selected = key"
            >
                <AssistantFace :seed="key" :label="companion.name" :character="key" :size="100" :animated />
                <span class="text-xs font-medium text-content">{{ companion.name }}</span>
                <span class="text-center text-2xs text-muted">{{ companion.detail }}</span>
            </button>
        </div>

        <div class="flex flex-wrap items-center gap-x-8 gap-y-5 rounded-xl border border-line bg-card px-6 py-5">
            <AssistantFace :seed="selected" :label="ASSISTANT_CHARACTERS[selected].name" :character="selected" :size="160" :animated />
            <div class="flex min-w-0 flex-col gap-2">
                <p class="text-base font-medium text-content">{{ ASSISTANT_CHARACTERS[selected].name }}</p>
                <p class="text-xs text-muted">{{ ASSISTANT_CHARACTERS[selected].detail }}</p>
                <p class="max-w-64 text-xs text-muted">A soft clay body, a little gold crown, and one familiar expression or favorite tool.</p>
            </div>
            <div class="ml-auto flex items-end gap-6" role="group" aria-label="Actual interface sizes">
                <div v-for="(size, surface) in FACE_SIZES" :key="surface" class="flex flex-col items-center gap-2">
                    <AssistantFace :seed="selected" :label="`${ASSISTANT_CHARACTERS[selected].name}, ${size} pixels`" :character="selected" :size :animated />
                    <span class="text-2xs tabular-nums text-muted">{{ size }} px</span>
                </div>
            </div>
        </div>
        <p class="text-xs text-muted">A slow bob and a gentle breath. Toolbar faces stay still; reduced motion stops all animation.</p>
    </section>
</template>
