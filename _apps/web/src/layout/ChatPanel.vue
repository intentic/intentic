<script setup lang="ts">
import { BottomSheet, useDevice } from "@intentic-app/ui";
import Popover from "primevue/popover";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { effortsFor, modelsFor, MODES, providerLabel } from "../composables/chat/catalog";
import type { ChatAttachment, ChatMessage, PendingAttachment } from "../composables/chat/conversation";
import { formatReset, usageStatusFor, usageWindowLabel } from "../composables/chat/usageStatus";
import { useChat } from "../composables/chat/useChat";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { useSpeechInput } from "../composables/chat/useSpeechInput";
import { sandboxJson, sandboxUpload } from "../composables/sandboxClient";
import { useLayout } from "../composables/useLayout";
import { useSandbox } from "../composables/useSandbox";
import { collectDroppedFiles } from "../pages/workspace/dropEntries";
import ChatAccountPanel from "./ChatAccountPanel.vue";
import ChatMessageView from "./ChatMessageView.vue";
import ChatModeMenu from "./ChatModeMenu.vue";
import ChatProviderMenu from "./ChatProviderMenu.vue";
import ChatTabs from "./ChatTabs.vue";
import ChatTabsMobile from "./ChatTabsMobile.vue";
import ProgressRing from "./ProgressRing.vue";
import ProviderLogo from "./ProviderLogo.vue";

/* The shared assistant. Presentational only — all state lives in the useChat singleton, so the transcript
 * persists as the user moves between workspace areas. The panel owns the layout (tabs, scroller, composer,
 * resize) and cross-cutting UI state (scroll pinning); the draft and attachments live per-tab on the active
 * conversation. Message rendering, the tab strip, and the account area are their own components. On mobile
 * (the full-screen /chat tab) the tab strip becomes a compact header, the pickers become bottom sheets, the
 * resize handle disappears, and the composer pads itself above the on-screen keyboard. */

const {
    active,
    messages,
    streaming,
    awaitingDecision,
    pendingPlanMessage,
    activeModel,
    contextUsage,
    mode,
    provider,
    account,
    accounts,
    grokModels,
    model,
    effort,
    draft,
    attachments,
    connected,
    setActive,
    send,
    stop,
    decidePlan,
    openConversation,
    openAccountManage,
    newChat: newChatAction,
    closeTab: closeTabAction,
} = useChat();
const layout = useLayout();
const { overlayTarget, poppedOut } = useChatPopout();
const { reachable, denied } = useSandbox();
const { mobile, keyboardInset } = useDevice();

// True while the user is dragging the left-edge handle to resize the panel.
const resizing = ref(false);

// Pill labels — rendered as our own text (not a PrimeVue Select); always a real model name. The option
// catalogs themselves live in chat/catalog.ts, shared with the menu bodies.
const providerName = computed(() => providerLabel(provider.value));
// Grok's list is loaded live from OpenCode's catalog; the others are the static catalog.
const models = computed(() => (provider.value === `grok` ? grokModels.value : modelsFor(provider.value)));
const modelLabelText = computed(() => models.value.find((m) => m.value === model.value)?.label ?? model.value);
const efforts = computed(() => effortsFor(provider.value));

// The mobile pickers: pill taps open bottom sheets instead of anchored popovers.
const modelSheetOpen = ref(false);
const modeSheetOpen = ref(false);

// True while the transcript is scrolled near its bottom; gates auto-follow so streaming tokens don't yank the
// user back down when they've scrolled up to read.
const atBottom = ref(true);

const scroller = ref<HTMLElement>();
const input = ref<HTMLTextAreaElement>();
const providerModel = ref<InstanceType<typeof Popover> | null>(null);
const modeMenu = ref<InstanceType<typeof Popover> | null>(null);

const activeError = computed(() => active.value.error.value);

// The active conversation's account when its stored credential can no longer be refreshed — surfaced as a
// pre-send banner so the user reconnects before hitting an opaque failure mid-turn (Codex today).
const activeAccountReauth = computed(() => {
    const id = account.value ?? accounts.value[0]?.id;
    return accounts.value.find((entry) => entry.id === id && entry.needsReauth === true);
});

// Compact "142k" style token count for the context tooltip.
const formatTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// Claude subscription usage (5-hour / weekly window) for the active conversation's account, pushed from the
// agent stream at no token cost — a small ring once that account's first Claude turn reports utilization,
// tinted on the warning/rejected states. Keyed by account so switching accounts shows the right window.
const usageRing = computed(() => {
    const info = usageStatusFor(active.value.account.value);
    if (info === undefined || info.utilization === undefined) {
        return undefined;
    }
    const rounded = Math.round(info.utilization);
    const reset = info.resetsAt !== undefined ? `resets ${formatReset(info.resetsAt)}` : undefined;
    return {
        value: info.utilization,
        label: `${rounded}%`,
        warn: info.status !== `allowed`,
        tooltip: [usageWindowLabel(info.rateLimitType), `${rounded}%`, reset].filter((part) => part !== undefined).join(` · `),
    };
});

// Per-conversation context-window fill — a ring that warns as the chat approaches auto-compaction.
const contextRing = computed(() => {
    const usage = contextUsage.value;
    if (usage === undefined || usage.contextWindow <= 0) {
        return undefined;
    }
    const pct = Math.min(100, Math.round((usage.tokens / usage.contextWindow) * 100));
    return {
        value: pct,
        label: `${pct}%`,
        warn: pct >= 80,
        tooltip: `Context · ${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} (${pct}%)`,
    };
});

// The model popup is anchored to the composer pill, which lives behind `v-if="connected"`. Switching to a
// disconnected provider unmounts that anchor while the popup is still open, stranding it in the top-left
// corner — close it when the composer goes away.
watch(connected, (isConnected) => {
    if (!isConnected) providerModel.value?.hide();
});

// True for the assistant turn currently being streamed (the last message while streaming).
const isStreaming = (message: ChatMessage): boolean => {
    const list = messages.value;
    return streaming.value && list[list.length - 1]?.id === message.id;
};

// Track whether the transcript is parked near its bottom (within ~80px), so the auto-follow watcher only snaps
// down when the user hasn't scrolled up to read.
const onScroll = (): void => {
    const el = scroller.value;
    if (el) {
        atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }
};

// --- Composer --------------------------------------------------------------------------------
const effortIndex = computed(() => efforts.value.findIndex((e) => e.value === effort.value));
const effortLabel = computed(() => efforts.value.find((e) => e.value === effort.value)?.label ?? effort.value);
const effortFill = (i: number) => {
    const top = Math.max(1, efforts.value.length - 1);
    const pct = 50 + (i / top) * 45; // Low ≈ 50% brand → top level ≈ 95% brand
    return `color-mix(in oklab, var(--color-primary-500) ${pct}%, transparent)`;
};
const modeLabel = computed(() => MODES.find((m) => m.value === mode.value)?.label ?? mode.value);
const modeIcon = computed(() => MODES.find((m) => m.value === mode.value)?.icon ?? `sliders-h`);
const modeDescription = computed(() => MODES.find((m) => m.value === mode.value)?.description ?? ``);

// Manual textarea auto-grow: reset to one line, then size to content up to the max-height.
const grow = (): void => {
    const el = input.value;
    if (!el) {
        return;
    }
    el.style.height = `auto`;
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
};

// Browser-native voice input: while listening, the running transcript is appended to whatever was already in
// the draft when the mic was toggled on (base), so interim results replace rather than stack.
const { supported: speechSupported, listening, error: speechError, start: startSpeech, stop: stopSpeech } = useSpeechInput();
const toggleSpeech = (): void => {
    if (listening.value) {
        stopSpeech();
        return;
    }
    const base = draft.value;
    startSpeech((transcript) => {
        draft.value = base.length > 0 ? `${base} ${transcript}` : transcript;
        void nextTick(() => {
            grow();
            input.value?.focus();
        });
    });
};

// Web Speech failure codes → a human message. `aborted` (user stopped) and `no-speech` (heard nothing) are
// benign, so they show nothing. `network` is the Brave / de-Googled-Chromium case: those builds ship no Google
// speech key, so the native recognizer can't transcribe — only Chrome/Edge (or a backend STT path) will.
const speechErrorMessage = computed(() => {
    switch (speechError.value) {
        case undefined:
        case `aborted`:
        case `no-speech`:
            return undefined;
        case `not-allowed`:
        case `service-not-allowed`:
            return `Microphone access is blocked. Allow it in your browser's site settings, then try again.`;
        case `audio-capture`:
            return `No microphone was found.`;
        case `network`:
            return `This browser doesn't support voice dictation. Use Chrome or Edge.`;
        default:
            return `Dictation failed (${speechError.value}).`;
    }
});

// --- Attachments ------------------------------------------------------------------------------
// Files staged for the next turn, per-tab like the draft (`attachments` forwards to the active conversation).
// ponytail: abandoned drafts orphan their uploads in .intentic/attachments (visible/deletable in the
// workspace tree); a daemon-side sweep of stale dirs is the upgrade path if they pile up.

const attach = (file: File): void => {
    const controller = new AbortController();
    // reactive() explicitly: entries are mutated through this reference (progress ticks), not via the
    // array ref's proxy, so the raw object wouldn't trigger updates. The entry lands on the tab active at
    // attach time and this closure keeps pointing at it, so a mid-upload tab switch updates the right chip.
    const entry = reactive<PendingAttachment>({
        id: crypto.randomUUID(),
        name: file.name,
        path: `.intentic/attachments/${crypto.randomUUID()}/${file.name}`,
        controller,
        status: `uploading`,
        progress: 0,
        ...(file.type.startsWith(`image/`) ? { previewUrl: URL.createObjectURL(file) } : {}),
    });
    attachments.value = [...attachments.value, entry];
    sandboxUpload(`/workspace/upload?path=${encodeURIComponent(entry.path)}`, file, {
        signal: controller.signal,
        onProgress: (loaded) => {
            entry.progress = file.size > 0 ? loaded / file.size : 1;
        },
    }).then(
        () => {
            entry.status = `done`;
        },
        (err: unknown) => {
            entry.status = `failed`;
            entry.error = err instanceof Error ? err.message : `Upload failed.`;
        },
    );
};

const removeAttachment = (attachment: PendingAttachment): void => {
    attachment.controller?.abort();
    if (attachment.previewUrl !== undefined) {
        URL.revokeObjectURL(attachment.previewUrl);
    }
    if (attachment.status === `done`) {
        // Fire-and-forget: drop the uploaded uuid dir; on failure the orphan stays visible in the
        // workspace tree, deletable there.
        const dir = attachment.path.slice(0, attachment.path.lastIndexOf(`/`));
        sandboxJson(`/workspace/entry`, {
            method: `DELETE`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ path: dir }),
        }).catch(() => undefined);
    }
    attachments.value = attachments.value.filter((entry) => entry.id !== attachment.id);
};

const onPaste = (event: ClipboardEvent): void => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) {
        return;
    }
    event.preventDefault();
    for (const file of files) {
        attach(file);
    }
};

// Depth counter (enter/leave fire per descendant) drives the drop ring on the whole panel.
const dragDepth = ref(0);
const onDragEnter = (event: DragEvent): void => {
    if (!connected.value || !event.dataTransfer?.types.includes(`Files`)) {
        return;
    }
    dragDepth.value += 1;
};
const onDragLeave = (): void => {
    dragDepth.value = Math.max(0, dragDepth.value - 1);
};
const onDrop = (event: DragEvent): void => {
    dragDepth.value = 0;
    if (!connected.value || !event.dataTransfer) {
        return;
    }
    // collectDroppedFiles must be called synchronously in the drop handler (drag-store validity window).
    // A dropped folder is walked but attached flat — chat attachments carry no directory structure.
    void collectDroppedFiles(event.dataTransfer).then(({ files }) => {
        for (const dropped of files) {
            attach(dropped.file);
        }
    });
};

// The composer Send is usable when there's text or a finished attachment and either nothing is streaming or
// a plan is pending (typed text becomes plan feedback). Blocked while a turn is mid-generation, while a
// question card is the input, and while any attachment is still uploading (or failed — remove it to proceed).
const canSend = computed(() => {
    if (attachments.value.some((entry) => entry.status !== `done`)) {
        return false;
    }
    if (pendingPlanMessage.value) {
        // Plan feedback is text-only; staged attachments wait for the next real turn.
        return draft.value.trim().length > 0;
    }
    if (draft.value.trim().length === 0 && attachments.value.length === 0) {
        return false;
    }
    return !streaming.value;
});
const sendHint = computed(() => (pendingPlanMessage.value ? `Send as feedback (keep planning)` : `Send`));
// While a plan awaits a decision, typing revises it (reject-with-feedback), so the placeholder says so.
const composerPlaceholder = computed(() => (pendingPlanMessage.value ? `Reply to revise the plan…` : `Ask ${providerName.value}…`));

const submit = (): void => {
    // canSend covers all the gates: mid-generation, empty composer, uploads still in flight.
    if (!connected.value || !canSend.value) {
        return;
    }
    const text = draft.value.trim();
    const pendingPlan = pendingPlanMessage.value;
    if (pendingPlan) {
        // Typing while a plan is pending rejects it with that text as feedback (Claude Code style).
        void decidePlan(pendingPlan, false, text);
    } else {
        // Snapshot the chips onto the turn, then clear WITHOUT revoking preview URLs — the thumbnails
        // now live on the sent user bubble.
        void send(
            text,
            attachments.value.map(({ name, path, previewUrl }): ChatAttachment => ({
                name,
                path,
                ...(previewUrl !== undefined ? { previewUrl } : {}),
            })),
        );
        attachments.value = [];
    }
    draft.value = ``;
    // Snap the box back to one line and keep the cursor ready for the next message.
    void nextTick(() => {
        grow();
        input.value?.focus();
    });
};

const onKeydown = (event: KeyboardEvent): void => {
    // Never submit mid-IME-composition (CJK candidates confirm with Enter).
    if (event.isComposing) {
        return;
    }
    if (event.key !== `Enter`) {
        return;
    }
    // On mobile Enter is a newline (the send button submits) — the virtual keyboard has no Shift+Enter.
    if (mobile.value) {
        return;
    }
    // Enter (or Cmd/Ctrl+Enter) sends; Shift+Enter inserts a newline.
    if (!event.shiftKey || event.metaKey || event.ctrlKey) {
        event.preventDefault();
        submit();
    }
};

// --- Tabs / history --------------------------------------------------------------------------
const newChat = (): void => {
    newChatAction();
    atBottom.value = true;
    void nextTick(() => {
        grow();
        input.value?.focus();
    });
};

// Switch the active tab and re-pin to the bottom (atBottom is shared across tabs).
const selectTab = (id: string): void => {
    setActive(id);
    atBottom.value = true;
};

const closeTab = (id: string): void => {
    closeTabAction(id);
    atBottom.value = true;
};

// Open a past conversation from the history menu into a tab, pinned to the bottom.
const openFromHistory = (id: string): void => {
    atBottom.value = true;
    void openConversation(id);
};

// --- Resize ----------------------------------------------------------------------------------
// Left-edge resize: pointer capture routes move/up to the handle even past its bounds. The chat is the
// rightmost column flush to the viewport's right edge, so its width is the distance from the pointer to it.
const startResize = (event: PointerEvent): void => {
    event.preventDefault();
    resizing.value = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
};
const onResize = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    layout.setChatWidth(globalThis.innerWidth - event.clientX);
};
const endResize = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    resizing.value = false;
    const target = event.target as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
    }
};

// --- Lifecycle / effects ---------------------------------------------------------------------
// Keep the newest tokens in view as the transcript grows — but only while the user is already at the bottom,
// so scrolling up to read isn't fought by streaming tokens.
watch(
    messages,
    () => {
        if (!atBottom.value) {
            return;
        }
        void nextTick(() => {
            const element = scroller.value;
            if (element) {
                element.scrollTop = element.scrollHeight;
            }
        });
    },
    { deep: true },
);

// A tab switch swaps a possibly multi-line draft under the textarea — re-size it to the new content.
watch(
    () => active.value.id,
    () => void nextTick(grow),
);

// Drop focus into the composer as soon as the account connects; grow sizes the box to a restored draft (the
// textarea mounts with the persisted text already in it). Not on mobile — autofocus there pops the keyboard
// over half the transcript before the user asked for it.
watch(
    connected,
    (isConnected) => {
        if (isConnected) {
            void nextTick(() => {
                grow();
                if (!mobile.value) {
                    input.value?.focus();
                }
            });
        }
    },
    { immediate: true },
);

// The keyboard opening shrinks the transcript from the bottom — keep it pinned there if it already was.
watch(keyboardInset, () => {
    if (!atBottom.value) {
        return;
    }
    void nextTick(() => {
        const element = scroller.value;
        if (element) {
            element.scrollTop = element.scrollHeight;
        }
    });
});
</script>

<template>
    <div
        class="chat-panel relative flex h-full min-h-0 flex-col overflow-hidden bg-card"
        :class="{ 'is-resizing': resizing }"
        @dragenter="onDragEnter"
        @dragover.prevent
        @dragleave="onDragLeave"
        @drop.prevent.stop="onDrop"
    >
        <div
            v-if="dragDepth > 0"
            class="pointer-events-none absolute inset-1 z-30 rounded-xl border-2 border-dashed border-primary-500 bg-primary-500/10"
        ></div>
        <div
            v-if="!poppedOut && !mobile"
            class="resize-handle"
            @pointerdown="startResize"
            @pointermove="onResize"
            @pointerup="endResize"
            @dblclick="layout.resetChatWidth()"
            title="Drag to resize · double-click to reset"
        ></div>

        <ChatTabsMobile v-if="mobile" @select="selectTab" @close="closeTab" @new="newChat" @open="openFromHistory" />
        <ChatTabs v-else @select="selectTab" @close="closeTab" @new="newChat" @open="openFromHistory" />

        <div ref="scroller" class="scrollbar-thin flex flex-1 flex-col gap-4 overflow-auto p-4" @scroll="onScroll">
            <template v-if="messages.length > 0">
                <ChatMessageView v-for="message in messages" :key="message.id" :message="message" :streaming="isStreaming(message)" />
            </template>
            <p v-else class="m-auto max-w-[80%] text-center text-sm text-muted">Start a conversation with {{ providerName }}.</p>
            <p v-if="activeError" class="text-sm text-danger">{{ activeError }}</p>
        </div>

        <!-- The whole footer (account connect + composer) talks to the daemon, so it yields to a hint while the
             sandbox is unreachable. The transcript above stays readable. On mobile the footer pads itself above
             the on-screen keyboard (iOS Safari only shrinks the visual viewport, not the layout). -->
        <div class="flex flex-col gap-2 p-3" :style="mobile && keyboardInset > 0 ? { paddingBottom: `${keyboardInset + 12}px` } : undefined">
            <p v-if="!reachable" class="px-1 text-2xs text-subtle">
                {{
                    denied
                        ? `Chat is unavailable — this Google account has no access to this sandbox.`
                        : `Chat is available once your sandbox is connected.`
                }}
            </p>
            <template v-else>
                <ChatAccountPanel />
                <!-- Proactive re-auth prompt: the account is connected (a credential exists) but can no longer be
                     refreshed, so surface it here — before a send fails opaquely — with a jump to reconnect. -->
                <button
                    v-if="activeAccountReauth"
                    type="button"
                    class="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-left text-2xs text-warning"
                    @click="openAccountManage"
                >
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0" />
                    <span
                        >{{ activeAccountReauth.detail ?? `This account needs to be reconnected.` }}
                        <span class="font-semibold underline">Reconnect</span></span
                    >
                </button>
                <template v-if="connected">
                    <form
                        class="flex flex-col rounded-2xl border border-line-strong bg-overlay shadow-lg transition-colors focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/25"
                        @submit.prevent="submit"
                    >
                        <div v-if="attachments.length > 0" class="flex flex-wrap gap-2 px-3 pt-3">
                            <div
                                v-for="a in attachments"
                                :key="a.id"
                                class="relative flex items-center gap-2 overflow-hidden rounded-lg border py-1.5 pl-2 pr-1 text-xs"
                                :class="a.status === 'failed' ? 'border-danger' : 'border-line bg-card'"
                                v-tooltip.top="a.error ?? a.name"
                            >
                                <img v-if="a.previewUrl" :src="a.previewUrl" class="h-9 w-9 rounded object-cover" alt="" />
                                <Icon name="file" v-else class="text-sm text-subtle" />
                                <span class="max-w-36 truncate text-content">{{ a.name }}</span>
                                <button
                                    type="button"
                                    class="composer-ghost h-5 w-5 shrink-0"
                                    @click="removeAttachment(a)"
                                    aria-label="Remove attachment"
                                >
                                    <Icon name="times" class="text-2xs" />
                                </button>
                                <div
                                    v-if="a.status === 'uploading'"
                                    class="absolute inset-x-0 bottom-0 h-0.5 bg-primary-500"
                                    :style="{ width: `${Math.round(a.progress * 100)}%` }"
                                ></div>
                            </div>
                        </div>
                        <!-- text-base below md: 16px is the iOS threshold under which focusing zooms the page. -->
                        <textarea
                            ref="input"
                            rows="1"
                            v-model="draft"
                            name="draft"
                            :placeholder="composerPlaceholder"
                            class="scrollbar-thin block max-h-48 w-full resize-none overflow-y-auto bg-transparent px-4 py-3 text-base leading-6 text-content placeholder:text-subtle focus:outline-none md:text-sm"
                            @input="grow"
                            @keydown="onKeydown"
                            @paste="onPaste"
                        ></textarea>

                        <div class="flex items-center gap-1 px-2.5 pb-2.5">
                            <button
                                type="button"
                                class="composer-ghost h-8 gap-1.5 px-2.5 text-xs font-medium max-md:h-11"
                                @click="mobile ? (modelSheetOpen = true) : providerModel?.toggle($event)"
                                v-tooltip.top="activeModel ?? `${providerName} · ${modelLabelText}`"
                                aria-label="Provider and model"
                            >
                                <ProviderLogo :provider="provider" class="text-2xs text-link" />
                                <span>{{ modelLabelText }}</span>
                                <Icon name="chevron-down" class="text-2xs text-subtle" />
                            </button>

                            <div class="flex items-center gap-1.5" role="group" aria-label="Reasoning effort">
                                <div class="flex items-center gap-0.5">
                                    <button
                                        v-for="(e, i) in efforts"
                                        :key="e.value"
                                        type="button"
                                        class="composer-effort-seg"
                                        :style="i <= effortIndex ? { background: effortFill(i) } : undefined"
                                        @click="effort = e.value"
                                        :aria-label="e.label"
                                        :aria-pressed="effort === e.value"
                                    ></button>
                                </div>
                                <span class="text-2xs text-subtle">{{ effortLabel }}</span>
                            </div>

                            <button
                                type="button"
                                class="composer-ghost ml-auto h-8 gap-1.5 px-2.5 text-xs font-medium max-md:h-11"
                                @click="mobile ? (modeSheetOpen = true) : modeMenu?.toggle($event)"
                                v-tooltip.top="modeDescription"
                                aria-label="Agent mode"
                            >
                                <Icon :name="modeIcon" class="text-2xs text-link" />
                                <span>{{ modeLabel }}</span>
                                <Icon name="chevron-down" class="text-2xs text-subtle" />
                            </button>

                            <button
                                v-if="speechSupported"
                                type="button"
                                class="composer-ghost h-8 w-8 max-md:h-11 max-md:w-11"
                                :class="{ 'composer-active': listening }"
                                @click="toggleSpeech"
                                v-tooltip.top="listening ? 'Stop dictation' : 'Dictate'"
                                :aria-pressed="listening"
                                aria-label="Dictate"
                            >
                                <Icon name="microphone" class="text-sm max-md:text-base" />
                            </button>

                            <button
                                v-if="streaming && !awaitingDecision"
                                type="button"
                                class="composer-send composer-stop"
                                @click="stop"
                                v-tooltip.top="'Stop generating'"
                                aria-label="Stop generating"
                            >
                                <Icon name="stop" class="text-sm" />
                            </button>
                            <button v-else type="submit" class="composer-send" :disabled="!canSend" v-tooltip.top="sendHint" aria-label="Send">
                                <Icon name="send" class="text-sm" />
                            </button>
                        </div>
                    </form>

                    <p v-if="speechErrorMessage" class="px-1 text-2xs text-danger">{{ speechErrorMessage }}</p>

                    <div class="flex items-center gap-2 px-1 text-2xs text-subtle">
                        <!-- Keyboard hint is meaningless on a virtual keyboard (Enter is a newline there). -->
                        <span class="hidden md:inline">Shift+Enter for new line</span>
                        <div class="ml-auto flex items-center gap-3">
                            <span v-if="contextRing" class="inline-flex items-center gap-1" v-tooltip.top="contextRing.tooltip">
                                <ProgressRing :value="contextRing.value" :class="contextRing.warn ? 'text-warning' : 'text-primary-500'" />
                                <span>{{ contextRing.label }}</span>
                            </span>
                            <span v-if="usageRing" class="inline-flex items-center gap-1" v-tooltip.top="usageRing.tooltip">
                                <ProgressRing :value="usageRing.value" :class="usageRing.warn ? 'text-warning' : 'text-primary-500'" />
                                <span>{{ usageRing.label }}</span>
                            </span>
                            <button
                                type="button"
                                class="inline-flex items-center gap-1 transition-colors hover:text-content"
                                @click="openAccountManage"
                            >
                                <span class="inline-block h-1.5 w-1.5 rounded-full bg-success"></span> Ready · Manage
                            </button>
                        </div>
                    </div>
                </template>
            </template>
        </div>

        <!-- The pickers: anchored popovers on desktop, bottom sheets on mobile — same menu bodies. -->
        <template v-if="mobile">
            <BottomSheet v-model="modelSheetOpen" header="Provider & model">
                <ChatProviderMenu />
            </BottomSheet>
            <BottomSheet v-model="modeSheetOpen" header="Agent mode">
                <ChatModeMenu @selected="modeSheetOpen = false" />
            </BottomSheet>
        </template>
        <template v-else>
            <Popover ref="providerModel" :append-to="overlayTarget" :pt="{ content: { class: 'composer-pop-content' } }">
                <div class="w-56">
                    <ChatProviderMenu />
                </div>
            </Popover>
            <Popover ref="modeMenu" :append-to="overlayTarget" :pt="{ content: { class: 'composer-pop-content' } }">
                <div class="w-56">
                    <ChatModeMenu @selected="modeMenu?.hide()" />
                </div>
            </Popover>
        </template>
    </div>
</template>

<!-- Unscoped on purpose: .chat-markdown targets v-html-injected prose, and the rest are class names shared
     across the chat components (tabs, message view, account panel), so they live once here at the panel root. -->
<style>
.chat-surface {
    background: color-mix(in srgb, var(--color-overlay) 55%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-primary-500) 22%, var(--color-line));
}
.chat-surface-assistant {
    background: color-mix(in srgb, var(--color-overlay) 35%, transparent);
    border: 1px solid var(--color-line);
}
.chat-markdown {
    font-size: 0.8125rem;
    line-height: 1.6;
}
.chat-markdown > :first-child {
    margin-top: 0;
}
.chat-markdown > :last-child {
    margin-bottom: 0;
}
.chat-markdown p {
    margin: 0.6rem 0;
}
.chat-markdown h1,
.chat-markdown h2,
.chat-markdown h3,
.chat-markdown h4 {
    margin: 1.1rem 0 0.5rem;
    font-weight: 600;
    line-height: 1.3;
}
.chat-markdown h1 {
    font-size: 1.2rem;
}
.chat-markdown h2 {
    font-size: 1.1rem;
}
.chat-markdown h3 {
    font-size: 1.02rem;
}
.chat-markdown h4 {
    font-size: 0.95rem;
}
.chat-markdown ul,
.chat-markdown ol {
    margin: 0.6rem 0;
    padding-left: 1.35rem;
}
.chat-markdown li {
    margin: 0.25rem 0;
}
.chat-markdown li > ul,
.chat-markdown li > ol {
    margin: 0.25rem 0;
}
.chat-markdown strong {
    font-weight: 600;
}
.chat-markdown blockquote {
    margin: 0.6rem 0;
    padding: 0.1rem 0 0.1rem 0.85rem;
    border-left: 3px solid var(--color-line-strong);
    color: var(--color-muted);
}
.chat-markdown hr {
    margin: 1rem 0;
    border: 0;
    border-top: 1px solid var(--color-line);
}
.chat-markdown pre {
    margin: 0.7rem 0;
    overflow-x: auto;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    background: var(--color-canvas);
    padding: 0.8rem;
}
.chat-markdown pre code {
    background: transparent;
    padding: 0;
    font-size: 0.8125rem;
}
.chat-markdown code {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.85em;
    background: color-mix(in srgb, var(--color-content) 9%, transparent);
    padding: 0.1em 0.34em;
    border-radius: var(--radius-xs);
}
.chat-markdown a {
    color: var(--color-link);
    text-decoration: none;
}
.chat-markdown a:hover {
    text-decoration: underline;
}
.chat-markdown table {
    width: 100%;
    margin: 0.7rem 0;
    border-collapse: collapse;
    font-size: 0.875rem;
}
.chat-markdown th,
.chat-markdown td {
    padding: 0.4rem 0.6rem;
    text-align: left;
    border-bottom: 1px solid var(--color-line);
}
.chat-markdown th {
    font-weight: 600;
    color: var(--color-content);
}
.chat-markdown-compact h1,
.chat-markdown-compact h2,
.chat-markdown-compact h3,
.chat-markdown-compact h4 {
    font-size: 0.875rem;
    margin: 0.7rem 0 0.35rem;
}
.chat-markdown-compact p {
    margin: 0.45rem 0;
}
.plan-approve,
.plan-reject {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    height: 2.25rem;
    padding: 0 1rem;
    border-radius: var(--radius-md);
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    transition:
        background-color 0.15s,
        color 0.15s,
        border-color 0.15s;
}
.plan-approve {
    background: var(--color-primary-700);
    color: var(--color-surface-0);
    border: 1px solid transparent;
}
.plan-approve:hover {
    background: var(--color-primary-600);
}
.plan-reject {
    background: transparent;
    color: var(--color-content);
    border: 1px solid var(--color-line-strong);
}
.plan-reject:hover {
    background: color-mix(in srgb, var(--color-content) 8%, transparent);
    border-color: var(--color-content);
}
.chat-tab {
    color: var(--color-muted);
    cursor: pointer;
    border: 1px solid transparent;
    transition:
        background-color 0.15s,
        color 0.15s,
        border-color 0.15s;
}
.chat-tab:hover {
    background: color-mix(in srgb, var(--color-content) 6%, transparent);
    color: var(--color-content);
}
.chat-tab-on {
    background: color-mix(in srgb, var(--color-overlay) 70%, transparent);
    color: var(--color-content);
    border-color: var(--color-line);
}
.qopt {
    cursor: pointer;
}
.qopt:hover {
    background: color-mix(in srgb, var(--color-content) 5%, transparent);
}
.qopt-on {
    background: color-mix(in srgb, var(--color-primary-500) 14%, transparent);
}
.p-popover-content.composer-pop-content {
    padding: 0.25rem;
}
.qopt-on:hover {
    background: color-mix(in srgb, var(--color-primary-500) 18%, transparent);
}
.composer-ghost {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-lg);
    color: var(--color-muted);
    cursor: pointer;
    transition:
        background-color 0.15s,
        color 0.15s;
}
.composer-ghost:hover {
    background: color-mix(in srgb, var(--color-content) 8%, transparent);
    color: var(--color-content);
}
.composer-active {
    background: color-mix(in srgb, var(--color-primary-500) 16%, transparent);
    color: var(--color-primary-500);
}
.composer-active:hover {
    background: color-mix(in srgb, var(--color-primary-500) 24%, transparent);
    color: var(--color-primary-500);
}
.composer-effort-seg {
    height: 0.75rem;
    width: 0.25rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    background: color-mix(in srgb, var(--color-content) 10%, transparent);
    transition:
        background-color 0.15s,
        filter 0.15s;
}
.composer-effort-seg:hover {
    background: color-mix(in srgb, var(--color-content) 22%, transparent); /* unlit hover */
    filter: brightness(1.15); /* lit-bar hover feedback (inline bg wins over class bg) */
}
.composer-send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 2rem;
    width: 2rem;
    border-radius: 9999px;
    background: var(--color-primary-700);
    color: var(--color-surface-0);
    cursor: pointer;
    transition:
        background-color 0.15s,
        opacity 0.15s;
}
.composer-send:hover {
    background: var(--color-primary-600);
}
.composer-send:disabled {
    background: var(--color-overlay);
    color: var(--color-subtle);
    cursor: default;
}
.composer-stop {
    background: var(--color-overlay);
    color: var(--color-content);
}
.composer-stop:hover {
    background: color-mix(in srgb, var(--color-content) 12%, var(--color-overlay));
}
.resize-handle {
    position: absolute;
    inset: 0 auto 0 0;
    width: 6px;
    cursor: col-resize;
    z-index: 20;
    touch-action: none;
    transition: background-color 0.15s;
}
.resize-handle:hover,
.chat-panel.is-resizing .resize-handle {
    background: color-mix(in srgb, var(--color-primary-500) 35%, transparent);
}
.chat-panel.is-resizing {
    user-select: none;
}

/* Mobile touch sizing: 44px send/stop and plan-decision targets, chunkier effort segments. The utility
   classes handle the Vue-templated buttons; these cover the fixed-size CSS components (send button, the
   v-html plan buttons rendered by ChatMessageView). */
@media (max-width: 767.98px) {
    .composer-send {
        height: 2.75rem;
        width: 2.75rem;
    }
    .plan-approve,
    .plan-reject {
        height: 2.75rem;
        padding: 0 1.25rem;
    }
    .composer-effort-seg {
        height: 1.1rem;
        width: 0.5rem;
    }
}
</style>
