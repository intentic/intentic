<script setup lang="ts">
import { type MainlinePush, pushFindingsFixBase, type PushFinding } from "@intentic/sandbox-contract";
import { AgentRunButton, type AgentRunAttempt, fixStanceLook, ui, useAgentRunPick } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useNotifications } from "../../../shell/notifications/notifications";
import { shellModelPicking } from "../../chat/models/shellModelPicking";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import { findingGist, findingSource, type PushDebt, projectName, recheckable, shortSha, sinceWhen } from "./mainlineView";
import { openLandConversation } from "./openLanded";
import { dismissPushFindings, handPushFindings, recheckPushFindings, usePushFixAttempt } from "./useMainline";

// WHAT ONE PROJECT'S PUSHES LEFT BEHIND, as a column of the Main line panel. The hook never refused them, so none of
// this is a failure of anyone's: it waits, in amber, until a later measurement no longer prints it or the owner
// dismisses it, and the owner picks it up when they choose. Nothing here raises a card or calls for attention; the only
// words it puts up of its own are the receipts of the owner's own presses.

const t = useT();

const props = defineProps<{
    debt: PushDebt;
    // Every push the daemon lists, which the hand-over's id is derived from (contract, pushFindingsFixBase).
    pushes: readonly MainlinePush[];
    // The minute the panel reads, so every column dates itself on the same tick.
    minute: number;
}>();

// A conversation was opened from here, so a host that is a sheet can get out of the way.
const emit = defineEmits<{ opened: [conversationId: string] }>();

const { say, warn } = useNotifications();

// As many as a dock's short panel shows without scrolling past the actions; the rest open in place.
const SHOWN = 6;
const SEP = ` · `;

const project = computed(() => props.debt.project);
const name = computed(() => projectName(project.value));

// Rows a dismiss has taken but the refreshed status has not yet dropped, so the press is seen at once.
const leaving = ref<ReadonlySet<string>>(new Set());
const standing = computed(() => props.debt.open.filter((finding) => !leaving.value.has(finding.id)));
const expanded = ref(false);
const shown = computed(() => (expanded.value ? standing.value : standing.value.slice(0, SHOWN)));
const hidden = computed(() => standing.value.length - SHOWN);

// The push the findings came with, as git would name it, and when; its branch even when it is main, since a push to a
// feature branch leaving something is a different story from main leaving it.
const pushLine = computed(() => {
    const push = props.debt.newest;
    return [
        shortSha(push.head),
        sinceWhen(push.at, props.minute),
        ...(push.branch === undefined ? [] : [push.branch]),
        t(`agents.mainline.push.commits`, { count: push.commits }, push.commits),
    ].join(SEP);
});
const earlier = computed(() => props.debt.pushes.length - 1);

// The check's own tone, never red: a `code` gate fails the tree whoever caused it, so it wears the column's amber; a
// `tidy` line is only something the push added, and reads as the quietest thing here.
const sourceTone = (finding: PushFinding): string => (finding.gate === `code` ? `text-warning` : finding.gate === `tidy` ? `text-subtle` : `text-muted`);

// Everything the row cuts: the whole finding, the commit that brought it, how to see it again, and, for the three
// that no measurement can see gone, how it ends. The tooltip is one paragraph, so the parts are joined like the lines.
const findingHint = (finding: PushFinding): string =>
    [
        finding.text,
        ...(finding.commit === undefined ? [] : [t(`agents.mainline.push.from`, { sha: shortSha(finding.commit.sha), subject: finding.commit.subject })]),
        ...(finding.command === undefined ? [] : [finding.command]),
        ...(recheckable(finding) ? [] : [t(`agents.mainline.push.endsWhenDismissed`)]),
    ].join(SEP);

const openNamed = (conversationId: string): void => {
    openLandConversation(conversationId);
    emit(`opened`, conversationId);
};

// Measured again over the main tree: whatever it no longer prints resolves, and the column redraws from the status.
const rechecking = ref(false);
const recheck = async (): Promise<void> => {
    if (rechecking.value) {
        return;
    }
    rechecking.value = true;
    try {
        const result = await recheckPushFindings(project.value);
        if (result.measured) {
            say(t(`agents.mainline.push.rechecked`, { project: name.value, resolved: result.resolved, open: result.open }));
        } else {
            warn(t(`agents.mainline.push.unmeasured`, { project: name.value }));
        }
    } catch (error) {
        warn(errorMessage(error, t(`agents.mainline.push.unmeasured`, { project: name.value })));
    } finally {
        rechecking.value = false;
    }
};

// Named ids even for "all", so the receipt's Undo opens exactly what this press closed and nothing a push filed since.
const dismiss = async (ids: readonly string[]): Promise<void> => {
    leaving.value = new Set([...leaving.value, ...ids]);
    try {
        const changed = await dismissPushFindings(project.value, ids);
        if (changed > 0) {
            say(t(`agents.mainline.push.dismissed`, { count: changed }, changed), async () => {
                await dismissPushFindings(project.value, ids, true);
            });
        }
    } catch (error) {
        warn(errorMessage(error, t(`agents.mainline.push.dismissFailed`)));
    } finally {
        leaving.value = new Set([...leaving.value].filter((id) => !ids.includes(id)));
    }
};

// THE HAND-OVER, after the CI rows' (PipelineRunRow.vue): no attempt yet, an attempt still in play (its chip and the
// way to it, no second press), or one that ended (its chip, and the press continues it).
const base = computed(() => pushFindingsFixBase(props.pushes, project.value));
const attempt = usePushFixAttempt(() => base.value);
const look = computed(() => (attempt.value === undefined ? undefined : fixStanceLook(attempt.value.stance.kind)));
const inPlay = computed(() => attempt.value?.stance.ongoing === true);

// The attempt as the picker's bar names it, so the caret's panel ends in Continue / Start over over it.
const attemptOnOffer = computed<AgentRunAttempt | undefined>(() => {
    const held = attempt.value;
    if (held === undefined) {
        return undefined;
    }
    const summary = [t(`agents.mainline.push.attempt`, { count: held.attempt }), held.agent.model, held.stance.label.toLowerCase()]
        .filter((part) => part !== undefined)
        .join(SEP);
    return { summary, continuable: held.stance.retry };
});
const fixModel = useAgentRunPick(
    () => shellModelPicking(),
    `pre-push-fix`,
    () => attemptOnOffer.value,
);

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
        openNamed(await handPushFindings(project.value, pick, mode));
    } catch (error) {
        // An attempt already running on them: the daemon refuses a second, and the one it means is the one to watch.
        if (error instanceof SandboxHttpError && error.status === 409 && base.value !== undefined) {
            openNamed(attempt.value?.agent.id ?? base.value);
            return;
        }
        warn(errorMessage(error, t(`agents.mainline.push.handFailed`)));
    } finally {
        handing.value = false;
    }
};
</script>

<template>
    <!-- One project's block in the panel's band under the road (MainlinePanel), drawn the way a Result row is: the project,
         what it stands at, and its one action at the end of the line; then what it holds. -->
    <section :data-section="`push-${debt.project}`" class="flex min-w-0 flex-col text-2xs">
        <div class="flex h-6 min-w-0 items-center gap-2 text-xs">
            <Icon name="arrow-up-right" class="shrink-0 text-2xs text-warning" />
            <span class="min-w-0 truncate font-medium text-content" v-tooltip.top="t(`agents.mainline.push.explain`)">{{ name }}</span>
            <span class="shrink-0 text-warning">{{ t(`agents.mainline.push.left`, { count: standing.length }, standing.length) }}</span>
            <button
                type="button"
                :class="ui.iconButton(`ml-auto hover:bg-content/10`)"
                :disabled="rechecking"
                v-tooltip.top="t(`agents.mainline.push.recheck`)"
                :aria-label="t(`agents.mainline.push.recheck`)"
                @click="recheck"
            >
                <Icon name="refresh" :spin="rechecking" class="text-2xs" />
            </button>
        </div>
        <p class="truncate pl-4 text-subtle">
            <span class="font-mono">{{ pushLine }}</span>
            <template v-if="earlier > 0">{{ SEP }}{{ t(`agents.mainline.push.earlier`, { count: earlier }, earlier) }}</template>
        </p>
        <ul class="flex min-w-0 flex-col pt-1 pl-4">
            <li v-for="finding in shown" :key="finding.id" data-finding class="group -mr-1 flex min-w-0 items-center gap-2 rounded-md pr-1 hover:bg-overlay">
                <span class="max-w-[45%] shrink-0 truncate font-mono" :class="sourceTone(finding)">{{ findingSource(finding) }}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-muted" v-tooltip.bottom="findingHint(finding)">{{ findingGist(finding.text) }}</span>
                <button
                    type="button"
                    :class="ui.iconButton(`h-4 w-4 opacity-0 group-hover:opacity-100 hover:bg-content/10 focus-visible:opacity-100`)"
                    v-tooltip.top="t(`agents.mainline.push.dismissHint`)"
                    :aria-label="t(`agents.mainline.push.dismissOne`, { source: findingSource(finding) })"
                    @click="dismiss([finding.id])"
                >
                    <Icon name="times" class="text-2xs" />
                </button>
            </li>
        </ul>
        <button
            v-if="hidden > 0"
            type="button"
            :class="ui.textAction(`min-h-7 pl-4 text-2xs text-subtle`)"
            :aria-expanded="expanded"
            @click="expanded = !expanded"
        >
            {{ expanded ? t(`agents.mainline.push.fewer`) : t(`agents.mainline.push.more`, { count: hidden }, hidden) }}
        </button>
        <!-- Who has them, said the way a failing project's fixer is: the attempt's state, then its conversation by title. -->
        <div v-if="attempt !== undefined && look !== undefined" data-attempt class="flex min-w-0 items-center gap-1.5 pt-1 pl-4 text-xs">
            <Icon :name="look.icon" :spin="look.spin" class="shrink-0 text-2xs" :class="look.ink" />
            <span class="shrink-0 text-muted" v-tooltip.top="attempt.stance.hint">{{ attempt.stance.label }}</span>
            <button type="button" :class="ui.linkButton(`min-w-0 text-xs`)" @click="openNamed(attempt.agent.id)">
                <span class="truncate">{{ attempt.agent.title ?? attempt.agent.id }}</span>
            </button>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5 pl-4">
            <AgentRunButton
                v-if="!inPlay"
                :label="attempt === undefined ? t(`agents.mainline.push.handOver`) : t(`agents.mainline.push.continue`)"
                :picker="fixModel"
                severity="secondary"
                :loading="handing"
                :hint="attempt === undefined ? t(`agents.mainline.push.handHint`) : attempt.stance.hint"
                @run="handOver"
            />
            <button type="button" :class="ui.textAction(`text-2xs`)" @click="dismiss(standing.map((finding) => finding.id))">
                {{ t(`agents.mainline.push.dismissAll`) }}
            </button>
        </div>
    </section>
</template>
