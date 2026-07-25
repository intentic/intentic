import {
    type AgentCommand,
    type AgentEvent,
    type AgentHarness,
    type AgentProvider,
    type AgentReply,
    type AskQuestion,
    type AttachFrame,
    type CatalogOption,
    type ContextUsage,
    type EditorContext,
    type ModelBadge,
    modelsFor,
    NATIVE_PROVIDERS,
    type NativeProvider,
    type OauthAccount,
    type PermissionAsk,
    type PermissionMode,
    providerLabel,
    sseData,
    sseFrames,
    type TodoItem,
    type ToolCallContent,
    type ToolCallLocation,
    type ToolCallStatus,
    type ToolKind,
} from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import { sandboxRequest } from "../sandbox/sandboxClient";
import { errorMessage } from "../useAsyncAction";
import { mentionPaths } from "./useMentions";
import { readTranscript, saveTranscript } from "./transcriptCache";
import { formatReset, usageStatusByAccount, usageStatusFor } from "./usageStatus";

// 'notice' is a small muted system line in the transcript (dismissed / kept planning / approved /
// stopped) — it keeps the user informed about control actions, Claude Code style.
export type ChatRole = "user" | "assistant" | "notice";

// The permission mode is the contract's PermissionMode — imported, not redeclared. The composer picks the
// turn's STARTING mode; the agent can then move itself (EnterPlanMode when a request turns out to need
// thinking through, ExitPlanMode once the user approves), which arrives back as a `mode` frame and drives
// this same ref. So the selector always shows the live posture, not just what the user last clicked.

// The provider (AgentProvider) and harness (AgentHarness) a turn runs on are the contract's wire enums —
// see schemas.ts for their semantics. Both are switchable mid-conversation: a session id only resumes on the
// runtime that minted it, so a switched turn retires the session and starts a fresh one seeded with the
// transcript so far (see Conversation.send).

// A live-catalog model option: the picker entry plus whatever the provider published about the model — the
// reasoning-effort tiers it accepts, its capability description, and capability badges. All optional because
// only Claude's discovery reports them; the OpenAI-compatible providers send ids alone and render label-only.
// Nothing here is ever synthesized locally, so a new release carries its own presentation with no code change.
export interface ModelOption extends CatalogOption {
    readonly efforts?: readonly string[];
    readonly description?: string;
    readonly badges?: readonly ModelBadge[];
}

// Seed one slot per native provider. AgentProvider is a bare string on the wire, so `Record<AgentProvider, T>`
// is `Record<string, T>` and a missing provider key is NOT a type error — it reads back as `undefined` and the
// provider silently loses its models, accounts or load state. Deriving every one of these records from the
// contract's own vocabulary is what makes adding a provider a single edit in NATIVE_PROVIDERS instead of a hunt
// through the literals below. `seed` runs per provider so no two share a mutable value.
export const perProvider = <T>(seed: (provider: NativeProvider) => T): Record<AgentProvider, T> =>
    Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, seed(provider)] as const));

// Every provider's model catalog is daemon-owned (/claude/models · /codex/models · /grok/models · /kimi/models ·
// /gemini/models — live discovery with a persisted/seed floor, never empty) and loaded into these records, so
// the pickers track provider renames and new releases without a static list. useChat.loadProviderModels fills
// them when a daemon is reachable; resetChat clears. Empty only until the first load.
export const providerModels = ref<Record<AgentProvider, ModelOption[]>>(perProvider<ModelOption[]>(() => []));
// Each provider's daemon-resolved default model id; empty only until the first load.
export const providerDefaultModel = ref<Record<AgentProvider, string>>(perProvider(() => ``));
// Per-provider catalog fetch state, so the picker can show a spinner/retry per provider group instead of a
// silently-empty list (every provider but Claude has no static floor to fall back on before its first load).
export type CatalogLoadState = "idle" | "loading" | "loaded" | "error";
export const providerModelsState = ref<Record<AgentProvider, CatalogLoadState>>(perProvider<CatalogLoadState>(() => `idle`));

// The model a fresh conversation seeds for a provider. Harness-independent: codex/grok run the SAME subscription
// model ids natively and under the Claude Code harness (the translator serves them), so the catalog no longer
// forks by harness. Every provider names its live daemon default; before the first catalog load Claude falls
// back to its stable `opus` alias (always valid) and codex/grok send empty (the daemon resolves its default).
const defaultModelFor = (provider: AgentProvider): string => {
    // An unseeded provider key (an ACP agent) has no catalog — the agent owns its own model, so empty rides.
    const live = providerDefaultModel.value[provider] ?? ``;
    if (live !== ``) {
        return live;
    }
    return provider === `claude` ? `opus` : ``;
};

// The model options for a provider's picker/chip: the provider's live daemon catalog, with the static catalog
// as the pre-load floor (Claude's tier aliases; codex/grok empty). Harness-independent (the harness is a
// separate axis now). Shared by the composer pill and the menu bodies so their list + label logic can't drift.
export const modelOptionsFor = (provider: AgentProvider): ModelOption[] => {
    const live = providerModels.value[provider] ?? [];
    return live.length > 0 ? live : modelsFor(provider);
};
// The slash commands each provider last published daemon-side (GET /agent/commands), loaded on the same
// reachable seam as accounts/models. A conversation's OWN list — replaced by every `commands` frame its turns
// emit — stays authoritative once it has run one; this is the seed that makes the composer's `/` popover work
// BEFORE that, since a provider's commands are a property of the workspace, not of one conversation. Empty
// until the first load, and until that provider has run a turn in the daemon's lifetime.
export const providerCommands = ref<Record<AgentProvider, readonly AgentCommand[]>>(perProvider<readonly AgentCommand[]>(() => []));

// Installed ACP agent providers (agent-kind capabilities): id + display label, loaded on the same reachable
// seam as accounts/models (useChat.loadAcpProviders) so the picker lists them. Empty until the first load.
export const acpProviders = ref<readonly { id: string; label: string }[]>([]);

// The display label for any provider: an ACP agent's capability name when known, else the shared static
// label (which itself falls back to the raw id).
export const providerDisplayLabel = (provider: AgentProvider): string =>
    acpProviders.value.find((agent) => agent.id === provider)?.label ?? providerLabel(provider);

// The display label for a selected model id — the option's label, else the raw id, else the provider name. The
// raw-id rung is what a custom model rides on: it belongs to no catalog by definition, and naming the provider
// there would hide WHICH model the turn actually runs. The provider name remains the floor for an EMPTY id, so
// the chip is never blank (Grok's catalog can be briefly empty on first load; an ACP agent owns its own model
// and carries no id at all).
export const modelLabelFor = (provider: AgentProvider, modelId: string): string => {
    const option = modelOptionsFor(provider).find((entry) => entry.value === modelId);
    if (option !== undefined) {
        return option.label;
    }
    return modelId === `` ? providerDisplayLabel(provider) : modelId;
};

// The provider tabs shown wherever accounts are picked (the account dialog + the composer's connect gate).
// Labels differ from the internal ids (codex → "ChatGPT").
export const providerTabs: readonly { value: AgentProvider; label: string }[] = [
    { value: `claude`, label: `Claude` },
    { value: `codex`, label: `ChatGPT` },
    { value: `grok`, label: `Grok` },
    { value: `kimi`, label: `Kimi Code` },
    { value: `gemini`, label: `Gemini` },
];

// A proposed plan awaiting the user's decision (the agent called ExitPlanMode). 'pending' shows the
// approve/keep-planning buttons; once decided the choice is frozen into the transcript.
export type PlanStatus = "pending" | "approved" | "rejected";

export interface PlanRequest {
    readonly requestId: string;
    readonly text: string;
    readonly status: PlanStatus;
}

// Split a plan's markdown into its leading heading (the plan card's header line) and the remaining body;
// without a heading the whole text is the body and the card falls back to a generic title.
export const planParts = (text: string): { title?: string; body: string } => {
    const match = /^\s*#{1,6}\s+(.+)/.exec(text);
    if (match === null) {
        return { body: text };
    }
    return { title: match[1]!.trim(), body: text.slice(match.index + match[0].length).trimStart() };
};

// A set of questions awaiting the user's picks. 'pending' shows the selectable card; once the user
// submits or dismisses, the choice is frozen into the transcript.
export type QuestionStatus = "pending" | "answered" | "cancelled";

export interface QuestionRequest {
    readonly requestId: string;
    readonly questions: AskQuestion[];
    readonly status: QuestionStatus;
    // Selected option label(s) per question text, captured on submit for the static summary.
    readonly answers?: Record<string, string[]>;
}

// A tool call awaiting the user's approval (the daemon's canUseTool gate). 'pending' shows the buttons; the
// answer then freezes into the transcript so the turn reads back as a record of what was allowed.
export type PermissionStatus = "pending" | "allowed" | "always" | "denied";

export interface PermissionRequest extends PermissionAsk {
    readonly requestId: string;
    readonly status: PermissionStatus;
}

// One tool call the sandbox agent made during a turn, built from its tool_call frame and merged-by-id with
// every later tool_call_update (status transitions, fresh content/locations — snapshots, not appends).
export interface ChatTool {
    readonly id: string;
    readonly name: string;
    readonly category: ToolKind;
    readonly status: ToolCallStatus;
    readonly target?: string;
    readonly locations?: readonly ToolCallLocation[];
    readonly content?: readonly ToolCallContent[];
}

// A file the user attached to a turn, already uploaded to the workspace before send. `previewUrl` is an
// object URL for image thumbnails — client-session only, gone on reload (restored history shows text).
export interface ChatAttachment {
    readonly name: string;
    // Workspace-relative upload destination (.intentic/attachments/<uuid>/<name>), sent on the turn.
    readonly path: string;
    readonly previewUrl?: string;
}

// A file staged in a conversation's composer, uploaded to the workspace the moment it's attached (send is
// then instant). Each lands in its own uuid dir so duplicate names never collide and the agent sees the real
// filename. `previewUrl` (object URL) and `controller` are client-session only — a restored entry has neither.
export interface PendingAttachment {
    readonly id: string;
    readonly name: string;
    // Workspace-relative destination: .intentic/attachments/<uuid>/<name>.
    readonly path: string;
    // Object URL for image thumbnails; revoked on remove, handed to the sent message on submit.
    readonly previewUrl?: string;
    readonly controller?: AbortController;
    status: `uploading` | `done` | `failed`;
    progress: number;
    error?: string;
}

// End-of-turn accounting from the SDK's result message.
export interface ChatUsage {
    readonly costUsd?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly durationMs?: number;
    readonly numTurns?: number;
}

export interface ChatMessage {
    readonly id: number;
    readonly role: ChatRole;
    readonly text: string;
    // Files the user attached to this turn (user bubbles only), for the chip/thumbnail row.
    readonly attachments?: readonly ChatAttachment[];
    // The workspace checkpoint capturing the state BEFORE this turn ran (user bubbles only, main-tree turns
    // only) — powers the hover "restore to before this message" affordance.
    readonly checkpointId?: string;
    // Accumulated extended-thinking text for assistant turns (empty when none / thinking off).
    readonly thinking?: string;
    // Set when this assistant turn proposed a plan; carries the approval state for the card UI.
    readonly plan?: PlanRequest;
    // Set when this assistant turn asked interactive questions; carries the answer state.
    readonly question?: QuestionRequest;
    // Set when a tool call on this turn needed the user's approval; carries the decision.
    readonly permission?: PermissionRequest;
    // Tool actions (Bash/Edit/…) the sandbox agent ran during this turn, newest last.
    readonly tools?: ChatTool[];
    // The agent's live task checklist (TodoWrite), replaced whole each time it updates.
    readonly todos?: TodoItem[];
    // Cost/token accounting, attached once the turn's result lands.
    readonly usage?: ChatUsage;
}

// What a conversation is doing right now, surfaced as the tab's status icon.
export type ConversationStatus = "idle" | "streaming" | "awaiting" | "error";

// The turn settings passed into a send — the active conversation's own selected provider/model/effort/thinking
// (see useChat's active-conversation facades), captured at send time.
export interface TurnSettings {
    readonly agent: AgentProvider;
    // Which harness runs the turn (native runtime vs the Claude Code loop). Orthogonal to `agent`.
    readonly harness: AgentHarness;
    // Which connected account of the provider serves the turn; undefined ⇒ the daemon's first account.
    readonly account: string | undefined;
    readonly model: string;
    readonly effort: string;
    readonly thinking: boolean;
}

// The persisted turn prefs, one JSON blob. Restored values are validated per field (enum for provider/mode,
// boolean for thinking) so a stale or hand-edited entry degrades to the defaults; model/effort stay plain
// strings — the Conversation constructor does the semantic clamping (codex model/effort scoping).
const TURN_DEFAULTS_KEY = `intentic.turnDefaults`;
const MODES: ReadonlySet<PermissionMode> = new Set([`plan`, `acceptEdits`, `default`, `bypassPermissions`]);

interface TurnDefaults {
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    readonly models: Record<AgentProvider, string>;
    readonly effort: string;
    readonly thinking: boolean;
    readonly mode: PermissionMode;
}

// Per-provider NATIVE model map: a stored string per provider, each degrading to that provider's native default
// when absent or malformed. The single point that parses the persisted record. (Claude-Code-harness models are
// deterministic — gpt-5-codex / grok-4 — so they aren't persisted; rememberedModelFor derives them.)
const readModels = (stored: unknown): Record<AgentProvider, string> => {
    const raw = (typeof stored === `object` && stored !== null ? stored : {}) as Record<string, unknown>;
    return perProvider((provider) => (typeof raw[provider] === `string` ? (raw[provider] as string) : defaultModelFor(provider)));
};

const readTurnDefaults = (): TurnDefaults => {
    const fallback: TurnDefaults = {
        provider: `claude`,
        harness: `native`,
        models: readModels(undefined),
        effort: `xhigh`,
        thinking: true,
        mode: `plan`,
    };
    try {
        const raw = localStorage.getItem(TURN_DEFAULTS_KEY);
        if (raw === null) {
            return fallback;
        }
        const stored = JSON.parse(raw) as Record<string, unknown>;
        return {
            // Only a native provider is restored: an ACP agent's id belongs to a capability that may no longer be
            // installed on the sandbox this session opens, so it degrades to Claude rather than to a dead picker.
            provider: NATIVE_PROVIDERS.includes(stored[`provider`] as NativeProvider) ? (stored[`provider`] as AgentProvider) : `claude`,
            harness: stored[`harness`] === `claude-code` ? `claude-code` : `native`,
            models: readModels(stored[`models`]),
            effort: typeof stored[`effort`] === `string` ? stored[`effort`] : fallback.effort,
            thinking: typeof stored[`thinking`] === `boolean` ? stored[`thinking`] : fallback.thinking,
            mode: MODES.has(stored[`mode`] as PermissionMode) ? (stored[`mode`] as PermissionMode) : fallback.mode,
        };
    } catch {
        return fallback;
    }
};

const seed = readTurnDefaults();

// The turn prefs a NEW conversation seeds from, persisted across reloads. A fresh-conversation provider pick
// writes back here (see Conversation.selectProvider), and useChat's facade setters write model/effort/
// thinking/mode through, so the next new chat — and the next session — inherit the last-used settings.
export const turnDefaults = {
    provider: ref<AgentProvider>(seed.provider),
    harness: ref<AgentHarness>(seed.harness),
    models: ref<Record<AgentProvider, string>>(seed.models),
    effort: ref<string>(seed.effort),
    thinking: ref<boolean>(seed.thinking),
    mode: ref<PermissionMode>(seed.mode),
};

watch(
    [turnDefaults.provider, turnDefaults.harness, turnDefaults.models, turnDefaults.effort, turnDefaults.thinking, turnDefaults.mode],
    ([provider, harness, models, effort, thinking, mode]) => {
        try {
            localStorage.setItem(TURN_DEFAULTS_KEY, JSON.stringify({ provider, harness, models, effort, thinking, mode }));
        } catch {
            // Storage may be unavailable (private mode); the in-memory refs still hold.
        }
    },
);

// The model to restore for a provider: the one the user last picked for it (persisted), else the provider's
// default. Harness-independent — the model survives a harness switch (the catalog is shared), so switching
// Default ↔ Claude Code keeps the chosen model. The single source every model-reset site routes through.
export const rememberedModelFor = (provider: AgentProvider): string => turnDefaults.models.value[provider] || defaultModelFor(provider);

// Connected provider accounts and the per-provider selection for new turns. In-memory (NOT persisted like
// turnDefaults): account ids are daemon-minted per sandbox, so they'd be meaningless across a sandbox switch —
// useChat.loadAccountStatus fills these when a daemon becomes reachable and resetChat clears them. Kept here
// (not in useChat) so a Conversation can seed/reset its account without importing useChat (a cycle).
export const providerAccounts = ref<Record<AgentProvider, readonly OauthAccount[]>>(perProvider<readonly OauthAccount[]>(() => []));
export const selectedAccountId = ref<Record<AgentProvider, string | undefined>>(perProvider<string | undefined>(() => undefined));

// The account a fresh turn on a provider uses: the user's explicit pick when it's still connected, else the
// provider's first connected account. The single source every account-reset site routes through.
export const rememberedAccountFor = (provider: AgentProvider): string | undefined => {
    // An unseeded provider key (an ACP agent) has no daemon account store — its own credential store serves it.
    const accounts = providerAccounts.value[provider] ?? [];
    const picked = selectedAccountId.value[provider];
    return accounts.some((account) => account.id === picked) ? picked : accounts[0]?.id;
};

// The client transcript as a daemon-seed history: user/assistant text turns only. Notices, tool runs, todos,
// and thinking are UI artifacts; a plan card's markdown IS the assistant's output in plan mode, so it rides.
export const transcriptOf = (messages: readonly ChatMessage[]): { role: "user" | "assistant"; text: string }[] =>
    messages.flatMap((message) => {
        if (message.role === `notice`) {
            return [];
        }
        const text = message.plan !== undefined ? [message.text, message.plan.text].filter((part) => part.length > 0).join(`\n\n`) : message.text;
        return text.trim().length > 0 ? [{ role: message.role, text }] : [];
    });

// A provider-minted resumable session and the runtime/account it belongs to — the trio is coherent by
// construction (captured together from the stream's session frame). A session only resumes on its own
// runtime/account; a mismatched selection at send time retires it.
export interface SessionRef {
    readonly id: string;
    readonly provider: AgentProvider;
    readonly account: string | undefined;
    // The harness that minted it — a session only resumes on the same runtime, so a harness switch retires it too.
    readonly harness: AgentHarness;
}

// One in-flight turn's streaming context: which assistant bubble frames write into (`id` is mutable — a plan
// card nulls it mid-turn, and each `usage` frame nulls it at the turn boundary, so the continuation / the
// next steered turn on the same stream opens a fresh bubble), plus the provider/account serving the turn —
// the attribution captured onto the session the stream mints.
interface TurnContext {
    id: number | null;
    // The turn's user bubble — the checkpoint frame anchors its restore affordance here.
    readonly userMessageId: number;
    readonly provider: AgentProvider;
    readonly account: string | undefined;
    readonly harness: AgentHarness;
}

// The head frame of an /agent/attach stream — the run's identity plus what a non-initiating window needs to
// synthesize the turn locally (user bubble from the prompt, elapsed readout from the start time).
type AttachHead = Extract<AttachFrame, { kind: "attached" }>;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* One chat conversation: its transcript, the resumed sandbox session, and the streaming machinery for a
 * turn. Self-contained so the manager can run several at once — each instance owns its AbortController and
 * typewriter loop, so tabs stream independently. A turn EXECUTES as a detached run on the sandbox daemon
 * (POST /agent starts it; the platform is not in the path) and this tab merely renders it via /agent/attach
 * — the same stream a reload, a second window, or another device attaches, resumable by seq cursor when the
 * connection drops. */
export class Conversation {
    readonly messages = ref<ChatMessage[]>([]);
    readonly streaming = ref(false);
    readonly error = ref<string | null>(null);
    // This conversation's slash commands — replaced whole per `commands` frame, listed by the composer's `/`
    // popover. Both provider families publish them: an ACP agent mid-session, Claude at each turn's init (plus
    // a republish whenever the session's list changes).
    readonly availableCommands = ref<readonly AgentCommand[]>([]);

    // True while a turn is paused on a card awaiting the user's input (a pending plan, question, or tool
    // permission). The attach stream stays open during this, so `streaming` is still true — but the agent
    // isn't generating, so the composer should drop the Stop spinner and show a ready Send (Claude Code style).
    readonly awaitingDecision = computed(() =>
        this.messages.value.some(
            (message) =>
                message.plan?.status === `pending` || message.question?.status === `pending` || message.permission?.status === `pending`,
        ),
    );

    // The message carrying a plan currently awaiting the user's decision, if any. Lets the composer route
    // typed feedback into a plan rejection (reject-with-feedback) instead of starting a fresh turn.
    readonly pendingPlanMessage = computed(() => this.messages.value.find((message) => message.plan?.status === `pending`));

    // Header title for this conversation; null shows "New chat". Derived from the first user message.
    readonly title = ref<string | null>(null);

    // The model the SDK actually resolved for the latest turn (from its init message), when reported.
    readonly activeModel = ref<string | null>(null);

    // Context-window fill for this conversation (tokens sent on the latest request vs the model's window),
    // updated at the end of each turn. Per-conversation, so the composer shows the active chat's meter.
    readonly contextUsage = ref<ContextUsage | undefined>();

    // Agent permission mode for this conversation, sent with each turn. Seeded from the persisted default
    // (plan — propose → approve — until the user picks otherwise).
    readonly mode = ref<PermissionMode>(turnDefaults.mode.value);

    // What this conversation is doing, for the tab's status icon.
    readonly status = computed<ConversationStatus>(() => {
        if (this.error.value !== null) {
            return `error`;
        }
        if (this.awaitingDecision.value) {
            return `awaiting`;
        }
        return this.streaming.value ? `streaming` : `idle`;
    });

    // The session the next matching turn resumes (Claude Code session / Codex thread / Grok session), captured
    // from the stream together with the provider/account that minted it. Public so the manager can focus an
    // already-open tab when the user reopens the same conversation from history.
    readonly session = ref<SessionRef | undefined>();

    // Whether this conversation's turns run in an isolated git worktree (the parallel-agents mode, the default
    // for new chats) or on the shared /work tree. Flipped off for history-menu restores (their sessions live in
    // the main tree's namespace) and legacy restored tabs.
    readonly isolated = ref(true);

    // The conversation's worktree identity from the turn's `worktree` frame: its agent/<id> branch and the
    // root repo's short base sha. Undefined until the first isolated turn runs (or on main-tree conversations).
    readonly worktree = ref<{ branch: string; base: string } | undefined>();

    // Lifetime accounting across the conversation's turns (finally surfaced — the fleet card and the usage
    // popover read these). The daemon's registry is the authoritative cross-device total; these accumulate the
    // turns THIS tab streamed, which matches it whenever the tab saw every turn.
    readonly costUsd = ref(0);
    readonly inputTokens = ref(0);
    readonly outputTokens = ref(0);

    // Start of the in-flight turn (ms), for the card's elapsed readout; undefined while idle.
    readonly turnStartedAt = ref<number | undefined>();

    // This conversation's turn selection, seeded from the module defaults at construction. All of it — provider
    // and account included — is switchable mid-chat (the composer binds them); send() decides whether the
    // session above still matches (resume) or a fresh one starts seeded with the transcript so far.
    readonly provider = ref<AgentProvider>(turnDefaults.provider.value);
    readonly harness = ref<AgentHarness>(turnDefaults.harness.value);
    readonly account = ref<string | undefined>(rememberedAccountFor(turnDefaults.provider.value));
    readonly model = ref<string>(rememberedModelFor(turnDefaults.provider.value));
    readonly effort = ref<string>(turnDefaults.effort.value);
    readonly thinking = ref<boolean>(turnDefaults.thinking.value);

    // This conversation's composer draft: the unsent message text and staged attachments. Per-tab so switching
    // tabs keeps each chat's draft; persisted per sandbox (see useChat's tab snapshot) so a refresh keeps it.
    readonly draft = ref(``);
    readonly attachments = ref<PendingAttachment[]>([]);

    private nextId = 1;

    // The one unsent "switched" divider notice, upserted/removed as the user toggles provider/account and made
    // permanent by the next send (the segment cut).
    private pendingSwitchNoticeId: number | undefined;

    // Aborts the in-flight ATTACH STREAM when the user hits Stop / closes the tab; cleared once the stream
    // settles. The turn itself runs detached on the daemon — only /agent/stop cancels it.
    private inflight: AbortController | null = null;

    // The in-flight reattach probe (see reattach), aborted by a send so the two never race one run.
    private probe: AbortController | undefined;

    // Typewriter buffer: deltas land here and a rAF loop drains them into the visible message a few characters
    // per frame, so the answer reveals smoothly regardless of how chunky the upstream deltas arrive. `typeId`
    // is the bubble being drained into; `rafId` is the active frame handle.
    private typeBuffer = ``;
    private typeId: number | null = null;
    private rafId: number | null = null;

    // `id` is the ephemeral tab id (c1, c2, … — never persisted); `conversationId` is the STABLE identity the
    // daemon keys the fleet registry entry and the worktree on. It survives provider/harness switches (which
    // retire sessions) and reloads (persisted in the tab snapshot), and its shape satisfies the wire's
    // branch/path-safety regex (a UUID: hex + hyphens, starts alphanumeric).
    constructor(
        readonly id: string,
        readonly conversationId: string = crypto.randomUUID(),
    ) {
        // Codex/Grok have no 'max' effort tier (only Claude does) — clamp a restored 'max'. The model is already
        // provider-correct from the seed (rememberedModelFor), so no model re-scope is needed.
        if (this.provider.value !== `claude` && this.effort.value === `max`) {
            this.effort.value = `xhigh`;
        }
    }

    // Switch the provider this conversation's next turn runs on and re-scope its provider-specific settings:
    // the model repoints to the new provider's remembered/live-default pick, and a non-Claude effort scale
    // tops out at xhigh. Writes the pick back to the module default so the next new chat inherits it. Mid-chat,
    // the switch takes effect at the next send — the current session is retired then and the new provider's
    // fresh session is seeded with the transcript so far (see send); browsing the picker never destroys it.
    selectProvider(next: AgentProvider): void {
        if (this.streaming.value || next === this.provider.value) {
            return;
        }
        this.provider.value = next;
        // Switching back to the session's own runtime restores its account, so the next send resumes it.
        this.account.value = next === this.session.value?.provider ? this.session.value.account : rememberedAccountFor(next);
        this.model.value = rememberedModelFor(next);
        if (next !== `claude` && this.effort.value === `max`) {
            this.effort.value = `xhigh`;
        }
        turnDefaults.provider.value = next;
        // The old segment's live model and context meter don't describe the next turn.
        this.activeModel.value = null;
        this.contextUsage.value = undefined;
        this.refreshSwitchNotice();
    }

    // Point the conversation's next turn at a specific account of its current provider (the account switcher).
    // Mid-chat, an account change — like a provider change — retires the session at the next send.
    selectAccount(id: string): void {
        if (this.streaming.value) {
            return;
        }
        this.account.value = id;
        selectedAccountId.value = { ...selectedAccountId.value, [this.provider.value]: id };
        this.refreshSwitchNotice();
    }

    // Switch the harness (native runtime vs the Claude Code loop) for the next turn. The model is kept — the
    // catalog is harness-independent now (codex/grok run the same subscription ids either way). Writes the pick
    // back to the module default so the next new chat inherits it. Mid-chat this retires the session at the next
    // send, exactly like a provider/account switch — the runtimes mint incompatible sessions. Meaningful only for
    // codex/grok; claude is always its own loop.
    selectHarness(next: AgentHarness): void {
        if (this.streaming.value || next === this.harness.value) {
            return;
        }
        this.harness.value = next;
        turnDefaults.harness.value = next;
        this.activeModel.value = null;
        this.contextUsage.value = undefined;
        this.refreshSwitchNotice();
    }

    // Upsert/remove the one pending "switched" divider as the user toggles provider/account: no notice when the
    // next send still resumes the session (the selection matches it) or the chat hasn't begun; otherwise one
    // notice says what the next message starts. send() freezes it into the transcript at the segment cut.
    private refreshSwitchNotice(): void {
        const session = this.session.value;
        const resumes =
            session !== undefined &&
            session.provider === this.provider.value &&
            session.account === this.account.value &&
            session.harness === this.harness.value;
        const started = this.messages.value.length > 0 || session !== undefined;
        if (resumes || !started) {
            if (this.pendingSwitchNoticeId !== undefined) {
                this.messages.value = this.messages.value.filter((message) => message.id !== this.pendingSwitchNoticeId);
                this.pendingSwitchNoticeId = undefined;
            }
            return;
        }
        // ACP providers have no tab entry — the shared label fallback (capability name layered by the picker,
        // else the raw id) covers them.
        const label = providerTabs.find((tab) => tab.value === this.provider.value)?.label ?? providerLabel(this.provider.value);
        // A restored codex/grok tab has a session but no readable transcript (the daemon's reader is
        // Claude-only) — there is nothing to carry over, so say so instead of promising continuity.
        const text = this.messages.value.some((message) => message.role !== `notice`)
            ? `Switched to ${label} — your next message starts a fresh session with the conversation so far carried over.`
            : `Switched to ${label} — your next message starts a fresh session (the earlier transcript isn't available to carry over).`;
        if (this.pendingSwitchNoticeId !== undefined) {
            this.messages.value = this.messages.value.map((message) => (message.id === this.pendingSwitchNoticeId ? { ...message, text } : message));
            return;
        }
        this.pendingSwitchNoticeId = this.nextId++;
        this.append({ id: this.pendingSwitchNoticeId, role: `notice`, text });
    }

    // Mirror the settled transcript to the local cache (see transcriptCache), so reopening this conversation
    // paints from disk rather than waiting on the sandbox. Fire-and-forget, and only where the transcript has
    // settled — a turn ending, a remote transcript landing — never per streamed frame.
    private persist(): void {
        void saveTranscript(this.conversationId, this.messages.value);
    }

    // Paint the locally cached transcript, if there is one and nothing has been rendered yet. Returns whether
    // anything was painted. The daemon still reconciles afterwards and REPLACES this — the cache only decides
    // what the user looks at during the round-trip, so a stale mirror costs a repaint and nothing more.
    async paintCached(): Promise<boolean> {
        if (this.messages.value.length > 0 || this.streaming.value) {
            return false;
        }
        const cached = await readTranscript(this.conversationId);
        // Re-checked after the await: a turn or a reattach may have landed while IndexedDB was reading, and
        // the live transcript always wins over the mirror.
        if (cached === undefined || this.messages.value.length > 0 || this.streaming.value) {
            return false;
        }
        this.messages.value = cached;
        this.nextId = Math.max(0, ...cached.map((message) => message.id)) + 1;
        return true;
    }

    // Seed this conversation as a BRANCH of `source` taken just before `index`: the turns before that point
    // become this conversation's transcript and its settings ride across, while the source is left completely
    // untouched — that is the whole point of branching over rewinding. No session is carried: a branch is a
    // new conversation daemon-side, and its first send seeds a fresh one from the transcript above via the
    // same `history` mechanism a provider switch already uses.
    branchFrom(source: Conversation, index: number): void {
        this.messages.value = source.messages.value.slice(0, index).map((message) => ({ ...message, id: this.nextId++ }));
        this.provider.value = source.provider.value;
        this.harness.value = source.harness.value;
        this.account.value = source.account.value;
        this.model.value = source.model.value;
        this.effort.value = source.effort.value;
        this.thinking.value = source.thinking.value;
        this.mode.value = source.mode.value;
        this.isolated.value = source.isolated.value;
        // Left null so send() names the branch after the edited message — two tabs sharing one title is the
        // one thing that makes a branch hard to find again.
        this.title.value = null;
    }

    // Restore a past conversation pulled from history: build bubbles from the stored transcript and arm its
    // session so the next turn resumes it in the sandbox.
    loadTranscript(messages: { role: ChatRole; text: string }[], sessionId: string, title: string | null): void {
        this.messages.value = messages.map((m) => ({ id: this.nextId++, role: m.role, text: m.text }));
        // History-menu sessions live in the MAIN tree's session namespace — resuming one in a worktree would
        // miss it. The fleet's own open path rehydrates isolated conversations separately.
        this.isolated.value = false;
        // The history menu lists Claude sessions only, so a restored conversation resumes on Claude, under the
        // current default Claude account (the transcript carries no account of its own).
        const account = rememberedAccountFor(`claude`);
        this.session.value = { id: sessionId, provider: `claude`, account, harness: `native` };
        this.provider.value = `claude`;
        this.harness.value = `native`;
        this.account.value = account;
        this.model.value = rememberedModelFor(`claude`);
        this.title.value = title;
        this.activeModel.value = null;
        this.error.value = null;
        this.persist();
    }

    async send(prompt: string, settings: TurnSettings, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<void> {
        const text = prompt.trim();
        if ((text.length === 0 && attachments.length === 0) || this.streaming.value) {
            return;
        }
        // A pending reattach probe must not race this send's own stream over the same run.
        this.probe?.abort();

        this.error.value = null;
        // The session is resumed only while the selection still matches the runtime/account that minted it — a
        // switched provider or account retires it, and the transcript so far (captured before this turn's
        // bubbles land) seeds the replacement session on the new runtime.
        const agent = settings.agent;
        const harness = settings.harness;
        const account = settings.account;
        const session = this.session.value;
        const resume =
            session !== undefined && session.provider === agent && session.account === account && session.harness === harness ? session : undefined;
        if (resume === undefined) {
            this.session.value = undefined;
        }
        const history = resume === undefined ? transcriptOf(this.messages.value).slice(-200) : [];
        // The switch divider (if any) is frozen into the transcript — the segment cut happened.
        this.pendingSwitchNoticeId = undefined;
        // First message of a fresh conversation names it — free, no model call.
        if (this.title.value === null) {
            this.title.value = this.deriveTitle(text.length > 0 ? text : attachments.map((file) => file.name).join(`, `));
        }
        const userMessageId = this.nextId++;
        this.append({ id: userMessageId, role: `user`, text, ...(attachments.length > 0 ? { attachments } : {}) });
        // Streaming context for the turn: the current text bubble — a fresh empty assistant message (so the
        // typing indicator shows immediately; a plan card clears it so the post-decision continuation streams
        // into a new bubble below the card) — plus the provider/account attribution for the session frame.
        const assistantId = this.nextId++;
        this.append({ id: assistantId, role: `assistant`, text: ``, thinking: `` });
        const turn: TurnContext = { id: assistantId, userMessageId, provider: agent, account, harness };
        this.streaming.value = true;
        this.turnStartedAt.value = Date.now();
        const controller = new AbortController();
        this.inflight = controller;

        // Uploaded attachments plus @-mentioned workspace paths — one wire field, the daemon resolves both the
        // same way (workspace-relative → absolute, folded into the prompt as a Read-tool note). Mentions never
        // render as chips: they're already visible inline in the text.
        const attachmentPaths = [
            ...attachments.map((file) => file.path),
            ...mentionPaths(text).filter((path) => !attachments.some((file) => file.path === path)),
        ];
        try {
            const response = await sandboxRequest(`/agent`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                signal: controller.signal,
                body: JSON.stringify({
                    prompt: text,
                    // The display title (derived above or user-chosen) seeds a fresh registry entry, so a
                    // renamed draft keeps its title through its first turn; existing entries keep theirs.
                    ...(this.title.value !== null ? { title: this.title.value } : {}),
                    ...(attachmentPaths.length > 0 ? { attachments: attachmentPaths } : {}),
                    agent,
                    // The stable conversation identity + the worktree opt-in: an isolated turn runs in this
                    // conversation's own git worktree (branch agent/<conversationId>) instead of /work.
                    conversationId: this.conversationId,
                    ...(this.isolated.value ? { isolated: true } : {}),
                    // The harness (loop) for the turn; `native` is the daemon's default, so only `claude-code`
                    // rides the wire — that's what routes codex/grok through the translator under the Claude Code loop.
                    ...(harness === `claude-code` ? { harness } : {}),
                    // Which connected account of the provider serves the turn; omitted (undefined dropped by
                    // JSON.stringify) ⇒ the daemon picks the provider's first account.
                    account,
                    // The resume rides only while the session still matches the selection; JSON.stringify
                    // drops the undefined key.
                    sessionId: resume?.id,
                    // The transcript seed for a fresh-after-switch session; mutually exclusive with sessionId.
                    ...(history.length > 0 ? { history } : {}),
                    // An empty selection (a catalog not yet loaded) is dropped from the wire; the daemon then
                    // resolves the provider's live catalog default server-side.
                    model: settings.model || undefined,
                    effort: settings.effort,
                    thinking: settings.thinking,
                    // The turn's STARTING permission posture. The daemon hands it straight to the SDK, so all
                    // four modes are real: 'plan' proposes-then-executes, 'default' prompts per tool on the
                    // permission card, 'acceptEdits' auto-accepts edits, 'bypassPermissions' asks nothing.
                    permissionMode: this.mode.value,
                    // The opt-in editor-context chip: the file (and selection) the user chose to attach.
                    ...(editorContext !== undefined ? { editorContext } : {}),
                }),
            });
            if (!response.ok) {
                throw new Error(
                    response.status === 409
                        ? `This agent is already running a turn in another window — wait for it to finish.`
                        : `Chat request failed (${response.status}).`,
                );
            }
            // The ack means the turn is running daemon-side regardless of what happens to this tab; from here
            // on this window is just one renderer of the run.
            const { run } = (await response.json()) as { run: string };
            await this.follow({ run, after: 0 }, () => turn, controller);
        } catch (err) {
            // A user-initiated Stop aborts the fetch; that's expected, not an error to surface.
            if (!(err instanceof DOMException && err.name === `AbortError`)) {
                this.error.value = errorMessage(err, `Chat failed.`);
            }
        } finally {
            this.flushType();
            this.inflight = null;
            this.streaming.value = false;
            this.turnStartedAt.value = undefined;
            this.persist();
        }
    }

    // Mid-turn steering: deliver a user message INTO the running turn (the daemon injects it between tool
    // calls — Claude Code's queue-and-steer). On the rare miss (the turn ended before delivery) the bubble is
    // withdrawn and the text goes back to the draft, so nothing is silently lost. The running turn keeps
    // streaming into its current bubble (above this message — that output answers what came before); a steer
    // the turn can't absorb runs as its own follow-up turn on the same stream, and the `usage` frame closing
    // the current turn retires the bubble, so that answer opens a fresh one below this message.
    async steer(text: string): Promise<void> {
        const trimmed = text.trim();
        if (trimmed.length === 0 || !this.streaming.value) {
            return;
        }
        const messageId = this.nextId++;
        this.append({ id: messageId, role: `user`, text: trimmed });
        const ok = await this.postTurnControl(`/agent/steer`, { conversationId: this.conversationId, text: trimmed });
        if (!ok) {
            this.messages.value = this.messages.value.filter((message) => message.id !== messageId);
            this.draft.value = this.draft.value.trim().length > 0 ? `${trimmed} ${this.draft.value}` : trimmed;
            this.appendNotice(`The turn ended before your message was delivered — send it again.`);
        }
    }

    // User-initiated Stop button: record a muted notice, hard-cancel the turn daemon-side (/agent/stop —
    // fire-and-forget; NOT_FOUND just means it already settled), then abort the local stream.
    stop(): void {
        if (!this.streaming.value) {
            return;
        }
        this.appendNotice(`Stopped.`);
        void this.postTurnControl(`/agent/stop`, { conversationId: this.conversationId });
        this.abort();
    }

    // Aborts this tab's attach stream; whatever streamed so far stays in the transcript. The run itself is
    // detached daemon-side, so this is soft BY DESIGN — stop() above pairs it with /agent/stop to hard-cancel.
    // Called bare by the manager when its tab is closed: the turn finishes and lands its work, and reopening
    // the conversation reattaches to it.
    abort(): void {
        this.flushType();
        this.probe?.abort();
        this.inflight?.abort();
    }

    // Attach to a turn already running daemon-side — started before a reload, or by another window/device on
    // the same conversation. False when nothing is live (or recently finished): the caller falls back to
    // transcript hydration. The attach head synthesizes what the initiating window appended locally: the
    // user bubble from the run's prompt and the elapsed readout from its start time.
    async reattach(): Promise<boolean> {
        if (this.streaming.value) {
            return true;
        }
        const controller = new AbortController();
        this.probe = controller;
        let engaged = false;
        const ensureTurn = (head: AttachHead): TurnContext | undefined => {
            // A send that started between this probe's entry check and the daemon's reply owns the stream.
            if (this.streaming.value) {
                return undefined;
            }
            engaged = true;
            this.inflight = controller;
            this.streaming.value = true;
            this.error.value = null;
            this.turnStartedAt.value = head.startedAt;
            const userMessageId = this.nextId++;
            this.append({ id: userMessageId, role: `user`, text: head.prompt });
            const assistantId = this.nextId++;
            this.append({ id: assistantId, role: `assistant`, text: ``, thinking: `` });
            return { id: assistantId, userMessageId, provider: this.provider.value, account: this.account.value, harness: this.harness.value };
        };
        try {
            return await this.follow({ run: undefined, after: 0 }, ensureTurn, controller);
        } finally {
            this.probe = undefined;
            if (engaged) {
                this.flushType();
                this.inflight = null;
                this.streaming.value = false;
                this.turnStartedAt.value = undefined;
                this.persist();
            }
        }
    }

    // Answers a pending plan card. The turn is parked on ExitPlanMode, so on approval it executes in `mode`
    // (the "auto-accept edits" vs "approve each edit" choice) and streams a closing turn; on rejection the
    // feedback is fed back and it re-plans.
    async decidePlan(message: ChatMessage, approve: boolean, mode: PermissionMode, feedback?: string): Promise<void> {
        const plan = message.plan;
        if (plan?.status !== `pending`) {
            return;
        }
        const ok = await this.reply({ kind: `plan`, requestId: plan.requestId, approve, mode, feedback });
        if (!ok) {
            this.error.value = `Could not record your plan decision — the turn may have ended.`;
            return;
        }
        this.attachCard(message.id, { plan: { ...plan, status: approve ? `approved` : `rejected` } });
        this.appendNotice(approve ? `Plan approved.` : `Kept planning.`);
        // Keep the rejection feedback visible as the user's turn — otherwise the typed text vanishes from the
        // transcript even though it was sent to the agent.
        const trimmed = feedback?.trim();
        if (!approve && trimmed) {
            this.append({ id: this.nextId++, role: `user`, text: trimmed });
        }
    }

    // Submits the user's picks for a pending question card. The turn is parked on the `ask` tool, which
    // unblocks and resumes using the answers.
    async answerQuestion(message: ChatMessage, answers: Record<string, string[]>): Promise<void> {
        const question = message.question;
        if (question?.status !== `pending`) {
            return;
        }
        const ok = await this.reply({ kind: `question`, requestId: question.requestId, answers });
        if (!ok) {
            this.error.value = `Could not submit your answers — the turn may have ended.`;
            return;
        }
        this.attachCard(message.id, { question: { ...question, status: `answered`, answers } });
    }

    // Dismisses a pending question. This TELLS the daemon (cancelled), rather than just dropping the stream:
    // the agent is parked inside its `ask` tool holding the conversation's run lock, so a client-side-only
    // dismissal would wedge the conversation until the daemon restarted. The tool result says the user
    // declined to answer, which lets the agent proceed on sensible defaults or ask again more cheaply.
    async cancelQuestion(message: ChatMessage): Promise<void> {
        const question = message.question;
        if (question?.status !== `pending`) {
            return;
        }
        const ok = await this.reply({ kind: `question`, requestId: question.requestId, cancelled: true });
        if (!ok) {
            this.error.value = `Could not dismiss the question — the turn may have ended.`;
            return;
        }
        this.attachCard(message.id, { question: { ...question, status: `cancelled` } });
        this.appendNotice(`Question dismissed.`);
    }

    // Answers a pending permission card. 'once' allows just this call, 'always' also persists the rules the
    // SDK suggested so the same tool stops asking, 'deny' blocks it and hands the reason back to the agent.
    async decidePermission(message: ChatMessage, decision: "once" | "always" | "deny", feedback?: string): Promise<void> {
        const permission = message.permission;
        if (permission?.status !== `pending`) {
            return;
        }
        const ok = await this.reply({ kind: `permission`, requestId: permission.requestId, decision, feedback });
        if (!ok) {
            this.error.value = `Could not record your decision — the turn may have ended.`;
            return;
        }
        const status = decision === `deny` ? `denied` : decision === `always` ? `always` : `allowed`;
        this.attachCard(message.id, { permission: { ...permission, status } });
    }

    // Un-parks the turn's pending card on the daemon's side channel. Returns whether it succeeded — a 404
    // means nothing holds that id any more (already answered, or the turn ended), which the callers surface
    // rather than silently freezing a card the agent is still waiting on.
    private async reply(body: AgentReply): Promise<boolean> {
        return this.postTurnControl(`/agent/reply`, body);
    }

    // Posts a turn-control message to the platform side-channel, which relays it to the sandbox daemon.
    // Returns whether it succeeded.
    private async postTurnControl(path: string, body: unknown): Promise<boolean> {
        try {
            const response = await sandboxRequest(path, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify(body),
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    // A free conversation title from a message: collapse whitespace and truncate to a header-sized snippet. No
    // model call — just the first user line.
    private deriveTitle(text: string): string {
        const clean = text.replace(/\s+/g, ` `).trim();
        return clean.length > 40 ? `${clean.slice(0, 40).trimEnd()}…` : clean;
    }

    /* Render a run by attaching to it, re-attaching from the seq cursor whenever the stream drops, until the
     * daemon says `end` (the run settled — every frame delivered) or the run disappears (404: finished past
     * retention, stopped, or never started). `ensureTurn` runs once, at the first attach head: the send path
     * already appended its bubbles and returns its prepared context; the reattach path synthesizes bubbles
     * from the head — or returns undefined to stand down when a send won the race. Returns whether the
     * stream ever engaged (a head arrived and ensureTurn produced a context). */
    private async follow(
        cursor: { run: string | undefined; after: number },
        ensureTurn: (head: AttachHead) => TurnContext | undefined,
        controller: AbortController,
    ): Promise<boolean> {
        let attached = false;
        let retryMs = 500;
        let turn: TurnContext | undefined;
        // Consecutive re-attaches that returned no new frames and no `end`. A run that keeps answering empty is
        // done with nothing left to stream (or never terminates its stream), so give up after a few rounds
        // rather than tight-looping the daemon at network speed. Reset the moment real progress arrives.
        let idleRounds = 0;
        for (;;) {
            if (controller.signal.aborted) {
                return attached;
            }
            let response: Response;
            try {
                response = await sandboxRequest(`/agent/attach`, {
                    method: `POST`,
                    headers: { "content-type": `application/json` },
                    signal: controller.signal,
                    body: JSON.stringify({
                        conversationId: this.conversationId,
                        ...(cursor.run !== undefined ? { run: cursor.run } : {}),
                        after: cursor.after,
                    }),
                });
            } catch {
                // Network drop between attaches. A probe that never engaged gives up (its caller retries on
                // the next reachability flip); an engaged stream backs off and retries — the turn may well
                // still be running, and the cursor resumes it exactly where this tab left off.
                if (controller.signal.aborted || !attached) {
                    return attached;
                }
                await delay(retryMs);
                retryMs = Math.min(retryMs * 2, 5_000);
                continue;
            }
            if (!response.ok || !response.body) {
                return attached;
            }
            retryMs = 500;
            const beforeAfter = cursor.after;
            try {
                for await (const frame of sseFrames(response.body)) {
                    const parsed = sseData(frame) as AttachFrame | undefined;
                    if (parsed === undefined || typeof parsed !== `object`) {
                        continue;
                    }
                    if (parsed.kind === `attached`) {
                        // A head naming a different run than the cursor's means a newer turn started while
                        // this tab was disconnected — that turn belongs at a different transcript position
                        // (after ITS user message), so this stream settles rather than misrendering it here.
                        if (cursor.run !== undefined && parsed.run !== cursor.run) {
                            return attached;
                        }
                        cursor.run = parsed.run;
                        turn ??= ensureTurn(parsed);
                        if (turn === undefined) {
                            return false;
                        }
                        attached = true;
                    } else if (parsed.kind === `frame`) {
                        cursor.after = parsed.seq;
                        if (turn !== undefined) {
                            this.handleEvent(parsed.event, turn);
                        }
                    } else if (parsed.kind === `end`) {
                        return attached;
                    }
                }
            } catch {
                // The stream broke mid-read — fall through and re-attach from the cursor.
            }
            // Reached only when the stream ENDED WITHOUT an `end` frame (a clean `end` returns above). If it also
            // delivered nothing new (cursor unmoved), the run has no more for us — a done run whose tail we
            // already hold, or one whose stream never terminates — so an immediate re-attach would spin. Back off,
            // and after a few empty rounds give up: what we hold is complete, and a live turn would have advanced
            // the cursor (resetting this). Real progress OR a fresh `end` keep the reconnect loop responsive.
            if (cursor.after === beforeAfter) {
                idleRounds += 1;
                if (idleRounds >= 3) {
                    return attached;
                }
                await delay(retryMs);
                retryMs = Math.min(retryMs * 2, 5_000);
            } else {
                idleRounds = 0;
            }
        }
    }

    private handleEvent(event: AgentEvent, turn: TurnContext): void {
        switch (event.kind) {
            case `delta`:
                if (event.text) {
                    this.appendDelta(this.currentTextId(turn), event.text);
                }
                return;
            case `thinking`:
                if (event.text) {
                    this.appendThinkingDelta(this.currentTextId(turn), event.text);
                }
                return;
            case `tool_call`: {
                this.appendTool(this.currentTextId(turn), event);
                // Follow-along: auto-open the file an edit touches (lazy import mirrors the terminal frame —
                // the chat model doesn't statically pull in the workspace-tabs chain).
                const toolCall = event;
                void import(`../workspace/useFollowAlong`).then((m) => m.useFollowAlong().followToolCall(toolCall));
                return;
            }
            case `tool_call_update`:
                // Merge the update into the call that produced it (matched by id); an update with no
                // matching tool is dropped rather than shown loose.
                this.mergeToolUpdate(event);
                return;
            case `todos`:
                this.setTodos(this.currentTextId(turn), event.items);
                return;
            case `checkpoint`:
                // The pre-turn workspace state's id — anchor the restore affordance on the turn's user bubble.
                this.messages.value = this.messages.value.map((message) =>
                    message.id === turn.userMessageId ? { ...message, checkpointId: event.id } : message,
                );
                return;
            case `commands`:
                // The provider's slash commands (ACP agents), replaced whole — the composer's `/` popover.
                this.availableCommands.value = event.items;
                return;
            case `usage`:
                // End-of-turn accounting — and the turn boundary: a steered conversation's stream can carry
                // several turns (a queued message the running turn couldn't absorb runs as its own turn after
                // this one settles), so retire the current bubble and let the next turn's frames open a fresh
                // one below the steered user message.
                this.flushType();
                this.setUsage(event);
                turn.id = null;
                return;
            case `rate_limit_info`: {
                // Account-wide subscription usage (5-hour / weekly window), keyed by the account that served
                // the turn so switching accounts shows the right window. Not tied to any bubble. Stamped with
                // the read time so it can be compared against the daemon's persisted snapshot on the next
                // `/accounts` load — whichever is newer wins, and the picker can say how stale a reading is.
                const { kind: _kind, account, ...snapshot } = event;
                if (account !== undefined) {
                    usageStatusByAccount.value = { ...usageStatusByAccount.value, [account]: { ...snapshot, measuredAt: Date.now() } };
                }
                return;
            }
            case `context_usage`:
                // Per-conversation context-window fill — held on this instance (not the singleton) so the
                // composer shows the active chat's meter for auto-compaction awareness.
                this.contextUsage.value = event;
                return;
            case `compact`:
                this.appendNotice(`Context compacted to free up space.`);
                return;
            case `plan`:
                // Attach the plan to the current bubble (its intro text, if any) and clear the turn's bubble so
                // the post-decision continuation streams into a fresh one below the plan card. Flush first so
                // any in-flight intro text finishes typing into this bubble, not the next.
                this.flushType();
                this.attachCard(this.currentTextId(turn), { plan: { requestId: event.requestId, text: event.text, status: `pending` } });
                turn.id = null;
                return;
            case `question`:
                // Same flow as plan: attach the card to the current bubble and start a fresh bubble for
                // whatever the agent streams after the answer comes back.
                this.flushType();
                this.attachCard(this.currentTextId(turn), {
                    question: { requestId: event.requestId, questions: event.questions, status: `pending` },
                });
                turn.id = null;
                return;
            case `permission`: {
                const { kind: _kind, ...ask } = event;
                this.flushType();
                this.attachCard(this.currentTextId(turn), { permission: { ...ask, status: `pending` } });
                turn.id = null;
                return;
            }
            case `mode`:
                // The turn's live posture — the user's pick echoed back at init, or a move the AGENT made
                // (EnterPlanMode / a plan approval). Drives the composer's selector so it never lies.
                this.mode.value = event.mode;
                return;
            case `session`:
                // Captured with the turn's provider/account so a later mismatch (a mid-chat switch) is
                // detectable at send time.
                this.session.value = { id: event.sessionId, provider: turn.provider, account: turn.account, harness: turn.harness };
                return;
            case `worktree`:
                // First frame of an isolated turn: which branch/base this conversation works on.
                this.worktree.value = { branch: event.branch, base: event.base };
                return;
            case `landed`:
                // End of a clean isolated turn: the delta auto-landed into the main tree as uncommitted
                // changes (review = the Changes panel), or conflicted and stayed safely in the worktree.
                this.appendNotice(
                    event.landed
                        ? `Changes landed in your workspace — review them in the Changes panel.`
                        : `Some changes couldn't land automatically — your own edits overlap in ${(event.conflicts ?? [])
                              .map((conflict) => conflict.repo)
                              .join(`, `)}. Resolve them, then use Land now in the agent's review.`,
                );
                return;
            case `terminal`: {
                // The agent started running Bash in its live `agent-<id>` tmux terminal — surface it as a tab in
                // the global panel (relist so it appears; no auto-open, no focus steal). Lazily imported so the
                // chat model doesn't statically pull in the xterm/terminal-panel chain.
                const { session } = event;
                void import("../terminal/useTerminalPanel").then((m) => m.useTerminalPanel().surface(session));
                return;
            }
            case `init`:
                this.activeModel.value = event.model;
                return;
            case `error`:
                if (event.code === `session-not-found`) {
                    // The sandbox no longer has this chat's transcript — drop the dead session so the next send
                    // starts a fresh one instead of replaying the failure forever. A muted notice, not the
                    // error ref: the condition is self-healed, so the red line + error tab status would overstate it.
                    this.session.value = undefined;
                    this.appendNotice(
                        `This chat's server-side history is gone (the sandbox was rebuilt or the session was deleted). Your last message wasn't processed — send it again; a fresh session starts, seeded with this window's transcript.`,
                    );
                    return;
                }
                if (event.code === `rate_limit`) {
                    // Claude's subscription usage cap, not a crash — render the daemon's message as a muted
                    // notice (like session-not-found) rather than the red error ref, so it reads as "wait and
                    // retry" instead of "the workspace broke". Append the concrete reset time when the usage
                    // store knows it (from this account's last rate_limit_info frame).
                    const resetsAt = usageStatusFor(this.account.value)?.resetsAt;
                    this.appendNotice(resetsAt !== undefined ? `${event.message} Resets ${formatReset(resetsAt)}.` : event.message);
                    return;
                }
                if (event.code === `codex-reauth`) {
                    // The daemon rejected this account's credential before the turn. Surface the red line AND
                    // light the account's reauth badge immediately (the proactive probe confirms it on the next
                    // status load) by marking the matching account in the shared list — no daemon round-trip.
                    const provider = this.provider.value;
                    const accounts = providerAccounts.value[provider] ?? [];
                    const accountId = this.account.value ?? accounts[0]?.id;
                    const message = event.message;
                    const markReauth = (account: OauthAccount): OauthAccount =>
                        account.id === accountId ? { ...account, needsReauth: true, detail: message } : account;
                    providerAccounts.value = { ...providerAccounts.value, [provider]: accounts.map(markReauth) };
                    this.error.value = message;
                    return;
                }
                if (event.code === `grok-model-invalid` || event.code === `codex-model-invalid`) {
                    // The daemon rejected the pinned model. Grok self-heals mid-turn (re-prompting with a model
                    // xAI named), so its code reaches us only when that failed; Codex can't (OpenAI names no
                    // alternative), so its code always lands here. Either way: surface it (red) and reload the
                    // provider's live catalog so the picker — and any conversation still pinning the dead id —
                    // repoints to what the daemon actually serves. Dynamic import breaks the static cycle
                    // (useChat imports this module), mirroring the terminal-panel import above.
                    const provider = this.provider.value;
                    void import(`./useChat`).then((chat) => chat.loadProviderModels(provider));
                    this.error.value = event.message;
                    return;
                }
                this.error.value = event.message;
                return;
            // `done` (and any unfamiliar future kind) has no transcript effect — a no-op instead of a crash.
            default:
                return;
        }
    }

    // The id of the bubble the current frame writes to, allocating a fresh assistant message when the turn's
    // bubble was cleared (start of turn already has one; a plan card clears it for the next).
    private currentTextId(turn: TurnContext): number {
        if (turn.id === null) {
            turn.id = this.nextId++;
            this.append({ id: turn.id, role: `assistant`, text: ``, thinking: `` });
        }
        return turn.id;
    }

    // Append a tool call to a bubble. Its id lets every later tool_call_update merge into the same card.
    private appendTool(id: number, event: Extract<AgentEvent, { kind: "tool_call" }>): void {
        const tool: ChatTool = {
            id: event.id,
            name: event.name,
            category: event.category,
            status: event.status,
            ...(event.target !== undefined ? { target: event.target } : {}),
            ...(event.locations !== undefined ? { locations: event.locations } : {}),
            ...(event.content !== undefined ? { content: event.content } : {}),
        };
        this.messages.value = this.messages.value.map((message) =>
            message.id === id ? { ...message, tools: [...(message.tools ?? []), tool] } : message,
        );
    }

    // Merge an update into the matching tool by id, wherever it lives. Present fields REPLACE the prior
    // value (snapshot semantics — Codex streams a command's growing output as whole snapshots); absent
    // fields leave it unchanged.
    private mergeToolUpdate(event: Extract<AgentEvent, { kind: "tool_call_update" }>): void {
        this.messages.value = this.messages.value.map((message) =>
            message.tools?.some((tool) => tool.id === event.id)
                ? {
                      ...message,
                      tools: message.tools.map((tool) =>
                          tool.id === event.id
                              ? {
                                    ...tool,
                                    ...(event.status !== undefined ? { status: event.status } : {}),
                                    ...(event.content !== undefined ? { content: event.content } : {}),
                                    ...(event.locations !== undefined ? { locations: event.locations } : {}),
                                }
                              : tool,
                      ),
                  }
                : message,
        );
    }

    private setTodos(id: number, items: TodoItem[]): void {
        this.messages.value = this.messages.value.map((message) => (message.id === id ? { ...message, todos: items } : message));
    }

    // Usage lands at end-of-turn; attach it to the last assistant bubble rather than spawning an empty one,
    // and fold it into the conversation's lifetime totals (the fleet card's cost/token readout).
    private setUsage(usage: ChatUsage): void {
        this.costUsd.value += usage.costUsd ?? 0;
        this.inputTokens.value += usage.inputTokens ?? 0;
        this.outputTokens.value += usage.outputTokens ?? 0;
        const target = this.messages.value.findLast((message) => message.role === `assistant`);
        if (target) {
            this.messages.value = this.messages.value.map((message) => (message.id === target.id ? { ...message, usage } : message));
        }
    }

    // Hang an interactive card (plan / question / permission) on a bubble — and, with the answered card,
    // freeze that answer into the transcript. One writer for all three: they differ in what they ask, not in
    // how they attach.
    private attachCard(id: number, card: Pick<ChatMessage, "plan" | "question" | "permission">): void {
        this.messages.value = this.messages.value.map((message) => (message.id === id ? { ...message, ...card } : message));
    }

    private append(message: ChatMessage): void {
        this.messages.value = [...this.messages.value, message];
    }

    // A small muted system line marking a control action (dismissed / kept planning / approved / stopped).
    private appendNotice(text: string): void {
        this.append({ id: this.nextId++, role: `notice`, text });
    }

    // Enqueue a delta for the typewriter loop rather than writing it straight to the bubble. If the target
    // bubble changed (a new turn / a fresh post-plan bubble), flush the prior buffer first so nothing leaks
    // across bubbles.
    private appendDelta(id: number, delta: string): void {
        if (this.typeId !== null && this.typeId !== id) {
            this.flushType();
        }
        this.typeId = id;
        this.typeBuffer += delta;
        if (this.rafId === null) {
            this.rafId = requestAnimationFrame(() => this.drainType());
        }
    }

    // Reveal a slice of the buffer each frame, sized to catch up when far behind so bursts type out quickly but
    // a large backlog never lags. Stops the loop once the buffer is empty.
    private drainType(): void {
        this.rafId = null;
        const id = this.typeId;
        if (id === null || this.typeBuffer.length === 0) {
            return;
        }
        const take = Math.max(2, Math.ceil(this.typeBuffer.length / 8));
        const slice = this.typeBuffer.slice(0, take);
        this.typeBuffer = this.typeBuffer.slice(take);
        this.messages.value = this.messages.value.map((message) => (message.id === id ? { ...message, text: `${message.text}${slice}` } : message));
        if (this.typeBuffer.length > 0) {
            this.rafId = requestAnimationFrame(() => this.drainType());
        }
    }

    // Drain the whole buffer synchronously and stop the loop — called when a turn ends, stops, or a
    // plan/question card takes over, so no text is left mid-type.
    private flushType(): void {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        const id = this.typeId;
        const rest = this.typeBuffer;
        this.typeBuffer = ``;
        this.typeId = null;
        if (id === null || rest.length === 0) {
            return;
        }
        this.messages.value = this.messages.value.map((message) => (message.id === id ? { ...message, text: `${message.text}${rest}` } : message));
    }

    private appendThinkingDelta(id: number, delta: string): void {
        this.messages.value = this.messages.value.map((message) =>
            message.id === id ? { ...message, thinking: `${message.thinking ?? ``}${delta}` } : message,
        );
    }
}
