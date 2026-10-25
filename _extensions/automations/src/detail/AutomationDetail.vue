<!-- One automation opened: what needs you (a failure, in full), its settings as facts at a glance, its instructions as a document, and its history as a timeline. -->
<script setup lang="ts">
import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import {
    Button,
    Code,
    CopyButton,
    formatDateTime,
    formatWeekdayTime,
    Icon,
    type IconName,
    Markdown,
    Section,
    toneInk,
    toneTint,
    ui,
} from "@intentic/extension-ui";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { nextIn, since } from "../cronSchedule";
import { host } from "../host";
import AutomationHooks from "./AutomationHooks.vue";
import RunHistory from "./RunHistory.vue";
import { failureStreak, runTally } from "./runHistory";
import { answersPhrase } from "../senderSummary";
import { builtInLabel, usePersonaReach } from "../persona/usePersonaReach";
import { FULL_ACCESS_PERSONA, unwatchedPick } from "@intentic/sandbox-contract/schemas/personas";
import { sourceLabel, watchLine } from "../watch";
import { t } from "../i18n.js";

const props = defineProps<{
    automation: AutomationSummary;
    triggerIcon: IconName;
    // What fires it, in the row's own words, so the drawer and the row can never say it two ways.
    triggerLabel: string;
    // Where a fire goes when it is not a new agent ("Continues …", "Notifies you"); undefined for a new agent.
    targetPhrase: string | undefined;
    targetIcon: IconName | undefined;
    // A one-time wake that already fired.
    spent: boolean;
    busy?: boolean;
}>();
const emit = defineEmits<{ edit: []; run: []; install: [] }>();

const automation = computed(() => props.automation);
const lastRun = computed(() => automation.value.runs[0]);

/* ---- what needs you ---- */

// The newest run failed: said first and in full, since the reason is what anybody opens a failing row to read.
const failure = computed(() => (lastRun.value?.outcome === `error` ? lastRun.value : undefined));
const streak = computed(() => failureStreak(automation.value.runs));

/* ---- facts ---- */

interface Fact {
    readonly key: string;
    readonly icon: IconName;
    readonly label: string;
    readonly value: string;
    readonly note?: string;
    readonly danger?: boolean;
}

const { personaList, reach } = usePersonaReach(automation);

const whenNote = computed<string | undefined>(() => {
    if (props.spent) {
        return t(`automationRow.alreadyFired`);
    }
    const next = automation.value.nextRun;
    if (next !== undefined) {
        return t(`automationDetail.nextAt`, { in: nextIn(next), at: formatWeekdayTime(next) });
    }
    const clock = automation.value.trigger.kind === `schedule` || automation.value.trigger.kind === `once`;
    return clock && !automation.value.enabled ? t(`automationDetail.offNothingScheduled`) : undefined;
});

// Who a new agent runs as, by the persona's own name. Naming none, or No accounts outright, is the built-in No accounts:
// a choice with a cost, so it says the cost where the sandbox holds accounts to miss. Full access says what it reaches.
const actor = computed<Fact>(() => {
    const id = unwatchedPick(automation.value.actsAs);
    const fact = { key: `actor`, icon: `user` as const, label: t(`automationDetail.runsAs`) };
    if (id === undefined) {
        const note = reach.value?.kind === `no-accounts` ? t(`builtInPersonas.noAccountsNote`) : undefined;
        return { ...fact, value: t(`builtInPersonas.noAccounts`), note };
    }
    if (id === FULL_ACCESS_PERSONA) {
        return { ...fact, value: t(`builtInPersonas.fullAccess`), note: t(`builtInPersonas.fullAccessNote`) };
    }
    const gone = reach.value?.kind === `missing` && reach.value.ids.includes(id);
    const label = personaList.data.value?.personas.find((persona) => persona.id === id)?.label ?? builtInLabel(id) ?? id;
    return { ...fact, value: label, note: gone ? t(`automationRow.personaMissing`) : undefined, danger: gone };
});

// The model it wants, then what else it may fall back to: the full ladder is one click away in the editor.
const model = computed<Fact>(() => {
    const [head, ...rest] = automation.value.models ?? [];
    return {
        key: `model`,
        icon: `cpu`,
        label: t(`automationDetail.model`),
        value: head?.model ?? t(`automationRow.noModel`),
        note: [
            ...(head === undefined ? [] : [head.provider]),
            ...(head?.effort === undefined ? [] : [head.effort]),
            ...(rest.length === 0 ? [] : [t(`automationDetail.fallbacks`, { count: rest.length }, rest.length)]),
        ].join(` · `),
    };
});

// Whether a fire goes ahead on its own: the fact that matters most about something that runs while nobody watches.
const gate = computed<Fact>(() => {
    const held = automation.value.requireApproval === true;
    const hold = automation.value.holdForSeconds ?? 0;
    const checked = automation.value.guard !== undefined || automation.value.source !== undefined;
    return {
        key: `gate`,
        icon: held ? `lock` : hold > 0 ? `clock` : `play`,
        label: t(`automationDetail.beforeItRuns`),
        value: held
            ? t(`automationDetail.waitsForYou`)
            : hold > 0
              ? t(`automationDetail.waitsThenRuns`, { seconds: hold })
              : t(`automationDetail.runsOnItsOwn`),
        note:
            automation.value.fireOn === `change`
                ? t(`automationDetail.onlyWhenItChanges`)
                : checked
                  ? t(`automationDetail.onceItsCheckPasses`)
                  : undefined,
    };
});

const facts = computed<readonly Fact[]>(() => {
    const answers = answersPhrase(automation.value.senders);
    return [
        { key: `when`, icon: props.triggerIcon, label: t(`automationDetail.when`), value: props.triggerLabel, note: whenNote.value },
        // A conversation runs on its own model and a notification on none, so only a new agent names one, or a persona.
        ...(props.targetPhrase === undefined
            ? [actor.value, model.value]
            : [{ key: `then`, icon: props.targetIcon ?? `comments`, label: t(`automationRow.then`), value: props.targetPhrase }]),
        gate.value,
        ...(answers === undefined ? [] : [{ key: `answers`, icon: `users` as const, label: t(`automationRow.answers`), value: answers }]),
    ];
});

/* ---- instructions ---- */

// Folded to a screenful with a fade, so a long prompt never pushes the history out of view; measured, not guessed from
// its length, since a short prompt with a code block can be taller than a long paragraph.
const promptBox = ref<HTMLElement>();
const promptOpen = ref(false);
const overflowing = ref(false);
const measure = (): void => {
    const box = promptBox.value;
    overflowing.value = box !== undefined && box.scrollHeight > box.clientHeight + 1;
};
onMounted(measure);
watch(
    () => automation.value.prompt,
    () => void nextTick(measure),
);

/* ---- the check ---- */

const watched = computed(() => watchLine(automation.value));

/* ---- history ---- */

const tally = computed(() => runTally(automation.value.runs));
const TALLY_INK = {
    error: toneInk(`danger`),
    interrupted: `text-muted`,
    completed: `text-muted`,
    skipped: `text-subtle`,
} as const;
const tallyWord = (outcome: keyof typeof TALLY_INK, count: number): string =>
    ({
        error: t(`runHistory.failedCount`, { count }, count),
        interrupted: t(`runHistory.cutOffCount`, { count }, count),
        completed: t(`runHistory.ranCount`, { count }, count),
        skipped: t(`runHistory.skippedCount`, { count }, count),
    })[outcome];

const openFailure = (): void => {
    const id = failure.value?.conversationId;
    if (id !== undefined) {
        host().chat.openSession(id);
    }
};
</script>

<template>
    <div class="@container flex flex-col gap-5 pr-3">
        <!-- What needs you, before anything about what it is. -->
        <div v-if="failure" class="flex items-start gap-3 rounded-lg border px-3.5 py-3" :class="toneTint(`danger`, `soft`)">
            <Icon name="exclamation-circle" class="shrink-0 text-sm" :class="toneInk(`danger`)" />
            <div class="flex min-w-0 flex-1 flex-col gap-1">
                <p class="text-xs font-medium text-content">
                    {{ streak > 1 ? t(`automationDetail.failedInARow`, { count: streak }, streak) : t(`automationDetail.lastRunFailed`) }}
                    <span class="font-normal text-subtle" v-tooltip.top="formatDateTime(failure.at)">· {{ since(failure.at) }}</span>
                </p>
                <p v-if="failure.detail" class="text-xs leading-relaxed break-words text-muted">{{ failure.detail }}</p>
            </div>
            <Button
                v-if="failure.conversationId"
                size="small"
                tier="quiet"
                class="shrink-0"
                :label="t(`automationDetail.openRun`)"
                @click="openFailure"
            >
                <template #icon><Icon name="arrow-up-right" /></template>
            </Button>
        </div>

        <!-- Its settings as facts, each a glyph, a label and a value, so five settings read at a glance rather than as a paragraph. -->
        <dl class="grid gap-2 @lg:grid-cols-2 @3xl:grid-cols-4">
            <div v-for="fact in facts" :key="fact.key" class="flex min-w-0 items-start gap-2.5 rounded-lg bg-content/5 px-3 py-2.5">
                <span
                    class="flex size-7 shrink-0 items-center justify-center rounded-md"
                    :class="fact.danger ? toneTint(`danger`, `soft`, toneInk(`danger`)) : `bg-content/5 text-muted`"
                >
                    <Icon :name="fact.icon" class="text-xs" />
                </span>
                <div class="flex min-w-0 flex-col">
                    <dt class="text-2xs text-subtle">{{ fact.label }}</dt>
                    <dd class="truncate text-xs font-medium text-content" v-tooltip.top.overflow="fact.value">{{ fact.value }}</dd>
                    <dd
                        v-if="fact.note"
                        class="truncate text-2xs"
                        :class="fact.danger ? toneInk(`danger`) : `text-subtle`"
                        v-tooltip.top.overflow="fact.note"
                    >
                        {{ fact.note }}
                    </dd>
                </div>
            </div>
        </dl>

        <!-- What it is told and checks on the left, what it has done on the right; one column when the pane is narrow. -->
        <div class="grid gap-x-8 gap-y-5 @3xl:grid-cols-3">
            <div class="flex min-w-0 flex-col gap-5 @3xl:col-span-2">
                <Section :label="t(`automationDetail.instructions`)">
                    <template #actions>
                        <CopyButton :text="automation.prompt" :aria-label="t(`automationDetail.copyInstructions`)" />
                    </template>
                    <div class="relative">
                        <!-- Rendered as the document it is: prompts are written in markdown, and raw backticks and asterisks are noise. -->
                        <div
                            ref="promptBox"
                            class="overflow-hidden rounded-lg border border-line-subtle px-4 py-3"
                            :class="promptOpen ? `` : `max-h-56`"
                        >
                            <Markdown :source="automation.prompt" />
                        </div>
                        <div
                            v-if="overflowing && !promptOpen"
                            class="pointer-events-none absolute inset-x-px bottom-px h-14 rounded-b-lg bg-gradient-to-t from-card to-transparent"
                            aria-hidden="true"
                        ></div>
                    </div>
                    <button
                        v-if="overflowing || promptOpen"
                        type="button"
                        :class="ui.textButton()"
                        class="mt-1.5"
                        :aria-expanded="promptOpen"
                        @click="promptOpen = !promptOpen"
                    >
                        {{ promptOpen ? t(`automationDetail.showLess`) : t(`automationDetail.showAllInstructions`) }}
                    </button>
                </Section>

                <!-- What decides whether a fire goes ahead, and what it saw last time it looked. -->
                <Section v-if="automation.guard || automation.source || watched" :label="t(`automationRow.check`)">
                    <div class="flex flex-col gap-1.5">
                        <Code v-if="automation.guard" :code="automation.guard" lang="bash" wrap :scroll-lines="6" />
                        <span v-else-if="automation.source" class="flex items-center gap-2 text-xs text-muted">
                            <Icon name="eye" class="shrink-0 text-2xs text-subtle" />
                            <span class="truncate" v-tooltip.top.overflow="sourceLabel(automation.source)">{{ sourceLabel(automation.source) }}</span>
                        </span>
                        <span v-if="watched" class="text-2xs text-subtle">{{ watched }}</span>
                        <template v-if="automation.watch?.value">
                            <span class="mt-1 text-2xs text-subtle">{{
                                automation.watch.changedAt === undefined
                                    ? t(`automationRow.lastSaw`)
                                    : t(`automationRow.lastSawSince`, { when: formatDateTime(automation.watch.changedAt) })
                            }}</span>
                            <pre class="max-h-32 overflow-auto rounded-md bg-canvas px-2 py-1.5 font-mono text-2xs break-words whitespace-pre-wrap text-muted">{{
                                automation.watch.value
                            }}</pre>
                        </template>
                    </div>
                </Section>

                <!-- The doors in from outside: a webhook's URL, a visitor chat's settings. -->
                <AutomationHooks :automation="automation" @install="emit(`install`)" />
            </div>

            <Section class="min-w-0" :label="t(`automationRow.runs`)">
                <template v-if="tally.length > 0" #info>
                    <span class="flex flex-wrap gap-x-2 text-2xs normal-case tracking-normal">
                        <span v-for="entry in tally" :key="entry.outcome" :class="TALLY_INK[entry.outcome]">{{ tallyWord(entry.outcome, entry.count) }}</span>
                    </span>
                </template>
                <RunHistory :runs="automation.runs" />
            </Section>
        </div>

        <!-- The verbs again, in words: the row's glyphs only show on hover, and somebody reading this is about to act on it. -->
        <div class="flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3">
            <Button size="small" tier="boring" :label="t(`automationRow.edit2`)" @click="emit(`edit`)">
                <template #icon><Icon name="pencil" /></template>
            </Button>
            <Button v-if="automation.trigger.kind !== `listener`" size="small" tier="quiet" :label="t(`automationRow.runNow2`)" :disabled="busy" @click="emit(`run`)">
                <template #icon><Icon name="play" /></template>
            </Button>
        </div>
    </div>
</template>
