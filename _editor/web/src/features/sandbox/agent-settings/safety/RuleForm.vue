<script setup lang="ts">
import type { Rule, RuleMoment } from "@intentic/api-contract";
import { Button, ui, Icon, Picker, ProseField, SegmentedControl } from "@intentic/ui";
import { computed, ref } from "vue";
import { useRepos } from "../../../workspace/explorer/useRepos";
import { ACTIONS, ANYWHERE, type Choice, globsOf, MOMENTS, momentOf, nameOf, repoLabel, type RuleDraft } from "./ruleWords";

// One form for creating a rule and for editing one already saved, ordered as the sentence it writes: when, only if,
// then. The name is derived from what's typed (see nameOf) unless overwritten below.

const { rule, disabled = false } = defineProps<{
    /** The rule being changed. Absent ⇒ writing a new one. */
    rule?: Rule;
    disabled?: boolean;
}>();

const emit = defineEmits<{ save: [RuleDraft]; cancel: [] }>();

// `builtin` never reaches this form; the three built-in rows are filtered out of the list it edits.
const choiceOf = (from: Rule | undefined): Choice => {
    if (from?.action.kind === `command`) {
        return `command`;
    }
    if (from?.action.kind === `verdict`) {
        return from.action.verdict;
    }
    return `instruct`;
};

const moment = ref<RuleMoment>(rule?.moment ?? `turn.ending`);
const action = ref<Choice>(choiceOf(rule));
const command = ref(rule?.action.kind === `command` ? rule.action.command : ``);
const text = ref(rule?.action.kind === `instruct` ? rule.action.text : ``);
const label = ref(rule?.label ?? ``);
// Which repository this is about; `ANYWHERE` is the whole workspace, and is what a rule with no repository means.
const repo = ref<string>(rule?.when?.repo ?? ANYWHERE);
const globs = ref<string[]>([...(rule?.when?.paths ?? [])]);
const globDraft = ref(``);
// Starts open if the rule already has globs; a new rule starts collapsed.
const narrowing = ref(globs.value.length > 0);

// Every repository in the workspace, plus "anywhere". A rule aimed at one runs there, so this is both the condition
// and the working directory; the note under the picker is the only place that can say so.
const { options: repoOptions } = useRepos();
// Each option carries a glyph like the moment picker's above it: two stacked pickers where only one has a mark leave
// the chosen values on two different left edges, which reads as a misalignment rather than a distinction.
const repoChoices = computed(() => [
    { value: ANYWHERE, label: `Anywhere in the workspace`, icon: `sitemap` as const },
    ...repoOptions.value.map((id) => ({ value: id, label: repoLabel(id), icon: `folder` as const })),
]);

const chosenMoment = computed(() => momentOf(moment.value));
const momentOptions = computed(() => MOMENTS.map(({ value, label: name, icon, cost }) => ({ value, label: name, icon, description: cost })));
const actionOptions = computed(() => ACTIONS[moment.value].map(({ value, label: name }) => ({ value, label: name })));
const chosenAction = computed(() => ACTIONS[moment.value].find((entry) => entry.value === action.value));

// If the new moment doesn't offer the current action, switch to its first action rather than leave an invalid pair.
const pickMoment = (next: RuleMoment | undefined): void => {
    if (next === undefined) {
        return;
    }
    moment.value = next;
    const offered = ACTIONS[next];
    if (!offered.some((entry) => entry.value === action.value)) {
        action.value = offered[0].value;
    }
};

const addGlobs = (from: string): void => {
    for (const glob of globsOf(from)) {
        if (!globs.value.includes(glob)) {
            globs.value.push(glob);
        }
    }
};

const commitDraft = (): void => {
    addGlobs(globDraft.value);
    globDraft.value = ``;
};

// Splits on the last comma or space: text before it becomes chips, the rest stays in the box. Input-driven, not
// v-model, to avoid both writing the same value on the same event.
const onGlobInput = (event: Event): void => {
    const box = event.target as HTMLInputElement;
    const typed = box.value;
    const at = Math.max(typed.lastIndexOf(`,`), typed.lastIndexOf(` `));
    if (at !== -1) {
        addGlobs(typed.slice(0, at + 1));
        box.value = typed.slice(at + 1);
    }
    globDraft.value = box.value;
};

// Backspace on an empty box removes the last chip.
const backspaceGlob = (): void => {
    if (globDraft.value === ``) {
        globs.value.pop();
    }
};

const removeGlob = (glob: string): void => {
    globs.value = globs.value.filter((entry) => entry !== glob);
};

const stopNarrowing = (): void => {
    globs.value = [];
    globDraft.value = ``;
    narrowing.value = false;
};

// autoName shows a hint instead of a blank placeholder until something is typed.
const derived = computed(() => nameOf(action.value, command.value, text.value, globs.value));
const autoName = computed(() => (derived.value === `` ? `Named after what you typed above` : derived.value));

// Names the field blocking save, shown next to the button instead of just disabling it.
const missing = computed<string | undefined>(() => {
    if (action.value === `command` && command.value.trim() === ``) {
        return `Type the command it runs.`;
    }
    if (action.value === `instruct` && text.value.trim() === ``) {
        return `Type what to tell the assistant.`;
    }
    return undefined;
});

const actionOf = (): Rule["action"] => {
    if (action.value === `command`) {
        // timeoutMs keeps the edited rule's value, or the schema default when creating a new one.
        return {
            kind: `command`,
            command: command.value.trim(),
            timeoutMs: rule?.action.kind === `command` ? rule.action.timeoutMs : 900_000,
        };
    }
    if (action.value === `instruct`) {
        return { kind: `instruct`, text: text.value.trim() };
    }
    return { kind: `verdict`, verdict: action.value === `allow` ? `allow` : `hold` };
};

const save = (): void => {
    // Commits any glob left in the input box before checking for missing fields.
    commitDraft();
    if (missing.value !== undefined) {
        return;
    }
    // One `when` assembled from both narrowings; with neither, the rule saves without a condition at all, which is
    // what an absent `when` means everywhere else.
    const when = {
        ...(repo.value === ANYWHERE ? {} : { repo: repo.value }),
        ...(globs.value.length > 0 ? { paths: [...globs.value] } : {}),
    };
    emit(`save`, {
        label: label.value.trim() === `` ? derived.value : label.value.trim(),
        moment: moment.value,
        ...(Object.keys(when).length > 0 ? { when } : {}),
        action: actionOf(),
    });
};
</script>

<template>
    <div class="flex flex-col gap-4">
        <!-- Each option shows what it costs, since the moments aren't interchangeable. -->
        <div class="flex flex-col gap-1.5">
            <span :class="ui.sectionLabel(`text-2xs`)">When</span>
            <Picker
                :model-value="moment"
                :options="momentOptions"
                :disabled="disabled"
                class="w-full py-1.5 text-xs"
                aria-label="When this rule runs"
                header="When this rule runs"
                @update:model-value="pickMoment"
            />
        </div>

        <!--
            Which repository, above the path narrowing because it is the coarser of the two and because it decides
            something the paths don't: where the command runs. Only shown where there is more than one repository to
            choose between, since a one-repository workspace has no question to answer here.
        -->
        <div v-if="repoChoices.length > 2" class="flex flex-col gap-1.5">
            <span :class="ui.sectionLabel(`text-2xs`)">Where</span>
            <Picker
                v-model="repo"
                :options="repoChoices"
                :disabled="disabled"
                class="w-full py-1.5 text-xs"
                aria-label="Which repository this rule is about"
                header="Which repository"
            />
            <p v-if="repo !== ANYWHERE && action === `command`" class="text-2xs text-muted">
                Runs in <span class="font-mono text-content">{{ repo === `root` ? `the workspace root` : repo }}</span
                >, so write the command as you would in a terminal there.
            </p>
        </div>

        <!-- Collapsed states the default in words; expanded shows the paths as removable chips. -->
        <div v-if="!narrowing" class="flex flex-wrap items-center gap-x-2 text-2xs text-subtle">
            <span>Applies to every change.</span>
            <button type="button" :class="ui.linkButton(`text-2xs`)" :disabled="disabled" @click="narrowing = true">Only when it touches…</button>
        </div>
        <div v-else class="flex flex-col gap-1.5">
            <span :class="ui.sectionLabel(`text-2xs`)">Only if it touches</span>
            <div class="flex items-start gap-1">
                <div
                    class="ui-field-shell flex min-w-0 flex-1 flex-wrap items-center gap-1.5 px-2 py-1.5"
                    :class="{ 'opacity-50': disabled }"
                >
                    <span
                        v-for="glob in globs"
                        :key="glob"
                        class="inline-flex items-center gap-1 rounded bg-overlay py-0.5 pl-1.5 pr-1 font-mono text-2xs text-content"
                    >
                        {{ glob }}
                        <button
                            type="button"
                            class="cursor-pointer text-subtle transition-colors hover:text-content"
                            :aria-label="`Remove ${glob}`"
                            @click="removeGlob(glob)"
                        >
                            <Icon name="times" class="text-[0.6rem]" />
                        </button>
                    </span>
                    <input
                        :value="globDraft"
                        type="text"
                        :placeholder="globs.length === 0 ? `docs/**` : `add another…`"
                        spellcheck="false"
                        autocapitalize="off"
                        autocorrect="off"
                        aria-label="Paths"
                        :disabled="disabled"
                        class="field-bare min-w-24 flex-1 font-mono md:text-xs"
                        @input="onGlobInput"
                        @keydown.enter.prevent="commitDraft"
                        @keydown.backspace="backspaceGlob"
                        @blur="commitDraft"
                    />
                </div>
                <button type="button" :class="ui.iconButton(`mt-1`)" aria-label="Apply to every change" @click="stopNarrowing">
                    <Icon name="times" class="text-xs" />
                </button>
            </div>
        </div>

        <!-- Shown only when the moment offers more than one action to choose from. -->
        <div class="flex flex-col gap-1.5">
            <span :class="ui.sectionLabel(`text-2xs`)">Then</span>
            <!-- Compact rather than full width, so it doesn't outweigh the moment picker above it. -->
            <SegmentedControl v-if="actionOptions.length > 1" v-model="action" :options="actionOptions" class="-mt-0.5 mb-0.5" />

            <div
                v-if="action === `command`"
                class="ui-field-shell flex items-center gap-2 px-2.5 py-1.5"
                :class="{ 'opacity-50': disabled }"
            >
                <span class="select-none font-mono text-xs text-subtle" aria-hidden="true">$</span>
                <input
                    v-model="command"
                    type="text"
                    placeholder="pnpm lint"
                    spellcheck="false"
                    autocapitalize="off"
                    autocorrect="off"
                    aria-label="Command to run"
                    :disabled="disabled"
                    class="field-bare min-w-0 flex-1 font-mono md:text-xs"
                />
            </div>
            <!-- Kept boxed like the command field beside it, unlike a bare ProseField elsewhere; it grows with the text. -->
            <div
                v-else-if="action === `instruct`"
                class="ui-field-shell px-0.5 py-1"
                :class="{ 'opacity-50': disabled }"
            >
                <ProseField
                    v-model="text"
                    placeholder="Update the changelog before you finish."
                    aria-label="What to tell the assistant"
                    :disabled="disabled"
                    class="min-h-8"
                />
            </div>

            <p v-if="chosenAction !== undefined" class="text-2xs text-muted">{{ chosenAction.outcome }}</p>
        </div>

        <!-- Name and save controls sit below the hairline, entered after the rule itself is decided. -->
        <div class="mt-3 flex flex-col gap-2">
            <label class="flex items-center gap-2">
                <span :class="ui.sectionLabel(`shrink-0 text-2xs`)">Called</span>
                <input
                    v-model="label"
                    type="text"
                    :placeholder="autoName"
                    aria-label="Rule name"
                    :disabled="disabled"
                    :class="ui.inputSm(`min-w-0 flex-1`)"
                />
            </label>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Button
                    size="small"
                    :label="rule === undefined ? `Add rule` : `Save changes`"
                    :disabled="missing !== undefined || disabled"
                    @click="save"
                />
                <Button size="small" text label="Cancel" @click="emit(`cancel`)" />
                <span v-if="missing !== undefined" class="text-2xs text-subtle">{{ missing }}</span>
            </div>
        </div>
    </div>
</template>
