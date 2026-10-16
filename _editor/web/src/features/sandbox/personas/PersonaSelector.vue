<script setup lang="ts">
import type { Persona } from "@intentic/sandbox-contract/schemas/personas";
import { personaBoundsWords } from "../../../models/sandbox/personas/personaBounds";
import { Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, useId } from "vue";
import PersonaTile from "../../../components/PersonaTile.vue";

// Settings owns the actions. They sit beside the tile's selection button, never inside another button. Renaming is not
// one of them: it rides the open persona's own heading, beside the name, the way the sandbox's name renames.
const { persona, selected, controls, signedIn, saving } = defineProps<{
    persona: Persona;
    selected: boolean;
    controls: string;
    signedIn: boolean;
    saving: boolean;
}>();
const emit = defineEmits<{ select: []; remove: [] }>();
const t = useT();
const nameId = useId();
const descriptionId = useId();
const label = computed(() => persona.label ?? persona.id);
const offline = computed(() => persona.capabilities.length > 0 && !signedIn);
const description = computed(() =>
    [
        persona.brief,
        persona.powers === undefined ? undefined : personaBoundsWords(persona),
        offline.value ? t(`sandbox.sandboxPersonas.notSignedIn`) : undefined,
    ]
        .filter(Boolean)
        .join(`\n`),
);
</script>

<template>
    <div class="relative size-28">
        <PersonaTile
            :persona="persona"
            :label="label"
            :name-id="nameId"
            :selected="selected"
            :aria-label="label"
            :aria-pressed="selected"
            :aria-controls="controls"
            :aria-describedby="description === `` ? undefined : descriptionId"
            v-tooltip.bottom="description"
            class="size-full"
            @click="emit(`select`)"
        >
            <template #badges>
                <Icon v-if="saving" name="spinner" spin class="absolute bottom-0 right-0 text-2xs text-subtle" />
                <span v-else-if="offline" class="absolute bottom-1 right-0 size-2 rounded-full bg-warning ring-2 ring-canvas" aria-hidden="true" />
            </template>
            <span v-if="description !== ``" :id="descriptionId" class="sr-only">{{ description }}</span>
        </PersonaTile>

        <button
            type="button"
            :class="ui.iconButton({ tone: `danger` }, 'absolute right-0.5 top-0.5')"
            :aria-label="t(`sandbox.sandboxPersonas.removePersona`)"
            :aria-describedby="nameId"
            v-tooltip.top="t(`sandbox.sandboxPersonas.removePersona2`)"
            @click="emit(`remove`)"
        >
            <Icon name="trash" class="text-2xs" />
        </button>
    </div>
</template>
