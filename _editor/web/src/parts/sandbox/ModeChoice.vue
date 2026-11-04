<!-- WHO HANDLES THE CODE HERE: the two ways a sandbox runs (@intentic/constants sandbox-mode.ts) as a pair of rows. Asked
     where a sandbox is made (features/setup/add/AddSandboxForm.vue) and where it is changed (the Overview's
     SandboxModeRow.vue), with the same words in both places, so the answer given at the start is the one found later.
     Rows on the surface's own ground, the pick a tint and a filled circle, as the "Runs on" list beside it. Each row's
     note names its mode ("Hands-off"), which is the word the sandbox's settings use for it afterwards. -->
<script setup lang="ts">
import type { SandboxMode } from "@intentic/constants";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";

defineProps<{
    /** The id of the label naming the question. */
    labelledBy: string;
}>();
const mode = defineModel<SandboxMode>({ required: true });

const t = useT();

// Hands-off first: the answer that asks nothing more of the reader afterwards.
const OPTIONS = computed(
    () =>
        [
            { value: `hands-off`, title: t(`sandbox.mode.handsOff.title`), note: t(`sandbox.mode.handsOff.note`) },
            { value: `hands-on`, title: t(`sandbox.mode.handsOn.title`), note: t(`sandbox.mode.handsOn.note`) },
        ] satisfies readonly { value: SandboxMode; title: string; note: string }[],
);

// One tab stop, the pick; the arrows move it, as in any radio group.
const group = ref<HTMLElement>();
const ARROWS = new Set([`ArrowDown`, `ArrowRight`, `ArrowUp`, `ArrowLeft`]);
const step = (event: KeyboardEvent): void => {
    if (!ARROWS.has(event.key)) {
        return;
    }
    event.preventDefault();
    const next = mode.value === `hands-off` ? 1 : 0;
    mode.value = OPTIONS.value[next]?.value ?? mode.value;
    group.value?.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)[next]?.focus();
};
</script>

<template>
    <div class="@container">
        <div ref="group" role="radiogroup" :aria-labelledby="labelledBy" class="-mx-2.5 grid grid-cols-1 gap-0.5 @lg:grid-cols-2 @lg:gap-x-1" @keydown="step">
            <button
                v-for="option in OPTIONS"
                :key="option.value"
                type="button"
                role="radio"
                :aria-checked="mode === option.value"
                :tabindex="mode === option.value ? 0 : -1"
                class="ui-row-select flex w-full min-w-0 items-start gap-3 rounded-lg px-2.5 py-2 text-left max-md:py-2.5"
                :class="{ 'ui-row-select-on': mode === option.value }"
                :data-sandbox-mode="option.value"
                @click="mode = option.value"
            >
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="text-sm font-medium text-content">{{ option.title }}</span>
                    <span class="text-xs leading-snug text-muted">{{ option.note }}</span>
                </span>
                <Icon
                    :name="mode === option.value ? `check-circle` : `circle`"
                    class="shrink-0 text-sm"
                    :class="mode === option.value ? `text-accent` : `text-subtle`"
                />
            </button>
        </div>
    </div>
</template>
