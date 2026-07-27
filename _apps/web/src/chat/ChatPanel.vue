<script setup lang="ts">
import { BottomSheet, useDevice } from "@intentic-app/ui";
import Popover from "primevue/popover";
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { NATIVE_PROVIDERS, type NativeProvider, providerLabel } from "@intentic/sandbox-contract";
import { effortsFor, MODES } from "../composables/chat/catalog";
import { type ChatAttachment, type ChatMessage, modelLabelFor, type PendingAttachment } from "../composables/chat/conversation";
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
import { inputHistoryFor, onFirstLine, onLastLine } from "../composables/chat/inputHistory";
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
    harness,
    account,
    accounts,
    model,
    effort,
    thinking,
    draft,
    attachments,
    connected,
    setActive,
    send,
    steer,
    stop,
    decidePlan,
    openConversation,
    newChat: newChatAction,
    closeTab: closeTabAction,
    availableCommands,
} = useChat();
const router = useRouter();
const layout = useLayout();
const followAlong = useFollowAlong();
const { overlayTarget, poppedOut } = useChatPopout();
const { activeSandboxId, reachable, denied } = useSandbox();
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
const workspaceTabs = useWorkspaceTabs();
const editorSelection = useEditorSelection();
const editorTarget = computed<{ file: string; startLine?: number; endLine?: number; selection?: string } | undefined>(() => {
    const selection = editorSelection.selection.value;
    if (selection !== undefined) {
        return { file: selection.path, startLine: selection.startLine, endLine: selection.endLine, selection: selection.text };
    }
    const tab = workspaceTabs.activeTab.value;
    return tab?.kind === `file` ? { file: tab.path } : undefined;
});
const includeEditorContext = ref(false);
// Attaching is an explicit per-file choice — a different file in the editor resets the opt-in.
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
// Whether the running turn accepts mid-turn steering: the Claude Code harness only — the claude provider, kimi
// and gemini (neither has a native runtime, so both always run on it), or codex/grok routed under harness
// "claude-code". Mirrors the daemon's steerable gate in agent.routes.
const steerable = computed(
    () =>
        provider.value === `claude` ||
        provider.value === `kimi` ||
        provider.value === `gemini` ||
        ((provider.value === `codex` || provider.value === `grok`) && harness.value === `claude-code`),
);

// The composer Send is usable when there's text or a finished attachment and the turn state accepts it: idle
// (a fresh send), a pending plan (typed text becomes feedback), or mid-generation on a steerable turn (typed
// text is injected into it). Blocked while a question card is the input and while any attachment is still
// uploading (or failed — remove it to proceed).
const canSend = computed(() => {
    if (attachments.value.some((entry) => entry.status !== `done`)) {
        return false;
    }
    if (pendingPlanMessage.value) {
        // Plan feedback is text-only; staged attachments wait for the next real turn.
        return draft.value.trim().length > 0;
    }
    if (streaming.value) {
        // Mid-turn steering: text-only (staged attachments wait for a real turn), and never past a pending
        // question card — the card is the input surface there.
        return steerable.value && !awaitingDecision.value && draft.value.trim().length > 0 && attachments.value.length === 0;
    }
    if (draft.value.trim().length === 0 && attachments.value.length === 0) {
        return false;
    }
    return true;
});
const sendHint = computed(() => {
    if (pendingPlanMessage.value) {
        return `Send as feedback (keep planning)`;
    }
    // A question / permission card IS the input surface while it's open — say so, rather than leaving a
    // disabled button that reads as "Send" and does nothing.
    if (streaming.value && awaitingDecision.value) {
        return `Answer the request above, or stop the turn`;
    }
    return streaming.value ? `Send to the running turn` : `Send`;
});
// Stop is offered for every live turn, including one parked on a card — that state is the most common reason to
// want out (a permission the user won't grant, a plan they'd rather restate from scratch), and until now the
// card's own buttons were the only way forward. Name the consequence there: the parked request goes with it.
const stopLabel = computed(() => (awaitingDecision.value ? `Stop the turn` : `Stop generating`));
const stopHint = computed(() =>
    awaitingDecision.value ? `Stop the turn — discards the request above` : mobile.value ? stopLabel.value : `${stopLabel.value} (Esc)`,
);
// While a plan awaits a decision, typing revises it (reject-with-feedback); while a steerable turn runs,
// typing steers it — the placeholder says which.
const composerPlaceholder = computed(() => {
    if (pendingPlanMessage.value) {
        return `Reply to revise the plan…`;
    }
    if (streaming.value && awaitingDecision.value) {
        return `Answer the request above…`;
    }
    if (streaming.value && steerable.value) {
        return `Steer ${providerName.value} mid-turn…`;
    }
    return `Ask ${providerName.value}…`;
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
    // canSend covers all the gates: empty composer, uploads still in flight, unsteerable mid-generation.
    if (!connected.value || !canSend.value) {
        return;
    }
    const text = draft.value.trim();
    const pendingPlan = pendingPlanMessage.value;
    if (pendingPlan) {
        // Typing while a plan is pending rejects it with that text as feedback (Claude Code style) — the
        // agent stays in plan mode and revises.
        void decidePlan(pendingPlan, false, `plan`, text);
    } else if (streaming.value) {
        // Mid-turn steering: injected into the running turn between tool calls; chip and attachments wait.
        void steer(text);
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
        // Snapshot the chips onto the turn, then clear WITHOUT revoking preview URLs — the thumbnails
        // now live on the sent user bubble.
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
    // Every branch above sends `text` somewhere (a turn, a steer, a plan revision), so every branch earns a
    // slot in the recall ring.
    history.value?.record(text);
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

// Returns true when recall consumed the key. The arrows are claimed only when the caret has nowhere left to go
// in that direction, so a recalled MULTI-LINE message can still be walked and edited natively before sending.
// The live element is read rather than the `caret` ref, which only tracks keyup/click and so goes stale under
// an auto-repeating arrow — exactly the case that decides when the caret reaches the first line.
const recallKeydown = (event: KeyboardEvent): boolean => {
    const past = history.value;
    const el = input.value;
    if (past === undefined || el === undefined || el.selectionStart !== el.selectionEnd) {
        return false;
    }
    const at = el.selectionStart;
    const recalled =
        event.key === `ArrowUp` && onFirstLine(draft.value, at)
            ? past.previous(draft.value)
            : event.key === `ArrowDown` && past.recalling && onLastLine(draft.value, at)
              ? past.next()
              : event.key === `Escape` && past.recalling
                ? past.cancel()
                : undefined;
    if (recalled === undefined) {
        return false;
    }
    event.preventDefault();
    recallInto(recalled);
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
const pinToBottom = (): void => {
    const element = scroller.value;
    if (element) {
        element.scrollTop = element.scrollHeight;
    }
};

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

        <ChatTabsMobile v-if="mobile" @select="selectTab" @close="closeTab" @new="newChat" @open="openFromHistory" />
        <ChatTabs v-else @select="selectTab" @close="closeTab" @new="newChat" @open="openFromHistory" />

        <!-- The inner wrapper is what the autoscroll ResizeObserver measures; the scroller itself never
             changes height, so it can't report the transcript growing. -->
        <div ref="scroller" class="scrollbar-thin flex flex-1 flex-col overflow-auto p-4" @scroll="onScroll">
            <div ref="content" class="flex flex-1 flex-col gap-1">
                <template v-if="messages.length > 0">
                    <ChatMessageView v-for="message in messages" :key="message.id" :message="message" :streaming="isStreaming(message)" />
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
                            <!-- Send stays alongside Stop while a steerable turn runs — typed text is
                                 injected into the running turn instead of waiting for it. It drops out
                                 entirely mid-turn on an unsteerable provider: there is nowhere for the text
                                 to go, so Stop is the only button in the corner. -->
                            <button
                                v-if="!streaming || awaitingDecision || steerable"
                                type="submit"
                                class="composer-send shrink-0"
                                :disabled="!canSend"
                                v-tooltip.top="sendHint"
                                aria-label="Send"
                            >
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

<!-- Unscoped on purpose: .chat-markdown targets v-html-injected prose, and the rest are class names shared
     across the chat components (tabs, message view, account panel), so they live once here at the panel root. -->
<style>
/* Long transcripts: let the browser skip layout and paint for turns that are scrolled out of view. Every
   message here has been painted at least once — it streamed in front of the user — so `auto` remembers each
   one's real height and scrolling back through them needs no size estimator. The intrinsic size only has to
   carry a transcript restored straight to its bottom, where the rows above have never painted; the browser's
   scroll anchoring absorbs the correction as they realize. */
.chat-message {
    content-visibility: auto;
    contain-intrinsic-size: auto 3rem;
}
.chat-surface {
    background: color-mix(in srgb, var(--color-overlay) 55%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-primary-500) 22%, var(--color-line));
}
.chat-surface-assistant {
    background: color-mix(in srgb, var(--color-overlay) 35%, transparent);
    border: 1px solid var(--color-line);
}
/* Chat type scale — three tiers, and nothing else in the chat column:
     meta   0.6875rem  (text-2xs)  tool cards, timestamps, badges, hints, descriptions, code
     body   0.75rem    (text-xs)   all prose and controls: bubbles, markdown, composer, menu rows
     title  0.875rem   (text-sm)   card header lines only (plan / question / permission)
   Touch bumps a step, so shared surfaces are written as a pair — `text-base md:text-xs` on inputs
   (16px is iOS's zoom threshold), `text-sm md:text-xs` on menu rows. The `md:` half is always a tier
   from this table; the mobile-only components (ChatTabsMobile) sit at the touch sizes throughout.
   Labelled .composer-ghost buttons are chrome, not content: they take the meta tier wherever they
   appear (the composer's model/mode row, the picker's footer, the connect gate's provider tabs), so
   the controls framing the input never out-weigh the message being written in it.
   Mono runs a tier below its sans context — it reads optically larger at the same nominal size.
   The rules below are stated in `em` so the prose scales with the body tier instead of pinning a
   second, absolute scale beside it. */
.chat-markdown {
    font-size: 0.75rem;
    line-height: 1.625;
}
.chat-markdown > :first-child {
    margin-top: 0;
}
.chat-markdown > :last-child {
    margin-bottom: 0;
}
/* A streamed assistant body is split across two .md-part wrappers (settled + still-writing). display:contents
   removes them from layout so the prose inside still behaves as direct children of .chat-markdown — but the
   two rules above then match the WRAPPER, where margin does nothing, so the edge rules are restated one level
   down. Both parts are v-if'd on non-empty content, so whichever exists is correctly first/last. */
.chat-markdown > .md-part {
    display: contents;
}
.chat-markdown > .md-part:first-child > :first-child {
    margin-top: 0;
}
.chat-markdown > .md-part:last-child > :last-child {
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
    font-size: 1.45em;
}
.chat-markdown h2 {
    font-size: 1.25em;
}
.chat-markdown h3 {
    font-size: 1.1em;
}
.chat-markdown h4 {
    font-size: 1em;
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
}
/* Fenced code blocks are substituted as raw markup by markdownCode and styled app-wide in styles.css — the
   workspace markdown preview renders the same markup from the same renderer.
   One size for inline and fenced code: the meta tier, which lands a step under the prose because mono runs
   optically larger than the sans body at the same nominal size. */
.chat-markdown code {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.6875rem;
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
/* A file the agent named, linkified by markdownFileLinks — clicking opens it in the Workspace. The dotted rule
   is the affordance: a path reads as "opens here" before it is hovered, and stays distinguishable from an
   outbound link, which is undecorated until hover. Written one level more specific than the rule above so it
   wins the text-decoration regardless of stylesheet order. */
.chat-markdown a.md-file-link {
    text-decoration: underline dotted color-mix(in srgb, var(--color-link) 45%, transparent);
    text-underline-offset: 0.2em;
}
.chat-markdown a.md-file-link:hover {
    text-decoration: underline solid var(--color-link);
}
.chat-markdown table {
    width: 100%;
    margin: 0.7rem 0;
    border-collapse: collapse;
    font-size: 0.6875rem;
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
    font-size: 1.1em;
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
    height: 2rem;
    padding: 0 0.85rem;
    border-radius: var(--radius-md);
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    transition:
        background-color 0.15s,
        color 0.15s,
        border-color 0.15s;
}
.plan-approve {
    background: var(--color-primary-fill);
    color: var(--color-fill-content);
    border: 1px solid transparent;
}
.plan-approve:hover {
    background: var(--color-primary-fill-hover);
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
/* The question card's Submit / Dismiss sit inline with smaller controls (option rows, the Other field),
   so they run a touch tighter than the plan/permission decisions. Desktop only — the mobile block below
   still lifts .plan-approve/.plan-reject back to full 2.75rem touch targets. */
.plan-sm {
    height: 1.75rem;
    padding: 0 0.7rem;
    font-size: 0.6875rem;
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
    box-sizing: content-box;
    background-clip: content-box; /* keep the visible bar thin; the padding-right gap stays transparent */
    border-radius: var(--radius-sm);
    cursor: pointer;
    background-color: color-mix(in srgb, var(--color-content) 10%, transparent);
    transition:
        background-color 0.15s,
        filter 0.15s;
}
/* The gap between two bars is a click target for the lower (left) level — it lives as this bar's
   right-padding rather than a flex gap, so clicking the empty space snaps down, not up. */
.composer-effort-seg:not(:last-child) {
    padding-right: 0.125rem;
}
.composer-effort-seg:hover {
    background-color: color-mix(in srgb, var(--color-content) 22%, transparent); /* unlit hover */
    filter: brightness(1.15); /* lit-bar hover feedback (inline bg wins over class bg) */
}
.composer-send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 2rem;
    width: 2rem;
    border-radius: 9999px;
    background: var(--color-primary-fill);
    color: var(--color-fill-content);
    cursor: pointer;
    transition:
        background-color 0.15s,
        opacity 0.15s;
}
.composer-send:hover {
    background: var(--color-primary-fill-hover);
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
   v-html plan buttons rendered by ChatMessageView). Deliberately viewport-based (device class), unlike the
   @container variants in the template that thin out labels by panel width — don't unify the two. */
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
    .composer-effort-seg:not(:last-child) {
        padding-right: 0.3rem; /* chunkier snap-down gap for touch */
    }
}
</style>
