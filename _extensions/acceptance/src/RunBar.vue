<script setup lang="ts">
import { Button, cmp, Icon, Picker } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { type Story, targetKeyOf } from "./stories";
import { DEFAULT_MODEL_VALUE, modelForTurn, PROVIDER_OPTIONS, useAgentRunModel, useModels } from "./useModels";
import type { StartRunInput } from "./useRuns";
import type { useTargets } from "./useTargets";

/* THE RUN COMPOSER — a bar docked under the list, not a dialog over it.
 *
 * This replaces a modal that asked three questions at once and gave each of them a section: which stories (a
 * scroller re-rendering the very list it was covering, ungrouped and truncated), where each app was (one card per
 * story group — a monorepo showed six that all said "Dev server isn't running" about one process), and who tests
 * it. Two scrollbars competed and the only fixed thing on the surface was the button you could not yet press.
 *
 * The other two questions went back where they belong. WHICH is ticked in the real list, which already groups by
 * repo and group and already carries titles, criteria counts and last verdicts. WHERE is stated on the headings
 * those stories sit under, once per repository. What is left is genuinely one line: the scope, who runs it, and
 * the button — so the bar states the whole of what is about to happen and never needs to be dismissed.
 *
 * NOTHING TICKED MEANS EVERYTHING, which is what the old dialog's preselect-them-all default meant. So there is no
 * mode to enter, no empty state, and no second Run button in the page header: the bar is always there, and it
 * always says exactly what pressing it will do.
 *
 * THE GATE IS UNCHANGED and is the reason any of this is stated at all: a run costs one agent session per story,
 * and a story pointed at nothing produces a session that spends minutes discovering the app is down and then
 * writes a blocked report. So Run stays disabled until every group in scope resolves to something serving, and the
 * bar names the first reason — a stopped server and a missing address call for different moves. */

const { chosen, total, narrowed, targets } = defineProps<{
    // What pressing Run will walk — resolved by the view, which owns the ticks, so the rule for "what is in scope"
    // has one home rather than being re-derived by whoever needs it.
    chosen: readonly Story[];
    // How many stories there are, so the bar can say "All 21" rather than "21" and mean something by it.
    total: number;
    // Whether anything is ticked at all. Distinct from `chosen.length < total`: ticking every row by hand is still
    // a narrowed list, and Clear must stay reachable from it.
    narrowed: boolean;
    targets: ReturnType<typeof useTargets>;
}>();
const emit = defineEmits<{
    submit: [Pick<StartRunInput, "stories" | "targets" | "provider" | "model">];
    clear: [];
}>();

/* WHO RUNS IT, and where that answer comes from before anybody touches the two pickers: the sandbox's
 * `agentRunModel`, the same setting every other surface-started run spends. A hand pick wins from the instant it
 * is made, which is why this is one "picked yet?" ref with a fallback rather than a watcher seeding the refs —
 * a watcher would re-seed under the user the moment the settings query refetched, and the bar would silently
 * undo a choice they had already made. */
const picked = ref<{ provider: string; model: string }>();
const agentRunModel = useAgentRunModel();
const provider = computed(() => picked.value?.provider ?? agentRunModel.value?.provider ?? `claude`);
const model = computed(() => picked.value?.model ?? agentRunModel.value?.model ?? DEFAULT_MODEL_VALUE);
const { models } = useModels(provider);

/* The Picker's model is `T | undefined` because a picker CAN be cleared; neither of these ever is (both carry a
 * real default), so an undefined emission is ignored rather than written through. A provider switch invalidates
 * the model with it — model ids belong to the provider that vends them. */
const setProvider = (value: string | undefined): void => {
    if (value !== undefined) {
        picked.value = { provider: value, model: DEFAULT_MODEL_VALUE };
    }
};
const setModel = (value: string | undefined): void => {
    if (value !== undefined) {
        picked.value = { provider: provider.value, model: value };
    }
};

// What Run will spend, said in the two numbers that decide it: one session per story, on a named model. The
// pickers state the model too, but not the multiplication — and 21 frontier sessions is the most expensive
// press in this app.
const spend = computed<string>(() => {
    const label = models.value.find((option) => option.value === model.value)?.label ?? model.value;
    return `${chosen.length} ${chosen.length === 1 ? `session` : `sessions`}${model.value === DEFAULT_MODEL_VALUE ? `` : ` on ${label}`}`;
});

// First-appearance order of the (repo, group) pairs the scope touches — the keys the run's `targets` map is
// built from, and the things the gate is asked about.
const groups = computed<readonly Story[]>(() => {
    const seen = new Map<string, Story>();
    for (const story of chosen) {
        const key = targetKeyOf(story);
        if (!seen.has(key)) {
            seen.set(key, story);
        }
    }
    return [...seen.values()];
});

const blocked = computed<readonly Story[]>(() => groups.value.filter((story) => targets.addressOf(story.repo, story.group) === undefined));
const canRun = computed(() => chosen.length > 0 && blocked.value.length === 0);

const storyCount = (howMany: number): string => `${howMany} ${howMany === 1 ? `story` : `stories`}`;

/* WHAT IS ACTUALLY WRONG, counted in problems rather than in blocked groups. A monorepo's six groups blocked by
 * one stopped dev server are ONE problem with one remedy, and reporting "(+5 more)" for them re-imported the
 * duplication this whole surface was rebuilt to remove — it reads as six things to go and fix. So a stopped or
 * starting server keys on its REPO (the daemon runs one, and Start is per repo) and a missing address keys on its
 * GROUP (each is typed separately). Named for the reason too: "is still starting" and "needs an address" call for
 * different moves, and a note that gave only a name made the user work out which of the two it was. */
const problems = computed<readonly string[]>(() => {
    const found = new Map<string, string>();
    for (const story of blocked.value) {
        const state = targets.stateOf(story.repo);
        if (state === `none`) {
            found.set(targetKeyOf(story), `${targetKeyOf(story)} needs an address`);
            continue;
        }
        found.set(story.repo, `${story.repo}'s dev server ${state === `starting` ? `is still starting` : `isn't running`}`);
    }
    return [...found.values()];
});

const blockedNote = computed<string | undefined>(() => {
    const first = problems.value[0];
    return first === undefined ? undefined : `${first}${problems.value.length > 1 ? ` (+${problems.value.length - 1} more)` : ``}`;
});

const submit = (): void => {
    emit(`submit`, {
        stories: chosen,
        targets: Object.fromEntries(groups.value.map((story) => [targetKeyOf(story), targets.addressOf(story.repo, story.group) ?? ``])),
        provider: provider.value,
        model: modelForTurn(model.value),
    });
};
</script>

<template>
    <!-- Wraps rather than scrolls or truncates: on a narrow area the scope and the agent drop to their own line
         and the button stays whole. A composer that clips its own verb is the failure this replaced. -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line bg-card px-4 py-2.5 sm:px-6">
        <div class="flex items-center gap-2">
            <!-- States the SCOPE in full, so nothing has to be opened to check it. "All" is a real answer, not a
                 placeholder: it is what an untouched list means. -->
            <span class="text-xs text-content">
                {{ narrowed ? `${chosen.length} of ${storyCount(total)}` : `All ${storyCount(total)}` }}
            </span>
            <button v-if="narrowed" type="button" :class="cmp.linkButton(`text-2xs text-muted hover:text-content`)" @click="emit(`clear`)">
                Clear
            </button>
        </div>

        <!-- The design system's own picker rather than two bare Selects — same rows, same keyboard handling, same
             mobile sheet, and a filter box that appears by itself once a provider's model list is long. Ghost
             variant because this is a toolbar, not a form. -->
        <div class="flex min-w-0 items-center gap-1">
            <Picker
                :model-value="provider"
                :options="PROVIDER_OPTIONS"
                variant="ghost"
                class="text-xs"
                aria-label="Agent"
                header="Agent"
                @update:model-value="setProvider"
            />
            <Picker
                :model-value="model"
                :options="models"
                variant="ghost"
                class="min-w-0 text-xs"
                aria-label="Model"
                header="Model"
                @update:model-value="setModel"
            />
        </div>

        <div class="ml-auto flex items-center gap-3">
            <span v-if="blockedNote" class="flex items-center gap-1.5 text-2xs text-warning">
                <Icon name="exclamation-triangle" class="shrink-0" />
                {{ blockedNote }}
            </span>
            <!-- The price of the press, next to the press. Hidden once something is blocking the run, because
                 then the number is not what the user has to act on. -->
            <span v-else-if="chosen.length > 0" class="text-2xs text-muted">{{ spend }}</span>
            <Button :label="`Run ${storyCount(chosen.length)}`" size="small" :disabled="!canRun" @click="submit">
                <template #icon><Icon name="play" /></template>
            </Button>
        </div>
    </div>
</template>
