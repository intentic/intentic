<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatClock } from "@intentic/ui/format";
import type { TranscriptBackgroundJob } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { formatElapsed } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { usePaneView } from "../panel/useChat-view";
import { useChatSurface } from "../tools/chatToolSurface";
import { jobPhase } from "./jobPhase";
import { useT } from "@intentic/ui/i18n";

// The row a background job's start left, drawn with the job's live state off the conversation's card (AgentSummary.jobs).

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

const glyph = computed<{ readonly name: IconName; readonly spin: boolean; readonly tone: string }>(() => {
    switch (phase.value.kind) {
        case `running`:
            return { name: `spinner`, spin: true, tone: `text-link` };
        case `finished`:
            return { name: `check`, spin: false, tone: `text-success` };
        case `failed`:
            return { name: `times`, spin: false, tone: `text-danger` };
        default:
            return { name: `terminal`, spin: false, tone: `text-subtle` };
    }
});

const status = computed(() => {
    const current = phase.value;
    switch (current.kind) {
        case `running`:
            return t(`chat.chatJobRow.running`, { elapsed: formatElapsed(current.startedAt, now.value) });
        case `finished`:
            return t(`chat.chatJobRow.finished`, { elapsed: formatElapsed(...current.took) });
        case `failed`:
            return t(`chat.chatJobRow.failed`, { code: current.exitCode, elapsed: formatElapsed(...current.took) });
        case `ended`:
            return t(`chat.chatJobRow.ended`, { elapsed: formatElapsed(...current.took) });
        default:
            return t(`chat.chatJobRow.untracked`, { clock: formatClock(props.job.startedAt) });
    }
});

// The pane the command runs in, while there is one to watch; a published page has no door to it.
const terminal = computed(() => (phase.value.kind === `running` && surface.watchTerminal !== undefined ? phase.value.session : undefined));

const commandOpen = ref(false);
</script>

<template>
    <div class="flex w-full min-w-0 flex-col gap-1">
        <div class="flex max-w-full min-w-0 items-center gap-2 self-start rounded-lg border border-line px-2.5 py-1 text-2xs text-muted">
            <!-- The label doubles as the command's fold, as a tool card's name does. -->
            <button
                type="button"
                class="flex min-w-0 items-center gap-1.5 transition-colors hover:text-content"
                :aria-expanded="commandOpen"
                v-tooltip.top="commandOpen ? t(`chat.chatJobRow.hideCommand`) : t(`chat.chatJobRow.showCommand`)"
                @click="commandOpen = !commandOpen"
            >
                <Icon :name="glyph.name" :spin="glyph.spin" class="shrink-0 text-2xs" :class="glyph.tone" />
                <span class="truncate font-medium">{{ job.label }}</span>
            </button>
            <span class="shrink-0 tabular-nums" :class="phase.kind === `failed` ? `text-danger` : `text-subtle`">{{ status }}</span>
            <button
                v-if="terminal !== undefined"
                type="button"
                class="-mr-1 flex shrink-0 items-center rounded p-0.5 transition-colors hover:bg-overlay hover:text-content"
                v-tooltip.top="t(`chat.chatJobRow.watchInTerminal`)"
                :aria-label="t(`chat.chatJobRow.watchInTerminal`)"
                @click="surface.watchTerminal?.(terminal)"
            >
                <Icon name="desktop" class="text-2xs" />
            </button>
        </div>
        <div v-if="commandOpen" class="chat-inset flex gap-1.5 px-2.5 py-1.5 font-mono text-2xs text-muted">
            <span class="shrink-0 select-none text-subtle">$</span>
            <span class="min-w-0 whitespace-pre-wrap">{{ job.command }}</span>
        </div>
    </div>
</template>
