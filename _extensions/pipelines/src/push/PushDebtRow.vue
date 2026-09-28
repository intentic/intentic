<script setup lang="ts">
import type { Finding } from "@intentic/sandbox-contract";
import {
    AgentRunButton,
    type AgentRunAttempt,
    appLink,
    DisclosureRow,
    fixStanceLook,
    formatTimestamp,
    Icon,
    type NoticeModel,
    noticeFrom,
    noticeOf,
    timeAgo,
    ui,
    useAgentRunPick,
} from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { host } from "../host";
import { findingGist, type PushDebt, type PushFixAttempt, pushTitle, shortSha } from "./pushChecks";
import type { PushChecksHands } from "./usePushChecks";
import { t } from "../i18n.js";

// ONE PROJECT'S DEBT AT PUSH, drawn the way a run row is: what it owes and the push that brought it on the header, the
// owner's hands at its end, and the findings themselves in its drawer, set in like a terminal's excerpt. The pre-push
// check never refused these, so nothing here is drawn as failing: it wears amber until a later measurement no longer
// prints it or the owner dismisses it. The only words it puts up of its own are the receipts of the owner's presses.

const props = defineProps<{
    debt: PushDebt;
    // What to call the project: its folder, or the workspace for the root.
    name: string;
    // The hand-over already on these findings, as the fleet reports it (pushFixAttemptOf).
    attempt: PushFixAttempt | undefined;
    hands: PushChecksHands;
}>();
const emit = defineEmits<{
    // Findings set aside, for the board's receipt and its Undo, which must outlive this row: dismissing the last finding
    // takes the row away with it.
    dismissed: [ids: readonly string[], changed: number];
    // Anything else worth saying about a press: a measurement's result, or why a press failed.
    notice: [notice: NoticeModel];
}>();

const api = host();
const SEP = ` · `;
// As many as keep a drawer a glance, the rest one press away.
const SHOWN = 8;

const project = computed(() => props.debt.project);

// Rows a dismiss has taken but the refreshed record has not yet dropped, so the press is seen at once.
const leaving = ref<ReadonlySet<string>>(new Set());
const standing = computed(() => props.debt.open.filter((finding) => !leaving.value.has(finding.id)));
const everything = ref(false);
const shown = computed(() => (everything.value ? standing.value : standing.value.slice(0, SHOWN)));
const hidden = computed(() => standing.value.length - SHOWN);
const open = ref(false);

const push = computed(() => props.debt.newest);
const earlier = computed(() => Math.max(0, props.debt.pushes.length - 1));

// The check's own tone, never red: a `code` gate fails the tree whoever caused it, so it wears the row's amber; a `tidy`
// line is only something the push added, and reads as the quietest thing here.
const sourceTone = (finding: Finding): string => (finding.gate === `code` ? `text-warning` : finding.gate === `tidy` ? `text-subtle` : `text-muted`);

// Everything the row cuts: the whole finding, the commit that brought it, how to see it again, and, for one no
// measurement can see gone, how it ends. One paragraph, so the parts are joined like the lines.
const findingHint = (finding: Finding): string =>
    [
        finding.text,
        ...(finding.commit === undefined ? [] : [t(`leftAtPush.from`, { sha: shortSha(finding.commit.sha), subject: finding.commit.subject })]),
        ...(finding.command === undefined ? [] : [finding.command]),
        ...(finding.recheckable ? [] : [t(`leftAtPush.endsWhenDismissed`)]),
    ].join(SEP);

// Named ids even for "all", so the receipt's Undo opens exactly what this press closed and nothing a push filed since.
const dismiss = async (ids: readonly string[]): Promise<void> => {
    leaving.value = new Set([...leaving.value, ...ids]);
    try {
        const changed = await props.hands.dismiss(project.value, ids);
        if (changed > 0) {
            emit(`dismissed`, ids, changed);
        }
    } catch (error) {
        emit(`notice`, noticeFrom(error, t(`leftAtPush.dismissFailed`)));
    } finally {
        leaving.value = new Set([...leaving.value].filter((id) => !ids.includes(id)));
    }
};

// Measured again over the main tree: whatever it no longer prints resolves, and the row redraws from the record.
const rechecking = ref(false);
const recheck = async (): Promise<void> => {
    if (rechecking.value) {
        return;
    }
    rechecking.value = true;
    try {
        const result = await props.hands.recheck(project.value);
        emit(
            `notice`,
            result.measured
                ? noticeOf(t(`leftAtPush.rechecked`, { project: props.name, resolved: result.resolved, open: result.open }), { tone: `info` })
                : noticeOf(t(`leftAtPush.unmeasured`, { project: props.name }), { tone: `warning` }),
        );
    } catch (error) {
        emit(`notice`, noticeFrom(error, t(`leftAtPush.unmeasured`, { project: props.name }), { tone: `warning` }));
    } finally {
        rechecking.value = false;
    }
};

// THE HAND-OVER, after the run rows' (PipelineRunRow.vue): no attempt yet (the press), an attempt still in play (its chip
// and the way to it, no second press), or one that ended (its chip, and the press continues it).
const look = computed(() => (props.attempt === undefined ? undefined : fixStanceLook(props.attempt.stance.kind)));
const inPlay = computed(() => props.attempt?.stance.ongoing === true);
const attemptLink = computed(() => {
    const id = props.attempt?.agent.id;
    return id === undefined ? undefined : appLink(api.href(`/agents/${id}`), () => api.chat.openAgent(id));
});

// The attempt as the picker's bar names it, so the caret's panel ends in Continue / Start over over it.
const attemptOnOffer = computed<AgentRunAttempt | undefined>(() => {
    const held = props.attempt;
    if (held === undefined) {
        return undefined;
    }
    const summary = [t(`leftAtPush.attempt`, { count: held.attempt }), held.agent.model, held.stance.label.toLowerCase()]
        .filter((part) => part !== undefined)
        .join(SEP);
    return { summary, continuable: held.stance.retry };
});
const fixModel = useAgentRunPick(
    () => host().models,
    `pre-push-fix`,
    () => attemptOnOffer.value,
);

// A refusal (an attempt already running on them, one the board had not seen yet) is said in the daemon's words, and the
// fleet is read again with it, so the attempt it means draws its chip here.
const handing = ref(false);
const handOver = async (): Promise<void> => {
    if (handing.value) {
        return;
    }
    handing.value = true;
    const pick = fixModel.overridden.value ? fixModel.model.value : undefined;
    const mode = fixModel.resume.value;
    fixModel.clear();
    try {
        const conversationId = await props.hands.handOver(project.value, pick, mode);
        // The fleet board, as the run rows' own Fix opens: nothing to review yet, and `?focus` waits for the roster.
        api.navigate(`/agents?focus=${encodeURIComponent(conversationId)}`);
    } catch (error) {
        emit(`notice`, noticeFrom(error, t(`leftAtPush.handFailed`)));
    } finally {
        handing.value = false;
    }
};
</script>

<template>
    <!-- @container: the header's facts are measured against this row, not the window, which the chat panel can halve. -->
    <DisclosureRow
        :data-push-debt="debt.project"
        class="@container border-l-4 border-l-warning"
        hit="pair"
        body="drawer"
        wide-control
        v-model:open="open"
    >
        <template #lead="{ iconClass }">
            <Icon name="arrow-up-right" class="shrink-0 text-warning" :class="iconClass" />
        </template>

        <template #title>
            <div class="flex min-w-0 items-center gap-2">
                <span class="min-w-0 truncate text-sm font-medium text-content" :class="debt.project === `` ? `` : `font-mono`">{{ name }}</span>
                <span class="shrink-0 text-xs text-warning" v-tooltip.top="t(`leftAtPush.explain`)">{{
                    t(`leftAtPush.stillOpen`, { count: standing.length }, standing.length)
                }}</span>
            </div>
        </template>

        <!-- The push the findings came with, as git would name it: the commit and the branch it went to, how much it carried, and when. -->
        <template #description>
            <span v-if="push !== undefined" data-push-line class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-subtle">
                <span>{{ t(`leftAtPush.lastPush`) }}</span>
                <span class="font-mono text-muted">{{ pushTitle(push) }}</span>
                <span v-if="push.refused" class="text-warning" v-tooltip.top="t(`leftAtPush.refusedHint`)">{{ t(`leftAtPush.refused`) }}</span>
                <span v-else>{{ t(`leftAtPush.commits`, { count: push.commits }, push.commits) }}</span>
                <span :title="formatTimestamp(push.at)">{{ timeAgo(push.at) }}</span>
                <span v-if="earlier > 0">{{ t(`leftAtPush.earlier`, { count: earlier }, earlier) }}</span>
            </span>
        </template>

        <template #control>
            <div class="ml-auto flex shrink-0 items-center gap-1">
                <!-- Who has them: the attempt's state, and the way to its conversation. -->
                <a
                    v-if="attempt !== undefined && look !== undefined && attemptLink !== undefined"
                    v-bind="attemptLink"
                    data-attempt
                    class="ui-chip shrink-0 rounded px-2 py-1 text-xs font-medium"
                    :class="[look.ink, look.chip]"
                    v-tooltip.top="attempt.stance.hint"
                    :aria-label="t(`leftAtPush.openAttempt`, { label: attempt.stance.label })"
                >
                    <Icon :name="look.icon" :spin="look.spin" class="text-2xs" />
                    {{ attempt.stance.label }}
                </a>
                <AgentRunButton
                    v-if="!inPlay"
                    :label="attempt === undefined ? t(`leftAtPush.handOver`) : t(`leftAtPush.continue`)"
                    :picker="fixModel"
                    severity="secondary"
                    text
                    :loading="handing"
                    :hint="attempt === undefined ? t(`leftAtPush.handHint`) : attempt.stance.hint"
                    @run="handOver"
                />
                <button
                    type="button"
                    :class="ui.iconButton(`hover:bg-content/10`)"
                    :disabled="rechecking"
                    v-tooltip.top="t(`leftAtPush.recheck`)"
                    :aria-label="t(`leftAtPush.recheck`)"
                    @click="recheck"
                >
                    <Icon name="refresh" :spin="rechecking" class="text-2xs" />
                </button>
            </div>
        </template>

        <!-- What it found, set in like a terminal's excerpt: the check that printed each, then its line. Two aligned
             columns where the row has the width; narrower, the check sits over its line and the line wraps, since a
             phone would otherwise show a dozen characters of it. -->
        <template #below>
            <div class="flex min-w-0 flex-col rounded-lg bg-content/5 px-1.5 py-1.5 text-2xs">
                <ul class="flex min-w-0 flex-col">
                    <li
                        v-for="finding in shown"
                        :key="finding.id"
                        data-finding
                        class="group/item flex min-h-7 min-w-0 items-start gap-2 rounded-md py-1 pl-1.5 hover:bg-overlay @lg:items-center @lg:py-0"
                    >
                        <div class="flex min-w-0 flex-1 flex-col gap-0.5 @lg:flex-row @lg:items-center @lg:gap-3">
                            <span class="truncate font-mono @lg:w-32 @lg:shrink-0" :class="sourceTone(finding)">{{ finding.source }}</span>
                            <span class="min-w-0 font-mono break-words text-muted @lg:flex-1 @lg:truncate" v-tooltip.bottom="findingHint(finding)">{{
                                findingGist(finding.text)
                            }}</span>
                        </div>
                        <button
                            type="button"
                            :class="
                                ui.iconButton(`h-6 w-6 hover:bg-content/10 md:opacity-0 md:group-hover/item:opacity-100 md:focus-visible:opacity-100`)
                            "
                            v-tooltip.top="t(`leftAtPush.dismissHint`)"
                            :aria-label="t(`leftAtPush.dismissOne`, { source: finding.source })"
                            @click="dismiss([finding.id])"
                        >
                            <Icon name="times" class="text-2xs" />
                        </button>
                    </li>
                </ul>
                <button
                    v-if="hidden > 0"
                    type="button"
                    :class="ui.textAction(`min-h-7 self-start pl-1.5 text-2xs text-subtle`)"
                    :aria-expanded="everything"
                    @click="everything = !everything"
                >
                    {{ everything ? t(`leftAtPush.fewer`) : t(`leftAtPush.more`, { count: hidden }, hidden) }}
                </button>
            </div>
            <div class="mt-2 flex items-center">
                <button type="button" :class="ui.textAction(`text-2xs`)" @click="dismiss(standing.map((finding) => finding.id))">
                    {{ t(`leftAtPush.dismissAll`) }}
                </button>
            </div>
        </template>
    </DisclosureRow>
</template>
