import { type AgentHarness, type AgentProvider, NATIVE_PROVIDERS, type OauthAccount, type UsageAccount } from "@intentic/sandbox-contract";
import { computed, ref, shallowRef, watch } from "vue";
import { router } from "../../router";
import {
    acpProviders,
    type ChatAttachment,
    type ChatMessage,
    type ChatMode,
    type ChatRole,
    Conversation,
    type PendingAttachment,
    planParts,
    type PlanRequest,
    providerAccounts,
    providerDefaultModel,
    providerModels,
    providerModelsState,
    rememberedAccountFor,
    rememberedModelFor,
    selectedAccountId,
    turnDefaults,
} from "./conversation";
import { track } from "../analytics";
import { sandboxJson, sandboxRequest } from "../sandbox/sandboxClient";
import { useSandbox } from "../sandbox/useSandbox";
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
// Transcripts are NOT persisted; the rehydration watch below re-fetches them from the daemon's session store.
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
}

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
                attachments: (Array.isArray(tab[`attachments`]) ? (tab[`attachments`] as Record<string, unknown>[]) : [])
                    .filter((entry) => typeof entry[`name`] === `string` && typeof entry[`path`] === `string`)
                    .map((entry) => ({ name: entry[`name`] as string, path: entry[`path`] as string })),
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
        conversation.draft.value = tab.draft;
        conversation.attachments.value = tab.attachments.map((file) => ({
            id: crypto.randomUUID(),
            name: file.name,
            path: file.path,
            status: `done` as const,
            progress: 1,
        }));
        conversation.title.value = tab.title ?? null;
        // Restore the harness before the model — the native/claude-code model lists diverge for codex/grok.
        if (tab.harness !== undefined) {
            conversation.harness.value = tab.harness;
        }
        if (tab.provider !== undefined) {
            conversation.provider.value = tab.provider;
            conversation.account.value = rememberedAccountFor(tab.provider);
            conversation.model.value = rememberedModelFor(tab.provider, conversation.harness.value);
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

// Past conversations from the sandbox's session store, loaded on demand for the history menu.
const sessions = ref<ChatSession[]>([]);

// Active-conversation facade — the chat panel binds these; they forward to the active tab so the
// message/composer template stays put as the user switches tabs.
const messages = computed(() => active.value.messages.value);
const streaming = computed(() => active.value.streaming.value);
const awaitingDecision = computed(() => active.value.awaitingDecision.value);
const pendingPlanMessage = computed(() => active.value.pendingPlanMessage.value);

// Open (or re-focus) the active conversation's plan preview tab in the main view — the tab id is derived from
// the conversation, so any plan card in the transcript reopens/replaces the same preview. Also the target of
// the auto-open watch below.
const { openPlan } = useWorkspaceTabs();
const openPlanPreview = (plan: PlanRequest): void => {
    openPlan(active.value.id, planParts(plan.text).title ?? `Plan`, plan.text);
    void router.push({ name: `workspace` });
};

// A newly proposed plan opens as a rendered markdown preview tab in the main view (Claude Code VSCode style);
// the approve/keep-planning buttons stay on the chat card. Keyed by decisionId so unrelated transcript updates
// (which re-create message objects) don't re-fire, while a revised plan — or switching to a chat tab with its
// own pending plan — opens/refreshes the preview. Watching the active-conversation facade means a background
// tab's plan never hijacks the main view; it opens when that tab is focused.
watch(
    () => pendingPlanMessage.value?.plan?.decisionId,
    (decisionId) => {
        const plan = pendingPlanMessage.value?.plan;
        if (decisionId === undefined || plan === undefined) {
            return;
        }
        openPlanPreview(plan);
    },
);

const activeModel = computed(() => active.value.activeModel.value);
const contextUsage = computed(() => active.value.contextUsage.value);
// The active conversation's permission mode (read + write) — the composer's mode pill drives it. Like the
// turn settings below, a pick writes through to the persisted defaults so the next new chat inherits it.
const mode = computed<ChatMode>({
    get: () => active.value.mode.value,
    set: (value) => {
        active.value.mode.value = value;
        turnDefaults.mode.value = value;
    },
});

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
// The active conversation's harness (native runtime vs the Claude Code loop). Only meaningful for codex/grok;
// picked through selectModel's "via Claude Code" rows. A switch retires the session at the next send.
const harness = computed<AgentHarness>(() => active.value.harness.value);
const model = computed<string>({
    get: () => active.value.model.value,
    set: (value) => {
        active.value.model.value = value;
        // Remember this model for the active conversation's provider, so switching provider away and back
        // restores it — per-provider memory, not one global model.
        turnDefaults.models.value = { ...turnDefaults.models.value, [active.value.provider.value]: value };
    },
});
// One picker row = one atomic selection: provider, harness, and model land together (the unified picker's
// rows span providers, and a codex/grok "via Claude Code" row is a harness choice too). The provider/harness
// selectors no-op when unchanged and carry the session-switch bookkeeping; claude ignores harness entirely
// (it is always its own loop), so its rows never touch it — a leftover claude-code harness on a claude
// conversation stays put and its session keeps resuming.
const selectModel = (pick: { provider: AgentProvider; harness: AgentHarness; value: string }): void => {
    const sameScope = pick.provider === provider.value && (pick.provider === `claude` || pick.harness === harness.value);
    if (streaming.value && !sameScope) {
        return;
    }
    if (pick.provider !== provider.value) {
        selectProvider(pick.provider);
    }
    if (pick.provider !== `claude`) {
        active.value.selectHarness(pick.harness);
    }
    active.value.model.value = pick.value;
    // Per-provider memory covers native picks only — claude-code translator ids are deterministic and derived
    // (rememberedModelFor), never persisted.
    if (pick.provider === `claude` || pick.harness === `native`) {
        turnDefaults.models.value = { ...turnDefaults.models.value, [pick.provider]: pick.value };
    }
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
    },
});
// Account facades: the active conversation's account selection + its picker. `accounts` lists the active
// provider's connected accounts for the composer switcher; `managedAccounts` the manage card's.
const account = computed<string | undefined>(() => active.value.account.value);
const selectAccount = (id: string): void => active.value.selectAccount(id);
// Providers are an open string vocabulary — an unseeded key (an ACP agent, which owns its own credentials)
// simply has no daemon account list.
const accountsOf = (provider: AgentProvider): readonly OauthAccount[] => providerAccounts.value[provider] ?? [];
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

// Per-provider labels + the route prefix each provider's daemon routes live under.
const providerLabel = (p: AgentProvider): string => (p === `codex` ? `ChatGPT` : p === `grok` ? `Grok` : `Claude`);
const providerBase = (p: AgentProvider): string => (p === `codex` ? `/codex` : p === `grok` ? `/grok` : `/claude`);

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
    if (accountManageOpen.value && accountsOf(target).length === 0) {
        void startConnect(); // startConnect drops any prior handshake first
        return;
    }
    cancelConnect();
};

// Account / connection (global; the sandbox owns each provider's credentials). Several accounts per provider
// live in `providerAccounts` (conversation.ts module state). `error` carries connection / account errors —
// per-turn chat errors live on each Conversation. `connected` = the ACTIVE conversation's provider has an
// account; `claudeConnected` = Claude specifically (the Sandbox page's card).
const error = ref<string | null>(null);
const hasAccount = (provider: AgentProvider): boolean => accountsOf(provider).length > 0;
// An ACP provider is its own credential store — installed means chat-ready, so it never gates the composer.
const connected = computed(() => hasAccount(provider.value) || acpProviders.value.some((agent) => agent.id === provider.value));
const claudeConnected = computed(() => hasAccount(`claude`));

// Keep the composer usable whenever ANY provider has an account: when the account lists change (initial load,
// a connect/disconnect, a sandbox reset), point each untouched fresh conversation sitting on an account-less
// provider at a connected one. Started conversations (a session or visible messages) are never auto-repointed —
// that would retire their session and insert a switch notice the user didn't ask for.
watch(providerAccounts, () => {
    for (const conversation of conversations.value) {
        if (conversation.session.value !== undefined || conversation.messages.value.length > 0 || hasAccount(conversation.provider.value)) {
            continue;
        }
        const fallback = ([`claude`, `codex`, `grok`] as const).find((p) => hasAccount(p));
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
// verifier/state to `completeConnect`; Codex holds the device-code identity the poll loop keeps sending; Grok
// (xAI OAuth via OpenCode) just tracks whether the method needs a pasted code — OpenCode owns the tokens.
type PendingAuth =
    | { provider: "claude"; verifier: string; state: string }
    | { provider: "codex"; deviceAuthId: string; userCode: string; interval: number }
    | { provider: "grok" };
let pendingAuth: PendingAuth | null = null;
// The one-time device code the user types into ChatGPT (codex only); shown in the account panel.
// Codex's device code and Grok's xAI device code both surface here — the one-time code shown in the card
// (Grok's is pre-filled at x.ai; the user just approves).
const userCode = ref<string | null>(null);
// The display label the user typed for the account being connected (blank ⇒ the daemon derives one from the
// sign-in identity or a provider default). Bound by the account panel; read when a connect completes.
const connectLabel = ref(``);

// Add a freshly-connected account to its provider's list and make it the selected one.
const addAccount = (provider: AgentProvider, account: OauthAccount): void => {
    const existing = accountsOf(provider).filter((a) => a.id !== account.id);
    providerAccounts.value = { ...providerAccounts.value, [provider]: [...existing, account] };
    selectedAccountId.value = { ...selectedAccountId.value, [provider]: account.id };
};

// Pull a provider's account list from its daemon and keep the selection valid (first account when the current
// pick is gone). The single reader of the `/accounts` routes.
const refreshAccounts = async (provider: AgentProvider): Promise<OauthAccount[]> => {
    const response = await sandboxRequest(`${providerBase(provider)}/accounts`);
    if (!response.ok) {
        return [...accountsOf(provider)];
    }
    const list = ((await response.json()) as { accounts?: OauthAccount[] }).accounts ?? [];
    providerAccounts.value = { ...providerAccounts.value, [provider]: list };
    if (!list.some((account) => account.id === selectedAccountId.value[provider])) {
        selectedAccountId.value = { ...selectedAccountId.value, [provider]: list[0]?.id };
    }
    return list;
};

// Load a provider's live model catalog from the daemon into the shared records (providerModels/
// providerDefaultModel), then keep selections valid: point any native conversation on that provider whose
// model is no longer offered — and the persisted per-provider default — back to the live default (the same
// selection-fix refreshAccounts does for accounts). Claude-Code-harness selections are translator-mapped ids,
// not catalog ids, so they're left alone (claude itself is its own loop on either harness).
export const loadProviderModels = async (provider: AgentProvider): Promise<void> => {
    providerModelsState.value = { ...providerModelsState.value, [provider]: `loading` };
    let body: { models: { id: string; label: string; efforts?: string[] }[]; default: string };
    try {
        const response = await sandboxRequest(`${providerBase(provider)}/models`);
        if (!response.ok) {
            providerModelsState.value = { ...providerModelsState.value, [provider]: `error` };
            return;
        }
        body = (await response.json()) as { models: { id: string; label: string; efforts?: string[] }[]; default: string };
        if (!Array.isArray(body.models)) {
            providerModelsState.value = { ...providerModelsState.value, [provider]: `error` };
            return;
        }
    } catch {
        // The daemon is unreachable/mid-restart; the picker shows the error row with a Retry.
        providerModelsState.value = { ...providerModelsState.value, [provider]: `error` };
        return;
    }
    providerModelsState.value = { ...providerModelsState.value, [provider]: `loaded` };
    // The daemon's catalog is never empty; the guard keeps us from ever pinning a selection to nothing.
    if (body.models.length === 0) {
        return;
    }
    providerModels.value = {
        ...providerModels.value,
        [provider]: body.models.map((entry) => ({
            label: entry.label,
            value: entry.id,
            ...(entry.efforts !== undefined ? { efforts: entry.efforts } : {}),
        })),
    };
    providerDefaultModel.value = { ...providerDefaultModel.value, [provider]: body.default };
    // Every native selection should carry a concrete offered id. Repoint anything empty OR no-longer-offered
    // (a since-renamed/retired id like `grok-code-fast-1`, or a tier alias once the real ids load) to the
    // default, so the picker highlights a selection and the chip always shows a name, never the bare icon.
    const valid = new Set(body.models.map((entry) => entry.id));
    for (const conversation of conversations.value) {
        const routed = conversation.harness.value === `claude-code` && conversation.provider.value !== `claude`;
        if (conversation.provider.value === provider && !routed && !valid.has(conversation.model.value)) {
            conversation.model.value = body.default;
        }
    }
    if (!valid.has(turnDefaults.models.value[provider] ?? ``)) {
        turnDefaults.models.value = { ...turnDefaults.models.value, [provider]: body.default };
    }
};

// Refresh every NATIVE provider's catalog (skipping ones already in flight) — the reachable seam and the
// picker's on-open refresh both use this, so searching across providers always has all lists warm. ACP
// providers have no daemon catalog (the agent owns its own model).
export const loadAllProviderModels = async (): Promise<void> => {
    await Promise.all(
        NATIVE_PROVIDERS.filter((target) => providerModelsState.value[target] !== `loading`).map((target) => loadProviderModels(target)),
    );
};

// Device-code sign-in expires after 15 minutes; stop polling past it.
const CODEX_POLL_DEADLINE_MS = 15 * 60 * 1000;
let codexPollTimer: ReturnType<typeof setTimeout> | undefined;
let grokPollTimer: ReturnType<typeof setTimeout> | undefined;

// Drop any in-progress handshake: clear the poll timers and the connect UI state. Safe to call repeatedly.
const cancelConnect = (): void => {
    if (codexPollTimer !== undefined) {
        clearTimeout(codexPollTimer);
        codexPollTimer = undefined;
    }
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

// One tick of the Codex device-code poll: ask the sandbox whether sign-in finished, flip to connected on
// success, else re-arm on the server-advised interval until the 15-minute deadline. Bails if the handshake
// was cancelled/replaced mid-await (identity check against the captured `auth`).
const pollCodexOnce = async (deadline: number): Promise<void> => {
    const auth = pendingAuth;
    if (auth?.provider !== `codex`) {
        return;
    }
    if (Date.now() > deadline) {
        error.value = `The ChatGPT sign-in code expired — start the connection again.`;
        cancelConnect();
        return;
    }
    try {
        const response = await sandboxRequest(`/codex/oauth/poll`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ deviceAuthId: auth.deviceAuthId, userCode: auth.userCode, label: connectLabel.value.trim() || undefined }),
        });
        if (pendingAuth !== auth) {
            return;
        }
        const body = response.ok ? ((await response.json()) as { pending: boolean; account?: OauthAccount }) : undefined;
        if (body !== undefined && !body.pending && body.account !== undefined) {
            addAccount(`codex`, body.account);
            cancelConnect();
            error.value = null;
            accountManageOpen.value = false;
            // The account just connected — its OAuth token may unlock model discovery, so refresh the catalog.
            void loadProviderModels(`codex`);
            return;
        }
    } catch {
        // Transient (sandbox blip); keep polling until the deadline.
    }
    if (pendingAuth !== auth) {
        return;
    }
    codexPollTimer = setTimeout(() => void pollCodexOnce(deadline), auth.interval * 1000);
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
    sessions.value = [];
    providerAccounts.value = { claude: [], codex: [], grok: [] };
    selectedAccountId.value = { claude: undefined, codex: undefined, grok: undefined };
    providerModels.value = { claude: [], codex: [], grok: [] };
    providerDefaultModel.value = { claude: ``, codex: ``, grok: `` };
    providerModelsState.value = { claude: `idle`, codex: `idle`, grok: `idle` };
    managedProvider.value = turnDefaults.provider.value;
    cancelConnect();
    error.value = null;
    accountManageOpen.value = false;
};

// --- Tabs -------------------------------------------------------------------------------------
// Open a fresh empty conversation and focus it (the composer's "+"). Other tabs keep streaming.
const newChat = (): void => {
    const conversation = new Conversation(`c${convSeq++}`);
    conversations.value = [...conversations.value, conversation];
    activeId.value = conversation.id;
};

const setActive = (id: string): void => {
    activeId.value = id;
};

// Close a tab: abort its in-flight turn, drop it, and keep at least one (a fresh chat if it was the last).
// Closing the active tab moves focus to the last remaining one.
const closeTab = (id: string): void => {
    const closing = conversations.value.find((conversation) => conversation.id === id);
    closing?.abort();
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
const send = (prompt: string, attachments?: readonly ChatAttachment[]): Promise<void> => {
    // Core funnel milestone (autocapture misses Enter-key sends); PostHog derives "first message" per person.
    track(`message_sent`, { agent: active.value.provider.value });
    return active.value.send(
        prompt,
        {
            agent: active.value.provider.value,
            harness: active.value.harness.value,
            account: active.value.account.value,
            model: active.value.model.value,
            effort: active.value.effort.value,
            thinking: active.value.thinking.value,
        },
        attachments,
    );
};

// Edit a past user message and re-run from that point: the conversation truncates at the message, retires
// its session, and re-sends the edited text (with the original turn's attachments) as a fresh turn.
const editAndResend = (message: ChatMessage, text: string): Promise<void> => {
    track(`message_sent`, { agent: active.value.provider.value, edited: true });
    return active.value.editAndResend(message.id, text, {
        agent: active.value.provider.value,
        harness: active.value.harness.value,
        account: active.value.account.value,
        model: active.value.model.value,
        effort: active.value.effort.value,
        thinking: active.value.thinking.value,
    });
};

const stop = (): void => {
    active.value.stop();
};

const decidePlan = (message: ChatMessage, approve: boolean, feedback?: string): Promise<void> => active.value.decidePlan(message, approve, feedback);

const answerQuestion = (message: ChatMessage, answers: Record<string, string[]>): Promise<void> => active.value.answerQuestion(message, answers);

const cancelQuestion = (message: ChatMessage): void => {
    active.value.cancelQuestion(message);
};

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

// Fetch a session's transcript from the daemon's session store into a conversation, arming its session id so
// the next turn resumes it. Shared by the history menu and the restored-tab rehydration watch.
const loadRemoteTranscript = async (conversation: Conversation, id: string, title: string | null): Promise<void> => {
    try {
        const response = await sandboxRequest(`/sessions/${encodeURIComponent(id)}`);
        if (!response.ok) {
            conversation.error.value = `Could not open that conversation.`;
            return;
        }
        const body = (await response.json()) as { messages?: { role: ChatRole; text: string }[] };
        conversation.loadTranscript(body.messages ?? [], id, title);
    } catch {
        conversation.error.value = `Could not open that conversation.`;
    }
};

// Open (or focus) the tab bound to a fleet agent's conversationId, seeding identity from its registry
// summary. An isolated conversation's transcript lives in its WORKTREE session namespace, which /sessions
// (main-tree-keyed) can't read — so a freshly-opened tab arms the session for server-side resume and starts
// visually empty, the same accepted restore shape codex/grok tabs have. Exported for useAgents.open.
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
    conversation.model.value = rememberedModelFor(agent.provider, agent.harness);
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
    await loadRemoteTranscript(conversation, id, sessions.value.find((session) => session.id === id)?.title ?? null);
};

// Restored tabs persist as session + title only — re-fetch their transcripts once their daemon is
// reachable. `conversations` is in the source so tabs restored by a sandbox switch (when reachability may
// already be true and never flip) are still picked up; the WeakSet keeps unrelated tab churn from re-firing a
// fetch already in flight. ponytail: /sessions/:id is Claude-only, so codex/grok tabs restore their draft,
// title, and session but not the visible transcript — the next turn still resumes the server thread.
const hydrating = new WeakSet<Conversation>();
watch([reachable, conversations], ([isReachable]) => {
    if (!isReachable) {
        return;
    }
    for (const conversation of conversations.value) {
        const session = conversation.session.value;
        if (session === undefined || session.provider !== `claude`) {
            continue;
        }
        if (conversation.messages.value.length > 0 || hydrating.has(conversation)) {
            continue;
        }
        hydrating.add(conversation);
        void loadRemoteTranscript(conversation, session.id, conversation.title.value);
    }
});

// --- Account / connection ---------------------------------------------------------------------
// Step 1 of connect. Claude: mint the authorize URL + PKCE challenge, stash verifier/state, expose the URL as a
// user-clicked link (finished via `completeConnect`). Codex: mint a one-time device code + verification URL and
// start the poll loop — the user signs in at ChatGPT and the account connects on its own. Surfaces the server's
// reason (sandbox offline / daemon still starting) inline on failure rather than as a silently-blocked popup.
const startConnect = async (): Promise<void> => {
    const target = managedProvider.value;
    cancelConnect();
    error.value = null;
    let response: Response;
    try {
        response = await sandboxRequest(`${providerBase(target)}/oauth/start`, { method: `POST` });
    } catch (err) {
        error.value = err instanceof Error ? err.message : `Could not start the ${providerLabel(target)} connection — is your sandbox online?`;
        return;
    }
    if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
        error.value = body?.error ?? `Could not start the ${providerLabel(target)} connection — is your sandbox online?`;
        return;
    }
    if (target === `codex`) {
        const body = (await response.json()) as { userCode: string; deviceAuthId: string; interval: number; verificationUri: string };
        pendingAuth = { provider: `codex`, deviceAuthId: body.deviceAuthId, userCode: body.userCode, interval: body.interval };
        authorizeUrl.value = body.verificationUri;
        userCode.value = body.userCode;
        codexPollTimer = setTimeout(() => void pollCodexOnce(Date.now() + CODEX_POLL_DEADLINE_MS), body.interval * 1000);
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

// Closing the card is a pure UI action — it must NOT abort an in-flight connect. The device flows (Grok/Codex)
// complete out-of-band (the user approves at x.ai / ChatGPT and the daemon exchanges tokens server-side later),
// so their poll has to outlive both this close and the reachable-flash that unmounts SandboxAgent. cancelConnect
// stays the sole handshake teardown, driven only by genuine invalidation: completion (pollGrokOnce/pollCodexOnce),
// the 15-min deadline, a fresh startConnect, a deliberate provider switch, or resetChat (sandbox switch).
const closeAccountManage = (): void => {
    accountManageOpen.value = false;
};

// Reflects the server's view of both providers' connections so the UI shows the right control on load and
// when the user switches provider. Module-exported (like resetChat) for sandboxScope, which re-runs it
// whenever the active daemon becomes reachable — connections live on the daemon, so reachability is the
// moment the status can actually be read.
export const loadAccountStatus = async (): Promise<void> => {
    await Promise.all([
        ...([`claude`, `codex`, `grok`] as const).map(async (target) => {
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
    const remaining = accountsOf(target).filter((account) => account.id !== id);
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
        awaitingDecision,
        pendingPlanMessage,
        activeModel,
        contextUsage,
        mode,
        provider,
        selectProvider,
        harness,
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
        setActive,
        closeTab,
        send,
        editAndResend,
        stop,
        decidePlan,
        openPlanPreview,
        answerQuestion,
        cancelQuestion,
        loadSessions,
        openConversation,
        openAccountManage,
        closeAccountManage,
        startConnect,
        completeConnect,
        disconnect,
    };
}
