import {
    type AgentCommand,
    type AgentHarness,
    type AgentProvider,
    clampEffort,
    type EditorContext,
    type KeyedProvider,
    NATIVE_PROVIDERS,
    type OauthAccount,
    type PermissionMode,
    planParts,
    providerLabel,
    type RestoredMessage,
    runsClaudeCode,
    type TranslatorAccounts,
    type UsageAccount,
} from "@intentic/sandbox-contract";
import { computed, ref, shallowRef, watch } from "vue";
import { router } from "../../router";
import {
    accountsLoaded,
    acpProviders,
    type CatalogLoadState,
    Conversation,
    type ModelOption,
    type PendingAttachment,
    perProvider,
    providerAccounts,
    providerCommands,
    providerDefaultModel,
    providerModels,
    providerModelsState,
    rememberedAccountFor,
    rememberedModelFor,
    selectedAccountId,
    startingMode,
    translatorAccounts,
    turnDefaults,
} from "./conversation";
import { providerReady } from "./access";
import { type ChatAttachment, type ChatMessage, type PlanRequest } from "./transcript";
import { approvalsFor } from "./catalog";
import { readAccountPreference, writeAccountPreference } from "./accountPreference";
import { readTabSnapshot, type StoredTab, writeTabSnapshot } from "./tabSnapshot";
import { dropTranscript } from "./transcriptCache";
import { usageStatusByAccount } from "./usageStatus";
import { track } from "../analytics";
import { withConcurrency } from "../concurrency";
import { sandboxJson, sandboxRequest } from "../sandbox/sandboxClient";
import { supportsRoute } from "../sandbox/useDaemonRoutes";
import { useSandbox } from "../sandbox/useSandbox";
import { errorMessage } from "../useAsyncAction";
import { useWorkspaceTabs } from "../workspace/useWorkspaceTabs";

// One past conversation in the sandbox's SDK session store, for the history menu.
export interface ChatSession {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
    // Why a searched row matched: the line of the user's own prompt the query hit. Absent on an unfiltered
    // list, and on a title match — the row already shows the title, so repeating it under itself is noise.
    readonly snippet?: string;
}

/* Manages the shared Claude Code chat as a module-level singleton: a set of concurrent conversations (the
 * tabs), plus the global account connection and turn preferences. A singleton
 * so the open conversations survive navigation between workspace areas (the chat panel lives in the
 * persistent shell). Each Conversation owns its own stream, so a background tab keeps generating while the
 * user views another. */

const { activeSandboxId, reachable } = useSandbox();

// Open conversations (tabs) and which one is focused; always at least one. A tab IS its conversation, so the
// focus is a conversationId — the one identity the daemon, the fleet registry, the transcript mirror and the
// workspace's plan preview all already key on. There is deliberately no second, tab-local id: the previous one
// was minted from a counter that resetChat rewound, so a reused value silently aliased two different chats in
// anything that outlived the reset.
// shallowRef, not ref: a deep ref would unwrap each Conversation's internal Vue refs (messages, title, …)
// and mangle the class type. The instances' own refs stay reactive; reassigning the array triggers updates.
const conversations = shallowRef<Conversation[]>([]);
const activeId = ref<string>(``);

/* An untouched "New agent" tab exists only while the focus is ON it. The tab and the fleet board's draft card
 * are one conversation under two skins, so an abandoned empty draft doesn't just crowd the strip — it squats in
 * the board's Active lane looking like work in flight. Anything at all in it makes it real and it stays:
 * composer text (whitespace alone isn't text — send() refuses it too), an attachment staged or still uploading,
 * a queued message, a transcript, a session, a running turn, a rename, an unread error, or a fleet
 * registration. */
const untouchedDraft = (conversation: Conversation): boolean =>
    conversation.isolated.value &&
    !conversation.registered.value &&
    !conversation.streaming.value &&
    conversation.messages.value.length === 0 &&
    conversation.draft.value.trim() === `` &&
    conversation.attachments.value.length === 0 &&
    conversation.queued.value.length === 0 &&
    conversation.session.value === undefined &&
    conversation.title.value === null &&
    conversation.error.value === null;

/* The one writer of the tab list AND of the focus (setActive routes through it too), holding both of the
 * strip's invariants in the same write:
 *   · the focus lands on a tab that is actually in the list, and on the LAST one when the tab that had it is
 *     gone (VSCode behaviour, the rule the workspace's tabs follow too). A focus naming nothing is invisible
 *     rather than loud — the strip highlights no tab while the panel quietly shows the first one, so every
 *     click afterwards looks like it did nothing.
 *   · at most ONE untouched draft is open, and only as the focused tab.
 *
 * The draft rule is enforced HERE rather than by a watcher reacting to the focus afterwards, which is what it
 * used to be. Reaping after the fact meant the outcome of an explicit action was decided by an implicit reaper
 * racing it: "New agent" pressed while sitting on an empty draft appended one and the reaper closed the other,
 * so the press was a visual no-op — and every intermediate state (a focus already moved, the doomed draft still
 * listed) was live long enough to render and to be persisted by the snapshot watch. It also only ever looked at
 * the tab that LOST the focus, so a draft that lost it to a list rewrite instead (a close reseating the focus on
 * the last tab) survived as a permanent, unsweepable "New agent" tab. One synchronous write, no ordering. */
const setConversations = (next: readonly Conversation[], focus: string): void => {
    const focused = next.some((conversation) => conversation.conversationId === focus) ? focus : next[next.length - 1]!.conversationId;
    // The focused tab is always kept, so the list can never come out empty. A dropped draft needs no teardown:
    // untouched means no turn to detach from and no transcript to evict.
    const kept = next.filter((conversation) => conversation.conversationId === focused || !untouchedDraft(conversation));
    // Reassigned only when the list actually moved, so a plain tab switch doesn't re-fire every list watcher
    // (the snapshot write, the hydrate sweep) for a change that is only about the focus.
    if (kept.length !== conversations.value.length || kept.some((conversation, at) => conversation !== conversations.value[at])) {
        conversations.value = kept;
    }
    activeId.value = focused;
};

// The focused conversation. The find always hits — setConversations reconciles the focus with every list it
// writes — and list[0] is the floor that keeps a slip a wrong tab rather than a crashed panel.
const active = computed<Conversation>(() => {
    const list = conversations.value;
    return list.find((conversation) => conversation.conversationId === activeId.value) ?? list[0]!;
});

// --- Tab persistence ---------------------------------------------------------------------------
// The snapshot's shape, storage and validation live in tabSnapshot.ts; what stays here is when it is read and
// written. Which SANDBOX the open tabs belong to is recorded at restore rather than read live at write time:
// activeSandboxId flips one flush before sandboxScope's watch re-scopes the list, so a snapshot that lands in
// the incoming sandbox's key during that window is the OUTGOING sandbox's tabs — restored, on the very next
// line, as if they were the new sandbox's own.
let scopedSandboxId: string | undefined;

// One persisted tab, back as a live conversation. Restored attachments carry upload metadata only (no
// previewUrl/controller — those are client-session objects); the chip falls back to the file icon.
const restoreTab = (tab: StoredTab): Conversation => {
    const conversation = new Conversation(tab.conversationId);
    conversation.isolated.value = tab.isolated;
    conversation.registered.value = tab.registered;
    // The posture isn't part of the snapshot (it is a per-task choice, not a preference) — a restored tab
    // starts from the mode its tree calls for, same as a fresh one.
    conversation.mode.value = startingMode(conversation.isolated.value);
    conversation.draft.value = tab.draft;
    conversation.attachments.value = tab.attachments.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        path: file.path,
        status: `done` as const,
        progress: 1,
    }));
    conversation.queued.value = tab.queued.map((message) => ({ id: crypto.randomUUID(), text: message.text, attachments: message.attachments }));
    conversation.title.value = tab.title ?? null;
    // Restore the harness before the model — the native/claude-code model lists diverge for codex/grok.
    if (tab.harness !== undefined) {
        conversation.harness.value = tab.harness;
    }
    if (tab.provider !== undefined) {
        conversation.provider.value = tab.provider;
        // An OPEN chat comes back on the account it was running on, not on whatever the remembered pick has since
        // become — switching one tab's account is not an instruction about the others. Only a tab that carries no
        // pin of its own (one persisted before this was stored) falls back to the provider's remembered one.
        conversation.account.value = tab.account ?? rememberedAccountFor(tab.provider);
        conversation.model.value = rememberedModelFor(tab.provider);
    }
    if (tab.session !== undefined) {
        // A session resumes only on the account that minted it, so it keeps its OWN pin rather than adopting the
        // tab's: forging the match would resume another account's session, and faking a mismatch would retire a
        // live one at the next send. Its harness moves with the tab.
        conversation.session.value = {
            ...tab.session,
            account: tab.session.account ?? rememberedAccountFor(tab.session.provider),
            harness: conversation.harness.value,
        };
    }
    return conversation;
};

// Rebuild this window's tab set for the active sandbox — its own snapshot, the last window's as a seed, or a
// single fresh tab when neither exists — and focus the stored active tab.
const restoreTabs = (): void => {
    scopedSandboxId = activeSandboxId.value;
    // Read BEFORE the tabs are built, because building one resolves an account: a fresh conversation seeds from
    // this pick (Conversation's constructor), and a restored one falls back to it. Scoped with the tabs — the
    // ids name credentials in THIS sandbox's store, so the incoming sandbox's picks replace the outgoing one's
    // rather than being cleared to nothing.
    selectedAccountId.value = readAccountPreference(scopedSandboxId);
    const stored = readTabSnapshot(scopedSandboxId);
    if (stored === undefined) {
        const conversation = new Conversation();
        setConversations([conversation], conversation.conversationId);
        return;
    }
    // `stored.active` names one of the tabs — the reader guarantees it.
    setConversations(stored.tabs.map(restoreTab), stored.active);
};

restoreTabs();

// Persist the tab snapshot on any change: the stringified getter touches every persisted field, so tab
// open/close/switch, keystrokes, uploads finishing, and session commits all write through automatically.
// ponytail: writes per keystroke; the blob is tiny — throttle if profiling shows jank.
watch(
    () =>
        JSON.stringify({
            active: activeId.value,
            tabs: conversations.value.map((conversation) => ({
                // JSON.stringify drops undefined keys, matching StoredTab's optional fields.
                conversationId: conversation.conversationId,
                isolated: conversation.isolated.value,
                registered: conversation.registered.value,
                provider: conversation.provider.value,
                account: conversation.account.value,
                harness: conversation.harness.value,
                session: conversation.session.value && {
                    id: conversation.session.value.id,
                    provider: conversation.session.value.provider,
                    account: conversation.session.value.account,
                },
                title: conversation.title.value ?? undefined,
                draft: conversation.draft.value,
                attachments: conversation.attachments.value
                    .filter((file) => file.status === `done`)
                    .map((file) => ({ name: file.name, path: file.path })),
                queued: conversation.queued.value.map((message) => ({
                    text: message.text,
                    attachments: message.attachments.map((file) => ({ name: file.name, path: file.path })),
                })),
            })),
        }),
    (json) => {
        if (scopedSandboxId !== undefined) {
            writeTabSnapshot(scopedSandboxId, json);
        }
    },
);

// Persist the account pick per provider — the seed a NEW conversation (and a fresh window) starts from. A watch
// rather than a write inside selectAccount, because the pick also moves on its own: a connect makes the new
// account current, a disconnect hands the selection to whatever is left, and a landing account list corrects a
// pick that is no longer valid. All of those are the user's "last preference" just as much as a click is.
watch(selectedAccountId, (picks) => {
    if (scopedSandboxId !== undefined) {
        writeAccountPreference(scopedSandboxId, picks);
    }
});

// Load a provider's daemon-published slash commands into the shared record. Cheap (a cached in-memory read
// daemon-side), so it rides the same reachable seam as the account/model catalogs.
const loadProviderCommands = async (target: AgentProvider): Promise<void> => {
    try {
        const body = await sandboxJson<{ commands?: AgentCommand[] }>(`/agent/commands?agent=${encodeURIComponent(target)}`);
        providerCommands.value = { ...providerCommands.value, [target]: body.commands ?? [] };
    } catch {
        // Leave the last list; the popover simply stays as it was until the next load.
    }
};

// Past conversations from the sandbox's session store, loaded on demand for the history menu.
const sessions = ref<ChatSession[]>([]);

// Active-conversation facade — the chat panel binds these; they forward to the active tab so the
// message/composer template stays put as the user switches tabs.
const messages = computed(() => active.value.messages.value);
const streaming = computed(() => active.value.streaming.value);
// The active conversation's slash commands: the list its own turns published (authoritative — it reflects the
// session's live config), falling back to the provider's last daemon-published list so a conversation that
// hasn't run a turn yet still has a populated `/` popover.
const availableCommands = computed<readonly AgentCommand[]>(() => {
    const own = active.value.availableCommands.value;
    return own.length > 0 ? own : (providerCommands.value[active.value.provider.value] ?? []);
});
const awaitingDecision = computed(() => active.value.awaitingDecision.value);
const pendingPlanMessage = computed(() => active.value.pendingPlanMessage.value);
// Whether the active conversation's attach stream is still re-telling frames from before it attached — see
// Conversation.replaying, and the plan-preview watch below, which is what it exists for.
const replaying = computed(() => active.value.replaying.value);
// The active conversation's undelivered messages (submitted while its turn was running) and whether its
// running turn can take one mid-flight — the composer renders the first and words its hints from the second.
const queued = computed(() => active.value.queued.value);
const removeQueued = (id: string): void => active.value.removeQueued(id);
const steerable = computed(() => active.value.steerable.value);

// Open (or re-focus) the active conversation's plan preview tab in the main view — the workspace tab is keyed
// `plan:<conversationId>`, so any plan card in the transcript reopens/replaces the same preview, and it stays
// that conversation's preview across a reload rather than being inherited by whichever chat happens to land in
// the same strip position. Also the target of the auto-open watch below.
const { openPlan } = useWorkspaceTabs();
const openPlanPreview = (plan: PlanRequest): void => {
    openPlan(active.value.conversationId, planParts(plan.text).title ?? `Plan`, plan.text);
    void router.push({ name: `workspace` });
};

/* A newly proposed plan opens as a rendered markdown preview tab in the main view (Claude Code VSCode style);
 * the approve/keep-planning buttons stay on the chat card. Keyed by requestId so unrelated transcript updates
 * (which re-create message objects) don't re-fire, while a revised plan — or switching to a chat tab with its
 * own pending plan — opens/refreshes the preview. Watching the active-conversation facade means a background
 * tab's plan never hijacks the main view; it opens when that tab is focused.
 *
 * Gated on `replaying`, because a plan card is not only born from a live frame: attaching to a run REPLAYS its
 * whole log, so an approved plan passes back through `pending` on its way to the frozen approval. Acting on
 * that instant threw the preview (and the router, which lands on the Workspace) in front of the user on every
 * reload, redeploy, second window and resume probe — for a decision they had already made, over whatever they
 * had moved on to. A plan STILL pending when the stream reaches the live boundary is one the agent is really
 * parked on, and that is worth surfacing. */
watch([() => pendingPlanMessage.value?.plan?.requestId, replaying], ([requestId, isReplaying]) => {
    const plan = pendingPlanMessage.value?.plan;
    if (requestId === undefined || plan === undefined || isReplaying) {
        return;
    }
    openPlanPreview(plan);
});

const activeModel = computed(() => active.value.activeModel.value);
const contextUsage = computed(() => active.value.contextUsage.value);
// The active conversation's permission mode (read + write) — the composer's mode pill drives it. Reads the
// RUNNING turn's posture while one is live (the agent can enter plan mode on its own, and the pill must not
// claim otherwise); a pick replaces it, because from that click on the user's choice is the truth. Not written
// through to the persisted defaults: the posture belongs to the conversation, not to the next one.
const mode = computed<PermissionMode>({
    get: () => active.value.liveMode.value ?? active.value.mode.value,
    set: (value) => {
        active.value.mode.value = value;
        active.value.liveMode.value = undefined;
    },
});

// The plan card's approve buttons for the active conversation, the posture it will RESTORE first.
const planApprovals = computed(() => approvalsFor(active.value.mode.value));

// Active-conversation turn settings (read+write) — the composer binds these; they forward to the active tab
// so switching tabs shows that chat's provider/model/effort/thinking. All of it is switchable mid-chat: a
// provider/account switch takes effect at the next send (see Conversation.send's segment cut).
const provider = computed<AgentProvider>(() => active.value.provider.value);
const selectProvider = (p: AgentProvider): void => {
    active.value.selectProvider(p);
    // The catalog is daemon-owned and can be stale (loaded before the account connected, or an empty transient)
    // — refetch on landing so the model picker is populated on arrival (the daemon caches, so this is cheap).
    void loadProviderModels(p);
};
// The active conversation's harness (Default = the provider's native runtime, vs the Claude Code loop). Only
// meaningful for codex/grok; picked through the model picker's footer chips. A switch retires the session at
// the next send.
const harness = computed<AgentHarness>(() => active.value.harness.value);
// Switch the active conversation's harness — an axis orthogonal to the model now (the catalog is shared, so the
// chosen model rides across). No-ops on claude (always its own loop) and mid-stream (selectHarness guards both).
const selectHarness = (next: AgentHarness): void => active.value.selectHarness(next);
const model = computed<string>({
    get: () => active.value.model.value,
    set: (value) => {
        active.value.model.value = value;
        // Remember this model for the active conversation's provider, so switching provider away and back
        // restores it — per-provider memory, not one global model.
        turnDefaults.models.value = { ...turnDefaults.models.value, [active.value.provider.value]: value };
    },
});
// One picker row = provider + model; the harness is a separate axis (the footer chips), so a model pick keeps
// the current harness. A cross-provider pick re-points the selection (the fresh session starts lazily at the
// next send). Mid-stream, only a same-provider model swap is allowed — a provider switch is not.
const selectModel = (pick: { provider: AgentProvider; value: string }): void => {
    if (streaming.value && pick.provider !== provider.value) {
        return;
    }
    if (pick.provider !== provider.value) {
        selectProvider(pick.provider);
    }
    active.value.model.value = pick.value;
    // Per-provider memory, so switching provider away and back restores the pick (catalog is harness-independent).
    turnDefaults.models.value = { ...turnDefaults.models.value, [pick.provider]: pick.value };
};

const effort = computed<string>({
    get: () => active.value.effort.value,
    set: (value) => {
        active.value.effort.value = value;
        turnDefaults.effort.value = value;
    },
});
const thinking = computed<boolean>({
    get: () => active.value.thinking.value,
    set: (value) => {
        active.value.thinking.value = value;
        turnDefaults.thinking.value = value;
        // Turning thinking OFF invalidates a 'max' effort pick (the API rejects the pair), and the picker drops
        // the tier from its list the moment this flips — so the selection is clamped here rather than left
        // pointing at an option that is no longer offered. Writing through `effort` persists it to turnDefaults
        // too, so the next new chat doesn't inherit the invalid pair.
        effort.value = clampEffort(effort.value, provider.value, value);
    },
});
// Account facades: the active conversation's account selection + its picker. `accounts` lists the active
// provider's connected accounts for the composer switcher; `managedAccounts` the manage card's.
const account = computed<string | undefined>(() => active.value.account.value);
const selectAccount = (id: string): void => active.value.selectAccount(id);
// Providers are an open string vocabulary — an unseeded key (an ACP agent, which owns its own credentials)
// simply has no daemon account list.
const accountsOf = (target: AgentProvider): readonly OauthAccount[] => providerAccounts.value[target] ?? [];
const accounts = computed<readonly OauthAccount[]>(() => accountsOf(active.value.provider.value));
const managedAccounts = computed<readonly OauthAccount[]>(() => accountsOf(managedProvider.value));

// The active conversation's composer draft (text + staged attachments) — per-tab, so switching tabs swaps the
// composer back to whatever was typed and attached there.
const draft = computed<string>({
    get: () => active.value.draft.value,
    set: (value) => {
        active.value.draft.value = value;
    },
});
const attachments = computed<PendingAttachment[]>({
    get: () => active.value.attachments.value,
    set: (value) => {
        active.value.attachments.value = value;
    },
});

// The route prefix each provider's daemon routes live under.
const providerBase = (p: AgentProvider): string =>
    p === `codex` ? `/codex` : p === `grok` ? `/grok` : p === `kimi` ? `/kimi` : p === `gemini` ? `/gemini` : `/claude`;
// Providers whose ONLY credential is the translator subscription: they have no native account handshake, so the
// card shows the routed row alone and there is nothing for `startConnect` to arm. Grok is deliberately absent —
// it has both a native xAI account and a routed subscription, and which one gates depends on the harness.
const subscriptionOnly = (p: AgentProvider): p is "codex" | "gemini" => p === `codex` || p === `gemini`;

// Which account the manage/connect card acts on — decoupled from the chat-turn provider so connecting or
// disconnecting one account never mutates the active conversation's provider.
const managedProvider = ref<AgentProvider>(turnDefaults.provider.value);

// Per-account token/cost totals (from the daemon's /system/usage aggregation of the activity log), keyed by
// account id. Loaded when the manage card opens; empty until then.
const accountUsage = ref<Record<string, UsageAccount>>({});
const loadUsage = async (): Promise<void> => {
    try {
        const body = await sandboxJson<{ accounts?: UsageAccount[] }>(`/system/usage`);
        accountUsage.value = Object.fromEntries((body.accounts ?? []).map((usage) => [usage.account, usage]));
    } catch {
        // Leave the last totals; usage is a non-critical display.
    }
};

/* Point the account card at a provider. That is ALL it does, and the emptiness is the point.
 *
 * It used to fire a connect handshake by itself whenever the card landed on an account-less native provider,
 * which is what made the switcher flicker: the row painted its "Connect" button, the /oauth/start round-trip
 * landed a moment later, and the button was yanked out from under the pointer and replaced by a device code
 * nobody had asked for. It also meant merely LOOKING at a provider minted a one-time code and started a
 * 15-minute poll, and it did so for three of the five tabs — the two that authenticate through the translator
 * never armed anything, so the same click did two different things depending on which chip it hit.
 *
 * Browsing is browsing: every provider now shows its state and waits to be asked (startConnect /
 * connectTranslator, from the row's own button). A live handshake is deliberately NOT cancelled here either —
 * both flows carry the provider they belong to, so a sign-in the user is completing at x.ai survives a look at
 * another tab instead of being silently killed by it. */
const setManagedProvider = (target: AgentProvider): void => {
    managedProvider.value = target;
};

// --- Routed-provider subscriptions (codex/grok UNDER the Claude Code harness) ------------------
// The sandbox's translator (CLIProxyAPI) serves codex/grok models to the Claude Code harness on the user's
// ChatGPT / SuperGrok subscription OAuth — a credential of its own, separate from the provider's native-harness
// account (each program owns and refreshes its own grant; a shared refresh token would rotate out from under
// one of them). The connection state itself lives in conversation.ts beside providerAccounts (so access.ts can
// derive from both without a cycle); what stays here is the login flow it is driven by — held outside
// SandboxAgent so a device-login poll survives that tab unmounting.
// The in-flight subscription login the Agent tab's routed row shows. `code` is the one-time device code for the
// providers that mint one; an EMPTY code means the provider redirects instead, so the row asks the user to paste
// the URL they landed on and `completeTranslator` finishes it against `state`. `baseline` is how many accounts
// the provider held when the login started — a provider can hold several, so "connected" is the count GROWING
// past it, not the provider being truthy (which an "add another account" login already is from the start).
const translatorConnectFlow = ref<{ provider: KeyedProvider; url: string; code: string; state: string; baseline: number } | undefined>(undefined);
/* The account write in flight right now, as the KEY of the thing being written: the provider id while a sign-in
 * is being started or finished, the account id / auth-file name while one is being dropped. One ref for both
 * mechanisms (native handshake and translator subscription alike), because it exists to answer one question the
 * card asks in one place: does THIS row's button spin?
 *
 * Keyed rather than boolean so the answer is that row's and not the whole card's — a click is acknowledged in
 * the button the user pressed, at the moment they press it, instead of by something appearing elsewhere a
 * round-trip later. Its other half is serialization: one account write at a time, which is the honest reading
 * of a card that shows one provider at a time. */
const accountBusy = ref<string | undefined>(undefined);
/* A routed row's key. Namespaced away from the provider id on purpose: under Grok the native xAI account and
 * the translator subscription are two connections of the SAME provider, sitting one above the other, and keying
 * both as `grok` made a click on either spin both their buttons. With `name`, one specific subscription (auth
 * file names are unique per provider, not across them); without it, that provider's sign-in. */
const translatorKey = (target: AgentProvider, name?: string): string => `translator:${target}${name === undefined ? `` : `:${name}`}`;
let translatorPollTimer: ReturnType<typeof setTimeout> | undefined;

const refreshTranslatorAccounts = async (): Promise<void> => {
    try {
        translatorAccounts.value = await sandboxJson<TranslatorAccounts>(`/translator/accounts`);
    } catch {
        // Non-fatal; the UI shows "not connected" until the daemon is reachable.
    }
};

// CLIProxyAPI finishes every routed login in the background — the device flows poll upstream on their own, and
// a redirect flow resumes the moment `completeTranslator` hands it the pasted URL — so in both cases the UI just
// polls the connection state until the provider flips connected, bounded by the native device flows' deadline.
const pollTranslatorOnce = async (target: KeyedProvider, deadline: number): Promise<void> => {
    if (translatorConnectFlow.value?.provider !== target) {
        return;
    }
    if (Date.now() > deadline) {
        error.value = `The ${target === `codex` ? `ChatGPT` : target === `grok` ? `SuperGrok` : `Google`} sign-in expired — start the connection again.`;
        translatorConnectFlow.value = undefined;
        return;
    }
    await refreshTranslatorAccounts();
    const flow = translatorConnectFlow.value;
    if (flow?.provider !== target) {
        return;
    }
    if (translatorAccounts.value[target].length > flow.baseline) {
        translatorConnectFlow.value = undefined;
        error.value = null;
        return;
    }
    translatorPollTimer = setTimeout(() => void pollTranslatorOnce(target, deadline), 3_000);
};

// Start a subscription login for a routed provider: the daemon returns the sign-in URL and, for the providers
// that mint one, a one-time code. The user approves upstream and the poll flips the row to connected. One flow
// at a time — a new connect supersedes a prior one (mirroring the daemon, which kills a superseded subprocess).
const connectTranslator = async (target: KeyedProvider): Promise<void> => {
    if (accountBusy.value !== undefined) {
        return;
    }
    accountBusy.value = translatorKey(target);
    error.value = null;
    clearTimeout(translatorPollTimer);
    try {
        translatorConnectFlow.value = {
            provider: target,
            baseline: translatorAccounts.value[target].length,
            ...(await sandboxJson<{ url: string; code: string; state: string }>(`/translator/${target}/connect`, { method: `POST` })),
        };
        translatorPollTimer = setTimeout(() => void pollTranslatorOnce(target, Date.now() + CODEX_POLL_DEADLINE_MS), 3_000);
    } catch (caught) {
        error.value = errorMessage(caught, `Could not start the subscription connection — is your sandbox online?`);
    } finally {
        accountBusy.value = undefined;
    }
};

// Finish a redirect login by handing the daemon the URL the provider sent the browser to. Google's sign-in ends
// on a loopback address only the sandbox container binds, so the page never loads for the user — but the address
// bar still carries the grant, which is what they paste here. The translator then resumes the exchange on its
// own, so success just means "keep polling"; the row flips connected on the next poll.
const completeTranslator = async (redirectUrl: string): Promise<void> => {
    const flow = translatorConnectFlow.value;
    if (flow === undefined) {
        return;
    }
    accountBusy.value = translatorKey(flow.provider);
    error.value = null;
    try {
        await sandboxJson(`/translator/${flow.provider}/complete`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ provider: flow.provider, redirectUrl: redirectUrl.trim(), state: flow.state }),
        });
        await refreshTranslatorAccounts();
    } catch (caught) {
        error.value = errorMessage(caught, `That sign-in link could not be completed — copy the whole URL and try again.`);
    } finally {
        accountBusy.value = undefined;
    }
};

// Drop ONE of the provider's connected accounts, addressed by its translator auth-file name.
const disconnectTranslator = async (target: KeyedProvider, name: string): Promise<void> => {
    accountBusy.value = translatorKey(target, name);
    try {
        await sandboxRequest(`/translator/${target}/disconnect`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ provider: target, name }),
        });
        if (translatorConnectFlow.value?.provider === target) {
            clearTimeout(translatorPollTimer);
            translatorConnectFlow.value = undefined;
        }
        await refreshTranslatorAccounts();
    } finally {
        accountBusy.value = undefined;
    }
};

// Abandon an in-flight subscription login. Dropping the flow is enough to stop its poll (every tick returns
// early once the flow it was started for is gone), but the pending timer is cleared too so a superseded tick
// can't fire against a row the user has moved on from.
const cancelTranslatorConnect = (): void => {
    clearTimeout(translatorPollTimer);
    translatorConnectFlow.value = undefined;
};

// Account / connection (global; the sandbox owns each provider's credentials). Several accounts per provider
// live in `providerAccounts` (conversation.ts module state). `error` carries connection / account errors —
// per-turn chat errors live on each Conversation. `connected` = the ACTIVE conversation's selection can send;
// `claudeConnected` = Claude specifically (the Sandbox page's card).
const error = ref<string | null>(null);
const hasAccount = (target: AgentProvider): boolean => accountsOf(target).length > 0;
// Whether a provider+harness selection can actually send — the composer gate, mirroring the daemon's own gate
// (agent.routes). Codex has no native account: it always authenticates through the translator's ChatGPT
// SUBSCRIPTION (native or under the Claude Code harness), so only that connection matters. Grok under the Claude
// Code harness likewise rides the translator subscription. Everything else needs the provider's account; an ACP
// provider is its own credential store — installed means chat-ready, so it never gates the composer.
const chatReady = (target: AgentProvider, loop: AgentHarness): boolean => {
    if (subscriptionOnly(target)) {
        return translatorAccounts.value[target].length > 0;
    }
    if (target === `grok` && loop === `claude-code`) {
        return translatorAccounts.value.grok.length > 0;
    }
    return hasAccount(target) || acpProviders.value.some((agent) => agent.id === target);
};
const connected = computed(() => chatReady(provider.value, harness.value));
const claudeConnected = computed(() => hasAccount(`claude`));

// Keep the composer usable whenever ANY provider has an account: when the connection state changes (initial
// load, a connect/disconnect, a sandbox reset), point each untouched fresh conversation whose selection can't
// send at a connected provider. Started conversations (a session or visible messages) are never auto-repointed —
// that would retire their session and insert a switch notice the user didn't ask for.
watch([providerAccounts, translatorAccounts], () => {
    for (const conversation of conversations.value) {
        if (
            conversation.session.value !== undefined ||
            conversation.messages.value.length > 0 ||
            chatReady(conversation.provider.value, conversation.harness.value)
        ) {
            continue;
        }
        const fallback = NATIVE_PROVIDERS.find((p) => providerReady(p));
        if (fallback) {
            conversation.selectProvider(fallback);
        }
    }
});
/* The in-flight NATIVE sign-in (Claude / Grok / Kimi), held between start and completion — deliberately the
 * same shape as translatorConnectFlow above, because the card renders the two identically and a difference in
 * the state is a difference the user ends up looking at.
 *
 * It carries the PROVIDER it belongs to, which is what lets a handshake outlive a look at another tab: the flow
 * unfolds under the row that started it and nowhere else, so browsing the switcher can neither smear a Grok
 * device code onto Claude's row nor force us to kill a sign-in the user is still completing at x.ai.
 *
 * `code` is the device code to approve upstream (Grok's, pre-filled at x.ai); it is empty for the flows that
 * hand the user something to paste back instead (Claude's authorization code, Kimi's API key). `pkce` is
 * Claude's verifier/state round-trip, carried to completeConnect and to nothing else. */
interface NativeConnectFlow {
    readonly provider: AgentProvider;
    readonly url: string;
    readonly code: string;
    readonly pkce?: { readonly verifier: string; readonly state: string };
}
const nativeConnectFlow = ref<NativeConnectFlow | undefined>(undefined);
// The display label the user typed for the account being connected (blank ⇒ the daemon derives one from the
// sign-in identity or a provider default). Bound by the account panel; read when a connect completes.
const connectLabel = ref(``);

// Add a freshly-connected account to its provider's list and make it the selected one.
const addAccount = (target: AgentProvider, added: OauthAccount): void => {
    const existing = accountsOf(target).filter((a) => a.id !== added.id);
    providerAccounts.value = { ...providerAccounts.value, [target]: [...existing, added] };
    selectedAccountId.value = { ...selectedAccountId.value, [target]: added.id };
    adoptStranded(target, added);
};

/* A reconnect mints a NEW account id, which leaves every chat still pinned to the old one sending against a
 * credential that no longer exists — measured in the incident this all comes from: a session kept failing for
 * a full minute AFTER the account was reconnected, purely because its tab held the dead id. Reconnecting means
 * "carry on", so the stranded chats move across and anything held for the outage goes now.
 *
 * Only chats whose account is missing or flagged for reauth move: adding a SECOND account alongside a healthy
 * one must not quietly redirect conversations away from the account the user chose for them. */
const adoptStranded = (target: AgentProvider, added: OauthAccount): void => {
    const live = accountsOf(target);
    for (const conversation of conversations.value) {
        if (conversation.provider.value !== target) {
            continue;
        }
        const current = conversation.account.value;
        if (current !== undefined && current !== added.id && !live.some((entry) => entry.id === current && entry.needsReauth !== true)) {
            conversation.rebindAccount(added.id);
        }
        void conversation.resume();
    }
};

/* adoptStranded's mirror image: conversations pinned to an account the provider's list no longer HAS, moved onto
 * the live pick. Two ways to get there — the account was disconnected in this window, or it was disconnected
 * while this window was away and the pin came back from the tab snapshot — and the same outcome either way: an
 * invisible dead pin, every turn on that chat failing with "No Claude account connected", naming a fix the user
 * has already done for an account that IS connected, because the dead id is the one thing the message can't
 * mention. `live` is the provider's current list; the pick it belongs with must already be reconciled against it.
 *
 * Rebound, not selected: the user didn't switch, their choice went away — so the session moves across with the
 * conversation and no "switched to…" divider is raised. Nothing to move to (the provider has no accounts left)
 * leaves the pin alone: the composer's connect gate is what has something to say then, not the account axis. */
const repointStranded = (target: AgentProvider, live: readonly OauthAccount[]): void => {
    const next = selectedAccountId.value[target];
    if (next === undefined) {
        return;
    }
    for (const conversation of conversations.value) {
        const pin = conversation.account.value;
        if (conversation.provider.value === target && pin !== undefined && !live.some((entry) => entry.id === pin)) {
            conversation.rebindAccount(next);
        }
    }
};

// Pull a provider's account list from its daemon and keep the selection valid (first account when the current
// pick is gone). The single reader of the `/accounts` routes. THROWS when the read fails (sandboxJson): a
// daemon that didn't answer has not told us the user has no accounts, and callers that treat the two the same
// are how an empty card comes to claim "not connected" during an outage.
const refreshAccounts = async (target: AgentProvider): Promise<OauthAccount[]> => {
    const list = (await sandboxJson<{ accounts?: OauthAccount[] }>(`${providerBase(target)}/accounts`)).accounts ?? [];
    providerAccounts.value = { ...providerAccounts.value, [target]: list };
    // Seed the shared usage map from the daemon's persisted snapshots, so a fresh page load shows each account's
    // remaining headroom immediately instead of staying blank until that account's next turn. A reading this
    // session already streamed wins when it is the newer of the two (the daemon's write is fire-and-forget, so
    // a refresh can land between the frame and its persist).
    const seeded = { ...usageStatusByAccount.value };
    for (const entry of list) {
        const persisted = entry.usage;
        if (persisted !== undefined && (seeded[entry.id]?.measuredAt ?? 0) <= persisted.measuredAt) {
            seeded[entry.id] = persisted;
        }
    }
    usageStatusByAccount.value = seeded;
    // The remembered pick, against the list that just landed — the only authority on whether it still exists.
    const picked = selectedAccountId.value[target];
    const valid = list.some((entry) => entry.id === picked) ? picked : list[0]?.id;
    if (valid !== picked) {
        selectedAccountId.value = { ...selectedAccountId.value, [target]: valid };
    }
    repointStranded(target, list);
    return list;
};

// Load a provider's live model catalog from the daemon into the shared records (providerModels/
// providerDefaultModel), then keep selections valid: point any native conversation on that provider whose
// model is no longer offered — and the persisted per-provider default — back to the live default (the same
// selection-fix refreshAccounts does for accounts). Claude-Code-harness selections are translator-mapped ids,
// not catalog ids, so they're left alone (claude itself is its own loop on either harness).
const loadProviderModelsOnce = async (target: AgentProvider): Promise<void> => {
    providerModelsState.value = { ...providerModelsState.value, [target]: `loading` };
    let body: { models: { id: string; label: string; efforts?: string[] }[]; default: string };
    try {
        const response = await sandboxRequest(`${providerBase(target)}/models`);
        if (!response.ok) {
            providerModelsState.value = { ...providerModelsState.value, [target]: `error` };
            return;
        }
        body = (await response.json()) as { models: { id: string; label: string; efforts?: string[] }[]; default: string };
        if (!Array.isArray(body.models)) {
            providerModelsState.value = { ...providerModelsState.value, [target]: `error` };
            return;
        }
    } catch {
        // The daemon is unreachable/mid-restart; the picker shows the error row with a Retry.
        providerModelsState.value = { ...providerModelsState.value, [target]: `error` };
        return;
    }
    providerModelsState.value = { ...providerModelsState.value, [target]: `loaded` };
    // The daemon's catalog is never empty; the guard keeps us from ever pinning a selection to nothing.
    if (body.models.length === 0) {
        return;
    }
    providerModels.value = {
        ...providerModels.value,
        [target]: body.models.map((entry) => ({
            label: entry.label,
            value: entry.id,
            ...(entry.efforts !== undefined ? { efforts: entry.efforts } : {}),
        })),
    };
    providerDefaultModel.value = { ...providerDefaultModel.value, [target]: body.default };
    // Every selection should carry a concrete offered id. Repoint anything empty OR no-longer-offered (a
    // since-renamed/retired id like `grok-code-fast-1`, or a tier alias once the real ids load) to the default,
    // so the picker highlights a selection and the chip always shows a name, never the bare icon. Harness-agnostic
    // now — the catalog is shared, so a claude-code codex/grok selection is validated the same as a native one.
    const valid = new Set(body.models.map((entry) => entry.id));
    for (const conversation of conversations.value) {
        if (conversation.provider.value === target && !valid.has(conversation.model.value)) {
            conversation.model.value = body.default;
        }
    }
    if (!valid.has(turnDefaults.models.value[target] ?? ``)) {
        turnDefaults.models.value = { ...turnDefaults.models.value, [target]: body.default };
    }
};

// One catalog load per provider at a time — the picker's on-open refresh, the reachable seam, and a manual
// retry all reach for the same list, and a second fetch would answer identically. Deduped by POLICY rather
// than by reading `providerModelsState` back as a mutex: that ref is what the picker RENDERS (spinner, error
// row), and using presentation state to decide whether a request may start meant a direct call while one was
// in flight duplicated the fetch, while `loaded` vs `loading` drifting for any other reason broke the dedup.
export const loadProviderModels = withConcurrency(loadProviderModelsOnce, { mode: `singleFlight`, key: (target) => target });

// Refresh every NATIVE provider's catalog — the reachable seam and the picker's on-open refresh both use this,
// so searching across providers always has all lists warm. ACP providers have no daemon catalog (the agent
// owns its own model). In-flight providers collapse into their running load, so this is safe to spam.
export const loadAllProviderModels = async (): Promise<void> => {
    await Promise.all(NATIVE_PROVIDERS.map((target) => loadProviderModels(target)));
};

// Device-code sign-in expires after 15 minutes; stop polling past it.
const CODEX_POLL_DEADLINE_MS = 15 * 60 * 1000;
let grokPollTimer: ReturnType<typeof setTimeout> | undefined;

// Drop any in-progress handshake: clear the poll timer and the connect UI state. Safe to call repeatedly.
const cancelConnect = (): void => {
    if (grokPollTimer !== undefined) {
        clearTimeout(grokPollTimer);
        grokPollTimer = undefined;
    }
    nativeConnectFlow.value = undefined;
    connectLabel.value = ``;
};

// One tick of the Grok device-flow poll: OpenCode completes the xAI token exchange on approval, so we just ask
// the sandbox whether xAI is connected yet, flipping to connected on success. Only the no-paste (device) flow
// polls; a paste-back method finishes via completeConnect instead. Supersession is checked against the flow
// OBJECT the tick was started for, so a restarted (or cancelled) handshake retires the ticks of the old one.
const pollGrokOnce = async (deadline: number): Promise<void> => {
    const flow = nativeConnectFlow.value;
    if (flow?.provider !== `grok`) {
        return;
    }
    if (Date.now() > deadline) {
        error.value = `The Grok sign-in expired — start the connection again.`;
        cancelConnect();
        return;
    }
    try {
        const grokAccounts = await refreshAccounts(`grok`);
        if (nativeConnectFlow.value !== flow) {
            return;
        }
        if (grokAccounts.length > 0) {
            cancelConnect();
            error.value = null;
            // The account just connected — load its model catalog now so the picker is populated immediately,
            // not only after the next reselect or reload.
            void loadProviderModels(`grok`);
            return;
        }
    } catch {
        // Transient (sandbox blip); keep polling until the deadline.
    }
    if (nativeConnectFlow.value !== flow) {
        return;
    }
    grokPollTimer = setTimeout(() => void pollGrokOnce(deadline), 3000);
};

// Reset the whole chat singleton when the active sandbox changes (see sandboxScope). Conversations, history,
// and the account-connection state all belong to the sandbox they were loaded from — carrying them onto a
// different sandbox would stream against the wrong daemon and show its "connected" status falsely.
export const resetChat = (): void => {
    for (const conversation of conversations.value) {
        conversation.abort();
    }
    /* Dropped BEFORE the tabs are rebuilt, not with the rest of the sandbox-scoped state below: restoring a tab
     * resolves its account against these, and the outgoing sandbox's list is not an answer about the incoming
     * one — it would validate the new sandbox's remembered pick against credentials from the old, and hand every
     * restored tab a foreign account id as the "first" one.
     *
     * Cleared rather than emptied-and-declared: the incoming sandbox's connections are unknown until ITS daemon
     * answers, and every surface shows that as a wait rather than as "you have nothing connected". */
    providerAccounts.value = perProvider<readonly OauthAccount[]>(() => []);
    accountsLoaded.value = false;
    // Rebuilds the tabs AND re-seeds the account pick from the incoming sandbox's own remembered one.
    restoreTabs();
    // The new sandbox's tabs get the same instant paint a reload does; the mirror is keyed by conversation, so
    // a switch reads that sandbox's transcripts, never the one just left.
    paintCachedTranscripts(conversations.value);
    sessions.value = [];
    providerModels.value = perProvider<ModelOption[]>(() => []);
    providerCommands.value = perProvider<readonly AgentCommand[]>(() => []);
    providerDefaultModel.value = perProvider(() => ``);
    providerModelsState.value = perProvider<CatalogLoadState>(() => `idle`);
    managedProvider.value = turnDefaults.provider.value;
    cancelConnect();
    clearTimeout(translatorPollTimer);
    translatorConnectFlow.value = undefined;
    accountBusy.value = undefined;
    translatorAccounts.value = { codex: [], grok: [], gemini: [] };
    error.value = null;
};

// --- Tabs -------------------------------------------------------------------------------------
/* Open a fresh empty conversation and focus it. The store half of "New agent" — every surface that offers the
 * action goes through startAgent (agents/agentActions.ts), which is the one place that also puts the caret in
 * the composer and, on mobile, navigates to the new agent's screen. Other tabs keep streaming.
 *
 * IDEMPOTENT, because the strip holds at most one untouched draft (see setConversations): pressed while such a
 * tab is already open, this hands that one back and focuses it rather than minting a second the write would drop
 * on the spot. The two are indistinguishable to the user — an empty draft has nothing in it to tell them apart —
 * so the difference was only ever visible as a "+" that did nothing. What the press is FOR then is the caret,
 * which startAgent asks for either way. */
const newChat = (): Conversation => {
    const open = conversations.value.find(untouchedDraft);
    if (open !== undefined) {
        setConversations(conversations.value, open.conversationId);
        return open;
    }
    const conversation = new Conversation();
    setConversations([...conversations.value, conversation], conversation.conversationId);
    return conversation;
};

// "Put the caret in the composer", as a signal rather than a call: the conversation list is store state, but
// the caret belongs to whichever chat surface is mounted (the docked panel, the mobile detail, a popped-out
// window), and only that component holds the textarea. A counter, not a flag — two "New agent" presses in a
// row must each land, and a re-focus of the same conversation is still a distinct request.
const composerFocus = ref(0);
export const focusComposer = (): void => {
    composerFocus.value++;
};

// Focus a tab, through the one writer — so leaving an untouched draft takes it with the same write that moves
// the focus. An id that names no open conversation is ignored rather than written: setConversations would seat
// the focus on the last tab instead, and a stale click would silently surface a chat the user didn't ask for.
const setActive = (conversationId: string): void => {
    if (conversations.value.some((conversation) => conversation.conversationId === conversationId)) {
        setConversations(conversations.value, conversationId);
    }
};

// Close a set of tabs (the tab ×, or the strip menu's Close / Close Others / Close to the Right / Close All):
// detach from each in-flight turn (Conversation.abort is soft — the daemon-side run keeps working and reopening
// reattaches to it), drop each cached transcript, and keep at least one conversation — a fresh chat when
// the set empties the strip. Closing the active tab moves focus to the last remaining one (VSCode behaviour, the
// same rule the workspace's closeTabs follows). The daemon-side sessions survive: a closed chat is still in History.
const closeTabs = (ids: ReadonlySet<string>): void => {
    for (const conversation of conversations.value) {
        if (ids.has(conversation.conversationId)) {
            conversation.abort();
            void dropTranscript(conversation.conversationId);
        }
    }
    const remaining = conversations.value.filter((conversation) => !ids.has(conversation.conversationId));
    const next = remaining.length > 0 ? remaining : [new Conversation()];
    setConversations(next, activeId.value);
};

// --- Active-conversation actions (forwarded) --------------------------------------------------
// The composer's one send path, whatever the conversation is doing: an idle chat starts a turn, a running one
// takes the message mid-turn (or holds it until it settles). See Conversation.enqueue.
const send = (prompt: string, staged?: readonly ChatAttachment[], editorContext?: EditorContext): Promise<void> => {
    // Core funnel milestone (autocapture misses Enter-key sends); PostHog derives "first message" per person.
    track(`message_sent`, { agent: active.value.provider.value, queued: active.value.streaming.value });
    return active.value.enqueue(prompt, staged, editorContext);
};

// Edit a past user message and re-run from that point — as a BRANCH, in a new tab. The turns before the
// edited message are copied into a fresh conversation which sends the edited text (with the original turn's
// attachments) as its first turn; the source conversation is untouched, so the answer being replaced is still
// there to compare against and nothing is destroyed by an experiment. The branch's first send seeds a fresh
// daemon session from the copied transcript, the same way a provider switch does.
const editAndResend = async (message: ChatMessage, text: string): Promise<void> => {
    const source = active.value;
    const index = source.messages.value.findIndex((entry) => entry.id === message.id);
    if (index === -1 || message.role !== `user` || source.streaming.value) {
        return;
    }
    const attachments = message.attachments ?? [];
    // Mirror send's own guard before opening a tab, so an empty edit doesn't leave an empty branch behind.
    if (text.trim().length === 0 && attachments.length === 0) {
        return;
    }
    const branch = new Conversation();
    branch.branchFrom(source, index);
    setConversations([...conversations.value, branch], branch.conversationId);
    track(`message_sent`, { agent: branch.provider.value, edited: true });
    await branch.send(text, branch.turnSettings(), attachments);
};

const stop = (): void => {
    active.value.stop();
};

// `nextMode` is the posture the approved plan executes in (Claude Code's auto-accept vs approve-each-edit
// choice); a rejection passes `plan` so the agent stays put and revises.
const decidePlan = (message: ChatMessage, approve: boolean, nextMode: PermissionMode, feedback?: string): Promise<void> =>
    active.value.decidePlan(message, approve, nextMode, feedback);

const answerQuestion = (message: ChatMessage, answers: Record<string, string[]>): Promise<void> => active.value.answerQuestion(message, answers);

const cancelQuestion = (message: ChatMessage): Promise<void> => active.value.cancelQuestion(message);

const decidePermission = (message: ChatMessage, decision: "once" | "always" | "deny", feedback?: string): Promise<void> =>
    active.value.decidePermission(message, decision, feedback);

// --- History ----------------------------------------------------------------------------------
// Refresh the history list from the sandbox's session store (call when opening the history menu). A query
// filters the list by chat title or content, server-side.
const loadSessions = async (query?: string): Promise<void> => {
    try {
        const response = await sandboxRequest(query ? `/sessions?query=${encodeURIComponent(query)}` : `/sessions`);
        if (!response.ok) {
            return;
        }
        const body = (await response.json()) as { sessions?: ChatSession[] };
        sessions.value = body.sessions ?? [];
    } catch {
        // Non-fatal; the menu shows whatever was loaded last.
    }
};

// Read a session's transcript from the daemon's session store, for both the history menu and the restored-tab
// rehydration watch. Returns undefined when the daemon has nothing, having reported it on the conversation.
const fetchTranscript = async (conversation: Conversation, id: string): Promise<RestoredMessage[] | undefined> => {
    try {
        const response = await sandboxRequest(`/sessions/${encodeURIComponent(id)}`);
        if (!response.ok) {
            conversation.error.value = `Could not open that conversation.`;
            return undefined;
        }
        const body = (await response.json()) as { messages?: RestoredMessage[] };
        return body.messages ?? [];
    } catch {
        conversation.error.value = `Could not open that conversation.`;
        return undefined;
    }
};

/* A registered agent's transcript, with the one distinction that matters to the TAB: NOT_FOUND is the daemon
 * saying this conversation has no registry entry any more (discarded, or a store that lost it), where a thrown
 * request or any other status says only that we could not ask right now. Archiving keeps the entry — the
 * registry holds archived agents and `entry(id)` finds them — so an archived agent answers 200 and its tab is
 * never touched by this.
 *
 * The 404 is only believed when the daemon ADVERTISES this route. A daemon older than this browser answers 404
 * for a route it simply doesn't have (see useDaemonRoutes), and reading that as "your agent is gone" would
 * unregister every open agent tab in the app against a sandbox that is merely behind. */
const fetchAgentTranscript = async (
    conversation: Conversation,
): Promise<{ sessionId?: string; messages: RestoredMessage[] } | "gone" | undefined> => {
    try {
        const response = await sandboxRequest(`/agents/${encodeURIComponent(conversation.conversationId)}/transcript`);
        if (response.status === 404 && supportsRoute(`agents.transcript`)) {
            return `gone`;
        }
        if (!response.ok) {
            conversation.error.value = `Could not open that conversation.`;
            return undefined;
        }
        const body = (await response.json()) as { sessionId?: string; messages?: RestoredMessage[] };
        return { ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}), messages: body.messages ?? [] };
    } catch {
        conversation.error.value = `Could not open that conversation.`;
        return undefined;
    }
};

// Bring a tab with no visible transcript up to date with the daemon: attach to the turn running for its
// conversation right now, or — when nothing is running — replay its stored session. Shared by the restore
// watch above and by opening a fleet agent, which is what lets an agent an AUTOMATION opened for an outside
// message read as an ordinary chat: its whole transcript (the configured prompt, the message that woke it,
// the reply) exists only daemon-side until this runs.
// Returns whether the tab is now as current as the daemon can make it. False means the round-trip itself
// failed, not that there was nothing to show: the caller drops its hydrating mark then, so the next
// reachability flip tries again instead of leaving a restored tab visibly empty until the window is reloaded.
const hydrate = async (conversation: Conversation): Promise<boolean> => {
    /* The transcript has to be in place BEFORE attaching to anything live. reattach appends the running turn's
     * prompt bubble to whatever the transcript currently holds, and marks the conversation streaming — which
     * makes the cache paint stand down — so attaching first renders the live turn onto an EMPTY transcript and
     * then persists that stub over a perfectly good local mirror when the run settles. That is how a chat comes
     * back from a reload showing nothing but the message you just sent, with its whole history still sitting
     * intact in the daemon's session store.
     *
     * The mirror read is local and cheap, so it always goes first. Only when it comes up empty — a conversation
     * this device has never painted, e.g. a fleet agent opened for the first time — is the daemon's session
     * store worth waiting on before attaching; that is also the only case where there is nothing to show
     * meanwhile, so the round-trip costs nothing the user can see. */
    await conversation.paintCached();
    // Whether anything is THERE, not whether this call is what put it there: the restore sweep paints the
    // mirror on its own, so a paint that declines because the transcript is already populated must not be read
    // as "empty" and pay a session fetch the user would wait through on every restored tab.
    const seeded = conversation.messages.value.length === 0;
    // A failed seed still lets the attach below run — a live turn is worth rendering either way — but it rides
    // out as the return value so the caller re-tries the read rather than settling for a tab that looks empty.
    const seededOk = seeded ? await replayStoredSession(conversation) : true;
    if (await conversation.reattach()) {
        return seededOk;
    }
    // With nothing running, what the mirror painted still has to be reconciled against the daemon — unless the
    // seeding above already read the very same store a moment ago.
    return seeded ? seededOk : await replayStoredSession(conversation);
};

// Redraw a conversation from the daemon's own session store — the authoritative transcript, and the only copy
// that survives a device with no local mirror. False when the READ failed, as opposed to finding nothing to
// show, so a transient round-trip failure is retried instead of leaving a restored tab visibly empty.
const replayStoredSession = async (conversation: Conversation): Promise<boolean> => {
    // A fleet conversation is stable across runtime switches; its session id is not. Resolve registered agents
    // by conversation/worktree identity, then adopt the SDK session that actually supplied the transcript so the
    // next turn resumes what the user is looking at. History-menu tabs still mean one exact runtime session.
    if (!runsClaudeCode(conversation.provider.value, conversation.harness.value)) {
        return true;
    }
    let restored: RestoredMessage[] | undefined;
    if (conversation.registered.value) {
        const transcript = await fetchAgentTranscript(conversation);
        if (transcript === undefined) {
            return false;
        }
        if (transcript === `gone`) {
            /* THE ONE THING THAT UNLATCHES `registered`. The latch exists to outlive the roster — an archive
             * takes the entry off the board, a dropped stream takes the whole roster away, and neither means a
             * tab has stopped being an agent. But a NAMED 404 for this exact id is the daemon answering about
             * this conversation, and a tab that goes on claiming a fleet identity nobody has is unreachable
             * from the board while it sits in the strip: the registry half of the fleet has no entry for it and
             * the DRAFT half skips it for being registered, so it shows up nowhere on /agents and the
             * focus-leave sweep — which only ever takes unregistered drafts — can never take it either. That is
             * how an empty, untitled, permanent "New agent" tab is born, in a strip that is supposed to be the
             * board under another skin.
             *
             * Unlatched, it is what it actually is again: a conversation the daemon has never registered. Empty,
             * that makes it an ordinary untouched draft, so the sweep below takes it the way it takes any other;
             * with a transcript in it, it stays open and readable, and its next send registers it anew (the
             * daemon rebuilds the entry at begin, the same path an archived agent's next message takes). */
            conversation.registered.value = false;
            setConversations(conversations.value, activeId.value);
        } else {
            restored = transcript.messages;
            if (transcript.sessionId !== undefined) {
                conversation.session.value = {
                    id: transcript.sessionId,
                    provider: conversation.provider.value,
                    account: conversation.account.value,
                    harness: conversation.harness.value,
                };
            }
        }
    }
    // Not an else: a tab that just lost its agent still has whatever SDK session it recorded, and that store is
    // a different one — the transcript may well be readable there after the registry entry is gone.
    if (restored === undefined) {
        const session = conversation.session.value;
        if (session === undefined) {
            return true;
        }
        restored = await fetchTranscript(conversation, session.id);
        if (restored === undefined) {
            return false;
        }
    }
    // An empty replay is not a transcript, it is the absence of one — the same distinction the mirror
    // makes when it refuses to save a blank. Painting it would blank a good cached transcript on any
    // daemon that answers but has nothing to say, which is exactly how a reopened tab goes empty.
    if (restored.length > 0) {
        conversation.restoreMessages(restored);
    }
    return true;
};

// Hydrate a tab once, holding the mark only while (and after) the daemon actually answered.
const hydrateOnce = (conversation: Conversation): void => {
    hydrating.add(conversation);
    void hydrate(conversation).then((current) => {
        if (!current) {
            hydrating.delete(conversation);
        }
    });
};

// Open (or focus) the tab bound to a fleet agent's conversationId, seeding identity from its registry
// summary. An isolated conversation's transcript is readable through /sessions after all — the SDK's store
// spans a repo's worktrees rather than one checkout — so the tab hydrates like any other instead of starting
// visually empty. Exported for useAgents.open.
export const openAgentConversation = (agent: {
    id: string;
    sessionId?: string;
    title?: string;
    provider: AgentProvider;
    harness: AgentHarness;
    account?: string;
    // Whether the fleet actually knows this agent — true unless the caller knows better. The board's
    // client-only DRAFT card is the one that does: its conversation must stay a draft (carded, and taken by
    // the focus-leave sweep when abandoned) until a first turn registers it.
    registered?: boolean;
}): Conversation => {
    const registered = agent.registered ?? true;
    const existing = conversations.value.find((conversation) => conversation.conversationId === agent.id);
    if (existing !== undefined) {
        setActive(existing.conversationId);
        // The fleet handed us this id, so the tab is a view of a real agent whatever the live roster says right
        // now — which is how an ARCHIVED agent opened from the archive view stopped painting a phantom "New
        // agent" card back onto the Active lane it had just left.
        if (registered) {
            existing.registered.value = true;
        }
        // An earlier probe may legitimately have found no transcript yet (the external runtime had not minted
        // its replacement SDK session). Opening the card is an explicit request to look again, not merely focus
        // the empty result that the restore sweep cached.
        if (existing.messages.value.length === 0 && !existing.streaming.value) {
            hydrateOnce(existing);
        }
        return existing;
    }
    const conversation = new Conversation(agent.id);
    conversation.registered.value = registered;
    conversation.provider.value = agent.provider;
    conversation.harness.value = agent.harness;
    conversation.account.value = agent.account ?? rememberedAccountFor(agent.provider);
    conversation.model.value = rememberedModelFor(agent.provider);
    conversation.title.value = agent.title ?? null;
    if (agent.sessionId !== undefined) {
        conversation.session.value = {
            id: agent.sessionId,
            provider: agent.provider,
            account: conversation.account.value,
            harness: agent.harness,
        };
    }
    setConversations([...conversations.value, conversation], conversation.conversationId);
    // The agent may be mid-turn right now — attach and render it live (the head synthesizes the prompt
    // bubble). Marked as hydrating so the restore watch above doesn't race a second attach; an idle agent's
    // probe just 404s and its stored transcript is replayed instead.
    hydrateOnce(conversation);
    return conversation;
};

// Open a past conversation: focus its tab if already open, else load its transcript into a new tab.
const openConversation = async (id: string): Promise<void> => {
    const existing = conversations.value.find((conversation) => conversation.session.value?.id === id);
    if (existing) {
        setActive(existing.conversationId);
        return;
    }
    const conversation = new Conversation();
    // Titled from the history row BEFORE the transcript round-trip: a nameless empty tab awaiting its fetch
    // is indistinguishable from an untouched draft, and the focus-leave sweep would close it mid-load.
    const title = sessions.value.find((session) => session.id === id)?.title ?? null;
    conversation.title.value = title;
    setConversations([...conversations.value, conversation], conversation.conversationId);
    const restored = await fetchTranscript(conversation, id);
    if (restored !== undefined) {
        conversation.loadTranscript(restored, id, title);
    }
};

// Restored tabs persist as session + title only — once their daemon is reachable, first try to ATTACH: a
// turn may be running for the conversation daemon-side (started before the reload, or by another window or
// device), and attaching renders it live mid-stream. Only when nothing is running does the flat transcript
// hydrate from the session store. `conversations` is in the source so tabs restored by a sandbox switch
// (when reachability may already be true and never flip) are still picked up; the WeakSet keeps unrelated
// tab churn from re-firing work already in flight. ponytail: /sessions/:id reads the Claude Code SDK's store,
// so a NATIVE codex/grok tab restores its draft, title, and session but not the visible transcript — the next
// turn still resumes the server thread.
const hydrating = new WeakSet<Conversation>();
// Conversations showing a locally cached transcript rather than a daemon-confirmed one. They still hydrate —
// the cache decides what the user looks at during the round-trip, not whether the round-trip happens — so the
// "already has messages, leave it alone" guard below must not mistake a painted mirror for live content.
const painted = new WeakSet<Conversation>();

// Paint every restored tab from the local mirror immediately, without waiting for the sandbox to be reachable
// (see transcriptCache). This is the whole point of the cache: a reopened chat is readable at once instead of
// after a probe, a tunnel round-trip, and a session-store read.
const paintCachedTranscripts = (list: readonly Conversation[]): void => {
    for (const conversation of list) {
        void conversation.paintCached().then((didPaint) => {
            if (didPaint) {
                painted.add(conversation);
            }
        });
    }
};
paintCachedTranscripts(conversations.value);

watch([reachable, conversations], ([isReachable]) => {
    if (!isReachable) {
        return;
    }
    for (const conversation of conversations.value) {
        if ((conversation.messages.value.length > 0 && !painted.has(conversation)) || conversation.streaming.value || hydrating.has(conversation)) {
            continue;
        }
        hydrateOnce(conversation);
    }
});

// --- Account / connection ---------------------------------------------------------------------
// Step 1 of connect. Claude: mint the authorize URL + PKCE challenge, stash verifier/state, expose the URL as a
// user-clicked link (finished via `completeConnect`). Codex: mint a one-time device code + verification URL and
// start the poll loop — the user signs in at ChatGPT and the account connects on its own. Surfaces the server's
// reason (sandbox offline / daemon still starting) inline on failure rather than as a silently-blocked popup.
// Moonshot's API-key page, surfaced as the "get your key" link in the Kimi connect card.
const KIMI_KEY_URL = `https://platform.moonshot.ai/console/api-keys`;

// Started by the row's own Connect button (never by a provider switch — see setManagedProvider), so the whole
// handshake is a thing the user asked for. `accountBusy` holds the provider for the length of the round-trip:
// that is the click's acknowledgement, and it is why the sign-in can only ever REPLACE the button that started
// it rather than appear next to a button still inviting the same click.
const startConnect = async (): Promise<void> => {
    const target = managedProvider.value;
    if (accountBusy.value !== undefined) {
        return;
    }
    cancelConnect();
    error.value = null;
    if (target === `kimi`) {
        // Kimi authenticates with an API key, not OAuth — there's no server `start`. Arm the paste UI (a link to
        // Moonshot's key page + the paste field) and finish in completeConnect by POSTing the key. No device
        // code: an empty `code` is what tells the card to render its paste field instead.
        nativeConnectFlow.value = { provider: `kimi`, url: KIMI_KEY_URL, code: `` };
        return;
    }
    // Busy for the WHOLE start, not just the fetch: clearing it a parse earlier would drop the button back to
    // "Connect" for a tick before the flow lands under it — the very blink this is here to remove.
    accountBusy.value = target;
    try {
        let response: Response;
        try {
            response = await sandboxRequest(`${providerBase(target)}/oauth/start`, { method: `POST` });
        } catch (err) {
            error.value = errorMessage(err, `Could not start the ${providerLabel(target)} connection — is your sandbox online?`);
            return;
        }
        if (!response.ok) {
            const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
            error.value = body?.error ?? `Could not start the ${providerLabel(target)} connection — is your sandbox online?`;
            return;
        }
        if (target === `grok`) {
            // xAI's headless device-code flow: the URL is x.ai's verification page with the code pre-filled, so
            // the user just opens it and approves (no paste-back). `code` is that same pre-filled code, shown
            // for reassurance. OpenCode polls to completion — we poll /grok/accounts until connected.
            const body = (await response.json()) as { url: string; code: string };
            nativeConnectFlow.value = { provider: `grok`, url: body.url, code: body.code };
            grokPollTimer = setTimeout(() => void pollGrokOnce(Date.now() + CODEX_POLL_DEADLINE_MS), 3000);
            return;
        }
        const body = (await response.json()) as { authorizeUrl: string; verifier: string; state: string };
        nativeConnectFlow.value = { provider: `claude`, url: body.authorizeUrl, code: ``, pkce: { verifier: body.verifier, state: body.state } };
    } finally {
        accountBusy.value = undefined;
    }
};

/* Point the account card at the provider the active conversation would send to — what it shows when it opens.
 * Skipped while a sign-in is in flight: that handshake (a device poll can outlive the card being closed and the
 * reachable-flash remounting it) owns what the card is looking at, and moving to another provider's rows would
 * hide the code the user is in the middle of approving.
 *
 * Nothing here tears a handshake down, and nothing does on the way out either — there is no "close" hook at all.
 * The Grok device flow completes out-of-band (the user approves at x.ai and the daemon exchanges tokens
 * server-side later), so cancelConnect stays the sole teardown, driven only by genuine invalidation:
 * completion (pollGrokOnce), the 15-minute deadline, a fresh startConnect, the user's own Cancel, or resetChat. */
const showActiveProvider = (): void => {
    if (nativeConnectFlow.value === undefined && translatorConnectFlow.value === undefined) {
        managedProvider.value = provider.value;
    }
};

/* Read every connection this sandbox holds — the providers' own accounts AND the translator's subscriptions.
 * One call, because to a user they are one question ("what is my agent signed in with?"), and because the
 * answer has to arrive as one state: two independently-landing halves is a card that rearranges itself twice.
 *
 * Landing the reads is also what earns the right to say "not connected": `accountsLoaded` flips only if a read
 * actually came back, so a daemon that is unreachable or mid-restart leaves the surfaces waiting (the reachable
 * seam retries) instead of asserting an empty state it cannot back up. The translator read is excluded from
 * that vote deliberately — it swallows its own failure, so it always "succeeds". */
const refreshConnections = async (): Promise<void> => {
    const natives = NATIVE_PROVIDERS.filter((target) => !subscriptionOnly(target));
    const [reads] = await Promise.all([Promise.allSettled(natives.map((target) => refreshAccounts(target))), refreshTranslatorAccounts()]);
    if (reads.some((read) => read.status === `fulfilled`)) {
        accountsLoaded.value = true;
    }
};

// Everything daemon-owned the chat needs, on the seam where it can first be read. Module-exported (like
// resetChat) for sandboxScope, which re-runs it whenever the active daemon becomes reachable — connections and
// catalogs live on the daemon, so reachability is the moment either can actually be asked for.
export const loadAccountStatus = async (): Promise<void> => {
    await Promise.all([
        // Which accounts and subscriptions this sandbox is signed in with — the gate every provider surface reads.
        refreshConnections(),
        // Model lists are daemon-owned too — load them on the same reachable seam so the pickers are ready.
        loadAllProviderModels(),
        // Installed ACP agents are providers too — surface them in the picker on the same seam.
        loadAcpProviders(),
        // Each provider's last-published slash commands, so a fresh conversation's `/` popover is populated
        // before its first turn. Claude only: the ACP list arrives per session on the wire anyway, and an ACP
        // provider isn't known until loadAcpProviders resolves.
        loadProviderCommands(`claude`),
    ]);
};

// Installed `agent`-kind capabilities (ACP agents), projected to picker entries: id + display label.
const loadAcpProviders = async (): Promise<void> => {
    try {
        const body = (await sandboxJson(`/capabilities`)) as { capabilities?: { id: string; kind: string; config: Record<string, unknown> }[] };
        acpProviders.value = (body.capabilities ?? [])
            .filter((entry) => entry.kind === `agent`)
            .map((entry) => ({ id: entry.id, label: typeof entry.config[`name`] === `string` ? (entry.config[`name`] as string) : entry.id }));
    } catch {
        // Leave the last list; the picker simply misses new agents until the next reachable load.
    }
};

// Step 2 of the paste-back connects. Claude: exchange the code Anthropic showed against the PKCE handshake.
// Only Claude has a paste-back step (exchange the code Anthropic showed against the PKCE handshake). Codex and
// Grok complete via their device poll loops — no code is entered in this app.
const completeConnect = async (code: string): Promise<boolean> => {
    const flow = nativeConnectFlow.value;
    accountBusy.value = flow?.provider;
    try {
        // Kimi: the pasted value is a Moonshot API key, stored as a new account (no OAuth exchange).
        if (flow?.provider === `kimi`) {
            let response: Response;
            try {
                response = await sandboxRequest(`/kimi/account/connect`, {
                    method: `POST`,
                    headers: { "content-type": `application/json` },
                    body: JSON.stringify({ apiKey: code.trim(), label: connectLabel.value.trim() || undefined }),
                });
            } catch {
                error.value = `Could not connect your Kimi account — check the API key and try again.`;
                return false;
            }
            if (!response.ok) {
                error.value = `Could not connect your Kimi account — check the API key and try again.`;
                return false;
            }
            addAccount(`kimi`, (await response.json()) as OauthAccount);
            cancelConnect();
            error.value = null;
            // The key just connected — its catalog (Moonshot /v1/models) may only now be discoverable.
            void loadProviderModels(`kimi`);
            return true;
        }
        if (flow?.pkce === undefined) {
            error.value = `Start the connection first.`;
            return false;
        }
        let response: Response;
        try {
            response = await sandboxRequest(`/claude/oauth/exchange`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ code, ...flow.pkce, label: connectLabel.value.trim() || undefined }),
            });
        } catch {
            error.value = `Could not connect your Claude account — check the code and try again.`;
            return false;
        }
        if (!response.ok) {
            error.value = `Could not connect your Claude account — check the code and try again.`;
            return false;
        }
        addAccount(`claude`, (await response.json()) as OauthAccount);
        cancelConnect();
        error.value = null;
        // The account just connected — supportedModels() needs a Claude credential, so the catalog may only now
        // be discoverable.
        void loadProviderModels(`claude`);
        return true;
    } finally {
        accountBusy.value = undefined;
    }
};

// Swap one account of a provider in place, leaving order and selection alone — the difference between a WRITE
// to an existing account and a new one arriving (see addAccount, which moves it to the end and selects it).
const replaceAccount = (target: AgentProvider, next: OauthAccount): void => {
    providerAccounts.value = {
        ...providerAccounts.value,
        [target]: accountsOf(target).map((entry) => (entry.id === next.id ? next : entry)),
    };
};

/* Rename one account of the managed provider. The credential is untouched — this writes the DISPLAY NAME, the
 * one thing that lets a second connection of the same provider tell itself apart when the provider hands back
 * no identity to derive one from (a pasted API key), or when the derived one isn't what the user calls it.
 *
 * Applied to the list BEFORE the round-trip and reconciled after: the name is the user's own keystrokes, so
 * showing it back to them is not a guess, and a rename that repaints a tunnel-latency later reads as one that
 * didn't take. The daemon's answer still wins (a blank means "back to the derived name", which only it knows),
 * and a failure re-reads rather than leaving an optimistic name standing over a write that never landed.
 *
 * Deliberately does NOT take `accountBusy`: that ledger drives the row's Disconnect spinner and gates
 * `startConnect`, and a rename is neither of those things. */
const renameAccount = async (id: string, label: string): Promise<void> => {
    const target = managedProvider.value;
    const typed = label.trim();
    const current = accountsOf(target).find((entry) => entry.id === id);
    if (current === undefined) {
        return;
    }
    if (typed !== ``) {
        replaceAccount(target, { ...current, label: typed });
    }
    let response: Response;
    try {
        response = await sandboxRequest(`${providerBase(target)}/account/rename`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ id, label: typed }),
        });
    } catch (err) {
        error.value = errorMessage(err, `Could not rename that account — is your sandbox online?`);
        replaceAccount(target, current);
        return;
    }
    if (!response.ok) {
        // A 404 means the row is gone (disconnected from another device or another tab), so re-read rather than
        // restore a name onto an account that no longer exists: the honest answer to a failed write is the
        // current truth, not the state we came from.
        error.value = response.status === 404 ? `That account is no longer connected.` : `Could not rename that account.`;
        await refreshAccounts(target).catch(() => replaceAccount(target, current));
        return;
    }
    replaceAccount(target, (await response.json()) as OauthAccount);
    error.value = null;
};

// Disconnect one account of the managed provider by id; drop it from the list and fix the selection. Busy for
// the round-trip, like every other account write — the row's own button says so.
const disconnect = async (id: string): Promise<void> => {
    const target = managedProvider.value;
    accountBusy.value = target;
    await sandboxRequest(`${providerBase(target)}/account/disconnect`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({ id }),
    })
        .catch(() => undefined)
        .finally(() => (accountBusy.value = undefined));
    const remaining = accountsOf(target).filter((entry) => entry.id !== id);
    providerAccounts.value = { ...providerAccounts.value, [target]: remaining };
    if (selectedAccountId.value[target] === id) {
        selectedAccountId.value = { ...selectedAccountId.value, [target]: remaining[0]?.id };
    }
    // The chats that were running on it move on too, rather than holding an id nothing can serve.
    repointStranded(target, remaining);
};

export function useChat() {
    return {
        conversations,
        activeId,
        active,
        sessions,
        messages,
        streaming,
        availableCommands,
        awaitingDecision,
        pendingPlanMessage,
        activeModel,
        contextUsage,
        mode,
        planApprovals,
        provider,
        selectProvider,
        harness,
        selectHarness,
        account,
        selectAccount,
        accounts,
        managedAccounts,
        accountUsage,
        model,
        selectModel,
        effort,
        thinking,
        draft,
        attachments,
        error,
        connected,
        claudeConnected,
        managedProvider,
        setManagedProvider,
        nativeConnectFlow,
        connectLabel,
        accountsLoaded,
        accountBusy,
        translatorKey,
        newChat,
        composerFocus,
        setActive,
        closeTabs,
        send,
        queued,
        removeQueued,
        steerable,
        editAndResend,
        stop,
        decidePlan,
        openPlanPreview,
        answerQuestion,
        cancelQuestion,
        decidePermission,
        loadSessions,
        openConversation,
        showActiveProvider,
        refreshConnections,
        loadUsage,
        startConnect,
        completeConnect,
        cancelConnect,
        renameAccount,
        disconnect,
        translatorAccounts,
        translatorConnectFlow,
        connectTranslator,
        completeTranslator,
        cancelTranslatorConnect,
        disconnectTranslator,
    };
}
