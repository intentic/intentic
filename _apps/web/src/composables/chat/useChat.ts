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
    providerLabel,
    type RestoredMessage,
    type TranslatorAccounts,
    type UsageAccount,
} from "@intentic/sandbox-contract";
import { computed, ref, shallowRef, watch } from "vue";
import { router } from "../../router";
import {
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
import { type ChatAttachment, type ChatMessage, planParts, type PlanRequest } from "./transcript";
import { approvalsFor } from "./catalog";
import { dropTranscript } from "./transcriptCache";
import { usageStatusByAccount } from "./usageStatus";
import { track } from "../analytics";
import { withConcurrency } from "../concurrency";
import { sandboxJson, sandboxRequest } from "../sandbox/sandboxClient";
import { useSandbox } from "../sandbox/useSandbox";
import { errorMessage } from "../useAsyncAction";
import { useWorkspaceTabs } from "../workspace/useWorkspaceTabs";

// One past conversation in the sandbox's SDK session store, for the history menu.
export interface ChatSession {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
}

/* Manages the shared Claude Code chat as a module-level singleton: a set of concurrent conversations (the
 * tabs), plus the global account connection and turn preferences. A singleton
 * so the open conversations survive navigation between workspace areas (the chat panel lives in the
 * persistent shell). Each Conversation owns its own stream, so a background tab keeps generating while the
 * user views another. */

const { activeSandboxId, reachable } = useSandbox();

// Open conversations (tabs) and which one is active; always at least one. `convSeq` mints unique tab ids.
let convSeq = 1;
// shallowRef, not ref: a deep ref would unwrap each Conversation's internal Vue refs (messages, title, …)
// and mangle the class type. The instances' own refs stay reactive; reassigning the array triggers updates.
const conversations = shallowRef<Conversation[]>([]);
const activeId = ref<string>(``);

// --- Tab persistence ---------------------------------------------------------------------------
// Each sandbox's open tabs — session/provider identity, title, and the composer draft (text + done-upload
// metadata) — persist as one JSON blob, so a refresh or a switch back to the sandbox restores its open chats.
// Transcript CONTENT is not in this snapshot — it is mirrored to IndexedDB instead (see transcriptCache), so
// a restored tab paints from disk at once and the rehydration watch below then reconciles it with the daemon.
const chatTabsKey = (sandboxId: string): string => `intentic.chatTabs.${sandboxId}`;
// Providers are an open string vocabulary (native ids + installed ACP agent ids) — a stored provider is valid
// when non-empty; a since-removed ACP id degrades at send time (the daemon's unknown-provider error frame).
const validProvider = (value: unknown): value is AgentProvider => typeof value === `string` && value !== ``;

interface StoredTab {
    // The stable daemon-side conversation identity (fleet registry + worktree key); absent on a legacy
    // snapshot ⇒ a fresh one is minted on restore.
    readonly conversationId?: string;
    // Whether the conversation runs in its isolated worktree. Absent (legacy snapshot): a tab WITH a session
    // restores as main-tree (its session lives in /work's namespace); a fresh tab gets the isolated default.
    readonly isolated?: boolean;
    // The tab's turn selection; the session's provider may differ while a switch is picked but not yet sent.
    readonly provider?: AgentProvider;
    // The tab's harness selection (native vs the Claude Code loop); absent ⇒ the current default on restore.
    readonly harness?: AgentHarness;
    readonly session?: { id: string; provider: AgentProvider };
    readonly title?: string;
    readonly draft: string;
    readonly attachments: { name: string; path: string }[];
    // Messages submitted while a turn ran that hadn't reached the agent yet — user-written text, so a refresh
    // must not swallow them. They restore as queued (not as draft, which would collide with the real draft)
    // and go out when the tab's turn settles or with the user's next send. The editor-context chip on one is
    // deliberately dropped: it points at a selection this window no longer has.
    readonly queued: { text: string; attachments: { name: string; path: string }[] }[];
}

// The persisted shape of one attachment (upload metadata only — previewUrl/controller are client-session
// objects), read back defensively from the tab snapshot's draft and queued entries alike.
const readAttachments = (raw: unknown): { name: string; path: string }[] =>
    (Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [])
        .filter((entry) => typeof entry[`name`] === `string` && typeof entry[`path`] === `string`)
        .map((entry) => ({ name: entry[`name`] as string, path: entry[`path`] as string }));

// Validated read of a sandbox's persisted tab snapshot; anything malformed degrades to undefined (fresh tab).
const readTabs = (sandboxId: string | undefined): { active: number; tabs: StoredTab[] } | undefined => {
    if (sandboxId === undefined) {
        return undefined;
    }
    try {
        const raw = localStorage.getItem(chatTabsKey(sandboxId));
        if (raw === null) {
            return undefined;
        }
        const stored = JSON.parse(raw) as { active?: unknown; tabs?: unknown };
        if (!Array.isArray(stored.tabs) || stored.tabs.length === 0) {
            return undefined;
        }
        const tabs: StoredTab[] = [];
        for (const tab of stored.tabs as Record<string, unknown>[]) {
            if (typeof tab[`draft`] !== `string`) {
                return undefined;
            }
            const session = tab[`session`] as Record<string, unknown> | null | undefined;
            const validSession =
                typeof session === `object` && session !== null && typeof session[`id`] === `string` && validProvider(session[`provider`])
                    ? { id: session[`id`] as string, provider: session[`provider`] }
                    : undefined;
            tabs.push({
                draft: tab[`draft`],
                attachments: readAttachments(tab[`attachments`]),
                queued: (Array.isArray(tab[`queued`]) ? (tab[`queued`] as Record<string, unknown>[]) : [])
                    .filter((entry) => typeof entry[`text`] === `string`)
                    .map((entry) => ({ text: entry[`text`] as string, attachments: readAttachments(entry[`attachments`]) })),
                ...(typeof tab[`conversationId`] === `string` ? { conversationId: tab[`conversationId`] } : {}),
                ...(typeof tab[`isolated`] === `boolean` ? { isolated: tab[`isolated`] } : {}),
                ...(validProvider(tab[`provider`]) ? { provider: tab[`provider`] } : {}),
                ...(tab[`harness`] === `claude-code` || tab[`harness`] === `native` ? { harness: tab[`harness`] as AgentHarness } : {}),
                ...(validSession !== undefined ? { session: validSession } : {}),
                ...(typeof tab[`title`] === `string` ? { title: tab[`title`] } : {}),
            });
        }
        return { active: typeof stored.active === `number` ? stored.active : 0, tabs };
    } catch {
        return undefined;
    }
};

// Rebuild the tab set from the active sandbox's snapshot (a single fresh tab when none) and focus the stored
// active tab. Tab ids are minted anew — c0/c1 are ephemeral and never persisted. Restored attachments carry
// upload metadata only (no previewUrl/controller — those are client-session objects); the chip falls back to
// the file icon.
const restoreTabs = (): Conversation[] => {
    const stored = readTabs(activeSandboxId.value);
    if (stored === undefined) {
        const conversation = new Conversation(`c${convSeq++}`);
        activeId.value = conversation.id;
        return [conversation];
    }
    const restored = stored.tabs.map((tab) => {
        const conversation = new Conversation(`c${convSeq++}`, tab.conversationId);
        conversation.isolated.value = tab.isolated ?? tab.session === undefined;
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
            conversation.account.value = rememberedAccountFor(tab.provider);
            conversation.model.value = rememberedModelFor(tab.provider);
        }
        if (tab.session !== undefined) {
            // Account ids are daemon-minted and loaded fresh per sandbox, so a restored session re-derives its
            // account from the provider's remembered pick; its harness moves with the tab.
            conversation.session.value = {
                ...tab.session,
                account: rememberedAccountFor(tab.session.provider),
                harness: conversation.harness.value,
            };
        }
        return conversation;
    });
    activeId.value = restored[Math.min(Math.max(stored.active, 0), restored.length - 1)]!.id;
    return restored;
};

conversations.value = restoreTabs();

const active = computed<Conversation>(() => {
    const list = conversations.value;
    return list.find((conversation) => conversation.id === activeId.value) ?? list[0]!;
});

// Persist the tab snapshot on any change: the stringified getter touches every persisted field, so tab
// open/close/switch, keystrokes, uploads finishing, and session commits all write through automatically.
// ponytail: writes per keystroke; the blob is tiny — throttle if profiling shows jank.
watch(
    () =>
        JSON.stringify({
            active: conversations.value.findIndex((conversation) => conversation.id === activeId.value),
            tabs: conversations.value.map((conversation) => ({
                // JSON.stringify drops undefined keys, matching StoredTab's optional fields.
                conversationId: conversation.conversationId,
                isolated: conversation.isolated.value,
                provider: conversation.provider.value,
                harness: conversation.harness.value,
                session: conversation.session.value && { id: conversation.session.value.id, provider: conversation.session.value.provider },
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
        const sandboxId = activeSandboxId.value;
        if (sandboxId === undefined) {
            return;
        }
        try {
            localStorage.setItem(chatTabsKey(sandboxId), json);
        } catch {
            // Storage may be unavailable (private mode); the in-memory tabs still hold.
        }
    },
);

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
// The active conversation's undelivered messages (submitted while its turn was running) and whether its
// running turn can take one mid-flight — the composer renders the first and words its hints from the second.
const queued = computed(() => active.value.queued.value);
const removeQueued = (id: string): void => active.value.removeQueued(id);
const steerable = computed(() => active.value.steerable.value);

// Open (or re-focus) the active conversation's plan preview tab in the main view — the tab id is derived from
// the conversation, so any plan card in the transcript reopens/replaces the same preview. Also the target of
// the auto-open watch below.
const { openPlan } = useWorkspaceTabs();
const openPlanPreview = (plan: PlanRequest): void => {
    openPlan(active.value.id, planParts(plan.text).title ?? `Plan`, plan.text);
    void router.push({ name: `workspace` });
};

// A newly proposed plan opens as a rendered markdown preview tab in the main view (Claude Code VSCode style);
// the approve/keep-planning buttons stay on the chat card. Keyed by requestId so unrelated transcript updates
// (which re-create message objects) don't re-fire, while a revised plan — or switching to a chat tab with its
// own pending plan — opens/refreshes the preview. Watching the active-conversation facade means a background
// tab's plan never hijacks the main view; it opens when that tab is focused.
watch(
    () => pendingPlanMessage.value?.plan?.requestId,
    (requestId) => {
        const plan = pendingPlanMessage.value?.plan;
        if (requestId === undefined || plan === undefined) {
            return;
        }
        openPlanPreview(plan);
    },
);

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
        const response = await sandboxRequest(`/system/usage`);
        if (!response.ok) {
            return;
        }
        const usageAccounts = ((await response.json()) as { accounts?: UsageAccount[] }).accounts ?? [];
        accountUsage.value = Object.fromEntries(usageAccounts.map((usage) => [usage.account, usage]));
    } catch {
        // Leave the last totals; usage is a non-critical display.
    }
};

// Point the account card at a provider and prep its connect handshake: an in-progress handshake belongs to
// the previous account, so drop it, and (when the card is open on a provider with no account) start a fresh one.
const setManagedProvider = (target: AgentProvider): void => {
    // Re-selecting the already-managed provider while a handshake is live must NOT re-authorize: a fresh device
    // code would diverge from the sign-in tab the user already opened. Only (re)start on an actual switch.
    if (managedProvider.value === target && (authorizeUrl.value !== null || userCode.value !== null)) {
        return;
    }
    managedProvider.value = target;
    // Codex and Gemini have no native account handshake — both connect through the translator subscription
    // (connectTranslator), its own control in the card. And no up-front handshake when the active conversation
    // runs this provider ROUTED (under the Claude Code harness): that too is the translator subscription.
    // Otherwise, when the card is open on an account-less provider, prep the native handshake so the open-URL
    // anchor is a real user gesture.
    const routedActive = target === provider.value && target === `grok` && harness.value === `claude-code`;
    if (accountManageOpen.value && !subscriptionOnly(target) && accountsOf(target).length === 0 && !routedActive) {
        void startConnect(); // startConnect drops any prior handshake first
        return;
    }
    cancelConnect();
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
// the URL they landed on and `completeTranslator` finishes it against `state`.
const translatorConnectFlow = ref<{ provider: KeyedProvider; url: string; code: string; state: string } | undefined>(undefined);
const translatorBusy = ref<KeyedProvider | undefined>(undefined);
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
    if (translatorConnectFlow.value?.provider !== target) {
        return;
    }
    if (translatorAccounts.value[target]) {
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
    if (translatorBusy.value !== undefined) {
        return;
    }
    translatorBusy.value = target;
    error.value = null;
    clearTimeout(translatorPollTimer);
    try {
        translatorConnectFlow.value = {
            provider: target,
            ...(await sandboxJson<{ url: string; code: string; state: string }>(`/translator/${target}/connect`, { method: `POST` })),
        };
        translatorPollTimer = setTimeout(() => void pollTranslatorOnce(target, Date.now() + CODEX_POLL_DEADLINE_MS), 3_000);
    } catch (caught) {
        error.value = errorMessage(caught, `Could not start the subscription connection — is your sandbox online?`);
    } finally {
        translatorBusy.value = undefined;
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
    translatorBusy.value = flow.provider;
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
        translatorBusy.value = undefined;
    }
};

const disconnectTranslator = async (target: KeyedProvider): Promise<void> => {
    translatorBusy.value = target;
    try {
        await sandboxRequest(`/translator/${target}/disconnect`, { method: `POST` });
        if (translatorConnectFlow.value?.provider === target) {
            clearTimeout(translatorPollTimer);
            translatorConnectFlow.value = undefined;
        }
        await refreshTranslatorAccounts();
    } finally {
        translatorBusy.value = undefined;
    }
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
        return translatorAccounts.value[target];
    }
    if (target === `grok` && loop === `claude-code`) {
        return translatorAccounts.value.grok;
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
const authorizeUrl = ref<string | null>(null);
// Shared account-management panel state. The chat panel renders it, but other workspace areas can open it to
// hand users back to the single place where provider authorization is managed.
const accountManageOpen = ref(false);

// In-progress connect handshake, held only between start and completion. Claude round-trips PKCE
// verifier/state to `completeConnect`; Grok (xAI OAuth via OpenCode) just tracks the poll — OpenCode owns the
// tokens. (Codex has no native connect: it authenticates through the translator subscription, whose device
// login is a separate flow — connectTranslator above.)
type PendingAuth = { provider: "claude"; verifier: string; state: string } | { provider: "grok" } | { provider: "kimi" };
let pendingAuth: PendingAuth | null = null;
// Grok's xAI device code, surfaced in the card (pre-filled at x.ai; the user just approves).
const userCode = ref<string | null>(null);
// The display label the user typed for the account being connected (blank ⇒ the daemon derives one from the
// sign-in identity or a provider default). Bound by the account panel; read when a connect completes.
const connectLabel = ref(``);

// Add a freshly-connected account to its provider's list and make it the selected one.
const addAccount = (target: AgentProvider, added: OauthAccount): void => {
    const existing = accountsOf(target).filter((a) => a.id !== added.id);
    providerAccounts.value = { ...providerAccounts.value, [target]: [...existing, added] };
    selectedAccountId.value = { ...selectedAccountId.value, [target]: added.id };
};

// Pull a provider's account list from its daemon and keep the selection valid (first account when the current
// pick is gone). The single reader of the `/accounts` routes.
const refreshAccounts = async (target: AgentProvider): Promise<OauthAccount[]> => {
    const response = await sandboxRequest(`${providerBase(target)}/accounts`);
    if (!response.ok) {
        return [...accountsOf(target)];
    }
    const list = ((await response.json()) as { accounts?: OauthAccount[] }).accounts ?? [];
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
    if (!list.some((entry) => entry.id === selectedAccountId.value[target])) {
        selectedAccountId.value = { ...selectedAccountId.value, [target]: list[0]?.id };
    }
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
    pendingAuth = null;
    authorizeUrl.value = null;
    userCode.value = null;
    connectLabel.value = ``;
};

// One tick of the Grok device-flow poll: OpenCode completes the xAI token exchange on approval, so we just ask
// the sandbox whether xAI is connected yet, flipping to connected on success. Only the no-paste (device) flow
// polls; a paste-back method finishes via completeConnect instead.
const pollGrokOnce = async (deadline: number): Promise<void> => {
    const auth = pendingAuth;
    if (auth?.provider !== `grok`) {
        return;
    }
    if (Date.now() > deadline) {
        error.value = `The Grok sign-in expired — start the connection again.`;
        cancelConnect();
        return;
    }
    try {
        const grokAccounts = await refreshAccounts(`grok`);
        if (pendingAuth !== auth) {
            return;
        }
        if (grokAccounts.length > 0) {
            cancelConnect();
            error.value = null;
            accountManageOpen.value = false;
            // The account just connected — load its model catalog now so the picker is populated immediately,
            // not only after the next reselect or reload.
            void loadProviderModels(`grok`);
            return;
        }
    } catch {
        // Transient (sandbox blip); keep polling until the deadline.
    }
    if (pendingAuth !== auth) {
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
    convSeq = 1;
    conversations.value = restoreTabs();
    // The new sandbox's tabs get the same instant paint a reload does; the mirror is keyed by sandbox, so a
    // switch reads that sandbox's transcripts, never the one just left.
    paintCachedTranscripts(conversations.value);
    sessions.value = [];
    providerAccounts.value = perProvider<readonly OauthAccount[]>(() => []);
    selectedAccountId.value = perProvider<string | undefined>(() => undefined);
    providerModels.value = perProvider<ModelOption[]>(() => []);
    providerCommands.value = perProvider<readonly AgentCommand[]>(() => []);
    providerDefaultModel.value = perProvider(() => ``);
    providerModelsState.value = perProvider<CatalogLoadState>(() => `idle`);
    managedProvider.value = turnDefaults.provider.value;
    cancelConnect();
    clearTimeout(translatorPollTimer);
    translatorConnectFlow.value = undefined;
    translatorBusy.value = undefined;
    translatorAccounts.value = { codex: false, grok: false, gemini: false };
    error.value = null;
    accountManageOpen.value = false;
};

// --- Tabs -------------------------------------------------------------------------------------
// Open a fresh empty conversation and focus it. The store half of "New agent" — every surface that offers the
// action goes through startAgent (agents/agentActions.ts), which is the one place that also puts the caret in
// the composer and, on mobile, navigates to the new agent's screen. Other tabs keep streaming.
const newChat = (): Conversation => {
    const conversation = new Conversation(`c${convSeq++}`);
    conversations.value = [...conversations.value, conversation];
    activeId.value = conversation.id;
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

const setActive = (id: string): void => {
    activeId.value = id;
};

// Close a tab: abort its in-flight turn, drop it, and keep at least one (a fresh chat if it was the last).
// Closing the active tab moves focus to the last remaining one.
const closeTab = (id: string): void => {
    const closing = conversations.value.find((conversation) => conversation.id === id);
    closing?.abort();
    if (closing !== undefined) {
        void dropTranscript(closing.conversationId);
    }
    let next = conversations.value.filter((conversation) => conversation.id !== id);
    if (next.length === 0) {
        next = [new Conversation(`c${convSeq++}`)];
    }
    conversations.value = next;
    if (activeId.value === id) {
        activeId.value = next[next.length - 1]!.id;
    }
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
    const branch = new Conversation(`c${convSeq++}`);
    branch.branchFrom(source, index);
    conversations.value = [...conversations.value, branch];
    activeId.value = branch.id;
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

// Bring a tab with no visible transcript up to date with the daemon: attach to the turn running for its
// conversation right now, or — when nothing is running — replay its stored session. Shared by the restore
// watch above and by opening a fleet agent, which is what lets an agent an AUTOMATION opened for an outside
// message read as an ordinary chat: its whole transcript (the configured prompt, the message that woke it,
// the reply) exists only daemon-side until this runs.
const hydrate = async (conversation: Conversation): Promise<void> => {
    if (await conversation.reattach()) {
        return;
    }
    const session = conversation.session.value;
    if (session === undefined || session.provider !== `claude`) {
        return;
    }
    const restored = await fetchTranscript(conversation, session.id);
    // An empty replay is not a transcript, it is the absence of one — the same distinction the mirror
    // makes when it refuses to save a blank. Painting it would blank a good cached transcript on any
    // daemon that answers but has nothing to say, which is exactly how a reopened tab goes empty.
    if (restored !== undefined && restored.length > 0) {
        conversation.restoreMessages(restored);
    }
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
}): Conversation => {
    const existing = conversations.value.find((conversation) => conversation.conversationId === agent.id);
    if (existing !== undefined) {
        activeId.value = existing.id;
        return existing;
    }
    const conversation = new Conversation(`c${convSeq++}`, agent.id);
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
    conversations.value = [...conversations.value, conversation];
    activeId.value = conversation.id;
    // The agent may be mid-turn right now — attach and render it live (the head synthesizes the prompt
    // bubble). Marked as hydrating so the restore watch above doesn't race a second attach; an idle agent's
    // probe just 404s and its stored transcript is replayed instead.
    hydrating.add(conversation);
    void hydrate(conversation);
    return conversation;
};

// Open a past conversation: focus its tab if already open, else load its transcript into a new tab.
const openConversation = async (id: string): Promise<void> => {
    const existing = conversations.value.find((conversation) => conversation.session.value?.id === id);
    if (existing) {
        activeId.value = existing.id;
        return;
    }
    const conversation = new Conversation(`c${convSeq++}`);
    conversations.value = [...conversations.value, conversation];
    activeId.value = conversation.id;
    const restored = await fetchTranscript(conversation, id);
    if (restored !== undefined) {
        conversation.loadTranscript(restored, id, sessions.value.find((session) => session.id === id)?.title ?? null);
    }
};

// Restored tabs persist as session + title only — once their daemon is reachable, first try to ATTACH: a
// turn may be running for the conversation daemon-side (started before the reload, or by another window or
// device), and attaching renders it live mid-stream. Only when nothing is running does the flat transcript
// hydrate from the session store. `conversations` is in the source so tabs restored by a sandbox switch
// (when reachability may already be true and never flip) are still picked up; the WeakSet keeps unrelated
// tab churn from re-firing work already in flight. ponytail: /sessions/:id is Claude-only, so codex/grok
// tabs restore their draft, title, and session but not the visible transcript — the next turn still resumes
// the server thread.
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
        hydrating.add(conversation);
        void hydrate(conversation);
    }
});

// --- Account / connection ---------------------------------------------------------------------
// Step 1 of connect. Claude: mint the authorize URL + PKCE challenge, stash verifier/state, expose the URL as a
// user-clicked link (finished via `completeConnect`). Codex: mint a one-time device code + verification URL and
// start the poll loop — the user signs in at ChatGPT and the account connects on its own. Surfaces the server's
// reason (sandbox offline / daemon still starting) inline on failure rather than as a silently-blocked popup.
// Moonshot's API-key page, surfaced as the "get your key" link in the Kimi connect card.
const KIMI_KEY_URL = `https://platform.moonshot.ai/console/api-keys`;

const startConnect = async (): Promise<void> => {
    const target = managedProvider.value;
    cancelConnect();
    error.value = null;
    if (target === `kimi`) {
        // Kimi authenticates with an API key, not OAuth — there's no server `start`. Arm the paste UI (a link to
        // Moonshot's key page + the paste field) and finish in completeConnect by POSTing the key. Reuses
        // authorizeUrl/pendingAuth so the card's existing paste flow (shared with Claude) renders unchanged.
        pendingAuth = { provider: `kimi` };
        authorizeUrl.value = KIMI_KEY_URL;
        return;
    }
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
        // xAI's headless device-code flow: the URL is x.ai's verification page with the code pre-filled, so the
        // user just opens it and approves (no paste-back). `code` is that same pre-filled code, shown for
        // reassurance. OpenCode polls to completion — we poll /grok/accounts until connected.
        const body = (await response.json()) as { url: string; code: string };
        pendingAuth = { provider: `grok` };
        authorizeUrl.value = body.url;
        userCode.value = body.code;
        grokPollTimer = setTimeout(() => void pollGrokOnce(Date.now() + CODEX_POLL_DEADLINE_MS), 3000);
        return;
    }
    const body = (await response.json()) as { authorizeUrl: string; verifier: string; state: string };
    pendingAuth = { provider: `claude`, verifier: body.verifier, state: body.state };
    authorizeUrl.value = body.authorizeUrl;
};

const openAccountManage = (): void => {
    accountManageOpen.value = true;
    void loadUsage();
    // Another device may have (dis)connected a subscription since the reachable-seam load — show fresh state.
    void refreshTranslatorAccounts();
    // A connect handshake already in flight (a device poll that outlived a card close / the reachable-flash
    // remount) owns the managed provider — leave it be. Re-running setManagedProvider here would either mint a
    // fresh device code that diverges from the sign-in tab the user already opened, or hit its cancelConnect
    // path and kill the live poll.
    if (pendingAuth !== null) {
        return;
    }
    // Manage the accounts of the provider the active conversation would send to; setManagedProvider preps a
    // connect handshake up front only when that provider has no account yet (so the open-URL anchor is a real
    // gesture, never a browser-blocked programmatic popup).
    setManagedProvider(provider.value);
};

// Closing the card is a pure UI action — it must NOT abort an in-flight connect. The Grok device flow completes
// out-of-band (the user approves at x.ai and the daemon exchanges tokens server-side later), so its poll has to
// outlive both this close and the reachable-flash that unmounts SandboxAgent. cancelConnect stays the sole
// handshake teardown, driven only by genuine invalidation: completion (pollGrokOnce), the 15-min deadline, a
// fresh startConnect, a deliberate provider switch, or resetChat (sandbox switch).
const closeAccountManage = (): void => {
    accountManageOpen.value = false;
};

// Reflects the server's view of provider connections so the UI shows the right control on load and when the
// user switches provider. Module-exported (like resetChat) for sandboxScope, which re-runs it whenever the
// active daemon becomes reachable — connections live on the daemon, so reachability is the moment the status
// can actually be read. Codex and Gemini have no account list (both ride a translator subscription, loaded
// below), so only the providers with a sandbox-owned credential store are listed here.
export const loadAccountStatus = async (): Promise<void> => {
    await Promise.all([
        ...NATIVE_PROVIDERS.filter((target) => !subscriptionOnly(target)).map(async (target) => {
            try {
                await refreshAccounts(target);
            } catch {
                // Leave the lists as-is; the composer hint covers the account-less case.
            }
        }),
        // Model lists are daemon-owned too — load them on the same reachable seam so the pickers are ready.
        loadAllProviderModels(),
        // Installed ACP agents are providers too — surface them in the picker on the same seam.
        loadAcpProviders(),
        // Each provider's last-published slash commands, so a fresh conversation's `/` popover is populated
        // before its first turn. Claude only: the ACP list arrives per session on the wire anyway, and an ACP
        // provider isn't known until loadAcpProviders resolves.
        loadProviderCommands(`claude`),
        // The translator's subscription connections gate routed chats (codex/gemini always, grok under claude-code).
        refreshTranslatorAccounts(),
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
    // Kimi: the pasted value is a Moonshot API key, stored as a new account (no OAuth exchange).
    if (pendingAuth?.provider === `kimi`) {
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
    if (pendingAuth?.provider !== `claude`) {
        error.value = `Start the connection first.`;
        return false;
    }
    let response: Response;
    try {
        response = await sandboxRequest(`/claude/oauth/exchange`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ code, verifier: pendingAuth.verifier, state: pendingAuth.state, label: connectLabel.value.trim() || undefined }),
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
};

// Disconnect one account of the managed provider by id; drop it from the list and fix the selection.
const disconnect = async (id: string): Promise<void> => {
    const target = managedProvider.value;
    await sandboxRequest(`${providerBase(target)}/account/disconnect`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({ id }),
    }).catch(() => undefined);
    const remaining = accountsOf(target).filter((entry) => entry.id !== id);
    providerAccounts.value = { ...providerAccounts.value, [target]: remaining };
    if (selectedAccountId.value[target] === id) {
        selectedAccountId.value = { ...selectedAccountId.value, [target]: remaining[0]?.id };
    }
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
        authorizeUrl,
        userCode,
        connectLabel,
        accountManageOpen,
        newChat,
        composerFocus,
        setActive,
        closeTab,
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
        openAccountManage,
        closeAccountManage,
        startConnect,
        completeConnect,
        disconnect,
        translatorAccounts,
        translatorConnectFlow,
        translatorBusy,
        connectTranslator,
        completeTranslator,
        disconnectTranslator,
    };
}
