<!-- One automation opened, as a document beside its settings: what needs you first, then what it is told and what it checks, what it has done, and its settings as a column of values that are each where they are changed. -->
<script setup lang="ts">
import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { Button, formatDateTime, Icon, Section, toneFill, toneInk } from "@intentic/extension-ui";
import { computed } from "vue";
import { since } from "../cronSchedule";
import { host } from "../host";
import AutomationProperties from "../properties/AutomationProperties.vue";
import AutomationHooks from "./AutomationHooks.vue";
import CheckSection from "./CheckSection.vue";
import InstructionsSection from "./InstructionsSection.vue";
import RunHistory from "./RunHistory.vue";
import { failureStreak, runTally } from "./runHistory";
import { t } from "../i18n.js";

const props = defineProps<{
    automation: AutomationSummary;
    // What fires it, in the row's own words, for a trigger that is not a clock.
    triggerLabel: string;
    // Where a fire goes when it is not a new agent ("Continues …", "Notifies you"); undefined for a new agent.
    targetPhrase: string | undefined;
    // A one-time wake that already fired.
    spent: boolean;
    busy?: boolean;
}>();
// `settings` opens the full editor, for what has no place of its own here: a listener's filters, the tools, the people.
const emit = defineEmits<{ settings: []; run: []; install: [] }>();

// The newest run failed: said first and in full, since the reason is what anybody opens a failing row to read.
const failure = computed(() => (props.automation.runs[0]?.outcome === `error` ? props.automation.runs[0] : undefined));
const streak = computed(() => failureStreak(props.automation.runs));
const openFailure = (): void => {
    const id = failure.value?.conversationId;
    if (id !== undefined) {
        host().chat.openSession(id);
    }
};

const tally = computed(() => runTally(props.automation.runs));
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
</script>

<template>
    <div class="@container flex flex-col gap-6 pr-3">
        <!-- What needs you, before anything about what it is: a tinted strip on the row's own ground, not a box inside it. -->
        <div v-if="failure" class="flex items-start gap-3 rounded-lg px-3.5 py-3" :class="toneFill(`danger`, `soft`)">
            <Icon name="exclamation-circle" class="shrink-0 text-sm" :class="toneInk(`danger`)" />
            <div class="flex min-w-0 flex-1 flex-col gap-1">
                <p class="text-sm font-medium text-content">
                    {{ streak > 1 ? t(`automationDetail.failedInARow`, { count: streak }, streak) : t(`automationDetail.lastRunFailed`) }}
                    <span class="font-normal text-subtle" v-tooltip.top="formatDateTime(failure.at)">· {{ since(failure.at) }}</span>
                </p>
                <p v-if="failure.detail" class="text-sm leading-relaxed break-words text-muted">{{ failure.detail }}</p>
            </div>
            <Button v-if="failure.conversationId" size="small" tier="quiet" class="shrink-0" :label="t(`automationDetail.openRun`)" @click="openFailure">
                <template #icon><Icon name="arrow-up-right" /></template>
            </Button>
        </div>

        <!-- Settings beside the document with room, above it without: the column is what a reader scans, the document what they read. -->
        <div class="flex flex-col gap-6 @3xl:flex-row @3xl:gap-8">
            <div class="@3xl:order-last @3xl:w-1/3 @3xl:shrink-0 @3xl:border-l border-line-subtle @3xl:pl-6">
                <AutomationProperties :automation="automation" :trigger-label="triggerLabel" :target-phrase="targetPhrase" :spent="spent" />
            </div>

            <div class="flex min-w-0 flex-1 flex-col gap-6">
                <InstructionsSection :automation="automation" />
                <CheckSection :automation="automation" />
                <AutomationHooks :automation="automation" @install="emit(`install`)" />
                <Section :label="t(`automationRow.runs`)">
                    <template v-if="tally.length > 0" #info>
                        <span class="flex flex-wrap gap-x-2 text-2xs normal-case tracking-normal">
                            <span v-for="entry in tally" :key="entry.outcome" :class="TALLY_INK[entry.outcome]">{{ tallyWord(entry.outcome, entry.count) }}</span>
                        </span>
                    </template>
                    <RunHistory :runs="automation.runs" />
                </Section>
            </div>
        </div>

        <!-- The two presses with no value of their own to sit on. -->
        <div class="flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3">
            <Button
                v-if="automation.trigger.kind !== `listener`"
                size="small"
                tier="boring"
                :label="t(`automationRow.runNow2`)"
                :disabled="busy"
                @click="emit(`run`)"
            >
                <template #icon><Icon name="play" /></template>
            </Button>
            <Button size="small" tier="quiet" :label="t(`automationDetail.allSettings`)" @click="emit(`settings`)">
                <template #icon><Icon name="sliders-h" /></template>
            </Button>
        </div>
    </div>
</template>
