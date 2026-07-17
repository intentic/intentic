import {
    type AgentCommand,
    type AgentEvent,
    type AgentHarness,
    type AgentProvider,
    type AskQuestion,
    type CatalogOption,
    type ContextUsage,
    modelsFor,
    type OauthAccount,
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
import { mentionPaths } from "./useMentions";

import { formatReset, usageStatusByAccount, usageStatusFor } from "./usageStatus";

// 'notice' is a small muted system line in the transcript (dismissed / kept planning / approved /
// stopped) — it keeps the user informed about control actions, Claude Code style.
export type ChatRole = "user" | "assistant" | "notice";

// The agent permission mode the composer drives (mirrors the SDK's permissionMode). Sent with every
// turn straight to the daemon's `/agent`. 'plan' proposes a plan the user approves; the others execute
// directly (accept edits / ask before edits / bypass all prompts).
export type ChatMode = "plan" | "acceptEdits" | "default" | "bypassPermissions";

// The provider (AgentProvider) and harness (AgentHarness) a turn runs on are the contract's wire enums —
// see schemas.ts for their semantics. Both are switchable mid-conversation: a session id only resumes on the
// runtime that minted it, so a switched turn retires the session and starts a fresh one seeded with the
// transcript so far (see Conversation.send).

// A live-catalog model option: the picker entry plus the reasoning-effort tiers the model accepts (reported
// per model by /claude/models; absent ⇒ the provider's default scale — see catalog.ts effortsFor).
export interface ModelOption extends CatalogOption {
    readonly efforts?: readonly string[];
}

// Every provider's model catalog is daemon-owned (/claude/models · /codex/models · /grok/models — live
// discovery with a persisted/seed floor, never empty) and loaded into these records, so the pickers track
// provider renames and new releases without a static list. useChat.loadProviderModels fills them when a daemon
// is reachable; resetChat clears. Empty only until the first load.
export const providerModels = ref<Record<AgentProvider, ModelOption[]>>({ claude: [], codex: [], grok: [] });
// Each provider's daemon-resolved default model id; empty only until the first load.
export const providerDefaultModel = ref<Record<AgentProvider, string>>({ claude: ``, codex: ``, grok: `` });
// Per-provider catalog fetch state, so the picker can show a spinner/retry per provider group instead of a
// silently-empty list (codex/grok have no static floor to fall back on before their first load).
export type CatalogLoadState = "idle" | "loading" | "loaded" | "error";
export const providerModelsState = ref<Record<AgentProvider, CatalogLoadState>>({ claude: `idle`, codex: `idle`, grok: `idle` });

// The model a fresh conversation seeds for a provider+harness. Under the Claude Code harness a non-Claude
// provider sends the translator's mapped id (the static catalog's entry). Natively every provider names its
// live daemon default; before the first catalog load Claude falls back to its stable `opus` alias (always
// valid) and codex/grok send empty (the daemon then resolves its own catalog default).
export const defaultModelFor = (provider: AgentProvider, harness: AgentHarness): string => {
    if (harness === `claude-code` && provider !== `claude`) {
        return modelsFor(provider, harness)[0]?.value ?? ``;
    }
    // An unseeded provider key (an ACP agent) has no catalog — the agent owns its own model, so empty rides.
    const live = providerDefaultModel.value[provider] ?? ``;
    if (live !== ``) {
        return live;
    }
    return provider === `claude` ? `opus` : ``;
};

// The model options for a provider+harness picker/chip: the provider's live daemon catalog, with the static
// catalog as the pre-load floor (Claude's tier aliases; codex/grok empty) — except under the Claude Code
// harness, where a non-Claude provider's list is the translator's static mapping. Shared by the composer pill
// and the menu bodies so their list + label logic can't drift.
export const modelOptionsFor = (provider: AgentProvider, harness: AgentHarness): CatalogOption[] => {
    if (harness === `claude-code` && provider !== `claude`) {
        return modelsFor(provider, harness);
    }
    const live = providerModels.value[provider] ?? [];
    return live.length > 0 ? live : modelsFor(provider, `native`);
};
// Installed ACP agent providers (agent-kind capabilities): id + display label, loaded on the same reachable
// seam as accounts/models (useChat.loadAcpProviders) so the picker lists them. Empty until the first load.
export const acpProviders = ref<readonly { id: string; label: string }[]>([]);

// The display label for any provider: an ACP agent's capability name when known, else the shared static
// label (which itself falls back to the raw id).
export const providerDisplayLabel = (provider: AgentProvider): string =>
    acpProviders.value.find((agent) => agent.id === provider)?.label ?? providerLabel(provider);

// The display label for a selected model id — the option's label, else the provider name so the chip is never
// blank (Grok's catalog can be briefly empty on first load; an ACP agent has no model options at all).
export const modelLabelFor = (provider: AgentProvider, harness: AgentHarness, modelId: string): string =>
    modelOptionsFor(provider, harness).find((option) => option.value === modelId)?.label ?? providerDisplayLabel(provider);

// The provider tabs shown wherever accounts are picked (the account dialog + the composer's connect gate).
// Labels differ from the internal ids (codex → "ChatGPT").
export const providerTabs: readonly { value: AgentProvider; label: string }[] = [
    { value: `claude`, label: `Claude` },
    { value: `codex`, label: `ChatGPT` },
    { value: `grok`, label: `Grok` },
];

// A proposed plan awaiting the user's decision (the agent called ExitPlanMode). 'pending' shows the
// approve/keep-planning buttons; once decided the choice is frozen into the transcript.
export type PlanStatus = "pending" | "approved" | "rejected";

export interface PlanRequest {
    readonly decisionId: string;
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
const MODES: readonly ChatMode[] = [`plan`, `acceptEdits`, `default`, `bypassPermissions`];

interface TurnDefaults {
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    readonly models: Record<AgentProvider, string>;
    readonly effort: string;
    readonly thinking: boolean;
    readonly mode: ChatMode;
}

// Per-provider NATIVE model map: a stored string per provider, each degrading to that provider's native default
// when absent or malformed. The single point that parses the persisted record. (Claude-Code-harness models are
// deterministic — gpt-5-codex / grok-4 — so they aren't persisted; rememberedModelFor derives them.)
const readModels = (stored: unknown): Record<AgentProvider, string> => {
    const raw = (typeof stored === `object` && stored !== null ? stored : {}) as Record<string, unknown>;
    const modelFor = (provider: AgentProvider): string =>
        typeof raw[provider] === `string` ? (raw[provider] as string) : defaultModelFor(provider, `native`);
    return { claude: modelFor(`claude`), codex: modelFor(`codex`), grok: modelFor(`grok`) };
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
            provider: stored[`provider`] === `codex` || stored[`provider`] === `grok` ? (stored[`provider`] as AgentProvider) : `claude`,
            harness: stored[`harness`] === `claude-code` ? `claude-code` : `native`,
            models: readModels(stored[`models`]),
            effort: typeof stored[`effort`] === `string` ? stored[`effort`] : fallback.effort,
            thinking: typeof stored[`thinking`] === `boolean` ? stored[`thinking`] : fallback.thinking,
            mode: MODES.includes(stored[`mode`] as ChatMode) ? (stored[`mode`] as ChatMode) : fallback.mode,
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
    mode: ref<ChatMode>(seed.mode),
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

// The model to restore for a provider+harness: under the Claude Code harness a non-Claude provider always uses
// the translator's deterministic mapped id; natively it's the one the user last picked for that provider
// (persisted), else the provider's default. The single source every model-reset site routes through, so a
// per-provider pick survives switching provider/harness away and back.
export const rememberedModelFor = (provider: AgentProvider, harness: AgentHarness): string =>
    harness === `claude-code` && provider !== `claude`
        ? defaultModelFor(provider, harness)
        : turnDefaults.models.value[provider] || defaultModelFor(provider, harness);

// Connected provider accounts and the per-provider selection for new turns. In-memory (NOT persisted like
// turnDefaults): account ids are daemon-minted per sandbox, so they'd be meaningless across a sandbox switch —
// useChat.loadAccountStatus fills these when a daemon becomes reachable and resetChat clears them. Kept here
// (not in useChat) so a Conversation can seed/reset its account without importing useChat (a cycle).
export const providerAccounts = ref<Record<AgentProvider, readonly OauthAccount[]>>({ claude: [], codex: [], grok: [] });
export const selectedAccountId = ref<Record<AgentProvider, string | undefined>>({ claude: undefined, codex: undefined, grok: undefined });

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

// One in-flight turn's streaming context: which assistant bubble frames write into (`id` is mutable so a plan
// card can null it mid-turn, redirecting the continuation to a new bubble), plus the provider/account serving
// the turn — the attribution captured onto the session the stream mints.
interface TurnContext {
    id: number | null;
    // The turn's user bubble — the checkpoint frame anchors its restore affordance here.
    readonly userMessageId: number;
    readonly provider: AgentProvider;
    readonly account: string | undefined;
    readonly harness: AgentHarness;
}

/* One chat conversation: its transcript, the resumed sandbox session, and the streaming machinery for a
 * turn. Self-contained so the manager can run several at once — each instance owns its AbortController and
 * typewriter loop, so tabs stream independently. Every turn streams from POST /agent on the sandbox daemon
 * directly (Bearer Google ID token) — the platform is not in the path. */
export class Conversation {
    readonly messages = ref<ChatMessage[]>([]);
    readonly streaming = ref(false);
    readonly error = ref<string | null>(null);
    // The provider's own slash commands (ACP agents advertise them mid-session; native providers never do) —
    // replaced whole per `commands` frame, listed by the composer's `/` popover.
    readonly availableCommands = ref<readonly AgentCommand[]>([]);

    // True while a turn is paused on a card awaiting the user's input (a pending plan or question). The
    // /agent fetch stays open during this, so `streaming` is still true — but the agent isn't generating, so
    // the composer should drop the Stop spinner and show a ready Send (Claude Code style).
    readonly awaitingDecision = computed(() =>
        this.messages.value.some((message) => message.plan?.status === `pending` || message.question?.status === `pending`),
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
    readonly mode = ref<ChatMode>(turnDefaults.mode.value);

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
    readonly model = ref<string>(rememberedModelFor(turnDefaults.provider.value, turnDefaults.harness.value));
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

    // Aborts the in-flight turn when the user hits Stop / closes the tab; cleared once the turn settles.
    private inflight: AbortController | null = null;

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
        this.model.value = rememberedModelFor(next, this.harness.value);
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

    // Switch the harness (native runtime vs the Claude Code loop) for the next turn and re-scope the model (the
    // list diverges by harness for codex/grok). Writes the pick back to the module default so the next new chat
    // inherits it. Mid-chat this retires the session at the next send, exactly like a provider/account switch —
    // the runtimes mint incompatible sessions. Meaningful only for codex/grok; claude is always its own loop.
    selectHarness(next: AgentHarness): void {
        if (this.streaming.value || next === this.harness.value) {
            return;
        }
        this.harness.value = next;
        this.model.value = rememberedModelFor(this.provider.value, next);
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
        this.model.value = rememberedModelFor(`claude`, `native`);
        this.title.value = title;
        this.activeModel.value = null;
        this.error.value = null;
    }

    async send(prompt: string, settings: TurnSettings, attachments: readonly ChatAttachment[] = []): Promise<void> {
        const text = prompt.trim();
        if ((text.length === 0 && attachments.length === 0) || this.streaming.value) {
            return;
        }

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
                    // Plan mode → propose-then-approve via /agent/decision (the daemon's gate). The finer
                    // permission modes aren't a daemon input, so only the `plan` boolean is sent.
                    plan: this.mode.value === `plan`,
                }),
            });
            if (!response.ok || !response.body) {
                throw new Error(`Chat request failed (${response.status}).`);
            }
            await this.consume(response.body, turn);
        } catch (err) {
            // A user-initiated Stop aborts the fetch; that's expected, not an error to surface.
            if (!(err instanceof DOMException && err.name === `AbortError`)) {
                this.error.value = err instanceof Error ? err.message : `Chat failed.`;
            }
        } finally {
            this.flushType();
            this.inflight = null;
            this.streaming.value = false;
            this.turnStartedAt.value = undefined;
        }
    }

    // Rewind-and-rerun: replace a past user turn with edited text and replay from that point. Everything from
    // the edited message onward is discarded — a pending switch notice included (it is always the last
    // message, so the cut removes it and send() resets its id) — the session is retired, and send() seeds a
    // fresh provider session from the truncated transcript: the same segment-cut mechanism a provider switch
    // uses, so it works uniformly across runtimes. The original turn's attachments ride again (their uploads
    // are still in the workspace; a lost previewUrl just drops the thumbnail to the file chip).
    async editAndResend(messageId: number, text: string, settings: TurnSettings): Promise<void> {
        if (this.streaming.value) {
            return;
        }
        const index = this.messages.value.findIndex((message) => message.id === messageId);
        if (index === -1 || this.messages.value[index]!.role !== `user`) {
            return;
        }
        const attachments = this.messages.value[index]!.attachments ?? [];
        // Mirror send's empty guard BEFORE truncating — an empty edit must not destroy the tail and then no-op.
        if (text.trim().length === 0 && attachments.length === 0) {
            return;
        }
        this.messages.value = this.messages.value.slice(0, index);
        this.session.value = undefined;
        // The retired session's live model and context meter don't describe the re-run (mirrors selectProvider).
        this.activeModel.value = null;
        this.contextUsage.value = undefined;
        // Editing the conversation's first user turn re-derives the title from the new text.
        if (!this.messages.value.some((message) => message.role === `user`)) {
            this.title.value = null;
        }
        await this.send(text, settings, attachments);
    }

    // User-initiated Stop button: record a muted notice, then abort the turn.
    stop(): void {
        if (!this.streaming.value) {
            return;
        }
        this.appendNotice(`Stopped.`);
        this.abort();
    }

    // Aborts the in-flight browser stream; whatever streamed so far stays in the transcript. NOTE: closing the
    // `/agent` fetch has no cancel frame, so this does not hard-cancel the sandbox agent — a parked or
    // still-generating query is reaped by the daemon's idle timeout (a true cancel needs a daemon route). Also
    // called by the manager when its tab is closed.
    abort(): void {
        this.flushType();
        this.inflight?.abort();
    }

    // Answers a pending plan card. The /agent request is still open, so on approval the agent exits plan mode
    // and streams a closing turn; on rejection the feedback is fed back and it re-plans.
    async decidePlan(message: ChatMessage, approve: boolean, feedback?: string): Promise<void> {
        const plan = message.plan;
        if (plan?.status !== `pending`) {
            return;
        }
        const ok = await this.postTurnControl(`/agent/decision`, { decisionId: plan.decisionId, approve, feedback });
        if (!ok) {
            this.error.value = `Could not record your plan decision — the turn may have ended.`;
            return;
        }
        this.setPlanStatus(message.id, approve ? `approved` : `rejected`);
        this.appendNotice(approve ? `Plan approved.` : `Kept planning.`);
        // Keep the rejection feedback visible as the user's turn — otherwise the typed text vanishes from the
        // transcript even though it was sent to the agent.
        const trimmed = feedback?.trim();
        if (!approve && trimmed) {
            this.append({ id: this.nextId++, role: `user`, text: trimmed });
        }
    }

    // Submits the user's picks for a pending question card. The /agent request is still open, so the agent's
    // `ask` tool unblocks and the turn resumes using the answers.
    async answerQuestion(message: ChatMessage, answers: Record<string, string[]>): Promise<void> {
        const question = message.question;
        if (question?.status !== `pending`) {
            return;
        }
        const ok = await this.postTurnControl(`/agent/answer`, { requestId: question.requestId, answers });
        if (!ok) {
            this.error.value = `Could not submit your answers — the turn may have ended.`;
            return;
        }
        this.setQuestionState(message.id, `answered`, answers);
    }

    // Dismisses a pending question and stops the turn (Claude Code-style interrupt). The agent is parked on its
    // `ask` tool — not generating — so aborting the stream leaves it idle rather than letting it proceed on a
    // guessed default (which, for a coding agent, could mean unwanted edits).
    cancelQuestion(message: ChatMessage): void {
        if (message.question?.status !== `pending`) {
            return;
        }
        this.setQuestionState(message.id, `cancelled`);
        this.appendNotice(`Question dismissed.`);
        this.abort();
    }

    // Posts a turn-control message (plan decision / question answer) to the platform side-channel, which relays
    // it to the sandbox daemon. Returns whether it succeeded.
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

    private async consume(body: ReadableStream<Uint8Array>, turn: TurnContext): Promise<void> {
        for await (const frame of sseFrames(body)) {
            this.handleFrame(frame, turn);
        }
    }

    private handleFrame(frame: string, turn: TurnContext): void {
        const event = sseData(frame) as AgentEvent | undefined;
        if (event === undefined) {
            return;
        }

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
                this.setUsage(event);
                return;
            case `rate_limit_info`:
                // Account-wide subscription usage (5-hour / weekly window), keyed by the account that served
                // the turn so switching accounts shows the right window. Not tied to any bubble.
                if (event.account !== undefined) {
                    usageStatusByAccount.value = { ...usageStatusByAccount.value, [event.account]: event };
                }
                return;
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
                this.attachPlan(this.currentTextId(turn), event.decisionId, event.text);
                turn.id = null;
                return;
            case `question`:
                // Same flow as plan: attach the question card to the current bubble and start a fresh bubble for
                // whatever the agent streams after the answers come back.
                this.flushType();
                this.attachQuestion(this.currentTextId(turn), event.requestId, event.questions);
                turn.id = null;
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

    private attachPlan(id: number, decisionId: string, text: string): void {
        this.messages.value = this.messages.value.map((message) =>
            message.id === id ? { ...message, plan: { decisionId, text, status: `pending` } } : message,
        );
    }

    private setPlanStatus(id: number, status: PlanStatus): void {
        this.messages.value = this.messages.value.map((message) =>
            message.id === id && message.plan ? { ...message, plan: { ...message.plan, status } } : message,
        );
    }

    private attachQuestion(id: number, requestId: string, questions: AskQuestion[]): void {
        this.messages.value = this.messages.value.map((message) =>
            message.id === id ? { ...message, question: { requestId, questions, status: `pending` } } : message,
        );
    }

    private setQuestionState(id: number, status: QuestionStatus, answers?: Record<string, string[]>): void {
        this.messages.value = this.messages.value.map((message) =>
            message.id === id && message.question ? { ...message, question: { ...message.question, status, answers } } : message,
        );
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
