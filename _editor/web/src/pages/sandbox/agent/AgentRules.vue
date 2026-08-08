<script setup lang="ts">
import type { Rule, RuleMoment } from "@intentic-app/api-contract";
import { Icon, Row, RowGroup, timeAgo } from "@intentic/ui";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { useRules } from "../../../composables/sandbox/useRules";
import RulesInfo from "./RulesInfo.vue";

/* EVERY OTHER STANDING INSTRUCTION — the rules that don't have a row of their own further up this tab.
 *
 * The bet this whole group makes is that a rule is a SENTENCE: at this moment, if this is true, do this. So the
 * add flow asks for those three things in that order and nothing else, and each row below reads back as the
 * sentence that was written. The moment a form here needs a fourth concept, the answer is an agent — which is
 * already one of the things a rule can do — rather than another field.
 *
 * WHAT A MOMENT COSTS is said at the point of choosing rather than in documentation. Today all three are cheap
 * (once a turn, once a push, once an agent), but the whole point of this table is that moments get added, and
 * the first hot one would otherwise arrive as a foot-gun with a friendly picker in front of it.
 *
 * WHICH ACTIONS FIT WHICH MOMENT is not a matter of taste — a verdict at a turn's end has nothing to decide,
 * and the daemon refuses the pair. The picker only ever offers what will actually save, because a form that
 * accepts a rule the daemon then rejects is a worse teacher than one that never offered it. */

const { settings, listed, firings, upsert, remove, setEnabled, move, freeId } = useRules();

const MOMENTS: { value: RuleMoment; label: string; when: string; cost: string }[] = [
    {
        value: `turn.ending`,
        label: `Before the assistant finishes`,
        when: `Runs when a turn is about to end — and it is the only moment that can send the assistant back to work.`,
        cost: `Once per turn.`,
    },
    {
        value: `push.starting`,
        label: `Before you push`,
        when: `Runs when a push is about to go out. Pass and the push goes; fail and it does not.`,
        cost: `Once per push.`,
    },
    {
        value: `agent.finished`,
        label: `When an agent finishes`,
        when: `Decides whether that agent's work lands in your workspace or waits on its branch.`,
        cost: `Once per finished agent.`,
    },
];

// What a rule at each moment can be told to do. Named for the effect rather than for the schema's action kinds
// — "hold" and "allow" are one kind with two verdicts, and nobody choosing between them is thinking that.
type Choice = `instruct` | `command` | `hold` | `allow`;

// The daemon enforces the same pairing; offering anything else here would just move the refusal to after the
// user had typed.
const ACTIONS: Record<RuleMoment, { value: Choice; label: string }[]> = {
    "turn.ending": [
        { value: `instruct`, label: `Tell the assistant something` },
        { value: `command`, label: `Run a command it has to pass` },
    ],
    "push.starting": [{ value: `command`, label: `Run a command` }],
    "agent.finished": [
        { value: `hold`, label: `Hold the work on its branch` },
        { value: `allow`, label: `Land the work` },
    ],
};

const adding = ref(false);
const label = ref(``);
const moment = ref<RuleMoment>(`turn.ending`);
const action = ref<Choice>(`instruct`);
const command = ref(``);
const text = ref(``);
const paths = ref(``);

const chosenMoment = computed(() => MOMENTS.find((entry) => entry.value === moment.value));
const actionOptions = computed(() => ACTIONS[moment.value]);

const reset = (): void => {
    adding.value = false;
    label.value = ``;
    moment.value = `turn.ending`;
    action.value = `instruct`;
    command.value = ``;
    text.value = ``;
    paths.value = ``;
};

// A moment change can strand an action that moment doesn't take (switching to a push leaves "tell the
// assistant" selected), so the action follows its moment to that moment's first option.
const pickMoment = (next: RuleMoment): void => {
    moment.value = next;
    const first = ACTIONS[next][0];
    if (first !== undefined) {
        action.value = first.value;
    }
};

// Every field the chosen action needs, filled. Guarding here rather than letting the daemon refuse keeps the
// disabled Add button as the explanation.
const complete = computed(() => {
    if (label.value.trim() === ``) {
        return false;
    }
    if (action.value === `command`) {
        return command.value.trim() !== ``;
    }
    if (action.value === `instruct`) {
        return text.value.trim() !== ``;
    }
    return true;
});

const actionOf = (): Rule["action"] => {
    if (action.value === `command`) {
        return { kind: `command`, command: command.value.trim(), timeoutMs: 900_000 };
    }
    if (action.value === `instruct`) {
        return { kind: `instruct`, text: text.value.trim() };
    }
    return { kind: `verdict`, verdict: action.value === `allow` ? `allow` : `hold` };
};

const add = (): void => {
    const globs = paths.value
        .split(`,`)
        .map((glob) => glob.trim())
        .filter((glob) => glob !== ``);
    upsert({
        id: freeId(label.value),
        label: label.value.trim(),
        moment: moment.value,
        ...(globs.length > 0 ? { when: { paths: globs } } : {}),
        action: actionOf(),
        enabled: true,
    });
    reset();
};

// The sentence a saved rule reads back as. Deliberately the same words the add flow used to ask for it — a row
// that describes itself differently from the form that made it is a row nobody trusts.
const sentenceOf = (rule: Rule): string => {
    const at = MOMENTS.find((entry) => entry.value === rule.moment)?.label ?? rule.moment;
    const narrowed = (rule.when?.paths?.length ?? 0) > 0 ? ` touching ${rule.when?.paths?.join(`, `)}` : ``;
    if (rule.action.kind === `command`) {
        return `${at}${narrowed} — run ${rule.action.command}`;
    }
    if (rule.action.kind === `instruct`) {
        return `${at}${narrowed} — say: ${rule.action.text}`;
    }
    if (rule.action.kind === `verdict`) {
        return `${at}${narrowed} — ${rule.action.verdict === `allow` ? `land the work` : `hold the work on its branch`}`;
    }
    return `${at}${narrowed}`;
};

// "Never" is a real answer and the one worth reading: a rule that has never done anything since it was written
// is either wrong or aimed at something that has not happened yet, and both are worth a second look.
const firedOf = (rule: Rule): string => {
    const at = firings.value[rule.id];
    return at === undefined ? `Never fired` : `Last fired ${timeAgo(at)}`;
};
</script>

<template>
    <RowGroup label="Rules">
        <template #info><RulesInfo /></template>

        <Row v-for="(rule, index) in listed" :key="rule.id" icon="shield" :title="rule.label" :description="sentenceOf(rule)" density="compact">
            <template #control>
                <div class="flex items-center gap-1">
                    <!-- Order is the priority at a deciding moment, so it has to be movable from the list that
                         shows it. Disabled at the ends rather than hidden: a control that vanishes reads as a
                         bug, and the ends are exactly where someone checks whether they can go further. -->
                    <Button text rounded size="small" aria-label="Move up" :disabled="index === 0" @click="move(rule.id, -1)">
                        <Icon name="chevron-up" />
                    </Button>
                    <Button text rounded size="small" aria-label="Move down" :disabled="index === listed.length - 1" @click="move(rule.id, 1)">
                        <Icon name="chevron-down" />
                    </Button>
                    <Button text rounded size="small" aria-label="Delete rule" @click="remove(rule.id)">
                        <Icon name="trash" />
                    </Button>
                    <ToggleSwitch
                        :model-value="rule.enabled"
                        :disabled="settings === undefined"
                        @update:model-value="(value: boolean) => setEnabled(rule.id, value)"
                    />
                </div>
            </template>
            <template #below>
                <p class="text-2xs" :class="firings[rule.id] === undefined ? 'text-subtle' : 'text-muted'">{{ firedOf(rule) }}</p>
            </template>
        </Row>

        <Row
            v-if="listed.length === 0 && !adding"
            icon="shield"
            density="compact"
            description="No rules yet — the three above are the common ones."
        />

        <!-- The add flow, in the order the sentence reads: when, if, do. -->
        <Row v-if="adding" icon="plus" density="compact" title="New rule">
            <template #below>
                <div class="flex flex-col gap-3 pt-1">
                    <InputText v-model="label" placeholder="What is this rule called?" size="small" aria-label="Rule name" />

                    <div class="flex flex-col gap-1">
                        <Select
                            :model-value="moment"
                            :options="MOMENTS"
                            option-label="label"
                            option-value="value"
                            size="small"
                            aria-label="When this rule runs"
                            @update:model-value="pickMoment"
                        />
                        <p class="text-2xs text-muted">{{ chosenMoment?.when }} {{ chosenMoment?.cost }}</p>
                    </div>

                    <div class="flex flex-col gap-1">
                        <InputText
                            v-model="paths"
                            placeholder="Only when it touches… (docs/**, **/*.sql — optional)"
                            size="small"
                            aria-label="Paths"
                        />
                        <p class="text-2xs text-muted">Leave empty and the rule always applies at its moment.</p>
                    </div>

                    <Select
                        v-model="action"
                        :options="actionOptions"
                        option-label="label"
                        option-value="value"
                        size="small"
                        aria-label="What this rule does"
                    />

                    <InputText
                        v-if="action === `command`"
                        v-model="command"
                        placeholder="pnpm lint"
                        size="small"
                        class="font-mono"
                        aria-label="Command to run"
                    />
                    <InputText
                        v-if="action === `instruct`"
                        v-model="text"
                        placeholder="Update the changelog before you finish."
                        size="small"
                        aria-label="What to tell the assistant"
                    />

                    <div class="flex items-center gap-2">
                        <Button size="small" label="Add rule" :disabled="!complete || settings === undefined" @click="add" />
                        <Button size="small" text label="Cancel" @click="reset" />
                    </div>
                </div>
            </template>
        </Row>

        <Row v-else as="button" icon="plus" density="compact" interactive title="Add a rule" @click="adding = true" />
    </RowGroup>
</template>
