<script setup lang="ts">
import { ProgressRing } from "@intentic/ui";
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import { useRouter } from "vue-router";
import { chatBarPeek, chatParked } from "./chatPanelLayout";
import { chatBarDock } from "../../../shell/window/dockSlots";
import { focusComposer } from "../tabs/useChat-tabs";
import { useChat } from "../run/useChat";
import { useT } from "@intentic/ui/i18n";
import IdentityTile from "../../capabilities/connect/IdentityTile.vue";

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
const { active, messages, streaming, draft, composerFocus, awaitingDecision, contextUsage, provider } = useChat();

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

// What the identity ring reads, the fleet card's two readings in the card's own order (tileRim): a turn in flight is
// an arc going round, and otherwise it is how full this chat's context window is. Nothing measured leaves the plain
// track, which is what the card draws too.
const rim = computed<{ percent: number; tone: string; spin: boolean } | undefined>(() => {
    if (streaming.value) {
        return { percent: 25, tone: `text-link`, spin: true };
    }
    const usage = contextUsage.value;
    if (usage === undefined || usage.contextWindow <= 0) {
        return undefined;
    }
    const percent = Math.min(100, Math.round((usage.tokens / usage.contextWindow) * 100));
    return { percent, tone: percent >= 80 ? `text-warning` : `text-primary-500`, spin: false };
});

// Hover opens on intent, not on contact: the bottom of the area is also the way to a scrollbar and to the terminal,
// and a pill that unfolded under every crossing pointer would cover the page being read.
const HOVER_INTENT_MS = 250;
// Long enough to cross the gap back after overshooting the pill's own edge.
const HOVER_GRACE_MS = 400;
// The handle is a target reached on purpose, so its guard only has to outlast a pointer leaving the box across it.
const PEEK_INTENT_MS = 140;
// Long enough to read as leaving, short enough that nobody waits for it; must match the card's own exit duration,
// since this is what keeps the turns mounted while they fade with it.
const PEEK_EXIT_MS = 130;
let timer: ReturnType<typeof setTimeout> | undefined;
let peekTimer: ReturnType<typeof setTimeout> | undefined;
let peekExit: ReturnType<typeof setTimeout> | undefined;
const cancelTimer = (): void => {
    clearTimeout(timer);
    timer = undefined;
};

// Two states, not one, and both flip in the same render: `peekOpen` is whether the transcript is being asked for,
// `chatBarPeek` is whether the panel is drawing it. They come apart only on the way out, where the turns have to stay
// mounted long enough to fade — they belong to the panel, so they cannot fade after the flag that draws them drops.
// The entry state is an ANIMATION rather than a transition (chat.css) precisely so nothing here has to wait a frame:
// a flag set a frame late is a flag that is wrong for a frame, and Escape arriving in it closed the wrong thing.
const peekOpen = ref(false);
const openPeek = (): void => {
    clearTimeout(peekTimer);
    clearTimeout(peekExit);
    peekTimer = peekExit = undefined;
    peekOpen.value = true;
    chatBarPeek.value = true;
};
const closePeek = (): void => {
    clearTimeout(peekTimer);
    peekTimer = undefined;
    if (!peekOpen.value) {
        return;
    }
    peekOpen.value = false;
    peekExit = setTimeout(() => {
        chatBarPeek.value = false;
        peekExit = undefined;
    }, PEEK_EXIT_MS);
};
// The whole form is leaving, so there is nothing for the transcript to fade out of: it goes with it, in one render.
const dropPeek = (): void => {
    clearTimeout(peekTimer);
    clearTimeout(peekExit);
    peekTimer = peekExit = undefined;
    peekOpen.value = false;
    chatBarPeek.value = false;
};
onBeforeUnmount(() => {
    cancelTimer();
    dropPeek();
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
    dropPeek();
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
    if (peekOpen.value) {
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
    if (!peekOpen.value) {
        peekTimer = setTimeout(openPeek, PEEK_INTENT_MS);
    }
};
const togglePeek = (): void => {
    if (peekOpen.value) {
        closePeek();
        return;
    }
    openPeek();
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
        class="chat-quick-seat pointer-events-none z-20 flex w-full justify-center self-end px-4 pb-5"
        style="grid-area: workspace"
    >
        <!-- ONE WIDTH AT EVERY STATE, and the box centred inside it: what moves is opacity and transform, never a size.
     Animating the width put the composer through its own container queries on every frame — the control row wrapped
     and unwrapped mid-flight — and it is the one property here that cannot move without the layout moving with it.
     Nothing hit-tests on this element (`pointer-events` inherits, so each form claims its own back): a 51rem strip of
     hover target would open the box from halfway across the page. Enter and leave still fire, through the forms. -->
        <div
            ref="float"
            class="chat-quick-float pointer-events-none relative w-[51rem] max-w-full"
            :class="{ 'chat-quick-open': expanded, 'chat-quick-peeking': peekOpen }"
            @pointerenter="onEnter"
            @pointerleave="onLeave"
            @focusin="holdsFocus = true"
            @focusout="onFocusOut"
            @keydown.esc="onEscape"
        >
            <!-- The peek's glass, drawn HERE rather than by the panel, because it has to arrive without the composer
     arriving with it — and the composer is the panel's own child, so anything done to that element is done to the box
     the reader is typing in. It is exactly the box's own rect: the transcript reads on it, and its bottom is hidden
     under the composer, so no surface of ours ever stretches past the box the reader is typing in. */ -->
            <div
                v-if="chatBarPeek"
                class="chat-quick-card pointer-events-auto absolute inset-0 rounded-2xl border border-line-strong bg-card/70 shadow-2xl backdrop-blur-2xl"
            ></div>

            <!-- WHICHEVER FORM IS NOT SHOWING LEAVES THE FLOW instead of being measured out of it: the box is the size of what is
     actually in it at both ends, so no reading can be stale and no frame can be left standing on air. -->
            <!-- It fades to nothing rather than to `display: none`, since the caret a summons sends arrives in the same render and
     an unrendered box cannot take it. `inert` is a boolean attribute — present is inert whatever it says — and Vue
     strips a `false` only for the attributes it knows are boolean, which this is not. Hence `|| undefined` on both. -->
            <!-- The wrapper is what leaves the flow, so the transform stays the pill's own: centring it with a translate
     of its own would have slid it half its width across the box every time it faded. -->
            <div
                class="chat-quick-rest mx-auto w-fit max-w-full origin-bottom rounded-full border border-line-strong bg-card/80 shadow-lg backdrop-blur-md transition-[opacity,scale] motion-reduce:transition-none"
                :class="
                    expanded
                        ? `pointer-events-none absolute inset-x-0 bottom-0 scale-110 opacity-0 duration-200 ease-out`
                        : `pointer-events-auto duration-150 ease-out`
                "
            >
                <button
                    type="button"
                    class="chat-quick-pill ui-chip h-9 max-w-[22rem] py-0 pr-3.5 pl-1 text-left"
                    :inert="expanded || undefined"
                    :aria-expanded="standing === `asking` ? undefined : expanded"
                    :aria-label="standing === `asking` ? t(`chat.chatQuickBar.openChatAgentWaiting`) : t(`chat.chatQuickBar.writeToAgentHere`)"
                    @click="onPress"
                >
                    <!-- The board's own identity mark, ring and all (AgentCard): one chat wears one face wherever it is named,
                         and the ring is the reading it already had room for — the turn in flight, or how full the window is. -->
                    <span
                        class="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                        :class="
                            rim !== undefined
                                ? ``
                                : standing === `asking`
                                  ? `ring-(length:--ring-track) ring-inset ring-warning/50`
                                  : `ring-(length:--ring-track) ring-inset ring-content/12`
                        "
                    >
                        <ProgressRing
                            v-if="rim !== undefined"
                            :value="rim.percent"
                            :size="28"
                            :stroke="1.5"
                            class="absolute inset-0"
                            :class="[rim.tone, rim.spin ? `animate-spin` : ``]"
                        />
                        <IdentityTile :title="title" :provider="provider" class="h-5.5 w-5.5 text-xs" />
                    </span>
                    <span
                        class="min-w-0 truncate text-2xs"
                        :class="standing === `asking` ? `text-warning` : standing === `inviting` ? `text-subtle` : `text-muted`"
                        >{{ restingLine }}</span
                    >
                </button>
            </div>

            <!-- The grown form: the panel's own composer, and nothing of this component's around it. IT GROWS OUT OF THE
     PILL — through a clip that opens from the pill's own footprint to the whole box (chat.css). The exit is this
     element's own transition; the entry is the animation there, which is the only one of the two that can start from
     a shape rather than from a value. -->
            <div
                class="chat-quick-host w-full origin-bottom transition-[opacity,scale] motion-reduce:transition-none"
                :class="
                    expanded
                        ? `pointer-events-auto relative duration-[260ms] ease-out`
                        : `pointer-events-none absolute inset-x-0 bottom-0 scale-95 opacity-0 duration-100 ease-in`
                "
                :inert="!expanded || undefined"
            >
                <div ref="slot" class="contents"></div>
            </div>

            <!-- ONE MARK FOR LOOKING, in the corner of the box it looks into: an eye, lit while it is open, and never a
     second glyph for closing — a chevron flipping over the box said "fold" about something that only ever appears and
     goes. Inside the float, so reading the turns is still "inside the box" and neither the peek nor the box closes
     under the pointer that went up to read them. -->
            <button
                v-if="expanded && hasTranscript"
                type="button"
                class="chat-quick-eye pointer-events-auto absolute -top-2.5 right-3 z-10 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border bg-card/80 shadow-md backdrop-blur-md transition-colors"
                :class="chatBarPeek ? `border-primary-500/40 text-link` : `border-line-strong text-subtle hover:text-content`"
                v-tooltip.top="t(`chat.chatQuickBar.whatWasSaidHover`)"
                :aria-expanded="chatBarPeek"
                :aria-label="t(`chat.chatQuickBar.conversationSoFar`)"
                @pointerenter="onPeekEnter"
                @click="togglePeek"
            >
                <Icon name="eye" class="text-2xs" />
            </button>
        </div>
    </div>
</template>
