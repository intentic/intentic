<script setup lang="ts">
import { Icon, isOverlayTarget, ProgressRing } from "@intentic/ui";
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import { useRouter } from "vue-router";
import { chatParked, quickBarShowAsk } from "./chatPanelLayout";
import { chatBarSlot } from "../../../workbench/window/panelSlots";
import { focusComposer } from "../tabs/useChat-tabs";
import { useChat } from "../run/useChat";
import { useT } from "@intentic/ui/i18n";
import IdentityTile from "../../capabilities/connect/IdentityTile.vue";
import { contextPct } from "../../agents/fleet/agentStatus";
import { lastWords } from "./lastWords";

// The parked chat's scratch pad: a pill over the bottom of the area that opens into the focused chat's own composer (the
// panel teleports into `slot`). It is for writing to the agent from wherever the reader is, so open it says who that
// is and where the conversation stands, in one header above the box: the chat's face and title, and the last thing
// said in it. Reading the conversation is /chat's job, and the header is the way there; no transcript is drawn here.
// The box is open while the reader is in it: a press or the caret landing anywhere else closes it, and so does Escape.
// A draft is the conversation's own, so closing loses nothing: the pill shows the draft until it is sent.

const t = useT();

const router = useRouter();
const { active, messages, streaming, draft, composerFocus, awaitingDecision, contextUsage, provider } = useChat();

const open = ref(false);
// Whether the box has ever opened: its closing animation must not play on a box that starts closed.
const woken = ref(false);
const float = useTemplateRef(`float`);
const slot = useTemplateRef(`slot`);
const pill = useTemplateRef(`pill`);

const title = computed(() => active.value.title.value ?? undefined);
// Where the conversation stands, for the open pad's header: the last words said in it, by either side.
const said = computed(() => lastWords(messages.value));

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

// A question is answered where its card is drawn, which is /chat, so nothing opens for one. Only a press asks for the
// caret here: a summons (New agent, a board starter) brings its own.
const expand = (caret: boolean): void => {
    if (standing.value === `asking`) {
        return;
    }
    open.value = true;
    woken.value = true;
    if (caret) {
        focusComposer();
    }
};
const collapse = (): void => {
    open.value = false;
};

// The menus the composer opens (the model list and its kind) are teleported to the body, and count as the box.
const elsewhere = (target: EventTarget | null): boolean =>
    target instanceof Node && float.value?.contains(target) !== true && !isOverlayTarget(target);
// Capture phase, so a page that stops its own presses cannot hide from the box that the reader went back to it.
const onPressAnywhere = (event: Event): void => {
    if (elsewhere(event.target)) {
        collapse();
    }
};
const onFocusAnywhere = (event: FocusEvent): void => {
    if (elsewhere(event.target)) {
        collapse();
    }
};
const disarm = (): void => {
    document.removeEventListener(`pointerdown`, onPressAnywhere, true);
    document.removeEventListener(`focusin`, onFocusAnywhere, true);
};
watch(open, (isOpen) => {
    disarm();
    if (isOpen) {
        document.addEventListener(`pointerdown`, onPressAnywhere, true);
        document.addEventListener(`focusin`, onFocusAnywhere, true);
    }
});
onBeforeUnmount(disarm);

// Escape is the composer's first (a turn to stop, an edit to drop, a list to dismiss) and it claims one with
// preventDefault. Closed by the keyboard, the caret goes back to the pill rather than falling to the page.
const onEscape = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || !open.value) {
        return;
    }
    collapse();
    void nextTick(() => pill.value?.focus({ preventScroll: true }));
};

// The header's press: the conversation itself, where its turns are read.
const openChat = (): void => {
    collapse();
    void router.push(`/chat`);
};

// A press on the pill is the one way in: the composer with the caret in it, or, while a card waits, the chat itself.
const onPress = (): void => {
    if (standing.value === `asking`) {
        void router.push(`/chat`);
        return;
    }
    expand(true);
};

// Anything that asks for the caret (New agent, a board starter, a summons from another window) opens the pad; the caret
// itself is already on its way from whoever raised the signal.
watch(composerFocus, () => {
    if (chatParked.value) {
        expand(false);
    }
});

// A board card's click, or a run it follows, asks to see the chat's turns (showParkedChat), and the pad draws none:
// the turns are on /chat, so that is where the ask goes.
watch(quickBarShowAsk, () => {
    collapse();
    void router.push(`/chat`);
});

// The slot is published only while the pill is on screen, and leaving closes the box over a surface with its own.
watch(
    [() => chatParked.value, slot],
    ([parked, element]) => {
        chatBarSlot.value = parked ? element : null;
        if (!parked) {
            collapse();
        }
    },
    { immediate: true, flush: `post` },
);
onBeforeUnmount(() => {
    chatBarSlot.value = null;
    collapse();
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
    return title.value ?? (standing.value === `working` ? t(`ui.status.working`) : t(`chat.words.askAnything`));
});
</script>

<template>
    <!-- Sits in the workspace cell rather than a row of its own, so it overlays the area instead of shortening it. -->
    <div
        v-if="chatParked"
        class="chat-quick-seat pointer-events-none z-20 flex w-full justify-center self-end px-4 pb-5"
        style="grid-area: workspace"
    >
        <!-- One width at every state with the forms centred in it, so only opacity and transform ever animate. Nothing
             hit-tests on this element itself: each form claims pointer events back for its own rect. Narrower than the
             chat's own column, since it is a note to the agent rather than a place to read. -->
        <div
            ref="float"
            class="chat-quick-float pointer-events-none relative w-[36rem] max-w-full"
            :class="{ 'chat-quick-open': open, 'chat-quick-woken': woken }"
            @keydown.esc="onEscape"
        >
            <!-- The form not showing leaves the flow, so the box is always the size of what is in it. `inert` is not a
                 boolean Vue knows, so a false value is written as `undefined` to drop the attribute. -->
            <div
                class="chat-quick-rest mx-auto w-fit max-w-full origin-bottom rounded-full border border-line-strong bg-card/80 shadow-lg backdrop-blur-md transition-[opacity,scale] motion-reduce:transition-none"
                :class="
                    open
                        ? `pointer-events-none absolute inset-x-0 bottom-0 scale-110 opacity-0 duration-200 ease-out`
                        : `pointer-events-auto duration-150 ease-out`
                "
            >
                <button
                    ref="pill"
                    type="button"
                    class="chat-quick-pill ui-chip h-9 max-w-[22rem] py-0 pr-3.5 pl-1 text-left"
                    :inert="open || undefined"
                    :aria-expanded="standing === `asking` ? undefined : open"
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

            <!-- The open form: the panel's own composer and nothing of this component's around it, opening out of the
                 pill's footprint through a clip (chat.css). -->
            <div
                class="chat-quick-host w-full origin-bottom transition-[opacity,scale] motion-reduce:transition-none"
                :class="
                    open
                        ? `pointer-events-auto relative duration-[260ms] ease-out`
                        : `pointer-events-none absolute inset-x-0 bottom-0 opacity-0 duration-100 ease-in`
                "
                :inert="!open || undefined"
            >
                <!-- Who the composer under it writes to and where that conversation stands, so the pad is never a box
                     addressed to nobody; the whole header is the way to the conversation itself. -->
                <button
                    type="button"
                    class="chat-quick-context group mb-1.5 flex w-full flex-col gap-1 rounded-xl border border-line-strong bg-card/90 px-3 py-2 text-left shadow-lg backdrop-blur-md transition-colors hover:bg-overlay"
                    :aria-label="t(`chat.chatQuickBar.openFullChat`)"
                    v-tooltip.top="t(`chat.chatQuickBar.openFullChat`)"
                    @click="openChat"
                >
                    <span class="flex w-full min-w-0 items-center gap-2">
                        <span class="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
                            <ProgressRing
                                v-if="rim !== undefined"
                                :value="rim.percent"
                                :size="24"
                                :stroke="1.5"
                                class="absolute inset-0"
                                :class="[rim.tone, rim.spin ? `animate-spin [animation-duration:2.4s]` : ``]"
                            />
                            <IdentityTile :title="title" :provider="provider" class="h-4.5 w-4.5 text-2xs" />
                        </span>
                        <span class="min-w-0 flex-1 truncate text-xs font-medium text-content">{{ title ?? t(`chat.words.newChat`) }}</span>
                        <span v-if="streaming" class="shrink-0 text-2xs text-link">{{ t(`ui.status.working`) }}</span>
                        <Icon name="arrow-right" class="shrink-0 text-2xs text-subtle transition-colors group-hover:text-content" />
                    </span>
                    <span v-if="said !== undefined" class="chat-quick-said line-clamp-2 pl-8 text-2xs text-muted">
                        <span v-if="said.who === `you`" class="text-subtle">{{ t(`chat.chatQuickBar.you`) }}: </span>{{ said.text }}
                    </span>
                </button>
                <div ref="slot" class="contents"></div>
            </div>
        </div>
    </div>
</template>
