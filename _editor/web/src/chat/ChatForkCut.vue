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
 * It sits in the GAP between two turns rather than on a message, because the gap is the thing being chosen: a
 * fork keeps everything above the line and nothing below it, which is a statement about a boundary, not about a
 * bubble. That is also what lets one affordance serve both readings users arrive with — "redo this prompt
 * differently" is the gap above their message, "carry on from that answer another way" is the gap below the
 * agent's, and between a turn and the next there is exactly ONE gap, so the two are the same click.
 *
 * Before this, the same question was answered by three unrelated controls that never used the same word: a
 * history icon that dropped messages in place, a pencil that copied the chat into a new tab and left the files
 * where they were, and a Restore button in the Checkpoints sidebar that moved the files and left the chat. The
 * user could not tell which of the two halves of their state — the conversation, and the files on disk — any of
 * them would move. So the three rows below are exactly that choice, spelled out, in one menu:
 *
 *   Fork            new chat · history up to here · the files as they were here (in a checkout of its own)
 *   Fork chat only  new chat · history up to here · the files as they are now
 *   Rewind          THIS chat · everything after here dropped · the files as they were here
 *
 * Only the third destroys anything, so only the third arms before it fires. */

const props = defineProps<{
    /* The message index the line sits ABOVE — the count of bubbles a fork here inherits. `messages.length` is
       the legitimate maximum: the cut past the last message forks the whole conversation. */
    cut: number;
}>();

const { conversation, messages, forkAt, streaming: conversationStreaming } = usePaneView();
const { overlayTarget } = useChatPopout();
const { mobile } = useDevice();
const queryClient = useQueryClient();
const { fleet, agentById } = useAgents();
const { conversations, setActive } = useChat();

/* WHAT WAS ALREADY TAKEN FROM THIS POINT — the other end of the fork's own "Forked from …" line.
 *
 * A cut that has been forked before stops being an empty gap and becomes a junction, and it says so
 * permanently rather than on hover: the whole value of forking is comparing the paths, and a path you cannot
 * find from where it left is a path you will not compare. Read off the fleet, so it counts forks whether or not
 * their tabs are open in this window — including ones a colleague took. */
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
 * files have to say so rather than quietly starting from today's. A cut past the last message never has one —
 * there is no turn below it to have been recorded. */
const anchored = computed(() => below.value?.rewindIndex !== undefined);

/* WHETHER "THE FILES AS THEY WERE" IS EVEN A CHOICE HERE, which is a question about the chat rather than about
 * the cut. A chat working in a copy of its own can hand those files to a fork, so the fork and the chat-only
 * fork are two different things and both are offered. A chat working in the shared workspace cannot: the files
 * are everyone else's too, and there is exactly one fork to offer — the menu then says so in two rows instead
 * of three, rather than showing a third that could never be pressed. Going BACK is still available either way;
 * that one moves the chat's own files, which is what rewinding has always meant. */
const ownFiles = computed(() => conversation.value.isolated.value);
// A turn in flight owns the transcript and the workspace both; nothing here may cut across it.
const busy = computed(() => conversationStreaming.value || rewinding.value);

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
    if (target === undefined || busy.value) {
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
 * silent — and the half that made the old pair of controls impossible to tell apart. */
const items = computed<MenuItem[]>(() => [
    ...(ownFiles.value
        ? [
              {
                  label: `Fork`,
                  icon: `fork`,
                  // Named as the outcome, not the mechanism: what is being chosen is which files the new chat
                  // opens on, and "its own copy" is the honest description of where those files have to live.
                  hint: anchored.value ? `New chat, files as they were here, in its own copy` : `No saved state for this point`,
                  disabled: !anchored.value || busy.value,
                  command: () => forkAt(props.cut, `then`),
              },
              {
                  label: `Fork chat only`,
                  icon: `comment`,
                  hint: `New chat, files as they are now`,
                  disabled: busy.value,
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
                  disabled: busy.value,
                  command: () => forkAt(props.cut, `now`),
              },
          ]),
    { separator: true },
    {
        label: armed.value ? `Click again — drops ${dropped.value} message${dropped.value === 1 ? `` : `s`}` : `Rewind this chat`,
        icon: `history`,
        hint: armed.value ? undefined : `Go back here and drop what follows`,
        disabled: !anchored.value || busy.value,
        danger: armed.value,
        // Kept open on the arming press so the second click has something to land on.
        command: () => void rewind(),
    },
]);

const open = (event: Event): void => {
    disarm();
    menu.value?.show(event);
};
</script>

<template>
    <!-- Zero layout height by construction (the padding is cancelled by the margin), so a transcript with a cut
         between every turn is the same transcript it was — what the padding buys is a 16px grab strip for a
         line that is 1px of paint. On touch there is no hover to reveal anything, so the chip stands at low
         opacity the way the message actions already do there, and the line stays hidden: one faint glyph per
         turn is a hint, a dashed rule through every gap is noise.
         A cut that HAS been forked shows both permanently — it is no longer an empty gap but a junction, and
         the branches taken from it are the thing worth seeing without hunting for it. -->
    <div class="group/cut relative -my-2 flex items-center py-2" :class="busy && `pointer-events-none`" @mouseleave="disarm">
        <span
            class="h-px flex-1 border-t border-dashed border-strong transition-opacity"
            :class="forks.length > 0 ? `opacity-60` : mobile ? `opacity-0` : `opacity-0 group-hover/cut:opacity-100 group-focus-within/cut:opacity-100`"
        ></span>
        <button
            type="button"
            class="composer-ghost mx-2 flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-2xs transition-opacity"
            :class="[
                forks.length > 0 ? `opacity-100` : mobile ? `opacity-40` : `opacity-0 focus-visible:opacity-100 group-hover/cut:opacity-100`,
                busy && `cursor-default opacity-30`,
            ]"
            v-tooltip.top="'Fork the conversation here'"
            aria-label="Fork the conversation here"
            :disabled="busy"
            @click.stop="open"
        >
            <Icon :name="rewinding ? `spinner` : `fork`" :spin="rewinding" class="text-2xs" />
            <span :class="mobile && `sr-only`">Fork here</span>
        </button>
        <!-- The paths already taken from this point, each by name. A count alone would say a fork exists and
             leave finding it as an exercise, which is the state this whole affordance is trying to end. -->
        <template v-if="forks.length > 0">
            <button
                v-for="fork in forks"
                :key="fork.id"
                type="button"
                class="composer-ghost mr-2 flex h-5 max-w-40 shrink-0 items-center gap-1 rounded-full px-2 text-2xs"
                v-tooltip.top="`Open this fork`"
                @click.stop="openFork(fork.id)"
            >
                <Icon name="arrow-up-right" class="text-2xs" />
                <span class="truncate">{{ fork.title ?? `Untitled fork` }}</span>
            </button>
        </template>
        <span
            class="h-px flex-1 border-t border-dashed border-strong transition-opacity"
            :class="forks.length > 0 ? `opacity-60` : mobile ? `opacity-0` : `opacity-0 group-hover/cut:opacity-100 group-focus-within/cut:opacity-100`"
        ></span>
        <ContextMenu ref="menu" :model="items" :append-to="overlayTarget" :min-width="17" />
    </div>
</template>
