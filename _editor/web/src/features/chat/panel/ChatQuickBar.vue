<script setup lang="ts">
import { isOverlayTarget, ProgressRing, ui, useHoverIntent } from "@intentic/ui";
import { computed, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch } from "vue";
import { useRouter } from "vue-router";
import { chatBarPeek, chatParked } from "./chatPanelLayout";
import { chatBarDock } from "../../../shell/window/dockSlots";
import { focusComposer } from "../tabs/useChat-tabs";
import { useChat } from "../run/useChat";
import { useT } from "@intentic/ui/i18n";
import IdentityTile from "../../capabilities/connect/IdentityTile.vue";
import { contextPct } from "../../agents/fleet/agentStatus";
import { CLOSED, type QuickBar, type QuickBarEvent, stepQuickBar } from "./quickBarHold";

// The parked chat's home: a pill over the bottom of the area that grows into the focused chat's own composer (the panel
// teleports into `slot`), with that pane's own transcript unfolding above it on request (chatBarPeek). Hover borrows the
// box and a press keeps it until the reader dismisses it (quickBarHold.ts).

// The section's area the bar floats over: a press there is the one gesture that means the reader went back to the page.
const { page } = defineProps<{ page: HTMLElement | undefined }>();

const t = useT();

const router = useRouter();
const { active, messages, streaming, draft, composerFocus, awaitingDecision, contextUsage, provider } = useChat();

// The box and its transcript, moved only by `apply` (quickBarHold.ts).
const bar = shallowRef<QuickBar>(CLOSED);
const expanded = computed(() => bar.value.box !== `closed`);
// A press, the caret or a summons has made the box the reader's: only a dismissal closes it, never the pointer.
const kept = computed(() => bar.value.box === `kept`);
// The transcript is shown, and a press has kept it past the pointer that borrowed it.
const peekOpen = computed(() => bar.value.peek !== `closed`);
const peekKept = computed(() => bar.value.peek === `kept`);
// Whether the box has ever opened: its closing animation must not play on a box that starts closed.
const woken = ref(false);
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

// A pointer crossing the bottom of the area on its way to a scrollbar or the terminal must not unfold the box, and one
// overshooting an edge can cross back; the transcript's grace is shorter, so it always folds before the box. The eye is
// reached on purpose, so its intent only has to outlast a pointer crossing it.
const boxHover = useHoverIntent({ open: 250, close: 400 });
const peekHover = useHoverIntent({ open: 140, close: 200 });

const words = (): boolean => draft.value.trim() !== ``;
const onPage = (node: EventTarget | null): boolean => node instanceof Node && page?.contains(node) === true;

// The one place the bar moves. The panel is told the transcript is wanted in the same render it opens, so Escape reads
// true at once; it is told it is no longer wanted when the card has finished fading (`onPeekGone`), since the turns
// fade with the card and must stay mounted until then. A clock whose surface closed by another route is stopped too.
const apply = (event: QuickBarEvent): void => {
    const before = bar.value;
    const next = stepQuickBar(before, event);
    bar.value = next;
    if (next.peek !== `closed`) {
        chatBarPeek.value = true;
    }
    if (next.box !== `closed` && !woken.value) {
        woken.value = true;
    }
    if (next.box === `closed` && before.box !== `closed`) {
        boxHover.hide();
    }
    if (next.peek === `closed` && before.peek !== `closed`) {
        peekHover.hide();
    }
};
const onPeekGone = (): void => {
    if (!peekOpen.value) {
        chatBarPeek.value = false;
    }
};

// Only a press or a summons takes the caret: taken on hover, it would route the next keystroke away from the page.
const expand = (caret: boolean): void => {
    apply({ kind: `open`, keep: caret, asking: standing.value === `asking` });
    if (caret && kept.value) {
        focusComposer();
    }
};
const collapse = (): void => apply({ kind: `fold` });

const onEnter = (): void => {
    peekHover.cancel();
    boxHover.enter(() => expand(false));
};
const onLeave = (): void => {
    peekHover.leave(() => apply({ kind: `peekLeave` }));
    boxHover.leave(() => apply({ kind: `leave`, words: words() }));
};
// A press anywhere on the box's content keeps it and whatever it is showing; the tools act on their own presses.
const onPressInside = (event: Event): void => {
    if (!(event.target instanceof Element && event.target.closest(`.chat-quick-tools`) !== null)) {
        apply({ kind: `press` });
    }
};
// What the reader going back to the page ends: the transcript always, the box unless it holds words. Nothing else
// does: the rail switching views, a menu, a dialog, or the caret moving anywhere leaves the box as it is.
const onPagePress = (event: Event): void => {
    if (onPage(event.target)) {
        apply({ kind: `release`, words: words() });
    }
};
// A press on transcript text or on the rail leaves the caret off the page and out of the box, so that is where the
// reader's Escape lands; kept, the box was the last thing pressed and the key is its. Menus and dialogs are teleported
// to the body and answer their own Escape.
const onStrayEscape = (event: KeyboardEvent): void => {
    const target = event.target;
    if (event.key !== `Escape` || !kept.value || !(target instanceof Element) || float.value?.contains(target) === true) {
        return;
    }
    if (!onPage(target) && !isOverlayTarget(target)) {
        onEscape(event);
    }
};
const disarm = (): void => {
    document.removeEventListener(`pointerdown`, onPagePress, true);
    document.removeEventListener(`keydown`, onStrayEscape);
};
// Capture phase, so a page that stops its own presses cannot hide from the box that the reader went back to it.
watch(expanded, (isOpen) => {
    disarm();
    if (isOpen) {
        document.addEventListener(`pointerdown`, onPagePress, true);
        document.addEventListener(`keydown`, onStrayEscape);
    }
});
onBeforeUnmount(disarm);

const onFocusIn = (): void => apply({ kind: `focus` });
// Escape is the composer's first (a turn to stop, an edit to drop) and it claims one with preventDefault; then the
// transcript, then the box: one press undoes one thing.
const onEscape = (event: KeyboardEvent): void => {
    if (!event.defaultPrevented) {
        apply({ kind: `escape` });
    }
};

const onEyeEnter = (): void => peekHover.enter(() => apply({ kind: `peek`, keep: false }));
const onEyeLeave = (): void => {
    if (!peekOpen.value) {
        peekHover.cancel();
    }
};
// A press keeps what a hover only borrowed, and a second press folds it: keyboard and touch have no hover to borrow with.
const onEyePress = (): void => apply({ kind: `peek`, keep: true });
const openChat = (): void => {
    collapse();
    void router.push(`/chat`);
};

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
    collapse();
    chatBarPeek.value = false;
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
            @keydown.esc="onEscape"
        >
            <!-- The transcript's glass: exactly the box's rect, drawn here so it can arrive without the composer moving. Its
                 fade out (chat.css) is what the panel's turns wait for before they unmount; a box folding whole takes it
                 with it in the same render, so no fade is waited for then. -->
            <Transition name="chat-quick-card" :css="expanded" @after-leave="onPeekGone">
                <div
                    v-if="peekOpen"
                    class="chat-quick-card pointer-events-auto absolute inset-0 rounded-2xl border border-line-strong bg-card/85 shadow-2xl backdrop-blur-2xl"
                ></div>
            </Transition>

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
