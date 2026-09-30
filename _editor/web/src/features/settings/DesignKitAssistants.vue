<script setup lang="ts">
import {
    ASSISTANT_ACCESSORIES,
    ASSISTANT_COLORS,
    AssistantFace,
    type AssistantAccessory,
    assistantFace,
    FACE_SIZES,
    personaAccessory,
    ui,
} from "@intentic/ui";
import { computed, ref } from "vue";

const animated = ref(true);
const name = ref(`UX Expert`);

// What the name box stands for: a persona made from that name, its id slugged the way the Personas page slugs one.
const typed = computed(() => {
    const label = name.value.trim() || `Persona`;
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, `-`).replace(/^-+|-+$/g, ``) || `persona`;
    return { id, label };
});
const typedAccessory = computed(() => ASSISTANT_ACCESSORIES[personaAccessory(typed.value)]);
const typedColor = computed(() => assistantFace(typed.value.id).color);

// A roster that shows every rule: a project persona named after its repository, head nouns read from the right, a
// generic title yielding to a specialty, and a plain name falling back to code.
const ROSTER = [
    { id: `project-intentic`, label: `intentic` },
    { id: `project-design-system`, label: `design-system` },
    { id: `ux-expert`, label: `UX Expert` },
    { id: `frontend-designer`, label: `Frontend Designer` },
    { id: `code-reviewer`, label: `Code Reviewer` },
    { id: `docs-writer`, label: `Docs Writer` },
    { id: `tutor`, label: `Tutor` },
    { id: `product-manager`, label: `Product Manager` },
    { id: `marketing-lead`, label: `Marketing Lead` },
    { id: `qa-engineer`, label: `QA Engineer` },
    { id: `ada`, label: `Ada` },
] as const;

// SAFETY: Object.entries of the catalogue yields its own keys, which are the accessories.
const accessories = Object.entries(ASSISTANT_ACCESSORIES) as [AssistantAccessory, (typeof ASSISTANT_ACCESSORIES)[AssistantAccessory]][];
</script>

<template>
    <section id="assistants" aria-labelledby="assistants-title" class="flex scroll-mt-4 flex-col gap-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-col gap-1">
                <h2 id="assistants-title" :class="ui.sectionLabel()">Little guardians</h2>
                <p class="text-sm text-muted">One clay companion. Its color comes from the persona's id, the prop it holds from its name.</p>
            </div>
            <label class="flex cursor-pointer items-center gap-2 text-xs text-muted">
                <input v-model="animated" type="checkbox" class="accent-primary-600" />
                Gentle motion
            </label>
        </div>

        <div class="flex flex-wrap items-center gap-x-8 gap-y-5 rounded-xl border border-line bg-card px-6 py-5">
            <AssistantFace :seed="typed.id" :label="typed.label" :accessory="personaAccessory(typed)" :size="160" :animated />
            <div class="flex min-w-0 flex-col gap-2">
                <label for="assistant-name" class="text-xs text-muted">Persona name</label>
                <input id="assistant-name" v-model="name" :class="ui.input(`w-56`)" placeholder="UX Expert" />
                <p class="text-xs text-muted">{{ typedAccessory.label }} · {{ typedAccessory.object }} · {{ typedColor.label }}</p>
            </div>
            <div class="ml-auto flex items-end gap-6" role="group" aria-label="Actual interface sizes">
                <div v-for="(size, surface) in FACE_SIZES" :key="surface" class="flex flex-col items-center gap-2">
                    <AssistantFace :seed="typed.id" :label="`${typed.label}, ${size} pixels`" :accessory="personaAccessory(typed)" :size :animated />
                    <span class="text-2xs tabular-nums text-muted">{{ size }} px</span>
                </div>
            </div>
        </div>

        <div class="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-2" role="list" aria-label="Names and what they hold">
            <div v-for="persona in ROSTER" :key="persona.id" role="listitem" class="flex flex-col items-center gap-1.5 rounded-xl border border-line bg-card px-2 py-3">
                <AssistantFace :seed="persona.id" :label="persona.label" :accessory="personaAccessory(persona)" :size="FACE_SIZES.card" :animated />
                <span class="text-center text-xs font-medium text-content">{{ persona.label }}</span>
                <span class="text-center text-2xs text-muted">{{ ASSISTANT_ACCESSORIES[personaAccessory(persona)].label }}</span>
            </div>
        </div>

        <div class="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-2" role="list" aria-label="Every prop">
            <div
                v-for="([key, accessory], index) in accessories"
                :key
                role="listitem"
                class="flex flex-col items-center gap-1.5 rounded-xl border border-line bg-card px-2 py-3"
            >
                <AssistantFace
                    :seed="key"
                    :label="accessory.object"
                    :accessory="key"
                    :color="ASSISTANT_COLORS[index % ASSISTANT_COLORS.length]!.hex"
                    :size="FACE_SIZES.card"
                    :animated
                />
                <span class="text-center text-xs font-medium text-content">{{ accessory.label }}</span>
                <span class="text-center text-2xs text-muted">{{ accessory.object }}</span>
            </div>
        </div>
        <p class="text-xs text-muted">A slow bob and a gentle breath. Toolbar faces stay still; reduced motion stops all animation.</p>
    </section>
</template>
