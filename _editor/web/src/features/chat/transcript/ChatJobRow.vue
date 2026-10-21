<script setup lang="ts">
import type { IconName, TooltipValue } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatClock } from "@intentic/ui/format";
import type { TranscriptBackgroundJob } from "@intentic/sandbox-contract/events/transcript";
import { computed, inject, ref, useTemplateRef } from "vue";
import { useAgents } from "../../../models/fleet/useAgents";
import { usePaneView } from "../../../models/conversations/panel/useChat-view";
import { useChatSurface } from "../../../models/conversations/tools/chatToolSurface";
import { jobPhase, type JobStopper, portsLine } from "./jobPhase";
import { useT } from "@intentic/ui/i18n";
import { formatElapsed } from "@intentic/ui";
import { useAudience } from "../../../app/useAudience";
import { plainToolWords } from "../../../lib/toolWords/toolWords";
import { useToolCalls } from "../../../models/conversations/tools/useToolCalls";
import ChatSpineNode from "./asides/ChatSpineNode.vue";
import { TRANSCRIPT_HOLD } from "./useStickToBottom";

// The row a background job's start left, drawn with the job's live state off the conversation's card (AgentSummary.jobs).
// While it runs it is a row, since what it is doing is still news. Once it is over it is a step the agent took, like the
// call that started it, and with tool calls hidden it folds onto the spine as that call did (ChatTurnAsides): a dotted
// band, pressed open into this same row. Only the drawing folds; the transcript row and its job are left as they are.

const t = useT();

const props = defineProps<{
    job: TranscriptBackgroundJob;
}>();

const { conversation } = usePaneView();
const { agentById } = useAgents();
const surface = useChatSurface();

const live = computed(() => agentById(conversation.value.conversationId)?.jobs?.find((entry) => entry.id === props.job.id));
const phase = computed(() => jobPhase(live.value));

const now = useNow(() => phase.value.kind === `running`);

const { maker } = useAudience();
const { showToolCalls } = useToolCalls();

// What the job is called. The agent's own description stands for itself; with none, the label IS the command line, which a
// maker is told as the act it is ("Running checks"), the same words its call's card uses. The command stays in the fold.
const shownLabel = computed(() =>
    maker.value && props.job.label === props.job.command ? plainToolWords({ name: `Bash`, target: props.job.command }) : props.job.label,
);

const glyph = computed<{ readonly name: IconName; readonly spin: boolean; readonly tone: string }>(() => {
    switch (phase.value.kind) {
        case `running`:
            return { name: `spinner`, spin: true, tone: `text-link` };
        case `finished`:
            return { name: `check`, spin: false, tone: `text-success` };
        case `failed`:
            return { name: `times`, spin: false, tone: `text-danger` };
        case `stopped`:
            return { name: `stop`, spin: false, tone: `text-subtle` };
        default:
            return { name: `terminal`, spin: false, tone: `text-subtle` };
    }
});

// Who ended it, said as the reader would: the turn's own ending is the sandbox's doing, not a failure.
const stoppedLine = (by: JobStopper, elapsed: string): string => {
    switch (by) {
        case `turn`:
            return t(`chat.chatJobRow.stoppedByTurn`, { elapsed });
        case `person`:
            return t(`chat.chatJobRow.stoppedByYou`, { elapsed });
        default:
            return t(`chat.chatJobRow.stoppedByAgent`, { elapsed });
    }
};

const status = computed(() => {
    const current = phase.value;
    switch (current.kind) {
        case `running`:
            if (current.stopping !== undefined) {
                return t(`chat.chatJobRow.stopping`);
            }
            return current.handed === true
                ? t(`chat.chatJobRow.leftForYou`, {
                      ports: portsLine(current.ports ?? []),
                      elapsed: formatElapsed((now.value - current.startedAt) / 1000),
                  })
                : t(`chat.chatJobRow.running`, { elapsed: formatElapsed((now.value - current.startedAt) / 1000) });
        case `stopped`:
            return stoppedLine(current.by, formatElapsed((current.took[1] - current.took[0]) / 1000));
        case `finished`:
            return t(`chat.chatJobRow.finished`, { elapsed: formatElapsed((current.took[1] - current.took[0]) / 1000) });
        case `failed`:
            // An exit code is a developer's reading; a maker is told that it went wrong, and when.
            return maker.value
                ? t(`chat.chatJobRow.failedPlain`, { elapsed: formatElapsed((current.took[1] - current.took[0]) / 1000) })
                : t(`chat.chatJobRow.failed`, { code: current.exitCode, elapsed: formatElapsed((current.took[1] - current.took[0]) / 1000) });
        case `ended`:
            return t(`chat.chatJobRow.ended`, { elapsed: formatElapsed((current.took[1] - current.took[0]) / 1000) });
        default:
            return t(`chat.chatJobRow.untracked`, { clock: formatClock(props.job.startedAt) });
    }
});

// The pane the command runs in, while there is one to watch; a published page has no door to it.
const terminal = computed(() => (phase.value.kind === `running` && surface.watchTerminal !== undefined ? phase.value.session : undefined));

const commandOpen = ref(false);

// Folded once it is over and the reader keeps tool calls hidden. A job the card no longer tracks is over too: it ran in a
// turn that is gone, and is most of what an old transcript holds.
const folds = computed(() => !showToolCalls.value && phase.value.kind !== `running`);
const failed = computed(() => phase.value.kind === `failed`);
const open = ref(false);
// Opening and shutting holds the band's place on screen, as a run's figure does (useStickToBottom's hold).
const spine = useTemplateRef<HTMLElement>(`spine`);
const hold = inject(TRANSCRIPT_HOLD, (_element, change) => change());
const toggle = (): void => hold(spine.value, () => (open.value = !open.value));
const tip = computed((): TooltipValue => ({ title: shownLabel.value, note: status.value }));
</script>

<template>
    <!-- Over, and folded: the band in the seam (`.chat-spine-wash` in chat.css), one step tall, the row's whole height. Open,
         the row under one mark in the gutter that folds it again. While it runs, or with tool calls shown, just the row. -->
    <div
        ref="spine"
        class="flex w-full min-w-0 flex-col gap-1"
        :class="folds ? [`chat-spine`, open ? `chat-spine-open` : `chat-spine-shut`] : undefined"
        :style="folds ? { '--wash-calls': 1 } : undefined"
    >
        <div v-if="folds" class="chat-spine-bar">
            <ChatSpineNode v-if="open" icon="chevron-up" :open="true" :label="t(`chat.chatJobRow.hideJob`)" :tip="tip" :failed="failed" @toggle="toggle" />
        </div>
        <button
            v-if="folds && !open"
            type="button"
            class="chat-spine-wash"
            :class="{ 'chat-spine-wash-failed': failed }"
            :aria-expanded="false"
            :aria-label="t(`chat.chatJobRow.showJob`)"
            v-tooltip.top="tip"
            @click="toggle"
        />
        <template v-else>
            <!-- A META ROW (chat.css `.chat-meta`), the same as a notice: the state's glyph in the mark box on the column's edge, the
                 label on the hang. What sets it apart is the glyph still moving, not a box drawn round it. -->
            <div class="chat-meta flex max-w-full min-w-0 items-center gap-2 self-start py-0.5 text-2xs text-muted max-md:min-h-9 max-md:py-0">
                <!-- The label doubles as the command's fold, as a tool card's name does. -->
                <button
                    type="button"
                    class="flex min-w-0 items-center gap-2 self-stretch transition-colors hover:text-content"
                    :aria-expanded="commandOpen"
                    v-tooltip.top="commandOpen ? t(`chat.chatJobRow.hideCommand`) : t(`chat.chatJobRow.showCommand`)"
                    @click="commandOpen = !commandOpen"
                >
                    <span class="chat-mark"><Icon :name="glyph.name" :spin="glyph.spin" class="text-xs" :class="glyph.tone" /></span>
                    <span class="truncate">{{ shownLabel }}</span>
                </button>
                <span class="shrink-0 tabular-nums" :class="phase.kind === `failed` ? `text-danger` : `text-subtle`">{{ status }}</span>
                <button
                    v-if="terminal !== undefined"
                    type="button"
                    class="-mr-1 flex shrink-0 items-center rounded p-0.5 transition-colors hover:bg-overlay hover:text-content max-md:-mr-2.5 max-md:min-w-9 max-md:justify-center max-md:self-stretch"
                    v-tooltip.top="t(`chat.words.watchTerminal`)"
                    :aria-label="t(`chat.words.watchTerminal`)"
                    @click="surface.watchTerminal?.(terminal)"
                >
                    <Icon name="desktop" class="text-2xs" />
                </button>
            </div>
            <div v-if="commandOpen" class="chat-inset ml-[calc(var(--chat-edge)+var(--chat-hang))] flex gap-1.5 px-2.5 py-1.5 font-mono text-2xs text-muted">
                <span class="shrink-0 select-none text-subtle">$</span>
                <span class="min-w-0 whitespace-pre-wrap">{{ job.command }}</span>
            </div>
        </template>
    </div>
</template>
