<script setup lang="ts">
import { ProgressRing, ui } from "@intentic/ui";
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { chatBarPeek, chatParked } from "./chatPanelLayout";
import { chatBarDock } from "../../../shell/window/dockSlots";
import { focusComposer } from "../tabs/useChat-tabs";
import { useChat } from "../run/useChat";
import { useT } from "@intentic/ui/i18n";
import IdentityTile from "../../capabilities/connect/IdentityTile.vue";
import { contextPct } from "../../agents/fleet/agentStatus";

// The parked chat's home: a pill over the bottom of the area that grows into the focused chat's own composer (the panel
// teleports into `slot`), with that pane's own transcript unfolding above it on request (chatBarPeek). Hover borrows the
// box and a press keeps it until the reader dismisses it; docs/design/chat-quick-bar.md has the rules and their reasons.

const t = useT();

const router = useRouter();
const route = useRoute();
const { active, messages, streaming, draft, composerFocus, awaitingDecision, contextUsage, provider } = useChat();

const expanded = ref(false);
// Whether the box has ever opened: its closing animation must not play on a box that starts closed.
const woken = ref(false);
// A press, the caret or a summons has made the box the reader's: only a dismissal closes it, never the pointer.
const kept = ref(false);
// The transcript is shown, and a press has kept it past the pointer that borrowed it.
const peekOpen = ref(false);
const peekKept = ref(false);
const float = useTemplateRef(`float`);
const slot = useTemplateRef(`slot`);

const title = computed(() => active.value.title.value ?? undefined);
const hasTranscript = computed(() => messages.value.length > 0);

// What the pill is for right now, most urgent first; `asking` is news only, since its card is drawn in the transcript.
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

// The fleet card's two readings in its own order (tileRim): a turn in flight spins, otherwise context fullness.
const rim = computed<{ percent: number; tone: string; spin: boolean } | undefined>(() => {
    if (streaming.value) {
        return { percent: 25, tone: `text-link`, spin: true };
    }
    const percent = contextPct(contextUsage.value?.tokens, contextUsage.value?.contextWindow);
    return percent === undefined ? undefined : { percent, tone: percent >= 80 ? `text-warning` : `text-primary-500`, spin: false };
});

// A pointer crossing the bottom of the area on its way to a scrollbar or the terminal must not unfold the box.
const HOVER_INTENT_MS = 250;
// Long enough to cross back after overshooting an edge; the transcript's is shorter, so it always folds before the box.
const HOVER_GRACE_MS = 400;
const PEEK_GRACE_MS = 200;
// The eye is reached on purpose, so its intent only has to outlast a pointer crossing it.
const PEEK_INTENT_MS = 140;
// Must match the card's exit transition in chat.css: the turns stay mounted this long so they fade with it.
const PEEK_EXIT_MS = 130;
// Surfaces the composer opens outside its own subtree; a press or the caret landing in one is still inside the box.
const OVERLAYS = `.ui-anchored, [role="dialog"], .p-contextmenu`;

let boxTimer: ReturnType<typeof setTimeout> | undefined;
let peekTimer: ReturnType<typeof setTimeout> | undefined;
let peekExit: ReturnType<typeof setTimeout> | undefined;
const cancelBoxTimer = (): void => {
    clearTimeout(boxTimer);
    boxTimer = undefined;
};
const cancelPeekTimer = (): void => {
    clearTimeout(peekTimer);
    peekTimer = undefined;
};

const within = (node: Element): boolean => float.value?.contains(node) === true || node.closest(OVERLAYS) !== null;

// `peekOpen` is whether the transcript is asked for and `chatBarPeek` whether the panel draws it: they part only on the
// way out, where the turns must stay mounted to fade with the card, and both flip in one render so Escape reads true.
const openPeek = (keep: boolean): void => {
    cancelPeekTimer();
    clearTimeout(peekExit);
    peekExit = undefined;
    peekOpen.value = true;
    chatBarPeek.value = true;
    if (keep) {
        peekKept.value = true;
        kept.value = true;
    }
};
const closePeek = (): void => {
    cancelPeekTimer();
    if (!peekOpen.value) {
        return;
    }
    peekOpen.value = false;
    peekKept.value = false;
    peekExit = setTimeout(() => {
        chatBarPeek.value = false;
        peekExit = undefined;
    }, PEEK_EXIT_MS);
};
// The whole box is leaving, so the transcript goes with it in the same render rather than fading on its own.
const dropPeek = (): void => {
    cancelPeekTimer();
    clearTimeout(peekExit);
    peekExit = undefined;
    peekOpen.value = false;
    peekKept.value = false;
    chatBarPeek.value = false;
};

// Only a press or a summons takes the caret: taken on hover, it would route the next keystroke away from the page.
const expand = (caret: boolean): void => {
    cancelBoxTimer();
    // A waiting card is answered in the transcript, not by a message, so no box is offered; one already open stays.
    if (standing.value === `asking`) {
        return;
    }
    if (!expanded.value) {
        expanded.value = true;
        woken.value = true;
    }
    if (caret) {
        kept.value = true;
        focusComposer();
    }
};
const collapse = (): void => {
    cancelBoxTimer();
    dropPeek();
    expanded.value = false;
    kept.value = false;
};
// Words in the box hold it open against the pointer and a press on the page; only Escape or minimizing folds them.
const collapsible = computed(() => !kept.value && draft.value.trim() === ``);

// What the reader moving on to the page ends: the transcript always, the box unless it holds words.
const release = (): void => {
    closePeek();
    kept.value = false;
    if (collapsible.value) {
        collapse();
    }
};

const onEnter = (): void => {
    cancelBoxTimer();
    cancelPeekTimer();
    if (!expanded.value) {
        boxTimer = setTimeout(() => expand(false), HOVER_INTENT_MS);
    }
};
const onLeave = (): void => {
    cancelBoxTimer();
    cancelPeekTimer();
    if (peekOpen.value && !peekKept.value) {
        peekTimer = setTimeout(closePeek, PEEK_GRACE_MS);
    }
    if (expanded.value && collapsible.value) {
        boxTimer = setTimeout(() => {
            if (collapsible.value) {
                collapse();
            }
        }, HOVER_GRACE_MS);
    }
};
// A press anywhere on the box's content keeps it and whatever it is showing; the tools act on their own presses.
const onPressInside = (event: Event): void => {
    if (!expanded.value || (event.target instanceof Element && event.target.closest(`.chat-quick-tools`) !== null)) {
        return;
    }
    kept.value = true;
    if (peekOpen.value) {
        peekKept.value = true;
    }
};
const onPressOutside = (event: Event): void => {
    if (event.target instanceof Element && !within(event.target)) {
        release();
    }
};
// A press on transcript text leaves the caret nowhere, so its Escape arrives on the body; kept, the box was the last
// thing pressed and the key is its.
const onStrayEscape = (event: KeyboardEvent): void => {
    if (event.key === `Escape` && kept.value && event.target === document.body) {
        onEscape(event);
    }
};
const disarm = (): void => {
    document.removeEventListener(`pointerdown`, onPressOutside, true);
    document.removeEventListener(`keydown`, onStrayEscape);
};
// Capture phase, so a surface that stops its own presses cannot hide from the box that the reader moved on.
watch(expanded, (open) => {
    disarm();
    if (open) {
        document.addEventListener(`pointerdown`, onPressOutside, true);
        document.addEventListener(`keydown`, onStrayEscape);
    }
});
onBeforeUnmount(disarm);

const onFocusIn = (): void => {
    if (expanded.value) {
        kept.value = true;
    }
};
// Focus falling to nothing is a press on text inside the box or the window losing focus, never the reader leaving.
const onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Element && !within(next)) {
        release();
    }
};
// Escape is the composer's first (a turn to stop, an edit to drop) and it claims one with preventDefault; then the
// transcript, then the box: one press undoes one thing.
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

const onEyeEnter = (): void => {
    cancelPeekTimer();
    if (!peekOpen.value) {
        peekTimer = setTimeout(() => openPeek(false), PEEK_INTENT_MS);
    }
};
const onEyeLeave = (): void => {
    if (!peekOpen.value) {
        cancelPeekTimer();
    }
};
// A press keeps what a hover only borrowed, and a second press folds it: keyboard and touch have no hover to borrow with.
const onEyePress = (): void => {
    if (peekOpen.value && peekKept.value) {
        closePeek();
        return;
    }
    openPeek(true);
};
const openChat = (): void => {
    collapse();
    void router.push(`/chat`);
};

// A link followed from the transcript is the reader going to look at something the transcript would cover.
watch(() => route.fullPath, closePeek);

// Anything that asks for the caret (New agent, a board starter, a summons from another window) grows the pill; the
// caret itself is already on its way from whoever raised the signal.
watch(composerFocus, () => {
    if (chatParked.value) {
        expand(false);
    }
});

// The slot is published only while the pill is on screen, and leaving closes the box over a surface with its own.
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
onBeforeUnmount(() => {
    chatBarDock.value = null;
    cancelBoxTimer();
    dropPeek();
});

const restingLine = computed(() => {
    if (standing.value === `asking`) {
        return title.value === undefined
            ? t(`chat.chatQuickBar.agentWaitingForYou`)
            : t(`chat.chatQuickBar.titleWaitingForYou`, { title: title.value });
    }
    if (standing.value === `unsent`) {
        return draft.value.trim();
    }
    return title.value ?? (standing.value === `working` ? t(`shared.working`) : t(`shared.askAnything`));
});

// A question is answered where its card is drawn, so while one waits the press is a door rather than a disclosure.
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

const tool = ui.iconButton(`rounded-full text-subtle`);
</script>

<template>
    <!-- Sits in the workspace cell rather than a row of its own, so it overlays the area instead of shortening it. -->
    <div
        v-if="chatParked"
        class="chat-quick-seat pointer-events-none z-20 flex w-full justify-center self-end px-4 pb-5"
        style="grid-area: workspace"
    >
        <!-- One width at every state with the forms centred in it, so only opacity and transform ever animate. Nothing
             hit-tests on this element itself: each form claims pointer events back for its own rect. -->
        <div
            ref="float"
            class="chat-quick-float pointer-events-none relative w-[51rem] max-w-full"
            :class="{ 'chat-quick-open': expanded, 'chat-quick-peeking': peekOpen, 'chat-quick-woken': woken }"
            @pointerenter="onEnter"
            @pointerleave="onLeave"
            @pointerdown.capture="onPressInside"
            @focusin="onFocusIn"
            @focusout="onFocusOut"
            @keydown.esc="onEscape"
        >
            <!-- The transcript's glass: exactly the box's rect, drawn here so it can arrive without the composer moving. -->
            <div
                v-if="chatBarPeek"
                class="chat-quick-card pointer-events-auto absolute inset-0 rounded-2xl border border-line-strong bg-card/85 shadow-2xl backdrop-blur-2xl"
            ></div>

            <!-- The form not showing leaves the flow, so the box is always the size of what is in it. `inert` is not a
                 boolean Vue knows, so a false value is written as `undefined` to drop the attribute. -->
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
                    <!-- The board's identity mark, ring included (AgentCard): one chat wears one face wherever it is named. -->
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
                            :class="[rim.tone, rim.spin ? `animate-spin [animation-duration:2.4s]` : ``]"
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

            <!-- The grown form: the panel's own composer and nothing of this component's around it, opening out of the
                 pill's footprint through a clip (chat.css). -->
            <div
                class="chat-quick-host w-full origin-bottom transition-[opacity,scale] motion-reduce:transition-none"
                :class="
                    expanded
                        ? `pointer-events-auto relative duration-[260ms] ease-out`
                        : `pointer-events-none absolute inset-x-0 bottom-0 opacity-0 duration-100 ease-in`
                "
                :inert="!expanded || undefined"
            >
                <div ref="slot" class="contents"></div>
            </div>

            <!-- The open box's own controls, on its top edge wherever that edge is: the transcript, the full chat, and a way
                 to fold even a box that words are holding open. -->
            <div
                v-if="expanded"
                class="chat-quick-tools pointer-events-auto absolute -top-3.5 right-3 z-10 flex items-center gap-0.5 rounded-full border border-line-strong bg-card/90 p-0.5 shadow-md backdrop-blur-md"
            >
                <template v-if="hasTranscript">
                    <button
                        type="button"
                        class="chat-quick-eye relative"
                        :class="[tool, peekOpen && `bg-primary-500/15 text-primary-500 hover:bg-primary-500/20 hover:text-primary-500`]"
                        v-tooltip.top="peekKept ? t(`chat.chatQuickBar.hideConversation`) : t(`chat.chatQuickBar.whatWasSaidHover`)"
                        :aria-label="t(`chat.chatQuickBar.conversationSoFar`)"
                        :aria-expanded="peekOpen"
                        @pointerenter="onEyeEnter"
                        @pointerleave="onEyeLeave"
                        @click="onEyePress"
                    >
                        <Icon name="eye" class="text-2xs" />
                        <!-- An answer arriving where nobody is looking: the one sign the box can give that there is news to read. -->
                        <span
                            v-if="streaming && !peekOpen"
                            class="chat-quick-news absolute top-0.5 right-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-link motion-reduce:animate-none"
                        ></span>
                    </button>
                    <button
                        type="button"
                        class="chat-quick-full"
                        :class="tool"
                        v-tooltip.top="t(`chat.chatQuickBar.openFullChat`)"
                        :aria-label="t(`chat.chatQuickBar.openFullChat`)"
                        @click="openChat"
                    >
                        <Icon name="expand" class="text-2xs" />
                    </button>
                </template>
                <button
                    type="button"
                    class="chat-quick-fold"
                    :class="tool"
                    v-tooltip.top="t(`chat.chatQuickBar.minimize`)"
                    :aria-label="t(`chat.chatQuickBar.minimize`)"
                    @click="collapse"
                >
                    <Icon name="chevron-down" class="text-2xs" />
                </button>
            </div>
        </div>
    </div>
</template>
