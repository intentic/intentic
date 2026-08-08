<script setup lang="ts">
import { ContextMenu, useDevice } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { invalidateWorkspace } from "../composables/workspace/useHistory";
import { openAgentConversation, useChat, usePaneView } from "../composables/chat/useChat";
import { useAgents } from "../composables/agents/useAgents";
import { useChatPopout } from "../composables/chat/useChatPopout";

/* THE CUT — one gesture for every way of going back to a point in a conversation.
 *
 * IT STANDS IN THE COLUMN'S MARGIN, level with the turn it cuts above, and it costs the transcript no height
 * whatsoever. It was a dashed rule drawn straight across the gap between every two turns with a "Fork here"
 * chip in the middle of it — and the last of those sat between the final answer and the composer, which is the
 * most valuable strip in the panel and the last place a control used once a day belongs. A mark in the margin
 * is beside the conversation instead of inside it: the reading column runs unbroken from the first turn to the
 * composer, and every turn still has its own point to cut at.
 *
 * The margin is REAL COLUMN, not negative space borrowed from the scroller (see --chat-gutter in chat.css), so
 * the mark cannot be clipped or push a horizontal scrollbar at any panel width — it simply gets narrower where
 * the pane is too tight to spare more.
 *
 * The cut is a boundary, not a bubble: a fork keeps everything above the line and nothing below it. That is
 * what lets one affordance serve both readings users arrive with — "redo this prompt differently" and "carry on
 * from that answer another way" are the same boundary named from either side, so they are the same click.
 *
 * Before this, the same question was answered by three unrelated controls that never used the same word: a
 * history icon that dropped messages in place, a pencil that copied the chat into a new tab and left the files
 * where they were, and a Restore button in the Checkpoints sidebar that moved the files and left the chat. The
 * user could not tell which of the two halves of their state — the conversation, and the files on disk — any of
 * them would move. So the rows below are exactly that choice, spelled out, in one menu:
 *
 *   Fork            new chat · history up to here · the files as they were here (in a checkout of its own)
 *   Fork chat only  new chat · history up to here · the files as they are now
 *   Rewind          THIS chat · everything after here dropped · the files as they were here
 *
 * Only the third destroys anything, so only the third arms before it fires. */

const props = defineProps<{
    /* The message index the mark sits BESIDE — the count of bubbles a fork here inherits. Zero means the mark
       is on the very first turn, where a fork would inherit nothing: there is no cut to offer there, only the
       whole conversation below. */
    cut: number;
    /* On the last turn, and therefore carrying the one offer that has no boundary of its own — the whole
       conversation, carried on somewhere else. It used to be a cut line of its own past the final message,
       which is exactly the row that was sitting on top of the composer. */
    last?: boolean;
}>();

const { conversation, messages, forkAt, streaming: conversationStreaming } = usePaneView();
const { overlayTarget } = useChatPopout();
const { mobile } = useDevice();
const queryClient = useQueryClient();
const { fleet, agentById } = useAgents();
const { conversations, setActive } = useChat();

/* WHAT WAS ALREADY TAKEN FROM THIS POINT — the other end of the fork's own "Forked from …" line.
 *
 * A cut that has been forked before stops being an empty margin and becomes a junction, so its mark stands lit
 * and permanent rather than waiting for a pointer: the whole value of forking is comparing the paths, and a
 * path you cannot find from where it left is a path you will not compare. The branches themselves are named in
 * the menu — out here they were a row of chips wide enough to need the gap this control just gave back. Read
 * off the fleet, so it counts forks whether or not their tabs are open in this window, including a colleague's. */
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

// The message below the line, which is what every row here acts against.
const below = computed(() => messages.value[props.cut]);

/* WHETHER THE FILES CAN COME BACK TO THIS POINT AT ALL. The daemon stamps an anchor on the messages it still
 * holds a state for; no anchor means there is nothing to put the files back to, and the rows that promise old
 * files have to say so rather than quietly starting from today's. */
const anchored = computed(() => below.value?.rewindIndex !== undefined);

/* WHETHER "THE FILES AS THEY WERE" IS EVEN A CHOICE HERE, which is a question about the chat rather than about
 * the cut. A chat working in a copy of its own can hand those files to a fork, so the fork and the chat-only
 * fork are two different things and both are offered. A chat working in the shared workspace cannot: the files
 * are everyone else's too, and there is exactly one fork to offer — the menu then says so in one row instead
 * of two, rather than showing a second that could never be pressed. Going BACK is still available either way;
 * that one moves the chat's own files, which is what rewinding has always meant. */
const ownFiles = computed(() => conversation.value.isolated.value);

/* WHAT A RUNNING TURN ACTUALLY BLOCKS, which is not everything — and used to be.
 *
 * Copying the turns above the line into a new chat takes nothing away from the run still writing below it, and
 * a turn that has been going twenty minutes is precisely when a second line of attack is worth opening. So
 * forking the CHAT is available mid-run. Moving FILES is not: putting a checkpoint back underneath an agent
 * that is writing to those same files is a different act, and both rows that promise old files wait for the
 * turn to end. A rewind of our own in flight is rewriting the transcript itself, so that one holds everything. */
const filesBusy = computed(() => conversationStreaming.value || rewinding.value);
const chatBusy = computed(() => rewinding.value);

const disarm = (): void => {
    clearTimeout(armedTimer);
    armed.value = false;
};

/* Go back in place. The two-step confirm and its wording are the rewind's own, kept exactly as they were: the
 * press is reversible (the daemon checkpoints before it restores) so a modal would cost more than it guards,
 * but the count of what is about to disappear has to be on screen before the second press. Arming decays, so a
 * menu left open across a coffee break cannot fire on a stray click. */
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

/* Every row states what becomes of the FILES, because that is the half of this decision that used to be
 * silent — and the half that made the old pair of controls impossible to tell apart. A row refused because a
 * turn is in flight says THAT instead, so a disabled row is never a dead end without a reason. */
const forkRows = computed<MenuItem[]>(() =>
    ownFiles.value
        ? [
              {
                  label: `Fork`,
                  icon: `fork`,
                  // Named as the outcome, not the mechanism: what is being chosen is which files the new chat
                  // opens on, and "its own copy" is the honest description of where those files have to live.
                  hint: !anchored.value
                      ? `No saved state for this point`
                      : filesBusy.value
                        ? `Old files have to wait for the turn to finish`
                        : `New chat, files as they were here, in its own copy`,
                  disabled: !anchored.value || filesBusy.value,
                  command: () => forkAt(props.cut, `then`),
              },
              {
                  label: `Fork chat only`,
                  icon: `comment`,
                  hint: `New chat, files as they are now`,
                  disabled: chatBusy.value,
                  command: () => forkAt(props.cut, `now`),
              },
          ]
        : [
              // The shared workspace has one fork to give, so it wears the plain name — and still says which
              // files it lands on, so the sentence a user reads is the same sentence either way.
              {
                  label: `Fork`,
                  icon: `fork`,
                  hint: `New chat, files as they are now`,
                  disabled: chatBusy.value,
                  command: () => forkAt(props.cut, `now`),
              },
          ],
);

const rewindRow = computed<MenuItem[]>(() => [
    {
        label: armed.value ? `Click again — drops ${dropped.value} message${dropped.value === 1 ? `` : `s`}` : `Rewind this chat`,
        icon: `history`,
        hint: armed.value ? undefined : filesBusy.value ? `Wait for the turn to finish` : `Go back here and drop what follows`,
        disabled: !anchored.value || filesBusy.value,
        danger: armed.value,
        // Kept open on the arming press so the second click has something to land on.
        command: () => void rewind(),
    },
]);

/* THE WHOLE CONVERSATION, on the last turn's mark. There is no turn below this cut and so no saved state filed
 * under it either, which leaves exactly one honest offer — the one that promises nothing about old files. */
const wholeRow = computed<MenuItem[]>(() => [
    {
        label: `Fork the whole conversation`,
        icon: `fork`,
        hint: `New chat, everything so far, files as they are now`,
        disabled: chatBusy.value,
        command: () => forkAt(messages.value.length, `now`),
    },
]);

// The branches already taken from this point, each by name. A count alone would say a fork exists and leave
// finding it as an exercise, which is the state this whole affordance is trying to end.
const openRows = computed<MenuItem[]>(() =>
    forks.value.map((fork) => ({
        label: fork.title ?? `Untitled fork`,
        icon: `arrow-up-right`,
        hint: `Open this fork`,
        command: () => openFork(fork.id),
    })),
);

// Four groups, each of which can be absent, with a rule between whichever ones are present — so no menu ever
// opens on a separator or wears two in a row.
const items = computed<MenuItem[]>(() => {
    const groups = [
        ...(props.cut > 0 ? [forkRows.value, rewindRow.value] : []),
        ...(props.last === true ? [wholeRow.value] : []),
        openRows.value,
    ].filter((group) => group.length > 0);
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
        : `${forks.value.length} fork${forks.value.length === 1 ? `` : `s`} from here — click to open`,
);

const open = (event: Event): void => {
    disarm();
    menu.value?.show(event);
};
</script>

<template>
    <!-- A full-height strip of the column's own margin, so the mark is reachable wherever the eye happens to be
         in a long turn: the button STICKS to the top of whatever part of the turn is on screen instead of
         scrolling away with its first line. Zero height in the transcript by construction — the strip is
         absolute, and the width it occupies is padding the column was already carrying.
         Revealed by hovering the TURN, not the strip, so there is nothing to hunt for with the pointer. On
         touch there is no hover to reveal anything, so it stands at low opacity the way the message actions
         already do there. A cut that HAS been forked shows permanently and in the link colour — it is no longer
         an empty margin but a junction, and the branches taken from it are the thing worth seeing without
         hunting. Notably it does NOT light up for a running turn: the old chip did exactly that, appearing only
         while it was refusing to be pressed. -->
    <!-- The armed rewind is NOT disarmed by the pointer leaving this strip, which is a rule the old full-width
         row could afford and a mark two characters wide cannot: the menu opens beside it, so the very first
         move toward the row you just armed would leave the strip and cancel it. What guards the second press
         is the four-second decay and the disarm on every reopen, both of which are about time rather than
         about where the pointer happens to be. -->
    <div class="absolute inset-y-0 left-[calc(-1*var(--chat-gutter))] z-[6] w-[var(--chat-gutter)]">
        <button
            type="button"
            class="sticky top-2 flex h-7 w-full cursor-pointer items-center justify-center rounded-md transition-opacity hover:bg-overlay hover:text-content"
            :class="[
                forks.length > 0 ? `text-link opacity-100` : `text-subtle`,
                forks.length > 0 ? `` : mobile ? `opacity-40` : `opacity-0 focus-visible:opacity-100 group-hover/turn:opacity-100`,
            ]"
            v-tooltip.right="tip"
            :aria-label="tip"
            @click.stop="open"
        >
            <Icon :name="rewinding ? `spinner` : `fork`" :spin="rewinding" class="text-2xs" />
        </button>
        <ContextMenu ref="menu" :model="items" :append-to="overlayTarget" :min-width="17" />
    </div>
</template>
