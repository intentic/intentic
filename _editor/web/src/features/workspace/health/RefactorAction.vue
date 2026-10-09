<script setup lang="ts">
import { type AgentRunPicker, type Tip, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import { startAgent } from "../../agents/fleet/agentActions";
import { useT } from "@intentic/ui/i18n";

// A Health row's refactor action, in the table's Suggested column: the sparkles, and on a wide pane the refactor's own
// name, start the agent on the Refactors job's model; the caret beside them opens the model picker over this one run, as
// a Fix button's caret does (AgentRunButton), and its own button starts it. It stays visible rather than fading in with
// the row, since the name is the finding and a pane too narrow for it leans on the legend under the table.

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
// The visible label leads the accessible name, so a screen reader hears what the button says, then which file.
const label = computed(() => t(`workspace.codebaseHealth.refactorAction`, { action: hint.title, name }));

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
    <!-- Stretched across the column so every caret lines up on its right edge, whatever the label's length. -->
    <span class="flex items-center justify-between gap-0.5">
        <button
            type="button"
            :class="ui.textButton({ tone: dormant ? `subtle` : `quiet`, size: `xs` }, `whitespace-nowrap`)"
            v-tooltip.top="hint"
            :aria-label="label"
            data-refactor
            @click="run"
        >
            <Icon name="sparkles" class="shrink-0" />
            <span class="hidden @2xl:inline">{{ hint.title }}</span>
        </button>
        <button
            ref="caret"
            type="button"
            :class="ui.iconButton({ size: `xs`, tone: `subtle` })"
            v-tooltip.top="caretHint"
            :aria-label="t(`ui.agentRunButton.configureStartRun`, { spend })"
            @click="configure"
        >
            <Icon name="chevron-down" class="text-4xs" />
        </button>
    </span>
</template>
