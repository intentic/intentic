<script setup lang="ts">
import type { AgentRunPicker, Tip } from "@intentic/ui";
import { computed, ref } from "vue";
import { startAgent } from "../../agents/fleet/agentActions";
import { useT } from "@intentic/ui/i18n";

// A Health row's refactor action, in the row's own icon scale: the sparkles start the agent on the Refactors job's model,
// the caret beside them opens the model picker over this one run, as a Fix button's caret does (AgentRunButton), and
// its own button starts it. Fades in with the row on a pointer, like every row action on this tab.

const t = useT();

const {
    prompt,
    name,
    hint,
    picker,
    dormant = false,
} = defineProps<{
    // What the agent is asked, and the file it is about, named in the verb the picker's commit button wears.
    prompt: string;
    name: string;
    hint: Tip;
    // The view's one picker for the Refactors job (useAgentRunPick): a pick lasts the run it starts, then clears.
    picker: AgentRunPicker;
    dormant?: boolean;
}>();

const caret = ref<HTMLElement>();
const verb = computed(() => t(`workspace.codebaseHealth.refactor`, { name }));

const run = (): void => {
    startAgent(prompt, undefined, picker.model.value);
    picker.clear();
};

const configure = (): void => {
    if (caret.value === undefined) {
        return;
    }
    void picker.choose(caret.value, verb.value).then((committed) => {
        if (committed) {
            run();
        }
    });
};

// What a press spends, said where a caret can say anything: the model, its effort, its speed.
const spend = computed(() => {
    const choice = picker.model.value;
    return [choice.label, ...(choice.effortLabel === undefined ? [] : [choice.effortLabel]), ...(choice.fast === true ? [t(`ui.agentRunButton.fast`)] : [])].join(
        ` · `,
    );
});
const caretHint = computed(
    (): Tip => ({
        title: t(`ui.agentRunButton.sandboxDefault`),
        rows: [
            { label: t(`ui.agentRunButton.model`), value: picker.model.value.label },
            { label: t(`ui.agentRunButton.effort`), value: picker.model.value.effortLabel ?? `` },
            { label: t(`ui.agentRunButton.speed`), value: picker.model.value.fast === true ? t(`ui.agentRunButton.fast`) : `` },
        ],
        note: t(`ui.agentRunButton.clickToConfigure`),
    }),
);
</script>

<template>
    <span
        class="flex w-8 shrink-0 items-center justify-end transition-opacity md:opacity-0 md:group-hover/row:opacity-100 md:focus-within:opacity-100"
    >
        <button
            type="button"
            class="w-4 cursor-pointer transition-colors"
            :class="dormant ? 'text-subtle hover:text-muted' : 'text-muted hover:text-link'"
            v-tooltip.top="hint"
            :aria-label="verb"
            @click="run"
        >
            <Icon name="sparkles" class="text-2xs" />
        </button>
        <button
            ref="caret"
            type="button"
            class="w-3.5 cursor-pointer text-subtle transition-colors hover:text-link"
            v-tooltip.top="caretHint"
            :aria-label="t(`ui.agentRunButton.configureStartRun`, { spend })"
            @click="configure"
        >
            <Icon name="chevron-down" class="text-[0.6rem]" />
        </button>
    </span>
</template>
