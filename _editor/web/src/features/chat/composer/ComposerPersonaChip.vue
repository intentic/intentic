<!--
    Composer control naming which persona this chat is about to act as, shown only when personaRoute.ts detects one. Three states: suggest (press
    adds the persona), route (adding automatically; press declines), held (declined; press undoes) — always spelled out in the label, never a
    tooltip. Keeps its mark and drops only its words on a narrow pane.
-->
<script setup lang="ts">
import { PersonaFace } from "@intentic/ui";
import { computed } from "vue";
import type { PersonaRoutePreview } from "../personas/personaRoute";

const props = defineProps<{ preview: PersonaRoutePreview | undefined }>();
const emit = defineEmits<{ press: [] }>();

const name = computed(() => props.preview?.persona.label ?? props.preview?.persona.id ?? ``);

// The whole sentence, on `title` AND `aria-label`: the words on the chip name the persona, this says what is
// being done and what the press does.
const title = computed(() => {
    const state = props.preview;
    if (state === undefined) {
        return undefined;
    }
    const why = state.reason === `` ? `` : ` ${state.reason}`;
    switch (state.kind) {
        case `suggest`:
            return `This message looks like ${name.value}'s work.${why} Press to act as ${name.value}: only its accounts and repositories in reach, on its model.`;
        case `route`:
            return `When you send, this chat will act as ${name.value}.${why} Press to keep it as everyone.`;
        default:
            return `Kept as everyone rather than ${name.value}. Press to let it act as ${name.value} after all.`;
    }
});
</script>

<template>
    <button
        v-if="preview !== undefined"
        type="button"
        class="composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
        :title="title"
        :aria-label="title"
        @click="emit(`press`)"
    >
        <PersonaFace v-if="preview.kind !== `held`" :persona="preview.persona" :size="16" />
        <Icon v-else name="lock" class="text-2xs" />
        <template v-if="preview.kind === `suggest`">
            <span class="@max-lg:hidden">Act as {{ name }}?</span>
        </template>
        <template v-else-if="preview.kind === `route`">
            <Icon name="arrow-right" class="text-2xs text-subtle" aria-hidden="true" />
            <span class="@max-lg:hidden">{{ name }}</span>
        </template>
        <template v-else>
            <span class="@max-lg:hidden">Everyone</span>
            <span class="text-subtle @max-lg:hidden" aria-hidden="true">·</span>
            <span class="text-link @max-lg:hidden">Undo</span>
        </template>
    </button>
</template>
