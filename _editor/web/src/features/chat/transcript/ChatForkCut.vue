<script setup lang="ts">
import { ContextMenu, useDevice } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { invalidateWorkspace } from "../../workspace/changes/useHistory";
import { useChat } from "../run/useChat";
import { usePaneView } from "../panel/useChat-view";
import { openAgentConversation } from "../panel/useChat-reveal";
import { useAgents } from "../../agents/fleet/useAgents";
import { errandOf } from "../run/errands";

// A mark in the column's margin, costing no transcript height, hanging off the answer above it rather than the prompt
// below. Its width matches the turn's control lane exactly, clear of the run-mark past it (`.chat-run-mark` in
// chat.css), so the two never overlap. The menu's four rows are two independent choices, which chat and which files.

const props = defineProps<{
    // Count of bubbles above the line and the index of the first bubble below it; the first message has none.
    cut: number;
}>();

const { conversation, messages, forkAt, beginEdit, editing, streaming: conversationStreaming } = usePaneView();
const { mobile } = useDevice();
const queryClient = useQueryClient();
const { fleet, agentById } = useAgents();
const { conversations, setActive } = useChat();

// Forks already taken from this point, read off the fleet so closed or another window's tabs still count.
const forks = computed(() =>
    fleet.value.filter((agent) => agent.forkedFrom?.conversationId === conversation.value.conversationId && agent.forkedFrom.index === props.cut),
);

const openFork = (id: string): void => {
    if (conversations.value.some((open) => open.conversationId === id)) {
        setActive(id);
        return;
    }
    const agent = agentById(id);
    if (agent !== undefined) {
        openAgentConversation(agent);
    }
};

const menu = ref<{ show: (event: Event) => void; hide: () => void } | undefined>();
const rewinding = ref(false);
const armed = ref(false);
let armedTimer: ReturnType<typeof setTimeout> | undefined;

// The message below the line; every row here acts against it.
const below = computed(() => messages.value[props.cut]);

// No turn exists past the end, so the only honest offer is carrying on the whole conversation elsewhere.
const whole = computed(() => props.cut >= messages.value.length);

// Whether the daemon still holds a state for this message; no anchor means no old files to restore.
const anchored = computed(() => below.value?.rewindIndex !== undefined);

// Whether the chat works in its own file copy; only then can a fork carry old files separately from the chat.
const ownFiles = computed(() => conversation.value.isolated.value);

// Forking the chat is allowed mid-run; moving files is not, and an in-flight rewind blocks everything.
const filesBusy = computed(() => conversationStreaming.value || rewinding.value);
const chatBusy = computed(() => rewinding.value);

const disarm = (): void => {
    clearTimeout(armedTimer);
    armed.value = false;
};

// Two-step confirm; the first press only arms it, decaying after a timeout so a stray later click can't fire it.
const rewind = async (): Promise<void> => {
    const target = below.value;
    if (target === undefined || filesBusy.value) {
        return;
    }
    if (!armed.value) {
        armed.value = true;
        armedTimer = setTimeout(disarm, 4000);
        return;
    }
    disarm();
    rewinding.value = true;
    try {
        // The workspace views are reading the tree this just rewrote.
        if (await conversation.value.rewindTo(target)) {
            await invalidateWorkspace(queryClient);
        }
    } finally {
        rewinding.value = false;
    }
};

const dropped = computed(() => Math.max(0, messages.value.length - props.cut));

// A fork keeping no turns and no old files is just New Chat, so this row stands down at the first message.
const head = computed(() => props.cut === 0);

// Every row states what happens to the files; a row disabled by a running turn says why.
const forkRows = computed<MenuItem[]>(() =>
    ownFiles.value
        ? [
              {
                  label: `Fork`,
                  icon: `fork`,
                  // Named by outcome: which files the new chat opens on, since they have to live in a copy of their
                  // own.
                  hint: !anchored.value
                      ? `No saved state for this point`
                      : filesBusy.value
                        ? `Old files have to wait for the turn to finish`
                        : `New chat, files as they were here, in its own copy`,
                  disabled: !anchored.value || filesBusy.value,
                  command: () => forkAt(props.cut, `then`),
              },
              // At the head this option keeps no turns and no old files either, which is just New Chat, so it's
              // omitted.
              ...(head.value
                  ? []
                  : [
                        {
                            label: `Fork chat only`,
                            icon: `comment`,
                            hint: `New chat, files as they are now`,
                            disabled: chatBusy.value,
                            command: () => forkAt(props.cut, `now`),
                        },
                    ]),
          ]
        : // Shared workspace has just one fork to give, so it uses the plain name.
          // Still names which files it opens on, and stays empty at the head where there's nothing to offer.
          head.value
          ? []
          : [
                {
                    label: `Fork`,
                    icon: `fork`,
                    hint: `New chat, files as they are now`,
                    disabled: chatBusy.value,
                    command: () => forkAt(props.cut, `now`),
                },
            ],
);

// Offered only above a user message, not an assistant turn or an errand; same refusals as the file rows.
const editRow = computed<MenuItem[]>(() => {
    const target = below.value;
    if (target?.role !== `user` || editing.value?.id === target.id || errandOf(target) !== undefined) {
        return [];
    }
    return [
        {
            label: `Edit this message`,
            icon: `pencil`,
            hint: !anchored.value
                ? `No saved state for this point`
                : filesBusy.value
                  ? `Old files have to wait for the turn to finish`
                  : `Ask it differently, replaces this and everything below`,
            disabled: !anchored.value || filesBusy.value,
            command: () => {
                beginEdit(target);
            },
        },
    ];
});

const rewindRow = computed<MenuItem[]>(() => [
    {
        label: armed.value ? `Click again, drops ${dropped.value} message${dropped.value === 1 ? `` : `s`}` : `Rewind this chat`,
        icon: `history`,
        hint: armed.value ? undefined : filesBusy.value ? `Wait for the turn to finish` : `Go back here and drop what follows`,
        disabled: !anchored.value || filesBusy.value,
        danger: armed.value,
        // Kept open on the arming press so the second click has something to land on.
        command: () => void rewind(),
    },
]);

// The only row offered on the last answer's mark; see `whole`.
const wholeRow = computed<MenuItem[]>(() => [
    {
        label: `Fork the whole conversation`,
        icon: `fork`,
        hint: `New chat, everything so far, files as they are now`,
        disabled: chatBusy.value,
        command: () => forkAt(messages.value.length, `now`),
    },
]);

// Branches already taken from this point, named individually rather than left as a count to go find.
const openRows = computed<MenuItem[]>(() =>
    forks.value.map((fork) => ({
        label: fork.title ?? `Untitled fork`,
        icon: `arrow-up-right`,
        hint: `Open this fork`,
        command: () => openFork(fork.id),
    })),
);

// This cut's own rows, or the last mark's one, followed by taken branches, separated by a rule between groups.
const items = computed<MenuItem[]>(() => {
    const groups = [...(whole.value ? [wholeRow.value] : [editRow.value, forkRows.value, rewindRow.value]), openRows.value].filter(
        (group) => group.length > 0,
    );
    const rows: MenuItem[] = [];
    for (const group of groups) {
        if (rows.length > 0) {
            rows.push({ separator: true });
        }
        rows.push(...group);
    }
    return rows;
});

const tip = computed(() =>
    forks.value.length === 0
        ? `Fork the conversation here`
        : `${forks.value.length} fork${forks.value.length === 1 ? `` : `s`} from here, click to open`,
);

const open = (event: Event): void => {
    disarm();
    menu.value?.show(event);
};
</script>

<template>
    <!-- Negative top margin cancels the flex gap so this zero-height strip doesn't change the transcript's height. -->
    <!-- Arming survives the pointer leaving this strip, since the menu opens beside it; only the timeout disarms it. -->
    <div class="relative z-[6] -mt-1 h-0">
        <button
            type="button"
            class="touch-target absolute right-[calc(-1*var(--chat-gutter))] bottom-0 flex h-7 w-[var(--chat-gutter)] cursor-pointer items-center justify-center rounded-md transition-opacity hover:bg-overlay hover:text-content"
            :class="[
                forks.length > 0 ? `text-link opacity-100` : `text-subtle`,
                forks.length > 0 ? `` : mobile ? `opacity-40` : `opacity-0 focus-visible:opacity-100 group-hover/turn:opacity-100`,
            ]"
            v-tooltip.left="tip"
            :aria-label="tip"
            @click.stop="open"
        >
            <Icon :name="rewinding ? `spinner` : `fork`" :spin="rewinding" class="text-2xs" />
        </button>
        <ContextMenu ref="menu" :model="items" :min-width="17" />
    </div>
</template>
