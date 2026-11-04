<!-- WHO READS THIS CONVERSATION, as a value pressed where it is read: "Private · you and Ola", or "Shared". The press opens
     the one choice anchored to it (SealChoice), a popover on a pointer and a sheet on a phone. Drawn at the head of a
     reader's own conversation (ChatSealHead) and in a new chat's composer row (ComposerSealPill), in the look of each. -->
<script setup lang="ts">
import type { SealPerson } from "@intentic/sandbox-contract/schemas/seal";
import { ResponsiveOverlay, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import SealChoice from "./SealChoice.vue";

const t = useT();

const {
    label,
    private: closed,
    readers = [],
    people = true,
    composer = false,
    busy = false,
    error,
} = defineProps<{
    label: string;
    private: boolean;
    readers?: readonly SealPerson[];
    people?: boolean;
    /** Drawn as one of the composer's pills rather than at the conversation's head. */
    composer?: boolean;
    busy?: boolean;
    error?: string | undefined;
}>();
const emit = defineEmits<{ change: [next: { readonly private: boolean; readonly readers: readonly string[] }] }>();

const open = ref(false);
const pill = ref<HTMLElement>();
</script>

<template>
    <button
        ref="pill"
        type="button"
        data-seal-pill
        :class="
            composer
                ? 'composer-ghost composer-glyph h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11'
                : ui.textButton({ tone: `quiet`, size: `xs` }, `min-w-0 gap-1.5 font-medium`)
        "
        v-tooltip.top="composer ? label : undefined"
        :aria-expanded="open"
        aria-haspopup="dialog"
        :aria-label="t(`chat.seal.whoReads`, { label })"
        @click="open = !open"
    >
        <!-- The lock says private where the words alone would be read past; in the composer, whose narrow row keeps only the
             glyph, an open one says shared. -->
        <Icon v-if="closed || composer" :name="closed ? `lock` : `unlock`" class="shrink-0 text-2xs" :class="closed ? 'text-link' : 'text-subtle'" />
        <span class="min-w-0 truncate" :class="composer ? '@max-md:hidden' : ''">{{ label }}</span>
        <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" :class="composer ? '@max-md:hidden' : ''" />
    </button>
    <ResponsiveOverlay v-model="open" :anchor="pill" :header="t(`chat.seal.who`)" panel-class="w-80">
        <SealChoice :private="closed" :readers="readers" :people="people" :busy="busy" :error="error" @change="(next) => emit(`change`, next)" />
    </ResponsiveOverlay>
</template>
