<script setup lang="ts">
import type { Rule, RuleMoment } from "@intentic-app/api-contract";
import { Button, ui, Icon, Picker, ProseField, SegmentedControl } from "@intentic/ui";
import { computed, ref } from "vue";
import { ACTIONS, type Choice, globsOf, MOMENTS, momentOf, nameOf, type RuleDraft } from "./ruleWords";

/* WRITING ONE RULE: the same form for a new one and for one already in the list, because "change the
 * command" should never have meant "delete it and type the whole thing again".
 *
 * IT IS THE SENTENCE, LAID OUT. A rule is "at this moment, if this is true, do this", and this form is read in
 * exactly that order with the connective words as its labels, when · only if · then. The version before it
 * made the same claim in a comment and then presented five identical boxes in a different order, with the
 * labels hidden inside placeholders that vanished on the first keystroke.
 *
 * THE FIRST QUESTION IS NOT THE NAME. It used to be, and it is the one question nobody can answer before they
 * have said what the rule does, so it got a bad answer, or it was the reason the button stayed grey. The rule
 * names itself from what was typed (ruleWords.nameOf) and the box at the bottom is a footnote you may
 * overwrite.
 *
 * NARROWING IS A CLAUSE, NOT A FIELD. Most rules apply to everything, so the shut state SAYS that: "Applies
 * to every change": instead of showing an empty box under a caption explaining that empty means always. Open
 * it and the globs become chips, which is the only way to see that a box splitting on commas understood you.
 *
 * A COMMAND KEEPS ITS BOX AND AN INSTRUCTION DOES NOT. The rule the workflows step inspector is typeset on,
 * and it holds for the same reason: a shell line is a VALUE, and what you tell an assistant is a paragraph
 * somebody writes. */

const { rule, disabled = false } = defineProps<{
    /** The rule being changed. Absent ⇒ writing a new one. */
    rule?: Rule;
    disabled?: boolean;
}>();

const emit = defineEmits<{ save: [RuleDraft]; cancel: [] }>();

// `builtin` never reaches here: the only rules that carry one are the three with a row of their own further up
// the tab, and those are filtered out of the list this form edits.
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
const globs = ref<string[]>([...(rule?.when?.paths ?? [])]);
const globDraft = ref(``);
// A rule that already narrows opens showing it; a new one starts on the sentence it will actually be.
const narrowing = ref(globs.value.length > 0);

const chosenMoment = computed(() => momentOf(moment.value));
const momentOptions = computed(() => MOMENTS.map(({ value, label: name, icon, cost }) => ({ value, label: name, icon, description: cost })));
const actionOptions = computed(() => ACTIONS[moment.value].map(({ value, label: name }) => ({ value, label: name })));
const chosenAction = computed(() => ACTIONS[moment.value].find((entry) => entry.value === action.value));

/* A moment change can strand an action that moment does not take, so the action follows, but only when it has
 * to. Switching "run a command" from the end of a turn to before a push used to throw the command away and
 * land on the first option; both moments run commands, and the one thing the user had typed was the thing that
 * did not survive. */
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

/* Everything before the last separator is finished; what follows it is still being typed. So a pasted
 * "docs/**, src/**" arrives as one chip and one half-typed path rather than as two chips the user never saw
 * form, and typing a comma ends a path the way pressing Enter does.
 *
 * The box is driven from here rather than by `v-model`, because both would be listening for the same `input`
 * and the one that ran second would win: v-model writing back the whole string this just split, or this
 * splitting a string v-model had not yet handed it. One listener, and the element is told what it holds. */
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

// Backspace on an empty box takes the chip before it: the gesture every token field has, and the reason the
// chips need no hover-only affordance to be removable.
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

/* The name the rule gives itself, shown as the box's placeholder so leaving it alone is a real choice rather
 * than a blank. Before anything has been typed there is nothing to derive, and a box with no placeholder at all
 * reads as broken, so the empty case says where the name will come from instead. */
const derived = computed(() => nameOf(action.value, command.value, text.value, globs.value));
const autoName = computed(() => (derived.value === `` ? `Named after what you typed above` : derived.value));

/* WHY THE BUTTON IS GREY, said next to the button. The old form's own comment claimed the disabled button was
 * the explanation; a disabled button explains nothing, and the field it is waiting on is the one thing this
 * can name. The name is deliberately not in here: it can no longer be missing. */
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
        // The ceiling is the schema's own default for a new rule, and whatever an edited one already carried.
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
    // A path still in the box is a path the user typed and would expect to count: committing it here is what
    // makes "type a glob, press Add" behave the way it reads.
    commitDraft();
    if (missing.value !== undefined) {
        return;
    }
    emit(`save`, {
        label: label.value.trim() === `` ? derived.value : label.value.trim(),
        moment: moment.value,
        ...(globs.value.length > 0 ? { when: { paths: [...globs.value] } } : {}),
        action: actionOf(),
    });
};
</script>

<template>
    <div class="flex flex-col gap-4">
        <!-- WHEN. Three moments, and the differences between them are not arbitrary, so each option carries
             what it costs, where the choice is actually made, rather than in a caption under the shut box. -->
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

        <!-- ONLY IF. Shut, it states the default in words; open, it is a list of globs you can see. -->
        <div v-if="!narrowing" class="flex flex-wrap items-center gap-x-2 text-2xs text-subtle">
            <span>Applies to every change.</span>
            <button type="button" :class="ui.linkButton(`text-2xs`)" :disabled="disabled" @click="narrowing = true">Only when it touches…</button>
        </div>
        <div v-else class="flex flex-col gap-1.5">
            <span :class="ui.sectionLabel(`text-2xs`)">Only if it touches</span>
            <div class="flex items-start gap-1">
                <div
                    class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-md border border-line bg-canvas px-2 py-1.5 focus-within:border-line-strong"
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
                        class="min-w-24 flex-1 bg-transparent font-mono text-xs text-content placeholder:text-subtle focus:outline-none"
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

        <!-- THEN. One control where there is a choice and none where there isn't: a push runs a command and
             only a command, and a picker with one option is a question with no answer to give. -->
        <div class="flex flex-col gap-1.5">
            <span :class="ui.sectionLabel(`text-2xs`)">Then</span>
            <!-- Compact rather than the full-width `stretch` track: two short options are a choice inside the
                 sentence, and at nine millimetres tall they shouted louder than the moment above them, which is
                 the bigger decision by far. -->
            <SegmentedControl v-if="actionOptions.length > 1" v-model="action" :options="actionOptions" class="-mt-0.5 mb-0.5" />

            <div
                v-if="action === `command`"
                class="flex items-center gap-2 rounded-md border border-line bg-canvas px-2.5 py-1.5 focus-within:border-line-strong"
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
                    class="min-w-0 flex-1 bg-transparent font-mono text-xs text-content placeholder:text-subtle focus:outline-none"
                />
            </div>
            <!-- The instruction keeps a box even though it is prose, and this is the one place the kit's
                 "a paragraph does not get a border" rule is overridden on purpose: on a document surface the
                 page says "write here", but in a form, beside a bordered command box and a bordered name box, a
                 borderless field reads as the caption of the control above it. It is still a ProseField and
                 still grows with what is typed: an instruction is sentences, and an <input> would scroll them
                 sideways out of sight. -->
            <div
                v-else-if="action === `instruct`"
                class="rounded-md border border-line bg-canvas px-0.5 py-1 focus-within:border-line-strong"
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

        <!-- The name, and the two buttons. Below the hairline because it is no longer part of writing the rule
            : it is what the activity feed will call this one when it fires, and it has already been written. -->
        <div class="mt-3 flex flex-col gap-2">
            <label class="flex items-center gap-2">
                <span :class="ui.sectionLabel(`shrink-0 text-2xs`)">Called</span>
                <input
                    v-model="label"
                    type="text"
                    :placeholder="autoName"
                    aria-label="Rule name"
                    :disabled="disabled"
                    :class="ui.input(`min-w-0 flex-1 px-2 py-1 text-xs`)"
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
