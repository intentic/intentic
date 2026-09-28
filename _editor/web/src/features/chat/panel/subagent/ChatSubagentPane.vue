<script setup lang="ts">
import type { SubagentSession, TranscriptTool } from "@intentic/sandbox-contract";
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, onBeforeUnmount, provide, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { agentDisplayTitle } from "../../../agents/fleet/agentStatus";
import { subagentLive, useSubagentRoster } from "../../../agents/fleet/subagentRoster";
import { useAgents } from "../../../agents/fleet/useAgents";
import type { Conversation } from "../../session/conversation";
import { tabLabel } from "../../tabs/tabs";
import { CHAT_SURFACE } from "../../tools/chatToolSurface";
import { subagentTranscript } from "../../transcript/agentTranscript";
import ChatPaneTurns from "../pane/ChatPaneTurns.vue";
import { paneSurface } from "../pane/paneSurface";
import { usePaneScroll } from "../pane/paneScroll";
import ChatSubagentBar from "./ChatSubagentBar.vue";
import { showRecord, subagentRecord } from "./subagentRecord";
import { closeSubagent } from "./subagentView";
import { conversationView, PANE_VIEW } from "../useChat-view";

// A SUBAGENT ITS PARENT'S RUNTIME RAN IN-PROCESS, SHOWN IN THE PARENT'S COLUMN (subagentView.ts): its own transcript,
// read from the daemon and drawn by the chat's own turns, with the subagent bar where the composer stands. Nothing here
// sends: the subagent took its ask from the parent's turn and answers to it. Read again every few seconds while it
// works, and once more when it settles, since the daemon has no stream of its own for it.

const props = defineProps<{
    // The conversation whose turn ran it, and whose column this is.
    parent: Conversation;
    subagentId: string;
    focused: boolean;
    closable: boolean;
}>();
const emit = defineEmits<{ focus: []; close: [] }>();

const t = useT();

// Keyed by the subagent in the panel, so one record serves this pane for its whole life.
const record = subagentRecord(props.parent, props.subagentId);
const paneView = conversationView(computed(() => record));
provide(PANE_VIEW, paneView);
const { sessions } = useSubagentRoster();
// The parent's surface: the subagent worked in the parent's checkout, and its calls' own calls sit in the parent's record.
provide(
    CHAT_SURFACE,
    paneSurface(
        () => props.parent,
        useRouter(),
        () => sessions.value,
    ),
);

const { agentById } = useAgents();
const parentCard = computed(() => agentById(props.parent.conversationId));
const parentTitle = computed(() => (parentCard.value === undefined ? tabLabel(props.parent) : agentDisplayTitle(parentCard.value)));

// The delegation's card in the parent's transcript, for a subagent the roster has already let go of.
const recorded = computed<TranscriptTool | undefined>(() => {
    const within = (tools: readonly TranscriptTool[]): TranscriptTool | undefined => {
        for (const tool of tools) {
            const found = tool.id === props.subagentId ? tool : within(tool.children ?? []);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    };
    for (const message of props.parent.transcript.messages.value.toReversed()) {
        const found = within(message.tools ?? []);
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
});
// The roster's record, else what the card recorded of it: a row in the tray and this bar read the same one.
const session = computed<SubagentSession>(() => {
    const rostered = sessions.value.find((entry) => entry.id === props.subagentId);
    if (rostered !== undefined) {
        return rostered;
    }
    const card = recorded.value?.subagent;
    return {
        id: props.subagentId,
        kind: `subagent`,
        conversationId: props.parent.conversationId,
        status: card?.status ?? `completed`,
        startedAt: 0,
        activityAt: 0,
        ...(card?.agentType !== undefined ? { agentType: card.agentType } : {}),
        ...(card?.description !== undefined ? { description: card.description } : {}),
    };
});
const live = computed(() => subagentLive(session.value));

const scroller = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const { pin, realizing } = usePaneScroll({
    scroller,
    content,
    conversationId: () => record.conversationId,
    bare: () => false,
    messageCount: () => paneView.messages.value.length,
    streaming: live,
    grow: () => {},
});

// The first read failed, which is not the same as nothing recorded; a later failed poll keeps what is drawn.
const failed = ref(false);
const drawn: { last: string | undefined } = { last: undefined };
const POLL_MS = 3000;
let timer: ReturnType<typeof setTimeout> | undefined;
let mounted = true;
const read = async (): Promise<void> => {
    const first = drawn.last === undefined;
    try {
        const rows = await subagentTranscript(props.parent.conversationId, props.subagentId, props.parent.box.value);
        if (!mounted) {
            return;
        }
        showRecord(record, rows, drawn);
        failed.value = false;
        if (first) {
            await nextTick();
            pin();
        }
    } catch {
        failed.value = mounted && drawn.last === undefined;
    } finally {
        record.transcript.loading.value = false;
    }
};
const schedule = (): void => {
    clearTimeout(timer);
    if (mounted && live.value) {
        timer = setTimeout(() => void read().then(schedule), POLL_MS);
    }
};
record.transcript.loading.value = true;
void read().then(schedule);
// Starting to work again polls again; settling reads the last of it once.
watch(live, (now, before) => {
    if (before && !now) {
        void read();
    }
    schedule();
});
onBeforeUnmount(() => {
    mounted = false;
    clearTimeout(timer);
});

// Focusing a pane is the panel's (it focuses the parent's tab), asked for only when the pane is not already the focus.
const takeFocus = (): void => {
    if (!props.focused) {
        emit(`focus`);
    }
};
</script>

<template>
    <div
        class="chat-pane @container relative flex min-h-0 min-w-0 flex-1 flex-col"
        :class="{ 'chat-pane-on': focused }"
        @pointerdown="takeFocus"
        @focusin="takeFocus"
    >
        <!-- The same corner × a split's ChatPane wears. -->
        <button
            v-if="closable"
            type="button"
            class="absolute top-2 right-2 z-20 flex h-6 w-6 cursor-pointer items-center justify-center rounded-lg bg-card/70 text-subtle backdrop-blur-sm transition-colors hover:bg-overlay hover:text-content"
            :aria-label="t(`chat.chatPane.closePane`)"
            @pointerdown.stop
            @focusin.stop
            @click.stop="emit(`close`)"
        >
            <Icon name="times" class="text-2xs" />
        </button>
        <div ref="scroller" class="chat-scroller flex flex-1 flex-col overflow-x-hidden overflow-y-auto" :class="{ 'chat-realize': realizing }">
            <div ref="content" class="flex min-w-0 flex-1 flex-col">
                <ChatPaneTurns subagent>
                    <template #empty>
                        <p
                            class="m-auto max-w-sm px-4 text-center text-xs"
                            :class="failed ? 'text-danger' : 'text-subtle'"
                            :role="failed ? `alert` : undefined"
                        >
                            {{
                                failed
                                    ? t(`chat.chatSubagentPane.readFailed`)
                                    : live
                                      ? t(`chat.chatSubagentPane.nothingYet`)
                                      : t(`chat.chatSubagentPane.nothingRecorded`)
                            }}
                        </p>
                    </template>
                </ChatPaneTurns>
                <div class="chat-footer sticky bottom-0 z-10 mx-auto flex w-full max-w-[51rem] flex-col gap-2 px-2 py-3">
                    <ChatSubagentBar
                        :child="session"
                        :parent-title="parentTitle"
                        :provider="parentCard?.provider ?? parent.selection.provider.value"
                        @back="closeSubagent(parent.conversationId)"
                    />
                </div>
            </div>
        </div>
    </div>
</template>
