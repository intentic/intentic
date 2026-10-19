<!-- UNINSTALL INTENTIC FROM THIS COMPUTER: what is here and what each choice does to every part of it, the choice, the run
     as a checklist, and its end, after which the app removes itself (src-tauri/src/uninstall.rs runs it, uninstallModel.ts
     reads it). The ledger is the page: every part of what Intentic put here says on its own line what happens to it, and
     says it again the moment the choice changes, so the consequence is read off the list rather than taken on trust. -->
<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { Button, Code, Icon, Modal, Notice, toneTint, toneWash, ui } from "@intentic/ui";
import type { IconName } from "@intentic/ui/icons";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { revealLog } from "../../desktop";
import {
    onUninstall,
    type UninstallChoice,
    type UninstallInventory,
    type UninstallProgress,
    type UninstallStep,
    uninstallFinish,
    uninstallInventory,
    uninstallRun,
    uninstallState,
} from "../../desktopUninstall";
import {
    checklistOf,
    choiceQuestion,
    choiceWords,
    cleanEnd,
    countTyped,
    currentStep,
    DEFAULT_CHOICE,
    type Fate,
    type Fates,
    fateWord,
    hasData,
    ledger,
    NAMED_SANDBOXES,
    needsCount,
    percentOf,
    primaryLabel,
    runArgs,
    sandboxLine,
    staysAfter,
    staysSentence,
} from "./uninstallModel";

const { appVersion } = defineProps<{
    /** The app's own version, for the ledger's last line when ic does not say. */
    appVersion?: string | undefined;
}>();

const open = defineModel<boolean>(`open`, { required: true });

const t = useT();

/** Where the dialog is: looking, could not look, the review, the run, its end, quitting, and the package left to remove. */
type Phase = `loading` | `lookFailed` | `review` | `running` | `ended` | `closing` | `package`;

const phase = ref<Phase>(`loading`);
const inventory = ref<UninstallInventory | undefined>(undefined);
const lookError = ref(``);
const picked = ref<UninstallChoice>(DEFAULT_CHOICE);
const typed = ref(``);
const runError = ref<string | undefined>(undefined);
const progress = ref<UninstallProgress | undefined>(undefined);
const finishError = ref<string | undefined>(undefined);
const packageCommand = ref<string | undefined>(undefined);
const packageReason = ref<string | undefined>(undefined);

const countId = useId();
const choiceName = useId();

/* WHAT IS HERE. */

const look = async (): Promise<void> => {
    phase.value = `loading`;
    runError.value = undefined;
    try {
        inventory.value = await uninstallInventory();
        picked.value = DEFAULT_CHOICE;
        typed.value = ``;
        phase.value = `review`;
    } catch (error) {
        lookError.value = errorMessage(error);
        phase.value = `lookFailed`;
    }
};

// On opening: a run already under way or ended in this run of the app is shown as it stands, never started again.
const begin = async (): Promise<void> => {
    let last: UninstallProgress | null = null;
    try {
        last = await uninstallState();
    } catch (error) {
        // An app too old to keep one has none to show: the review starts afresh.
        console.warn(`[device] the last uninstall could not be read:`, error);
    }
    if (last !== null) {
        progress.value = last;
        phase.value = last.outcome === null ? `running` : `ended`;
        return;
    }
    await look();
};

watch(open, (now) => {
    if (now && (phase.value === `loading` || phase.value === `lookFailed` || phase.value === `review`)) {
        void begin();
    }
});

const rows = computed(() => (inventory.value === undefined ? [] : ledger(inventory.value, appVersion)));
const data = computed(() => inventory.value !== undefined && hasData(inventory.value));
const words = computed(() => (inventory.value === undefined ? undefined : choiceWords(inventory.value)));
const question = computed(() => (inventory.value === undefined ? `` : choiceQuestion(inventory.value)));
const counting = computed(() => inventory.value !== undefined && needsCount(inventory.value, picked.value));
const counted = computed(() => inventory.value !== undefined && countTyped(inventory.value, picked.value, typed.value));
const label = computed(() => (inventory.value === undefined ? t(`desktop.uninstall.uninstall`) : primaryLabel(inventory.value, picked.value)));
const sandboxes = computed(() => (inventory.value?.sandboxes ?? []).map(sandboxLine));
const choices: readonly UninstallChoice[] = [`everything`, `keep-sandboxes`];

/** What the chosen outcome does to a row, for the fate drawn at its end. */
const fateOf = (fates: Fates): Fate => (data.value ? fates[picked.value] : fates.everything);


/* THE RUN. */

const choice = computed<UninstallChoice>(() => progress.value?.choice ?? (inventory.value === undefined ? picked.value : runArgs(inventory.value, picked.value).choice));
const steps = computed(() => checklistOf(inventory.value, choice.value, progress.value));
const current = computed(() => currentStep(steps.value));
const percent = computed(() => percentOf(steps.value));
const outcome = computed(() => progress.value?.outcome ?? null);
const clean = computed(() => outcome.value !== null && cleanEnd(outcome.value));
const stays = computed(() => staysSentence(staysAfter(outcome.value, inventory.value)));
const position = computed(() => {
    const at = current.value;
    return at === undefined ? undefined : t(`desktop.uninstall.stepOf`, { index: steps.value.indexOf(at) + 1, total: steps.value.length });
});

const run = async (): Promise<void> => {
    // One run, however many times Enter is pressed: the first press leaves the review.
    if (phase.value !== `review` || inventory.value === undefined || !counted.value) {
        return;
    }
    const args = runArgs(inventory.value, picked.value);
    runError.value = undefined;
    progress.value = undefined;
    phase.value = `running`;
    try {
        progress.value = await uninstallRun(args.choice, args.confirm);
        phase.value = `ended`;
    } catch (error) {
        // It never started: nothing was removed, and the review is still the truth.
        runError.value = errorMessage(error);
        phase.value = `review`;
    }
};

let unlisten: (() => void) | undefined;
onMounted(async () => {
    unlisten = await onUninstall((heard) => {
        progress.value = heard;
        if (heard.outcome !== null && phase.value === `running`) {
            phase.value = `ended`;
        }
    });
});
onBeforeUnmount(() => unlisten?.());

/* THE APP ITSELF. */

const finish = async (leavePackage = false): Promise<void> => {
    finishError.value = undefined;
    const from = phase.value;
    phase.value = `closing`;
    try {
        const answer = await uninstallFinish(leavePackage);
        if (!answer.closing) {
            packageCommand.value = answer.command ?? undefined;
            packageReason.value = answer.reason ?? undefined;
            phase.value = `package`;
        }
    } catch (error) {
        finishError.value = errorMessage(error);
        phase.value = from;
    }
};

/* THE BOX. */

// Only a box nothing has started in may be put away: once ic runs, the run and its end are the only way on.
const dismissable = computed(() => phase.value === `loading` || phase.value === `lookFailed` || phase.value === `review`);
const shown = computed({
    get: () => open.value,
    set: (value: boolean) => {
        if (value || dismissable.value) {
            open.value = value;
        }
    },
});

const header = computed(() => {
    switch (phase.value) {
        case `running`:
            return t(`desktop.uninstall.runningTitle`);
        case `ended`:
        case `closing`:
            return clean.value ? t(`desktop.uninstall.doneTitle`) : t(`desktop.uninstall.partialTitle`);
        case `package`:
            return t(`desktop.uninstall.packageTitle`);
        default:
            return t(`desktop.uninstall.title`);
    }
});

const description = computed((): string | undefined => {
    switch (phase.value) {
        case `review`:
            return t(`desktop.uninstall.lead`);
        case `ended`:
        case `closing`:
            return clean.value
                ? t(`desktop.uninstall.doneLead`)
                : t(`desktop.uninstall.partialLead`, { count: outcome.value?.failed.length ?? 1 }, outcome.value?.failed.length ?? 1);
        case `package`:
            return t(`desktop.uninstall.packageLead`);
        default:
            return undefined;
    }
});

/** The mark beside the title. */
interface Mark {
    readonly icon: IconName;
    readonly tone: `danger` | `primary` | `success` | `warning`;
    readonly spin: boolean;
}

/** The mark beside the title says where the uninstall is: about to remove, removing, removed, or short of it. */
const mark = computed((): Mark => {
    switch (phase.value) {
        case `running`:
            return { icon: `spinner`, tone: `primary`, spin: true };
        case `ended`:
        case `closing`:
            return clean.value ? { icon: `check`, tone: `success`, spin: false } : { icon: `exclamation-triangle`, tone: `warning`, spin: false };
        // One step left, and it is the reader's to take in a terminal.
        case `package`:
            return { icon: `terminal`, tone: `primary`, spin: false };
        default:
            return { icon: `trash`, tone: `danger`, spin: false };
    }
});

/** A step's glyph and ink, and what a screen reader hears it as. */
interface StepGlyph {
    readonly icon: IconName | undefined;
    readonly ink: string;
    readonly spin: boolean;
    readonly said: string;
}

const glyph = (step: UninstallStep): StepGlyph => {
    switch (step.state) {
        case `done`:
            return { icon: `check`, ink: `text-success`, spin: false, said: t(`desktop.uninstall.stateDone`) };
        case `running`:
            return { icon: `spinner`, ink: `text-link`, spin: true, said: t(`desktop.uninstall.stateRunning`) };
        case `failed`:
            return { icon: `times`, ink: `text-danger`, spin: false, said: t(`desktop.uninstall.stateFailed`) };
        case `skipped`:
            return { icon: undefined, ink: `text-faint`, spin: false, said: t(`desktop.uninstall.stateSkipped`) };
        default:
            return { icon: undefined, ink: `text-faint`, spin: false, said: t(`desktop.uninstall.statePending`) };
    }
};
</script>

<template>
    <Modal v-model:open="shown" size="md" :header="header" :description="description" :dismissable="dismissable" :closable="dismissable">
        <template #icon>
            <span :class="toneWash(mark.tone, `grid size-9 place-items-center rounded-full`)">
                <Icon :name="mark.icon" :spin="mark.spin" />
            </span>
        </template>

        <!-- LOOKING: ic lists the sandboxes and asks docker their sizes, which takes a few seconds on a big machine. -->
        <p v-if="phase === `loading`" class="flex items-center gap-2.5 py-6 text-sm text-muted" role="status">
            <Icon name="spinner" spin class="shrink-0 text-link" />
            <span>{{ t(`desktop.uninstall.looking`) }}</span>
        </p>

        <Notice v-else-if="phase === `lookFailed`" tone="danger" class="text-xs">
            <span class="block font-medium">{{ t(`desktop.uninstall.lookFailed`) }}</span>
            <span class="mt-0.5 block break-words whitespace-pre-line text-2xs">{{ lookError }}</span>
        </Notice>

        <!-- THE REVIEW: the ledger, the choice, the count, what stays. -->
        <div v-else-if="phase === `review` && inventory" class="flex flex-col gap-5">
            <ul class="-my-1 flex flex-col divide-y divide-line-subtle" :aria-label="t(`desktop.uninstall.lead`)">
                <li v-for="row in rows" :key="row.id" class="flex items-start gap-3 py-2">
                    <Icon :name="row.icon" class="mt-0.5 shrink-0 text-subtle" />
                    <div class="min-w-0 flex-1">
                        <p class="flex min-w-0 items-baseline gap-2 text-sm leading-snug">
                            <span class="truncate font-medium text-content">{{ row.title }}</span>
                            <span v-if="row.size" class="shrink-0 text-xs text-subtle tabular-nums">{{ row.size }}</span>
                        </p>
                        <p v-if="row.detail" class="text-xs leading-snug text-muted">{{ row.detail }}</p>
                        <!-- The sandboxes one by one, a few at most: which of them is about to go is the point of the row. -->
                        <ul v-if="row.id === `sandboxes`" class="mt-0.5 flex flex-col text-xs leading-snug text-muted">
                            <li v-for="sandbox in sandboxes.slice(0, NAMED_SANDBOXES)" :key="sandbox.name" class="flex min-w-0 items-baseline gap-2">
                                <span class="truncate font-mono text-2xs text-content/80">{{ sandbox.name }}</span>
                                <span v-if="sandbox.state" class="shrink-0 text-subtle">{{ sandbox.state }}</span>
                                <span v-if="sandbox.size" class="ml-auto shrink-0 text-subtle tabular-nums">{{ sandbox.size }}</span>
                            </li>
                            <li v-if="sandboxes.length > NAMED_SANDBOXES" class="text-subtle">
                                {{ t(`desktop.uninstall.moreSandboxes`, { count: sandboxes.length - NAMED_SANDBOXES }) }}
                            </li>
                        </ul>
                    </div>
                    <!-- WHAT HAPPENS TO IT, under the choice made now: said again the moment the choice changes. -->
                    <!-- A column of its own, as wide as its longest word, so a row does not shift when the choice changes. -->
                    <span class="flex w-20 shrink-0 justify-end">
                        <Transition
                            mode="out-in"
                            enter-active-class="transition-opacity duration-150 motion-reduce:transition-none"
                            enter-from-class="opacity-0"
                            leave-active-class="transition-opacity duration-100 motion-reduce:transition-none"
                            leave-to-class="opacity-0"
                        >
                            <span
                                :key="fateOf(row.fate)"
                                class="inline-flex items-center gap-1 text-xs font-medium"
                                :class="{
                                    [toneWash(`danger`, `rounded-md px-1.5 py-px`)]: fateOf(row.fate) === `deleted`,
                                    'text-subtle': fateOf(row.fate) === `removed`,
                                    'text-success': fateOf(row.fate) === `stays`,
                                }"
                            >
                                <Icon v-if="fateOf(row.fate) === `deleted`" name="trash" class="text-2xs" />
                                <Icon v-else-if="fateOf(row.fate) === `stays`" name="check" class="text-2xs" />
                                {{ fateWord(fateOf(row.fate)) }}
                            </span>
                        </Transition>
                    </span>
                </li>
            </ul>

            <!-- THE CHOICE, when there is anything of the reader's to keep: two cards, one radio group. -->
            <fieldset v-if="data && words" class="flex flex-col gap-2.5">
                <legend class="mb-2.5 text-sm font-semibold text-content">{{ question }}</legend>
                <div class="grid gap-2.5 sm:grid-cols-2">
                    <label
                        v-for="option in choices"
                        :key="option"
                        class="flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3.5 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-primary-fill/50 motion-reduce:transition-none"
                        :class="picked === option ? toneTint(option === `everything` ? `danger` : `primary`, `soft`) : `border-line hover:border-line-strong`"
                    >
                        <input v-model="picked" type="radio" class="sr-only" :name="choiceName" :value="option" />
                        <span class="flex items-center gap-2 text-sm font-semibold text-content">
                            <span
                                class="grid size-4 shrink-0 place-items-center rounded-full border-2"
                                :class="picked === option ? (option === `everything` ? `border-danger` : `border-primary-fill`) : `border-line-strong`"
                                aria-hidden="true"
                            >
                                <span v-if="picked === option" class="size-2 rounded-full" :class="option === `everything` ? `bg-danger` : `bg-primary-fill`" />
                            </span>
                            {{ words[option].title }}
                        </span>
                        <span class="pl-6 text-xs leading-relaxed text-muted">{{ words[option].body }}</span>
                    </label>
                </div>
            </fieldset>
            <p v-else class="flex items-start gap-2.5 text-sm leading-relaxed text-muted">
                <Icon name="info-circle" class="mt-0.5 shrink-0 text-subtle" />
                <span>{{ t(`desktop.uninstall.noData`) }}</span>
            </p>

            <!-- THE COUNT: what stands between the button and a deletion nobody can undo. -->
            <div v-if="counting" class="flex flex-wrap items-center gap-3">
                <label :for="countId" class="text-sm text-content">{{ t(`desktop.uninstall.typeCount`, { count: inventory.deleteCount }) }}</label>
                <input
                    :id="countId"
                    v-model="typed"
                    type="text"
                    inputmode="numeric"
                    autocomplete="off"
                    spellcheck="false"
                    maxlength="6"
                    :class="ui.input(`w-20 text-center font-mono tabular-nums`)"
                    @keydown.enter.prevent="run"
                />
                <Icon v-if="counted" name="check" class="text-success" :aria-label="t(`desktop.uninstall.stateDone`)" />
            </div>

            <p v-if="staysSentence(inventory.stays)" class="text-xs leading-relaxed text-subtle">{{ staysSentence(inventory.stays) }}</p>

            <Notice v-if="runError" tone="danger" class="text-xs">
                <span class="block font-medium">{{ t(`desktop.uninstall.runFailed`) }}</span>
                <span class="mt-0.5 block break-words text-2xs">{{ runError }}</span>
            </Notice>
        </div>

        <!-- THE RUN, AND ITS END: the plan as a checklist, the step in hand at reading size. -->
        <div v-else-if="phase === `running` || phase === `ended` || phase === `closing`" class="flex flex-col gap-4">
            <template v-if="phase === `running`">
                <div class="flex flex-col gap-2.5" role="status" aria-live="polite">
                    <div class="flex items-baseline justify-between gap-3">
                        <p class="min-w-0 truncate text-sm font-medium text-content">{{ current?.label || t(`desktop.uninstall.gettingReady`) }}</p>
                        <span v-if="position" class="shrink-0 text-xs text-subtle tabular-nums">{{ position }}</span>
                    </div>
                    <div class="relative h-1.5 overflow-hidden rounded-full bg-content/10" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100">
                        <span class="absolute inset-y-0 left-0 rounded-full bg-primary-fill transition-[width] duration-500 ease-out motion-reduce:transition-none" :style="{ width: `${Math.max(percent, 4)}%` }" />
                    </div>
                    <p v-if="current?.detail" class="truncate text-xs text-muted">{{ current.detail }}</p>
                </div>
            </template>

            <!-- What did not come off, each with its own words and the command that finishes it. -->
            <ul v-if="phase !== `running` && outcome && outcome.failed.length > 0" class="flex flex-col gap-3">
                <li v-for="(failure, index) in outcome.failed" :key="index" :class="toneTint(`warning`, `soft`, `flex flex-col gap-1.5 rounded-lg border p-3`)">
                    <p class="flex items-start gap-2 text-sm font-medium text-content">
                        <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                        <span>{{ failure.label }}</span>
                    </p>
                    <p class="pl-6 text-xs leading-relaxed break-words text-muted">{{ failure.problem }}</p>
                    <div v-if="failure.fix" class="pl-6">
                        <Code :code="failure.fix" lang="bash" :wrap="true" :label="t(`desktop.uninstall.runToFinish`)" />
                    </div>
                </li>
            </ul>

            <ol class="flex flex-col gap-1.5" :class="phase === `running` ? `border-t border-line pt-3.5` : ``">
                <li v-for="step in steps" :key="step.step" class="flex items-start gap-2.5 text-xs">
                    <span class="mt-0.5 flex size-3.5 shrink-0 items-center justify-center" :class="glyph(step).ink">
                        <Icon v-if="glyph(step).icon" :name="glyph(step).icon!" :spin="glyph(step).spin" />
                        <span v-else class="size-1.5 rounded-full border border-current" :class="step.state === `skipped` ? `` : `bg-current opacity-60`" />
                    </span>
                    <span class="min-w-0 flex-1" :class="step.state === `running` ? `font-medium text-content` : step.state === `skipped` ? `text-faint line-through` : `text-muted`">
                        {{ step.label }}
                        <span class="sr-only">({{ glyph(step).said }})</span>
                    </span>
                </li>
            </ol>

            <Notice v-if="phase === `running`" tone="warning" class="text-xs">{{ t(`desktop.uninstall.cantStop`) }}</Notice>

            <p v-if="phase !== `running` && stays" class="text-xs leading-relaxed text-subtle">{{ stays }}</p>

            <Notice v-if="finishError" tone="danger" class="text-xs">
                <span class="block font-medium">{{ t(`desktop.uninstall.finishFailed`) }}</span>
                <span class="mt-0.5 block break-words text-2xs">{{ finishError }}</span>
            </Notice>
        </div>

        <!-- THE PACKAGE LEFT TO REMOVE (a deb or rpm whose password prompt was missing or refused). -->
        <div v-else-if="phase === `package`" class="flex flex-col gap-3">
            <Code v-if="packageCommand" :code="packageCommand" lang="bash" :wrap="true" />
            <p v-if="packageReason" class="text-xs leading-relaxed text-subtle">{{ packageReason }}</p>
        </div>

        <template #footer>
            <template v-if="phase === `loading` || phase === `lookFailed` || phase === `review`">
                <Button :label="t(`ui.action.cancel`)" tier="quiet" @click="open = false" />
                <Button v-if="phase === `lookFailed`" :label="t(`ui.action.tryAgain`)" tier="boring" @click="look" />
                <Button v-if="phase === `review`" :label="label" tone="danger" :disabled="!counted" @click="run">
                    <template #icon><Icon name="trash" /></template>
                </Button>
            </template>
            <template v-else-if="phase === `ended` || phase === `closing`">
                <button
                    v-if="progress?.log && !clean"
                    type="button"
                    :class="ui.textButton({ tone: `quiet`, size: `xs` }, `mr-auto`)"
                    @click="revealLog(progress.log)"
                >
                    {{ t(`desktop.uninstall.openLog`) }}
                </button>
                <Button :label="phase === `closing` ? t(`desktop.uninstall.closing`) : t(`desktop.uninstall.finish`)" :loading="phase === `closing`" :disabled="phase === `closing`" @click="finish()" />
            </template>
            <template v-else-if="phase === `package`">
                <Button :label="t(`desktop.uninstall.closeIntentic`)" @click="finish(true)" />
            </template>
        </template>
    </Modal>
</template>
