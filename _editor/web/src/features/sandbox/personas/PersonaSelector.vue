<script setup lang="ts">
import { type Persona, personaBounds } from "@intentic/sandbox-contract";
import { Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { createInlineRename } from "@intentic/ui/inline-rename";
import { computed, useId } from "vue";
import PersonaTile from "../../../components/PersonaTile.vue";

// Settings owns the actions. They sit beside the tile's selection button, never inside another button.
const { persona, selected, controls, signedIn, saving, write } = defineProps<{
    persona: Persona;
    selected: boolean;
    controls: string;
    signedIn: boolean;
    saving: boolean;
    write: (name: string) => Promise<void>;
}>();
const emit = defineEmits<{ select: []; remove: [] }>();
const t = useT();
const nameId = useId();
const descriptionId = useId();
const errorId = useId();
const label = computed(() => persona.label ?? persona.id);
const offline = computed(() => persona.capabilities.length > 0 && !signedIn);
const description = computed(() =>
    [
        persona.brief,
        persona.powers === undefined ? undefined : personaBounds(persona),
        offline.value ? t(`sandbox.sandboxPersonas.notSignedIn`) : undefined,
    ]
        .filter(Boolean)
        .join(`\n`),
);
const rename = createInlineRename(
    () => label.value,
    (name) => write(name),
    `Couldn't rename this persona.`,
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
                <Icon v-if="saving || rename.busy" name="spinner" spin class="absolute bottom-0 right-0 text-2xs text-subtle" />
                <span v-else-if="offline" class="absolute bottom-1 right-0 size-2 rounded-full bg-warning ring-2 ring-canvas" aria-hidden="true" />
            </template>
            <span v-if="description !== ``" :id="descriptionId" class="sr-only">{{ description }}</span>
        </PersonaTile>

        <button
            type="button"
            :class="ui.iconButton('absolute left-0.5 top-0.5 size-6 text-subtle hover:text-content')"
            :aria-label="`${label}, ${t(`sandbox.sandboxPersonas.renamePersona`)}`"
            v-tooltip.top="t(`sandbox.sandboxPersonas.renamePersona`)"
            @click="rename.begin()"
        >
            <Icon name="pencil" class="text-2xs" />
        </button>
        <button
            type="button"
            :class="ui.iconButton('absolute right-0.5 top-0.5 size-6 text-subtle hover:text-danger')"
            :aria-label="t(`sandbox.sandboxPersonas.removePersona`)"
            :aria-describedby="nameId"
            v-tooltip.top="t(`sandbox.sandboxPersonas.removePersona`)"
            @click="emit(`remove`)"
        >
            <Icon name="trash" class="text-2xs" />
        </button>

        <div v-if="rename.editing" class="absolute inset-x-1 bottom-1.5 flex h-8 items-center rounded bg-card">
            <input
                v-model="rename.draft"
                type="text"
                :aria-label="t(`sandbox.sandboxPersonas.personaName`)"
                :aria-invalid="rename.error !== undefined"
                :aria-describedby="rename.error === undefined ? undefined : errorId"
                :readonly="rename.busy"
                maxlength="80"
                size="1"
                autocomplete="off"
                spellcheck="false"
                :class="ui.inputInline('w-full min-w-0 px-1 text-xs')"
                @keydown.enter.stop.prevent="rename.commit()"
                @keydown.esc.stop.prevent="rename.cancel()"
                @blur="rename.blurCommit()"
                @vue:mounted="rename.focusInput"
            />
            <button
                type="button"
                :class="ui.iconButton('size-6')"
                :aria-label="t(`ui.action.save`)"
                :disabled="rename.busy"
                @mousedown.prevent
                @click="rename.commit()"
            >
                <Icon name="check" class="text-2xs" />
            </button>
        </div>
        <span
            v-if="rename.error !== undefined"
            :id="errorId"
            role="alert"
            class="absolute inset-x-0 top-full z-10 break-words rounded border border-danger/30 bg-card p-2 text-xs text-danger shadow-lg"
            >{{ rename.error }}</span
        >
    </div>
</template>
