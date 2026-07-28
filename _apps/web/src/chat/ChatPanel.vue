<script setup lang="ts">
import { BottomSheet, useDevice } from "@intentic-app/ui";
import Popover from "primevue/popover";
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NATIVE_PROVIDERS, type NativeProvider, providerLabel } from "@intentic/sandbox-contract";
import { useAgents } from "../composables/agents/useAgents";
import { effortsFor, MODES } from "../composables/chat/catalog";
import { modelLabelFor, type PendingAttachment } from "../composables/chat/conversation";
import { type ChatAttachment, type ChatMessage, turnsOf } from "../composables/chat/transcript";
import { bindingWindow, formatUtilization, isStale, usageDetail, usageStatusFor } from "../composables/chat/usageStatus";
import { errorMessage } from "../composables/useAsyncAction";
import { useChat } from "../composables/chat/useChat";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { useSpeechInput } from "../composables/chat/useSpeechInput";
import { sandboxJson, sandboxUpload } from "../composables/sandbox/sandboxClient";
import { useEditorSelection } from "../composables/workspace/useEditorSelection";
import { useFollowAlong } from "../composables/workspace/useFollowAlong";
import { useWorkspaceTabs } from "../composables/workspace/useWorkspaceTabs";
import { useLayout } from "../composables/useLayout";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { collectDroppedFiles } from "../pages/workspace/dropEntries";
import { inputHistoryFor, recallStep } from "../composables/chat/inputHistory";
import { insertMention, mentionQueryAt } from "../composables/chat/useMentions";
import ChatAccountPanel from "./ChatAccountPanel.vue";
import ChatCommandPopover from "./ChatCommandPopover.vue";
import ChatImageThumb from "./ChatImageThumb.vue";
import ChatMentionPopover from "./ChatMentionPopover.vue";
import ChatMessageView from "./ChatMessageView.vue";
import ChatModelPicker from "./ChatModelPicker.vue";
import ChatModeMenu from "./ChatModeMenu.vue";
import ChatTabs from "./ChatTabs.vue";
import ChatTabsMobile from "./ChatTabsMobile.vue";
import { ProgressRing } from "@intentic-app/ui";
import ProviderLogo from "./ProviderLogo.vue";

/* The shared assistant. Presentational only — all state lives in the useChat singleton, so the transcript
 * persists as the user moves between workspace areas. The panel owns the layout (tabs, scroller, composer,
 * resize) and cross-cutting UI state (scroll pinning); the draft and attachments live per-tab on the active
 * conversation. Message rendering, the tab strip, and the account area are their own components. On mobile
 * (the full-screen /chat tab) the tab strip becomes a compact header, the pickers become bottom sheets, the
 * resize handle disappears, and the composer pads itself above the on-screen keyboard.
 *
 * The panel root is a @container: composer/status label density keys off the panel's own width (it can be
 * 288px while the viewport is desktop-wide — docked column or PiP popout), while touch-target sizing keys
 * off the max-md: device class. Two intentional axes — don't unify them. */

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
    model,
    effort,
    thinking,
    draft,
    attachments,
    connected,
    queued,
    removeQueued,
    steerable,
    setActive,
    send,
    stop,
    decidePlan,
    openConversation,
    composerFocus,
    closeTabs: closeTabsAction,
    availableCommands,
} = useChat();
const router = useRouter();
const layout = useLayout();
const followAlong = useFollowAlong();
const { overlayTarget, poppedOut } = useChatPopout();
const { activeSandboxId, reachable, connection } = useSandbox();
// The daemon refused this Google account outright — a different sentence than "not connected yet", because
// waiting will not fix it.
const denied = computed(() => connection.value.failure?.kind === `forbidden`);
const { mobile, keyboardInset } = useDevice();

// True while the user is dragging the left-edge handle to resize the panel.
const resizing = ref(false);

// Pill labels — rendered as our own text (not a PrimeVue Select); always a real model name. The option
// catalogs live in the contract's agent-catalog.ts (shared with the automations dialog) and chat/catalog.ts.
const providerName = computed(() => providerLabel(provider.value));
// The chip's model name: shared with the picker menu so they can't drift; falls back to the provider name (never
// blank) while Grok's daemon catalog is still loading.
const modelLabelText = computed(() => modelLabelFor(provider.value, model.value));
// An ACP provider owns its own model AND reasoning settings — no effort scale to offer (the segments hide).
const nativeProvider = computed(() => NATIVE_PROVIDERS.includes(provider.value as NativeProvider));
const efforts = computed(() => (nativeProvider.value ? effortsFor(provider.value, model.value, thinking.value) : []));

// The mobile pickers: pill taps open bottom sheets instead of anchored popovers.
const modelSheetOpen = ref(false);
const modeSheetOpen = ref(false);

// True while the transcript is scrolled near its bottom; gates auto-follow so streaming tokens don't yank the
// user back down when they've scrolled up to read.
const atBottom = ref(true);

const scroller = ref<HTMLElement>();
const content = ref<HTMLElement>();
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

/* Archiving an agent does NOT close its chat tab — see the archive note in useAgents for why the quiet,
 * undoable action is the wrong one to hang a tab close off. What it must not do either is leave the tab
 * looking live, so the panel says the agent is off the board and offers the one press back. The line also
 * spends its second half on the fact nothing else here could tell the user: a message sent from this tab
 * un-archives the agent (the daemon rebuilds the entry without its marker — registry.begin), which is a
 * feature, not a surprise to walk into.
 *
 * Archived agents ride their own list rather than the live roster, so it has to be asked for. On the REACHABLE
 * seam, not at setup: this panel mounts with the shell, long before the daemon is answering, and a read fired
 * then simply fails — leaving every archived tab in the app looking live until the user happened to open the
 * board. Only while the list is empty, so the one request is not repeated per reconnect once it has landed. */
const { agentById, archived, loadArchived, restore, busyIds } = useAgents();
watch(
    reachable,
    (live) => {
        if (live && archived.value.length === 0) {
            void loadArchived();
        }
    },
    { immediate: true },
);
const activeArchived = computed(() => {
    const agent = agentById(active.value.conversationId);
    return agent?.archivedAt === undefined ? undefined : agent;
});

// Compact "142k" style token count for the context tooltip.
const formatTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// Claude subscription headroom for the active conversation's account, pushed from the agent stream at no token
// cost — a small ring once that account's first Claude turn reports its limits, tinted as the binding pool
// fills. Keyed by account so switching accounts shows the right one. The ring tracks the FULLEST pool (the one
// that will gate the next turn); the tooltip lists them all, because which one is binding shifts between turns.
const usageRing = computed(() => {
    const info = usageStatusFor(active.value.account.value);
    const window = bindingWindow(info);
    if (info === undefined || window === undefined) {
        return undefined;
    }
    const rounded = Math.round(window.utilization);
    return {
        value: window.utilization,
        label: formatUtilization(rounded, isStale(info)),
        warn: rounded >= 75,
        tooltip: usageDetail(info),
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

// True for the assistant turn currently being streamed: the last assistant bubble while streaming. Not
// simply the last message — a steered user message (and trailing notices) land below the bubble the turn
// is still writing into.
const isStreaming = (message: ChatMessage): boolean =>
    streaming.value && message.role === `assistant` && messages.value.findLast((entry) => entry.role === `assistant`)?.id === message.id;

// The transcript as prompt-headed groups. Each group is the box its own prompt is sticky WITHIN (see
// .chat-prompt), which is what ends the pin where the answer ends — rendered flat, every prompt would pin to
// the same top edge and pile up on the one before it. Recomputed per streamed frame like the list it replaces,
// and just as shallow: one pass, no message read beyond its role.
const turns = computed(() => turnsOf(messages.value));

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
            entry.error = errorMessage(err, `Upload failed.`);
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

// --- Editor context chip ---------------------------------------------------------------------
// What the chip would attach: the live Monaco selection, else the active file tab. OFF by default — the user
// clicks the chip to attach it to the next message (the inverse of VSCode Claude Code's always-on injection).
//
// Gated on the Workspace being the area on screen. The chip's whole claim is "the file you are LOOKING AT",
// and it reads two singletons (useWorkspaceTabs, useEditorSelection) that outlive the Workspace view — while
// this panel is docked in the persistent shell (ShellDesktop) beside whatever area is open. Off /workspace
// there is nothing the user is looking at, so "this file" has no referent and the chip is a stale nag for a
// file they left behind (worse in /agents, where the turn runs in the agent's worktree, not the /work tree
// the tab came from). Route-gated rather than dismissible: it is self-correcting — walk back into the
// Workspace and the chip returns, with nothing to undo.
const route = useRoute();
const workspaceTabs = useWorkspaceTabs();
const editorSelection = useEditorSelection();
const editorTarget = computed<{ file: string; startLine?: number; endLine?: number; selection?: string } | undefined>(() => {
    if (route.name !== `workspace`) {
        return undefined;
    }
    const selection = editorSelection.selection.value;
    if (selection !== undefined) {
        return { file: selection.path, startLine: selection.startLine, endLine: selection.endLine, selection: selection.text };
    }
    const tab = workspaceTabs.activeTab.value;
    return tab?.kind === `file` ? { file: tab.path } : undefined;
});
const includeEditorContext = ref(false);
// Attaching is an explicit per-file choice — a different file in the editor resets the opt-in, as does
// leaving the Workspace (the target goes undefined with the chip, so an opt-in can't outlive the chip that
// explained it and ride along invisibly into a later message).
watch(
    () => editorTarget.value?.file,
    () => {
        includeEditorContext.value = false;
    },
);
const editorChipLabel = computed(() => {
    const target = editorTarget.value;
    if (target === undefined) {
        return ``;
    }
    const name = target.file.split(`/`).pop() ?? target.file;
    return target.startLine !== undefined ? `${name}:${target.startLine}-${target.endLine}` : name;
});
// The composer Send is usable whenever there is something to send — text, a finished attachment, or a queued
// message waiting to go out — regardless of what the conversation is doing: a message written mid-turn is
// never refused, it is delivered into the running turn or queued behind it (see Conversation.enqueue). The
// two blocks left are an attachment still uploading (or failed — remove it to proceed) and a pending plan,
// whose card takes typed text as revision feedback rather than as a message.
const canSend = computed(() => {
    if (attachments.value.some((entry) => entry.status !== `done`)) {
        return false;
    }
    if (pendingPlanMessage.value) {
        // Plan feedback is text-only; staged attachments wait for the next real turn.
        return draft.value.trim().length > 0;
    }
    return draft.value.trim().length > 0 || attachments.value.length > 0 || (queued.value.length > 0 && !streaming.value);
});
const sendHint = computed(() => {
    if (pendingPlanMessage.value) {
        return `Send as feedback (keep planning)`;
    }
    if (!streaming.value) {
        return `Send`;
    }
    // Mid-turn the message either reaches the running turn or waits for it — say which, so a Send that looks
    // identical in both cases doesn't quietly mean two different things.
    if (awaitingDecision.value) {
        return `Queue for after the request above`;
    }
    return steerable.value ? `Send to the running turn` : `Queue for when this turn ends`;
});
// Stop is offered for every live turn, including one parked on a card — that state is the most common reason to
// want out (a permission the user won't grant, a plan they'd rather restate from scratch), and until now the
// card's own buttons were the only way forward. Name the consequence there: the parked request goes with it.
const stopLabel = computed(() => (awaitingDecision.value ? `Stop the turn` : `Stop generating`));
const stopHint = computed(() =>
    awaitingDecision.value ? `Stop the turn — discards the request above` : mobile.value ? stopLabel.value : `${stopLabel.value} (Esc)`,
);
// While a plan awaits a decision, typing revises it (reject-with-feedback); while a turn runs, typing either
// steers it or queues behind it — the placeholder says which.
const composerPlaceholder = computed(() => {
    if (pendingPlanMessage.value) {
        return `Reply to revise the plan…`;
    }
    if (!streaming.value) {
        return `Ask ${providerName.value}…`;
    }
    if (awaitingDecision.value) {
        return `Answer above, or add a message for after…`;
    }
    return steerable.value ? `Steer ${providerName.value} mid-turn…` : `Add a message for when this turn ends…`;
});

// The one line under the queued stack: what will actually happen to those messages. A turn that can take
// mid-turn input has already been offered them (they are only sitting here because it is parked on a card),
// so the wait is the card; an unsteerable turn ends first; with nothing running the queue rides the next send.
const queuedHint = computed(() => {
    if (!streaming.value) {
        return `Sends with your next message`;
    }
    return awaitingDecision.value ? `Sends once you answer the request above` : `Sends when this turn ends`;
});

// The sandbox's message-recall ring (↑ / ↓ / Escape in the composer — see the Message recall section below).
// Resolved per active sandbox rather than held, so switching sandboxes switches rings.
const history = computed(() => (activeSandboxId.value === undefined ? undefined : inputHistoryFor(activeSandboxId.value)));

// A tab or sandbox switch swaps the composer's draft out from under a half-finished recall — drop it on both
// the outgoing and incoming ring so ↓/Escape can never paste one tab's draft into another's composer.
watch([active, history], (_current, [, previousHistory]) => {
    previousHistory?.reset();
    history.value?.reset();
});

// The one hint slot under the composer. An empty box can't take a newline but CAN take a recall, so it
// advertises whichever of the two is live. Recomputed as the draft empties — which is exactly when a send has
// just filled the ring.
const composerHint = computed(() => {
    // While the agent is generating, the shortcut worth the slot is the way out of it — the same slot is how
    // the user learns Escape does this at all.
    if (streaming.value && !awaitingDecision.value) {
        return `Esc to stop`;
    }
    return draft.value === `` && history.value?.recallable === true ? `↑ for previous message` : `Shift+Enter for new line`;
});

const submit = (): void => {
    // canSend covers the gates that are left: empty composer, uploads still in flight, an empty plan reply.
    if (!connected.value || !canSend.value) {
        return;
    }
    const text = draft.value.trim();
    const pendingPlan = pendingPlanMessage.value;
    if (pendingPlan) {
        // Typing while a plan is pending rejects it with that text as feedback (Claude Code style) — the
        // agent stays in plan mode and revises.
        void decidePlan(pendingPlan, false, `plan`, text);
    } else {
        const target = editorTarget.value;
        const editorContext =
            includeEditorContext.value && target !== undefined
                ? {
                      file: target.file,
                      ...(target.selection !== undefined
                          ? { startLine: target.startLine, endLine: target.endLine, selection: target.selection.slice(0, 20_000) }
                          : {}),
                  }
                : undefined;
        // One path whether or not a turn is running — the conversation delivers it into the running turn or
        // queues it (see Conversation.enqueue). Snapshot the chips onto the message, then clear WITHOUT
        // revoking preview URLs — the thumbnails now live on the queued/sent message.
        void send(
            text,
            attachments.value.map(({ name, path, previewUrl }): ChatAttachment => ({
                name,
                path,
                ...(previewUrl !== undefined ? { previewUrl } : {}),
            })),
            editorContext,
        );
        attachments.value = [];
        includeEditorContext.value = false;
    }
    // Both branches send `text` somewhere (a turn, the queue, a plan revision), so both earn a slot in the
    // recall ring — except the bare "flush the queue" press, which contributed no text of its own.
    if (text.length > 0) {
        history.value?.record(text);
    }
    draft.value = ``;
    // Snap the box back to one line and keep the cursor ready for the next message.
    void nextTick(() => {
        grow();
        input.value?.focus();
    });
};

// --- @-mention + /-command popovers -----------------------------------------------------------
// The caret drives which popover is live: an @-token at the caret opens the file picker; a leading `/` with
// the caret still inside the first token opens the provider's command list. Escape dismisses until the token
// changes.
const caret = ref(0);
const syncCaret = (): void => {
    caret.value = input.value?.selectionStart ?? draft.value.length;
};
const onInput = (): void => {
    grow();
    syncCaret();
    // Typing makes the text the user's own again — a recalled message they have started editing is a draft, so
    // the stashed one it displaced is no longer anyone's to restore. Only real keystrokes land here: the
    // programmatic draft writes (recall, mention/command picks) go through v-model and fire no input event.
    history.value?.reset();
};
const popoverDismissed = ref(false);
const activeMention = computed(() => mentionQueryAt(draft.value, caret.value));
const slashQuery = computed<string | undefined>(() => {
    if (availableCommands.value.length === 0 || !draft.value.startsWith(`/`)) {
        return undefined;
    }
    const upto = draft.value.slice(1, caret.value);
    return caret.value >= 1 && !/\s/.test(upto) ? upto : undefined;
});
watch([() => activeMention.value?.query, slashQuery], () => {
    popoverDismissed.value = false;
});
const mentionPopover = ref<InstanceType<typeof ChatMentionPopover>>();
const commandPopover = ref<InstanceType<typeof ChatCommandPopover>>();
const mentionOpen = computed(() => activeMention.value !== undefined && !popoverDismissed.value);
const commandOpen = computed(() => !mentionOpen.value && slashQuery.value !== undefined && !popoverDismissed.value);

// Put the picked text into the draft and land the caret after it, keeping the textarea focused.
const applyDraftEdit = (text: string, nextCaret: number): void => {
    draft.value = text;
    void nextTick(() => {
        const el = input.value;
        if (el) {
            el.focus();
            el.setSelectionRange(nextCaret, nextCaret);
        }
        caret.value = nextCaret;
        grow();
    });
};

const pickMention = (path: string): void => {
    const mention = activeMention.value;
    if (mention === undefined) {
        return;
    }
    const result = insertMention(draft.value, mention, caret.value, path);
    applyDraftEdit(result.text, result.caret);
};

const pickCommand = (name: string): void => {
    const rest = draft.value.slice(caret.value);
    const inserted = `/${name} `;
    applyDraftEdit(`${inserted}${rest.startsWith(` `) ? rest.slice(1) : rest}`, inserted.length);
};

// --- Message recall --------------------------------------------------------------------------
// Put a recalled message in the composer with the caret at its end, ready to send or edit.
const recallInto = (text: string): void => {
    applyDraftEdit(text, text.length);
    // A recalled message is complete — a leading `/` or an @-path in it must not pop an autocomplete list open
    // over it. Dismissed on the next tick, after the query watch above has re-armed on the new draft.
    void nextTick(() => {
        popoverDismissed.value = true;
    });
};

// Returns true when recall consumed the key — see recallStep for which presses it claims and which walk the
// caret to the edge of a wrapped line first. Nothing is claimed while text is selected: there the arrows are
// collapsing a selection, not navigating. The live element is read rather than the `caret` ref, which only
// tracks keyup/click and so goes stale under an auto-repeating arrow — exactly the case that decides when the
// caret reaches the edge.
const recallKeydown = (event: KeyboardEvent): boolean => {
    const past = history.value;
    const el = input.value;
    if (past === undefined || el === undefined || el.selectionStart !== el.selectionEnd) {
        return false;
    }
    const step = recallStep(past, event.key, draft.value, el.selectionStart);
    if (step === undefined) {
        return false;
    }
    event.preventDefault();
    if (step.kind === `text`) {
        recallInto(step.text);
        return true;
    }
    el.setSelectionRange(step.at, step.at);
    caret.value = step.at;
    // The step always lands on an edge of the draft, which past max-h-48 is scrolled out of view — and moving a
    // textarea's selection does not reliably bring it back. Without this the caret would leave the visible rows
    // and the press would read as having done nothing.
    el.scrollTop = step.at === 0 ? 0 : el.scrollHeight;
    return true;
};

const onKeydown = (event: KeyboardEvent): void => {
    // Never submit mid-IME-composition (CJK candidates confirm with Enter).
    if (event.isComposing) {
        return;
    }
    // An open popover owns the list keys; Enter/Tab pick, Escape dismisses, arrows move.
    const popover = mentionOpen.value ? mentionPopover.value : commandOpen.value ? commandPopover.value : undefined;
    if (popover !== undefined) {
        if (event.key === `ArrowDown` || event.key === `ArrowUp`) {
            event.preventDefault();
            popover.move(event.key === `ArrowDown` ? 1 : -1);
            return;
        }
        if (event.key === `Escape`) {
            event.preventDefault();
            popoverDismissed.value = true;
            return;
        }
        if ((event.key === `Enter` && !event.shiftKey) || event.key === `Tab`) {
            if (popover.pickActive()) {
                event.preventDefault();
                return;
            }
        }
    }
    // After the popovers: an open @/-list owns the arrows for the token being typed, and recall's own Escape
    // must not pre-empt dismissing that list.
    if (recallKeydown(event)) {
        return;
    }
    // Escape interrupts the turn (Claude Code's shortcut), once the popovers and message recall have had their
    // claim on the key. Only while it's GENERATING: a turn parked on a card is spending nothing, and losing a
    // plan the user is still reading to a stray Escape costs far more than the keystroke saves — the Stop
    // button is the deliberate way out of that one.
    if (event.key === `Escape` && streaming.value && !awaitingDecision.value) {
        event.preventDefault();
        stop();
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
// The panel's half of "New agent" (and of anything else that hands the user the composer): the action itself
// lives in agentActions.startAgent, which opens the tab wherever it was pressed — the board, the strip's "+",
// the mobile header — and then asks for the caret. This is the only component that can give it, so it answers
// the signal, and every surface gets the same result instead of the one that happens to sit next to the
// textarea getting a better one.
watch(composerFocus, () => {
    atBottom.value = true;
    void nextTick(() => {
        grow();
        input.value?.focus();
    });
});

// Switch the active tab and re-pin to the bottom (atBottom is shared across tabs).
const selectTab = (id: string): void => {
    setActive(id);
    atBottom.value = true;
};

// One or many — the strip's × sends a single id, its context menu the Close Others / to-the-Right / All sets.
const closeTabs = (ids: ReadonlySet<string>): void => {
    closeTabsAction(ids);
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
const pinToBottom = (): void => {
    const element = scroller.value;
    if (element) {
        element.scrollTop = element.scrollHeight;
    }
};

/* Make the native scrollbar truthful after a transcript lands wholesale.
 *
 * .chat-message rows are content-visibility:auto with a 3rem estimate (chat.css), so a freshly swapped-in
 * transcript reports a scrollHeight built almost entirely of estimates. Left alone, every row realizing on
 * the way past rewrites scrollHeight mid-scroll — and a native scrollbar DRAG maps the thumb against the
 * current scrollHeight, so the thumb kept leaping hundreds of px away from the cursor. The cure is one
 * idle-time realization pass: .chat-realize forces every row to lay out for real, `auto` records those
 * heights as remembered sizes, and skipping resumes with a scrollHeight that no longer moves.
 *
 * Two frames under the class on purpose: the first lays the realized transcript out and records remembered
 * sizes (that happens at resize-observer timing, at the end of the frame), the second may drop back to
 * skipping. The at-bottom pin survives the growth spurt via the ResizeObserver below; elsewhere scroll
 * anchoring holds the view. requestIdleCallback keeps the one full layout off the restore's critical path
 * (Safari has no idle callback — a beat of setTimeout is the same bargain). */
const realizing = ref(false);
let warmQueued = false;
const warmTranscript = (): void => {
    if (warmQueued) {
        return;
    }
    warmQueued = true;
    const idle = globalThis.requestIdleCallback ?? ((task: () => void) => setTimeout(task, 200));
    idle(() => {
        realizing.value = true;
        void nextTick(() => {
            requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                    realizing.value = false;
                    warmQueued = false;
                }),
            );
        });
    });
};

// Every path that mounts never-painted rows outside the viewport, and nothing that fires per streamed frame:
// a tab switch or history open swaps the whole list (conversationId), the IndexedDB repaint and the daemon's
// replay land in bulk (length jumps while idle — a live turn only ever appends one bubble per flush), and a
// turn's end covers an answer that streamed in below the fold while the user was scrolled up reading.
watch(() => active.value.conversationId, warmTranscript, { immediate: true });
watch(
    () => messages.value.length,
    (now, before) => {
        if (!streaming.value && Math.abs(now - before) > 1) {
            warmTranscript();
        }
    },
);
watch(streaming, (now, was) => {
    if (was && !now) {
        warmTranscript();
    }
});

// Keep the newest tokens in view as the transcript grows — but only while the user is already at the bottom,
// so scrolling up to read isn't fought by streaming tokens.
//
// Driven by the transcript's measured HEIGHT rather than by watching message data. The deep watch this
// replaces re-traversed every message, tool call and todo of the whole conversation on each streamed frame
// (the typewriter loop ticks per animation frame), so its cost grew with the conversation's length rather
// than the answer's. Measuring is O(1) and also catches growth that never appears in the data at all — an
// image finishing load, a tool card expanding, prose reflowing when the panel is resized.
onMounted(() => {
    const observer = new ResizeObserver(() => {
        if (atBottom.value) {
            pinToBottom();
        }
    });
    if (content.value) {
        observer.observe(content.value);
    }
    onUnmounted(() => observer.disconnect());
});

// A tab switch swaps a possibly multi-line draft under the textarea — re-size it to the new content.
watch(
    () => active.value.conversationId,
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
    void nextTick(pinToBottom);
});
</script>

<template>
    <div
        class="chat-panel @container relative flex h-full min-h-0 flex-col overflow-hidden bg-card"
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

        <ChatTabsMobile v-if="mobile" @select="selectTab" @close="closeTabs" @open="openFromHistory" />
        <ChatTabs v-else @select="selectTab" @close="closeTabs" @open="openFromHistory" />

        <!-- The inner wrapper is what the autoscroll ResizeObserver measures; the scroller itself never
             changes height, so it can't report the transcript growing.
             The top inset lives on the wrapper, not the scroller: a sticky prompt pins to the scroller's
             PADDING edge, so a pt-4 out here would leave a 1rem band above the pinned row for the previous
             turn to slide through. Inside the wrapper the same inset is content, and the prompt pins flush. -->
        <!-- .chat-scroller is the IntersectionObserver root each prompt uses to tell whether it is pinned. -->
        <div
            ref="scroller"
            class="chat-scroller scrollbar-thin flex flex-1 flex-col overflow-auto px-4 pb-4"
            :class="{ 'chat-realize': realizing }"
            @scroll="onScroll"
        >
            <div ref="content" class="chat-turns flex flex-1 flex-col gap-1 pt-4">
                <template v-if="messages.length > 0">
                    <!-- One section per turn, purely so each prompt's sticky range ends where its answer does. -->
                    <section v-for="turn in turns" :key="turn.id" class="flex flex-col gap-1">
                        <ChatMessageView v-for="message in turn.messages" :key="message.id" :message="message" :streaming="isStreaming(message)" />
                    </section>
                </template>
                <p v-else class="m-auto max-w-[80%] text-center text-xs text-muted">Start a conversation with {{ providerName }}.</p>
                <p v-if="activeError" class="text-xs text-danger">{{ activeError }}</p>
            </div>
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
                <!-- This conversation's agent is off the board. Muted, not a warning: archiving loses nothing
                     (the branch, the diff, the transcript and every counter stay — this tab is the proof), so
                     the line states a fact rather than raising an alarm. It carries the one thing no other
                     surface could tell the user in time — that sending from here un-archives the agent — and
                     the press that does it deliberately, without sending anything. -->
                <div
                    v-if="activeArchived !== undefined"
                    class="flex items-center gap-2 rounded-xl border border-line bg-overlay/60 px-3 py-2 text-2xs text-muted"
                >
                    <Icon name="box" class="shrink-0" />
                    <span class="min-w-0 flex-1">Archived — off the agents board. Sending a message puts it back.</span>
                    <button
                        type="button"
                        class="shrink-0 rounded-full px-2 py-px font-semibold text-link transition-colors hover:bg-primary-600/15 disabled:opacity-50"
                        :disabled="busyIds.includes(activeArchived.id)"
                        v-tooltip.top="'Put this agent back on the board now'"
                        @click="restore([activeArchived.id])"
                    >
                        Restore
                    </button>
                </div>
                <ChatAccountPanel />
                <!-- Proactive re-auth prompt: the account is connected (a credential exists) but can no longer be
                     refreshed, so surface it here — before a send fails opaquely — with a jump to reconnect. -->
                <button
                    v-if="activeAccountReauth"
                    type="button"
                    class="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-left text-2xs text-warning"
                    @click="router.push({ path: '/sandbox/agent', query: { connect: provider } })"
                >
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0" />
                    <span
                        >{{ activeAccountReauth.detail ?? `This account needs to be reconnected.` }}
                        <span class="font-semibold underline">Reconnect</span></span
                    >
                </button>
                <template v-if="connected">
                    <!-- Messages written while the agent was busy that haven't reached it yet. They sit here
                         rather than in the transcript because they are not part of the conversation until the
                         agent has them — a steered one moves into the transcript the moment the daemon takes
                         it. Each is removable, so a queued thought can be withdrawn before it lands. -->
                    <div v-if="queued.length > 0" class="flex flex-col gap-1">
                        <div
                            v-for="message in queued"
                            :key="message.id"
                            class="flex items-start gap-2 rounded-xl border border-dashed border-line-strong bg-overlay/60 px-3 py-2"
                        >
                            <Icon name="clock" class="mt-0.5 shrink-0 text-2xs text-subtle" />
                            <div class="min-w-0 flex-1">
                                <p v-if="message.text" class="truncate text-2xs text-muted">{{ message.text }}</p>
                                <p v-if="message.attachments.length > 0" class="truncate text-2xs text-subtle">
                                    <Icon name="file" class="text-2xs" />
                                    {{ message.attachments.map((file) => file.name).join(`, `) }}
                                </p>
                            </div>
                            <button
                                type="button"
                                class="composer-ghost h-5 w-5 shrink-0"
                                @click="removeQueued(message.id)"
                                v-tooltip.top="'Remove — this message will not be sent'"
                                aria-label="Remove queued message"
                            >
                                <Icon name="times" class="text-2xs" />
                            </button>
                        </div>
                        <p class="px-1 text-2xs text-subtle">{{ queuedHint }}</p>
                    </div>
                    <form
                        class="relative flex flex-col rounded-2xl border border-line-strong bg-overlay shadow-lg transition-colors focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/25"
                        @submit.prevent="submit"
                    >
                        <ChatMentionPopover v-if="mentionOpen" ref="mentionPopover" :query="activeMention?.query ?? ''" @pick="pickMention" />
                        <ChatCommandPopover
                            v-if="commandOpen"
                            ref="commandPopover"
                            :query="slashQuery ?? ''"
                            :commands="availableCommands"
                            @pick="pickCommand"
                        />
                        <div v-if="attachments.length > 0 || editorTarget !== undefined" class="flex flex-wrap gap-2 px-3 pt-3">
                            <!-- Editor-context chip: off by default, one click attaches the open file /
                                 selection to the next message — the inverse of VSCode Claude Code. Sized
                                 like the attachment chips beside it. -->
                            <button
                                v-if="editorTarget !== undefined"
                                type="button"
                                class="flex items-center gap-1.5 rounded-lg border py-1.5 px-2 text-xs transition-colors"
                                :class="
                                    includeEditorContext
                                        ? 'border-primary-500 bg-primary-500/10 text-content'
                                        : 'border-dashed border-line text-subtle hover:text-content'
                                "
                                @click="includeEditorContext = !includeEditorContext"
                                :aria-pressed="includeEditorContext"
                                aria-label="Attach editor context"
                            >
                                <Icon name="code" class="shrink-0 text-2xs" />
                                <span class="max-w-36 truncate">{{ editorChipLabel }}</span>
                            </button>
                            <div
                                v-for="a in attachments"
                                :key="a.id"
                                class="relative flex items-center gap-2 overflow-hidden rounded-lg border py-1.5 pl-2 pr-1 text-xs"
                                :class="a.status === 'failed' ? 'border-danger' : 'border-line bg-card'"
                            >
                                <ChatImageThumb v-if="a.previewUrl" :src="a.previewUrl" :alt="a.name" size="h-9 w-9" />
                                <Icon name="file" v-else class="text-sm text-subtle" />
                                <span class="max-w-36 truncate text-content" v-tooltip.top="a.error ?? a.name">{{ a.name }}</span>
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
                        <!-- Body tier on desktop: what you type must read at the size it will land in the
                             transcript. text-base below md: 16px is the iOS threshold under which focusing
                             zooms the page. -->
                        <textarea
                            ref="input"
                            rows="1"
                            v-model="draft"
                            name="draft"
                            :placeholder="composerPlaceholder"
                            class="scrollbar-thin block max-h-48 w-full resize-none overflow-y-auto bg-transparent px-4 py-3 text-base leading-relaxed text-content placeholder:text-subtle focus:outline-none md:text-xs"
                            @input="onInput"
                            @keydown="onKeydown"
                            @keyup="syncCaret"
                            @click="syncCaret"
                            @paste="onPaste"
                        ></textarea>

                        <div class="flex items-center gap-1 px-2.5 pb-2.5">
                            <button
                                type="button"
                                class="composer-ghost h-8 min-w-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                @click="mobile ? (modelSheetOpen = true) : providerModel?.toggle($event)"
                                v-tooltip.top="activeModel ?? `${providerName} · ${modelLabelText}`"
                                aria-label="Provider and model"
                            >
                                <ProviderLogo :provider="provider" class="shrink-0 text-2xs text-link" />
                                <span class="truncate @max-xs:hidden">{{ modelLabelText }}</span>
                                <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
                            </button>

                            <div v-if="efforts.length > 0" class="flex shrink-0 items-center gap-1.5" role="group" aria-label="Reasoning effort">
                                <div class="flex items-center">
                                    <button
                                        v-for="(e, i) in efforts"
                                        :key="e.value"
                                        type="button"
                                        class="composer-effort-seg"
                                        :style="i <= effortIndex ? { backgroundColor: effortFill(i) } : undefined"
                                        @click="effort = e.value"
                                        :aria-label="e.label"
                                        :aria-pressed="effort === e.value"
                                    ></button>
                                </div>
                                <span class="text-2xs text-subtle @max-sm:hidden">{{ effortLabel }}</span>
                            </div>

                            <button
                                type="button"
                                class="composer-ghost ml-auto h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                @click="mobile ? (modeSheetOpen = true) : modeMenu?.toggle($event)"
                                v-tooltip.top="modeDescription"
                                aria-label="Agent mode"
                            >
                                <Icon :name="modeIcon" class="text-2xs text-link" />
                                <span class="@max-md:hidden">{{ modeLabel }}</span>
                                <Icon name="chevron-down" class="text-2xs text-subtle" />
                            </button>

                            <button
                                type="button"
                                class="composer-ghost h-8 w-8 shrink-0 max-md:h-11 max-md:w-11"
                                :class="{ 'composer-active': followAlong.enabled.value }"
                                @click="followAlong.setEnabled(!followAlong.enabled.value)"
                                v-tooltip.top="followAlong.enabled.value ? 'Stop following agent edits' : 'Follow agent edits live'"
                                :aria-pressed="followAlong.enabled.value"
                                aria-label="Follow agent edits"
                            >
                                <Icon :name="followAlong.enabled.value ? 'eye' : 'eye-slash'" class="text-xs max-md:text-base" />
                            </button>

                            <button
                                v-if="speechSupported"
                                type="button"
                                class="composer-ghost h-8 w-8 shrink-0 max-md:h-11 max-md:w-11"
                                :class="{ 'composer-active': listening }"
                                @click="toggleSpeech"
                                v-tooltip.top="listening ? 'Stop dictation' : 'Dictate'"
                                :aria-pressed="listening"
                                aria-label="Dictate"
                            >
                                <Icon name="microphone" class="text-xs max-md:text-base" />
                            </button>

                            <!-- Stop is present for the whole live turn — generating OR parked on a plan /
                                 question / permission card. A parked turn still holds the conversation's run
                                 lock, so without this the user's only exits were answering a card they didn't
                                 want to answer or closing the tab. -->
                            <button
                                v-if="streaming"
                                type="button"
                                class="composer-send composer-stop shrink-0"
                                @click="stop"
                                v-tooltip.top="stopHint"
                                :aria-label="stopLabel"
                            >
                                <Icon name="stop" class="text-sm" />
                            </button>
                            <!-- Send stays alongside Stop for the whole live turn: mid-turn text goes into the
                                 running turn where the harness takes it, and queues behind the turn where it
                                 doesn't. There is no state in which the composer has nowhere to put a message,
                                 so there is no state in which this button is missing. -->
                            <button type="submit" class="composer-send shrink-0" :disabled="!canSend" v-tooltip.top="sendHint" aria-label="Send">
                                <Icon name="send" class="text-sm" />
                            </button>
                        </div>
                    </form>

                    <p v-if="speechErrorMessage" class="px-1 text-2xs text-danger">{{ speechErrorMessage }}</p>

                    <div class="flex items-center gap-2 px-1 text-2xs text-subtle">
                        <!-- Keyboard hint is meaningless on a virtual keyboard (Enter is a newline there),
                             and doesn't earn its width in a narrow panel. An empty composer is the one moment
                             message recall is available, so the slot advertises it instead. -->
                        <span v-if="!mobile" class="@max-md:hidden">{{ composerHint }}</span>
                        <div class="ml-auto flex items-center gap-3">
                            <span v-if="contextRing" class="inline-flex items-center gap-1" v-tooltip.top="contextRing.tooltip">
                                <ProgressRing :value="contextRing.value" :class="contextRing.warn ? 'text-warning' : 'text-primary-500'" />
                                <span class="@max-xs:hidden">{{ contextRing.label }}</span>
                            </span>
                            <!-- The chip answers "am I about to get rate-limited"; a click goes to the screen
                                 that answers "and what has it cost me". -->
                            <button
                                v-if="usageRing"
                                type="button"
                                class="inline-flex cursor-pointer items-center gap-1 transition-colors hover:text-content"
                                v-tooltip.top="usageRing.tooltip"
                                @click="router.push('/sandbox/usage')"
                            >
                                <ProgressRing :value="usageRing.value" :class="usageRing.warn ? 'text-warning' : 'text-primary-500'" />
                                <span class="@max-xs:hidden">{{ usageRing.label }}</span>
                            </button>
                            <button
                                type="button"
                                class="inline-flex items-center gap-1 transition-colors hover:text-content"
                                @click="router.push('/sandbox/agent')"
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
            <BottomSheet v-model="modelSheetOpen" header="Model">
                <ChatModelPicker @selected="modelSheetOpen = false" />
            </BottomSheet>
            <BottomSheet v-model="modeSheetOpen" header="Agent mode">
                <ChatModeMenu @selected="modeSheetOpen = false" />
            </BottomSheet>
        </template>
        <template v-else>
            <!-- Flush content (no composer-pop-content padding): the picker's search bar and rail sit
                 edge-to-edge against the popover chrome. -->
            <Popover ref="providerModel" :append-to="overlayTarget" :pt="{ content: { class: '!p-0' } }">
                <div class="w-[26rem]">
                    <ChatModelPicker @selected="providerModel?.hide()" />
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
