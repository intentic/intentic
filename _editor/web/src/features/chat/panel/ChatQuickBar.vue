<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import { useRouter } from "vue-router";
import { chatBarPeek, chatParked } from "./chatPanelLayout";
import { chatBarDock } from "../../../shell/window/dockSlots";
import { focusComposer } from "../tabs/useChat-tabs";
import { useChat } from "../run/useChat";
import { useT } from "@intentic/ui/i18n";

// The chat's home while it is parked: a pill floating over the bottom of the area that grows into the focused chat's
// own composer. The panel teleports here (PoppablePanels), so this is never a second composer — the words, the model,
// the attachments and the stream are the conversation /chat would show.
// It floats rather than sitting in the shell's grid: growing it must not reflow the page underneath, because the
// reader opened it to say something ABOUT that page.
// Open, THE COMPOSER IS THE WHOLE SURFACE: no frame, no title, no status row around it. Every one of those drew a
// second edge around a box that already has one, and none of them carried anything a reader writing one message needs.
// The one thing the box cannot answer on its own — "what did it just say?" — is a handle on its top edge, and what
// that reveals is this same pane's transcript, unfolding upward over the page (chatBarPeek).

const t = useT();

const router = useRouter();
const { active, messages, streaming, draft, composerFocus, awaitingDecision } = useChat();

const expanded = ref(false);
// Focus, not hover, is what keeps it open through a pointer that has wandered off.
const holdsFocus = ref(false);
const float = useTemplateRef(`float`);
const slot = useTemplateRef(`slot`);

const title = computed(() => active.value.title.value ?? undefined);
// Nothing said yet is nothing to look back at, so the handle isn't drawn on a chat that has no turns.
const hasTranscript = computed(() => messages.value.length > 0);

// What the pill is for right now, most urgent first. `asking` is the one that isn't about the composer at all: a
// permission card or a question is drawn in the transcript, which a pill has none of, so it can only carry the news.
type Standing = `asking` | `working` | `unsent` | `named` | `inviting`;
const standing = computed<Standing>(() => {
    if (awaitingDecision.value) {
        return `asking`;
    }
    if (streaming.value) {
        return `working`;
    }
    if (draft.value.trim() !== ``) {
        return `unsent`;
    }
    return title.value === undefined ? `inviting` : `named`;
});

// Hover opens on intent, not on contact: the bottom of the area is also the way to a scrollbar and to the terminal,
// and a pill that unfolded under every crossing pointer would cover the page being read.
const HOVER_INTENT_MS = 250;
// Long enough to cross the gap back after overshooting the pill's own edge.
const HOVER_GRACE_MS = 400;
// The handle is a target reached on purpose, so its guard only has to outlast a pointer leaving the box across it.
const PEEK_INTENT_MS = 140;
let timer: ReturnType<typeof setTimeout> | undefined;
let peekTimer: ReturnType<typeof setTimeout> | undefined;
const cancelTimer = (): void => {
    clearTimeout(timer);
    timer = undefined;
};
const closePeek = (): void => {
    clearTimeout(peekTimer);
    peekTimer = undefined;
    chatBarPeek.value = false;
};
onBeforeUnmount(() => {
    cancelTimer();
    closePeek();
});

// Words in the box are the one thing a close could lose sight of, so they hold it open; a live turn does not, since
// the pill says so on its own line.
const collapsible = computed(() => !holdsFocus.value && draft.value.trim() === ``);

// A pointer that merely crossed the pill gets the box, never the caret: taking it on hover would route the next
// keystroke away from whatever the reader was actually typing into, and the caret it stole would then hold the
// composer open over the page. Only a press or a summons means to write.
const expand = (caret: boolean): void => {
    cancelTimer();
    // While a card is waiting for an answer, a box offering to send a message is the wrong instrument: it would read as
    // the way to answer, and the answer isn't a message. One already open stands, so nobody loses sight of a draft.
    if (standing.value === `asking`) {
        return;
    }
    if (!expanded.value) {
        expanded.value = true;
    }
    if (caret) {
        focusComposer();
    }
};
const collapse = (): void => {
    cancelTimer();
    closePeek();
    expanded.value = false;
};

const onEnter = (): void => {
    cancelTimer();
    if (!expanded.value) {
        timer = setTimeout(() => expand(false), HOVER_INTENT_MS);
    }
};
const onLeave = (): void => {
    cancelTimer();
    // The transcript goes with the pointer that asked for it, whether or not a draft is holding the box open.
    closePeek();
    if (expanded.value && collapsible.value) {
        timer = setTimeout(() => {
            if (collapsible.value) {
                collapse();
            }
        }, HOVER_GRACE_MS);
    }
};
// Escape belongs to the composer first: it stops a streaming turn, abandons an armed edit and quits hands-free, and
// says so by calling preventDefault on the ones it claimed. Then the transcript, then the box: one press undoes one
// thing, in the order they were opened.
const onEscape = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) {
        return;
    }
    if (chatBarPeek.value) {
        closePeek();
        return;
    }
    collapse();
};
const onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && float.value?.contains(next) === true) {
        return;
    }
    holdsFocus.value = false;
    if (collapsible.value) {
        collapse();
    }
};

// Hover reads, a press keeps: the handle is also the transcript's only door for a keyboard or a touch, neither of
// which can hover at all.
const onPeekEnter = (): void => {
    clearTimeout(peekTimer);
    if (!chatBarPeek.value) {
        peekTimer = setTimeout(() => (chatBarPeek.value = true), PEEK_INTENT_MS);
    }
};
const togglePeek = (): void => {
    clearTimeout(peekTimer);
    peekTimer = undefined;
    chatBarPeek.value = !chatBarPeek.value;
};

// Anything that asks for the caret — "New agent" from any surface, a board starter filling the box, a card summoned
// from another window — means to be typed into, so it grows the pill wherever the reader is standing.
watch(composerFocus, () => {
    if (chatParked.value) {
        // The caret is already on its way from whoever raised the signal; this only has to give it somewhere to land.
        expand(false);
    }
});

// Publishes the slot only while the pill is on screen; parked elsewhere, the panel goes back to the parking stage.
// Leaving also closes the box, so the composer is never left grown over a surface that has its own.
watch(
    [() => chatParked.value, slot],
    ([parked, element]) => {
        chatBarDock.value = parked ? element : null;
        if (!parked) {
            collapse();
        }
    },
    { immediate: true, flush: `post` },
);
onBeforeUnmount(() => (chatBarDock.value = null));

const restingLine = computed(() => {
    if (standing.value === `asking`) {
        return title.value === undefined
            ? t(`chat.chatQuickBar.agentWaitingForYou`)
            : t(`chat.chatQuickBar.titleWaitingForYou`, { title: title.value });
    }
    if (standing.value === `unsent`) {
        return draft.value.trim();
    }
    return title.value ?? (standing.value === `working` ? t(`chat.chatQuickBar.working`) : t(`chat.chatQuickBar.askAnything`));
});

// A question can only be answered where its card is drawn, so here the press is a door, not a disclosure.
const onPress = (): void => {
    if (standing.value === `asking`) {
        collapse();
        void router.push(`/chat`);
        return;
    }
    if (expanded.value) {
        collapse();
        return;
    }
    expand(true);
};
</script>

<template>
    <!-- Sits in the workspace cell rather than a row of its own, so it overlays the area instead of shortening it. -->
    <div
        v-if="chatParked"
        class="chat-quick-seat pointer-events-none z-20 flex w-full justify-center self-end px-4 pb-4"
        style="grid-area: workspace"
    >
        <!-- NOTHING HERE TRANSITIONS. The swap is one render: an animated width reflowed the composer's own container queries
     every frame of it, and the opacity crossfade between the two forms spent its first 100ms showing neither. -->
        <div
            ref="float"
            class="chat-quick-float pointer-events-auto relative max-w-full"
            :class="expanded ? `chat-quick-open w-[51rem]` : `w-[22rem]`"
            @pointerenter="onEnter"
            @pointerleave="onLeave"
            @focusin="holdsFocus = true"
            @focusout="onFocusOut"
            @keydown.esc="onEscape"
        >
            <!-- WHICHEVER FORM IS NOT SHOWING LEAVES THE FLOW instead of being measured out of it: the box is the size of what is
     actually in it at both ends, so no reading can be stale and no frame can be left standing on air. -->
            <!-- It fades to nothing rather than to `display: none`, since the caret a summons sends arrives in the same render and
     an unrendered box cannot take it. `inert` is a boolean attribute — present is inert whatever it says — and Vue
     strips a `false` only for the attributes it knows are boolean, which this is not. Hence `|| undefined` on both. -->
            <button
                type="button"
                class="chat-quick-pill flex h-10 w-full cursor-pointer items-center gap-2 rounded-2xl border border-line-strong bg-card px-3 text-left shadow-lg"
                :class="expanded ? `pointer-events-none absolute inset-x-0 bottom-0 opacity-0` : ``"
                :inert="expanded || undefined"
                :aria-expanded="standing === `asking` ? undefined : expanded"
                :aria-label="standing === `asking` ? t(`chat.chatQuickBar.openChatAgentWaiting`) : t(`chat.chatQuickBar.writeToAgentHere`)"
                @click="onPress"
            >
                <Icon v-if="standing === `asking`" name="exclamation-circle" class="shrink-0 text-2xs text-warning" />
                <Icon v-else-if="standing === `working`" name="spinner" spin class="shrink-0 text-2xs text-link" />
                <Icon v-else name="comments" class="shrink-0 text-2xs text-subtle" />
                <span
                    class="min-w-0 flex-1 truncate text-2xs"
                    :class="standing === `asking` ? `text-warning` : standing === `inviting` ? `text-subtle` : `text-muted`"
                    >{{ restingLine }}</span
                >
            </button>

            <!-- The grown form: the panel's own composer, and nothing of this component's around it. -->
            <div
                class="chat-quick-host w-full"
                :class="expanded ? `` : `pointer-events-none absolute inset-x-0 bottom-0 opacity-0`"
                :inert="!expanded || undefined"
            >
                <div ref="slot" class="contents"></div>
            </div>

            <!-- The transcript's handle, straddling the edge the transcript comes out of: the box grows UPWARD from it, so the
     composer never moves under the pointer and the page it was opened to talk about stays where it was. Inside the
     float, so reading the turns is still "inside the box" and neither the peek nor the box closes under the pointer. -->
            <button
                v-if="expanded && hasTranscript"
                type="button"
                class="chat-quick-handle absolute top-0 left-1/2 z-10 flex h-5 w-12 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-line-strong bg-card text-subtle shadow-md hover:text-content"
                v-tooltip.top="chatBarPeek ? t(`chat.chatQuickBar.hideConversation`) : t(`chat.chatQuickBar.whatWasSaidHover`)"
                :aria-expanded="chatBarPeek"
                :aria-label="t(`chat.chatQuickBar.conversationSoFar`)"
                @pointerenter="onPeekEnter"
                @click="togglePeek"
            >
                <Icon :name="chatBarPeek ? `chevron-down` : `chevron-up`" class="text-2xs" />
            </button>
        </div>
    </div>
</template>
