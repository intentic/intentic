<script setup lang="ts">
import { ui } from "@intentic/ui";
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import { useRouter } from "vue-router";
import { startAgent } from "../../agents/fleet/agentActions";
import { chatParked } from "./chatPanelLayout";
import { chatBarDock } from "../../../shell/window/dockSlots";
import { focusComposer } from "../tabs/useChat-tabs";
import { useChat } from "../run/useChat";

// The chat's home while it is parked: one strip along the bottom of the area, growing into the focused chat's own
// composer. The panel teleports here (PoppablePanels), so this is never a second composer — the words, the model, the
// attachments and the stream are the conversation /chat would show.
// Collapsed it is also the only sign a parked turn is running, which the rail's chat tile deliberately doesn't carry.

const router = useRouter();
const { active, streaming, draft, composerFocus, awaitingDecision } = useChat();

const expanded = ref(false);
// Focus, not hover, is what keeps the strip open through a pointer that has wandered off it.
const holdsFocus = ref(false);
const section = useTemplateRef(`section`);
const slot = useTemplateRef(`slot`);

const title = computed(() => active.value.title.value ?? undefined);

// What the strip is for right now, most urgent first. `asking` is the one that isn't about the composer at all: a
// permission card or a question is drawn in the transcript, which a strip has none of, so it can only carry the news.
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

// Hover opens on intent, not on contact: the bottom edge is also the way to a scrollbar and to the terminal below,
// and a strip that unfolded under every crossing pointer would cover the page being read.
const HOVER_INTENT_MS = 250;
// Long enough to cross the gap back after overshooting the strip's own edge.
const HOVER_GRACE_MS = 400;
let timer: ReturnType<typeof setTimeout> | undefined;
const cancelTimer = (): void => {
    clearTimeout(timer);
    timer = undefined;
};
onBeforeUnmount(cancelTimer);

// Words in the box are the one thing a collapse could lose sight of, so they keep it open; a live turn does not,
// since the strip says so on its own line.
const collapsible = computed(() => !holdsFocus.value && draft.value.trim() === ``);

// A pointer that merely crossed the strip gets the box, never the caret: taking it on hover would route the next
// keystroke away from whatever the reader was actually typing into, and the caret it stole would then hold the strip
// open over the page. Only a press or a summons means to write.
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
    if (expanded.value && collapsible.value) {
        timer = setTimeout(() => {
            if (collapsible.value) {
                collapse();
            }
        }, HOVER_GRACE_MS);
    }
};
// Escape belongs to the composer first: it stops a streaming turn, abandons an armed edit and quits hands-free, and
// says so by calling preventDefault on the ones it claimed. Closing the strip is what's left over.
const onEscape = (event: KeyboardEvent): void => {
    if (!event.defaultPrevented) {
        collapse();
    }
};
const onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && section.value?.contains(next) === true) {
        return;
    }
    holdsFocus.value = false;
    if (collapsible.value) {
        collapse();
    }
};

// Anything that asks for the caret — "New agent" from any surface, a board starter filling the box, a card summoned
// from another window — means to be typed into, so it raises the strip wherever the reader is standing.
watch(composerFocus, () => {
    if (chatParked.value) {
        // The caret is already on its way from whoever raised the signal; this only has to give it somewhere to land.
        expand(false);
    }
});

// Publishes the slot only while the strip is on screen; parked elsewhere, the panel goes back to the parking stage.
watch(
    [() => chatParked.value, slot],
    ([parked, element]) => {
        chatBarDock.value = parked ? element : null;
    },
    { immediate: true, flush: `post` },
);
onBeforeUnmount(() => (chatBarDock.value = null));

const restingLine = computed(() => {
    if (standing.value === `asking`) {
        return title.value === undefined ? `Your agent is waiting for you` : `${title.value} · waiting for you`;
    }
    if (standing.value === `unsent`) {
        return draft.value.trim();
    }
    return title.value ?? (standing.value === `working` ? `Working…` : `Ask anything…`);
});

const openFullChat = (): void => {
    collapse();
    void router.push(`/chat`);
};
// A question can only be answered where its card is drawn, so here the press is a door, not a disclosure.
const onPress = (): void => {
    if (standing.value === `asking`) {
        openFullChat();
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
    <section
        v-if="chatParked"
        ref="section"
        class="chat-quick-bar flex flex-col border-t border-line bg-card"
        style="grid-area: composer"
        @pointerenter="onEnter"
        @pointerleave="onLeave"
        @focusin="holdsFocus = true"
        @focusout="onFocusOut"
        @keydown.esc="onEscape"
    >
        <div class="flex items-center gap-1 px-2">
            <!-- The row itself is the toggle; the chevron states which way it goes rather than being the only target. -->
            <button
                type="button"
                class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 pl-1 text-left transition-colors hover:bg-overlay"
                :aria-expanded="standing === `asking` ? undefined : expanded"
                :aria-label="
                    standing === `asking`
                        ? `Open the chat: your agent is waiting for an answer`
                        : expanded
                          ? `Hide the composer`
                          : `Write to your agent from here`
                "
                @click="onPress"
            >
                <Icon v-if="standing === `asking`" name="exclamation-circle" class="shrink-0 text-2xs text-warning" />
                <Icon v-else-if="standing === `working`" name="spinner" spin class="shrink-0 text-2xs text-link" />
                <Icon v-else :name="expanded ? `chevron-down` : `chevron-up`" class="shrink-0 text-2xs text-subtle" />
                <span
                    class="min-w-0 flex-1 truncate text-2xs"
                    :class="standing === `asking` ? `text-warning` : standing === `inviting` ? `text-subtle` : `text-muted`"
                    >{{ restingLine }}</span
                >
            </button>

            <button
                type="button"
                :class="ui.iconButton(`h-7 w-7 rounded-md`)"
                v-tooltip.top="'New agent'"
                aria-label="New agent"
                @click="startAgent()"
            >
                <Icon name="plus" class="text-2xs" />
            </button>
            <button
                type="button"
                :class="ui.iconButton(`h-7 w-7 rounded-md`)"
                v-tooltip.top="'Open the chat: the whole conversation'"
                aria-label="Open the chat"
                @click="openFullChat"
            >
                <Icon name="expand" class="text-2xs" />
            </button>
        </div>

        <!-- 0fr → 1fr animates the composer's real height; a max-height guess would either clip a long draft or
             overshoot a short one. `inert` while closed, or Tab would land in a box nobody can see. -->
        <div class="chat-quick-host" :class="{ 'chat-quick-open': expanded }">
            <div class="chat-quick-clip" :inert="!expanded">
                <div ref="slot" class="contents"></div>
            </div>
        </div>
    </section>
</template>

<style scoped>
.chat-quick-host {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 160ms ease;
}

.chat-quick-open {
    grid-template-rows: 1fr;
}

/* The grid's single row; both are what makes a 0fr row actually collapse. */
.chat-quick-clip {
    min-height: 0;
    overflow: hidden;
}

@media (prefers-reduced-motion: reduce) {
    .chat-quick-host {
        transition: none;
    }
}
</style>
