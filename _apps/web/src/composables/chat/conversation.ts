import {
    type AgentCommand,
    type AgentEvent,
    type AgentHarness,
    type AgentProvider,
    type AgentReply,
    type AttachFrame,
    type CatalogOption,
    clampEffort,
    type ContextUsage,
    deriveTitle,
    type EditorContext,
    type ModelBadge,
    modelsFor,
    NATIVE_PROVIDERS,
    type NativeProvider,
    type OauthAccount,
    type PermissionMode,
    providerLabel,
    type RestoredMessage,
    runsClaudeCode,
    sseData,
    sseFrames,
    type TranslatorAccounts,
} from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import { sandboxRequest } from "../sandbox/sandboxClient";
import { errorMessage } from "../useAsyncAction";
import { mentionPaths } from "./useMentions";
import { type ChatAttachment, type ChatMessage, transcriptOf } from "./transcript";
import { readTranscript, saveTranscript } from "./transcriptCache";
import {
    appendMessage,
    appendNotice,
    applyTurnFrame,
    emptyTurnState,
    flushPending,
    revealPending,
    type TurnEffect,
    type TurnState,
} from "./turnReducer";
import { bindingWindow, formatReset, usageStatusByAccount, usageStatusFor } from "./usageStatus";

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
// forks by harness. Every provider names its live daemon default; before the first catalog load it takes the
// head of the same static floor the picker shows (Claude's newest seeded version; codex/grok empty, so the
// daemon resolves its own default). Reading the floor rather than naming an id here is what keeps the seeded
// model a row the picker actually offers.
const defaultModelFor = (provider: AgentProvider): string => {
    // An unseeded provider key (an ACP agent) has no catalog — the agent owns its own model, so empty rides.
    const live = providerDefaultModel.value[provider] ?? ``;
    if (live !== ``) {
        return live;
    }
    return modelsFor(provider)[0]?.value ?? ``;
};

// The model options for a provider's picker/chip: the provider's live daemon catalog, with the static catalog
// as the pre-load floor (Claude's seeded versions; codex/grok empty). Harness-independent (the harness is a
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
    { value: `gemini`, label: `Google` },
];

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

// A message the user wrote while a turn was already running, waiting to reach the agent. The composer never
// refuses input: a message submitted mid-turn lands here and the conversation delivers it as soon as it can —
// injected into the running turn where the harness accepts that (Claude Code's queue-and-steer), else sent as
// the next turn the moment this one settles. Carries everything a fresh message can (files, the editor chip),
// so "add more while it works" isn't a lesser kind of message.
// An assistant bubble a turn opened for an answer that never arrived. A turn the daemon refused before running
// it leaves one behind, and a rewound turn must take it back too rather than leave a blank agent reply.
const blank = (message: ChatMessage): boolean =>
    message.role === `assistant` &&
    message.text === `` &&
    (message.thinking ?? ``) === `` &&
    message.tools === undefined &&
    message.plan === undefined &&
    message.question === undefined &&
    message.permission === undefined;

export interface QueuedMessage {
    readonly id: string;
    readonly text: string;
    readonly attachments: readonly ChatAttachment[];
    readonly editorContext?: EditorContext;
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

// The posture a conversation STARTS in, by where it works. An isolated conversation owns a throwaway worktree
// inside the sandbox container — the container is the isolation boundary, so it runs unattended and never asks;
// a main-tree conversation edits the workspace the user is looking at, so it proposes a plan first.
// Deliberately NOT persisted with the other turn prefs: the permission mode is a per-task posture, and the
// agent moves it mid-turn (EnterPlanMode), so a remembered value means one agent's escalation silently becomes
// every later agent's starting mode.
export const startingMode = (isolated: boolean): PermissionMode => (isolated ? `bypassPermissions` : `plan`);

// The persisted turn prefs, one JSON blob. Restored values are validated per field (enum for provider, boolean
// for thinking) so a stale or hand-edited entry degrades to the defaults; model/effort stay plain strings — the
// Conversation constructor does the semantic clamping (codex model/effort scoping).
const TURN_DEFAULTS_KEY = `intentic.turnDefaults`;

interface TurnDefaults {
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    readonly models: Record<AgentProvider, string>;
    readonly effort: string;
    readonly thinking: boolean;
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
        };
    } catch {
        return fallback;
    }
};

const seed = readTurnDefaults();

// The turn prefs a NEW conversation seeds from, persisted across reloads. A fresh-conversation provider pick
// writes back here (see Conversation.selectProvider), and useChat's facade setters write model/effort/thinking
// through, so the next new chat — and the next session — inherit the last-used settings. The permission mode is
// NOT one of them; it comes from startingMode() per conversation.
export const turnDefaults = {
    provider: ref<AgentProvider>(seed.provider),
    harness: ref<AgentHarness>(seed.harness),
    models: ref<Record<AgentProvider, string>>(seed.models),
    effort: ref<string>(seed.effort),
    thinking: ref<boolean>(seed.thinking),
};

watch(
    [turnDefaults.provider, turnDefaults.harness, turnDefaults.models, turnDefaults.effort, turnDefaults.thinking],
    ([provider, harness, models, effort, thinking]) => {
        try {
            localStorage.setItem(TURN_DEFAULTS_KEY, JSON.stringify({ provider, harness, models, effort, thinking }));
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

// Which SUBSCRIPTIONS the bundled translator holds (codex/grok/gemini) — the other half of "can this provider
// run", since those three authenticate through the translator rather than through a daemon-stored account.
// Written by useChat (refreshTranslatorAccounts / resetChat); kept here beside providerAccounts so the access
// rules can be derived from one place without importing useChat (a cycle).
export const translatorAccounts = ref<TranslatorAccounts>({ codex: false, grok: false, gemini: false });

// The account a fresh turn on a provider uses: the user's explicit pick when it's still connected, else the
// provider's first connected account. The single source every account-reset site routes through.
export const rememberedAccountFor = (provider: AgentProvider): string | undefined => {
    // An unseeded provider key (an ACP agent) has no daemon account store — its own credential store serves it.
    const accounts = providerAccounts.value[provider] ?? [];
    const picked = selectedAccountId.value[provider];
    return accounts.some((account) => account.id === picked) ? picked : accounts[0]?.id;
};

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
    // The turn's user bubble — the checkpoint frame anchors its restore affordance here. The turn's CURRENT
    // bubble is not here: which bubble the agent is writing into moves with every block boundary and card, so
    // it belongs to the reducer's state (TurnState.bubbleId) rather than to a context the caller holds.
    readonly userMessageId: number;
    readonly provider: AgentProvider;
    readonly account: string | undefined;
    readonly harness: AgentHarness;
}

// The head frame of an /agent/attach stream — the run's identity plus what a non-initiating window needs to
// synthesize the turn locally (user bubble from the prompt, elapsed readout from the start time).
type AttachHead = Extract<AttachFrame, { kind: "attached" }>;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* Usage-limit auto-resume, as this window sees it. The daemon owns the resume itself (limit-resume.ts fires
 * a minute after the provider's reset instant, so a skewed clock can't retry into the same closed window);
 * what the client owns is RENDERING it — attach streams are pull, and an open tab re-probes only on
 * reachability flips, so a resumed run would play to nobody without a local probe armed for around when the
 * daemon fires. Probing starts a beat after the daemon's own delay and retries across its poll cadence; it
 * gives up quietly once the window has clearly passed (the toggle went off, or the resumed run already
 * finished — its transcript replays on the next hydrate either way). */
const RESUME_DELAY_S = 60;
const LIMIT_REATTACH_DELAY_MS = 70_000;
const LIMIT_REATTACH_INTERVAL_MS = 15_000;
const LIMIT_REATTACH_TRIES = 20;

/* One chat conversation: its transcript, the resumed sandbox session, and the streaming machinery for a
 * turn. Self-contained so the manager can run several at once — each instance owns its AbortController and
 * typewriter loop, so tabs stream independently. A turn EXECUTES as a detached run on the sandbox daemon
 * (POST /agent starts it; the platform is not in the path) and this tab merely renders it via /agent/attach
 * — the same stream a reload, a second window, or another device attaches, resumable by seq cursor when the
 * connection drops. */
export class Conversation {
    // The transcript, the turn's current bubble, the id allocator, and the typewriter's undrained buffer — one
    // value, moved through the pure reducer in turnReducer.ts. Holding them together is what makes the frame
    // rules testable without a conversation: every question the reducer asks (does this bubble hold prose yet,
    // which bubble does a card attach to) is answerable from this object alone.
    private readonly state = ref<TurnState>(emptyTurnState);

    readonly messages = computed<readonly ChatMessage[]>(() => this.state.value.messages);
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
            (message) => message.plan?.status === `pending` || message.question?.status === `pending` || message.permission?.status === `pending`,
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

    // The user's permission posture for this conversation — the composer's pick, sent as every turn's STARTING
    // mode. Seeded by where the conversation works (startingMode); only the user writes it.
    readonly mode = ref<PermissionMode>(startingMode(true));

    // The posture the RUNNING turn is actually in, from the turn's `mode` frames — the agent's own
    // EnterPlanMode, or the mode a plan approval landed in. Display-only (the composer shows it so the pill
    // never lies mid-turn) and cleared at each send: an agent that escalates itself into planning must not
    // leave the user's standing pick demoted for every turn after it.
    readonly liveMode = ref<PermissionMode | undefined>();

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

    // The tmux session this conversation's Bash commands are running in (`agent-<sdk session>`), from the
    // daemon's own `terminal` frame. Held so the transcript can offer to WATCH the shell — the agent's terminals
    // no longer tab themselves into the panel (useAgentTerminals), so the Bash card is where that door lives.
    // Undefined until the first Bash of a turn; a fresh conversation, a branch, and a restored transcript all
    // start without one, because whatever shell they inherited belongs to a session they no longer run in.
    readonly agentTerminal = ref<string | undefined>();

    // Whether this conversation's turns run in an isolated git worktree (the parallel-agents mode, the default
    // for new chats) or on the shared /work tree. Flipped off for history-menu restores (their sessions live in
    // the main tree's namespace) and legacy restored tabs.
    readonly isolated = ref(true);

    // Whether the fleet has ever known this conversation. The board's DRAFT card exists to bridge exactly one
    // gap — "New agent" pressed → the first roster frame that registers it — and that crossing happens once, so
    // this LATCHES rather than tracking the roster. Reading "absent from the roster" as "draft" instead is what
    // put an agent the user had just ARCHIVED straight back in the Active lane under a fresh "New agent" card:
    // the roster carries live agents only, so its open tab looked brand new again. A dropped events stream
    // (resetAgents empties the roster) and a cold load before the first frame did the same to every open agent
    // tab at once. Persisted with the tab, so a reload doesn't un-know it.
    readonly registered = ref(false);

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

    // Messages submitted while a turn was running and not yet delivered — see enqueue/drainQueue. Rendered
    // above the composer so nothing the user wrote is ever invisible, and persisted with the draft.
    readonly queued = ref<QueuedMessage[]>([]);

    // A usage-limit failure the daemon remembered but will only resume once the autoResumeOnLimit setting
    // comes on — what the composer's offer banner renders (enable → armLimitResume). Cleared by the next
    // send, which supersedes the pending resume daemon-side the same way. Not persisted: after a reload the
    // standing toggle on the settings page is the offer.
    readonly limitResume = ref<{ resetsAt: number } | undefined>();

    // Whether the running turn can absorb a message mid-flight: the Claude Code loop only (see runsClaudeCode,
    // the same predicate the daemon's streamAgent gates its SteeringQueue on). Used for WORDING alone (the
    // composer says "steer" vs "queue"): delivery asks the daemon and falls back to the queue on a refusal, so
    // a drift here can't lose a message.
    readonly steerable = computed(() => runsClaudeCode(this.provider.value, this.harness.value));

    // The one unsent "switched" divider notice, upserted/removed as the user toggles provider/account and made
    // permanent by the next send (the segment cut).
    private pendingSwitchNoticeId: number | undefined;

    // Aborts the in-flight ATTACH STREAM when the user hits Stop / closes the tab; cleared once the stream
    // settles. The turn itself runs detached on the daemon — only /agent/stop cancels it.
    private inflight: AbortController | null = null;

    // The in-flight reattach probe (see reattach), aborted by a send so the two never race one run.
    private probe: AbortController | undefined;

    // Set by abort() — a Stop, a closed tab, a sandbox switch — and cleared whenever a turn starts or the user
    // submits again. An INTERRUPTED turn must not flush the queue: someone who just stopped the agent did not
    // ask for another turn to start on its own. The queued messages stay put and ride the user's next send.
    private interrupted = false;

    // True while drainQueue owns the idle flush (it is awaiting the turn that carries the queue), so a second
    // drain — the settle hook, a fresh submit — can't send the same messages twice.
    private flushing = false;

    // The typewriter's CLOCK. What a tick means (how much to reveal, into which bubble) is the reducer's
    // revealPending; all this owns is when one happens, so the animation can be driven off a test's own calls
    // instead of a browser frame.
    private rafId: number | null = null;

    // `conversationId` is the conversation's whole identity — the key the daemon puts on the fleet registry
    // entry and the worktree, the strip puts on the tab, and the transcript mirror puts on the cache entry. It
    // survives provider/harness switches (which retire sessions) and reloads (persisted in the tab snapshot),
    // and its shape satisfies the wire's branch/path-safety regex (a UUID: hex + hyphens, starts alphanumeric).
    constructor(readonly conversationId: string = crypto.randomUUID()) {
        // A restored 'max' can be invalid two ways — Codex/Grok have no such tier, and Claude's API rejects it
        // with thinking off — and turnDefaults persists BOTH halves, so an unclamped pair would fail every turn
        // of every new conversation until the user happened to change one. The model is already provider-correct
        // from the seed (rememberedModelFor), so no model re-scope is needed.
        this.effort.value = clampEffort(this.effort.value, this.provider.value, this.thinking.value);
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
        this.effort.value = clampEffort(this.effort.value, next, this.thinking.value);
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

    // Retract the pending "switched" divider — the change it announced is no longer what the next send does.
    private dropSwitchNotice(): void {
        if (this.pendingSwitchNoticeId === undefined) {
            return;
        }
        this.state.value = {
            ...this.state.value,
            messages: this.state.value.messages.filter((message) => message.id !== this.pendingSwitchNoticeId),
        };
        this.pendingSwitchNoticeId = undefined;
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
            this.dropSwitchNotice();
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
            this.state.value = {
                ...this.state.value,
                messages: this.state.value.messages.map((message) => (message.id === this.pendingSwitchNoticeId ? { ...message, text } : message)),
            };
            return;
        }
        this.pendingSwitchNoticeId = this.append({ role: `notice`, text });
    }

    // Mirror the settled transcript to the local cache (see transcriptCache), so reopening this conversation
    // paints from disk rather than waiting on the sandbox. Fire-and-forget, and only where the transcript has
    // settled — a turn ending, a remote transcript landing — never per streamed frame.
    // `authoritative` is the daemon's own replay, which may legitimately shrink the mirror; everything else is
    // this window reporting what it is showing, which can be a fraction of the conversation (see saveTranscript).
    private persist(authoritative = false): void {
        void saveTranscript(this.conversationId, this.messages.value, authoritative);
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
        // The cache carries its own ids, so the allocator has to resume ABOVE them or the next notice would
        // collide with a restored bubble.
        this.state.value = { ...emptyTurnState, messages: cached, nextId: Math.max(0, ...cached.map((message) => message.id)) + 1 };
        return true;
    }

    // Seed this conversation as a BRANCH of `source` taken just before `index`: the turns before that point
    // become this conversation's transcript and its settings ride across, while the source is left completely
    // untouched — that is the whole point of branching over rewinding. No session is carried: a branch is a
    // new conversation daemon-side, and its first send seeds a fresh one from the transcript above via the
    // same `history` mechanism a provider switch already uses.
    branchFrom(source: Conversation, index: number): void {
        this.state.value = source.messages.value.slice(0, index).reduce((state, message) => appendMessage(state, message), emptyTurnState);
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

    // Redraw the bubbles of a transcript the daemon replayed, leaving every other property of the conversation
    // alone. This is the whole of what a RESTORED tab needs: it already carries its own session, title,
    // provider and isolation from the tab snapshot, and overwriting those with the history-menu defaults below
    // would quietly move an isolated agent's next turn onto the main tree.
    restoreMessages(messages: readonly RestoredMessage[]): void {
        this.state.value = messages.reduce(
            (state, message) =>
                appendMessage(state, {
                    role: message.role,
                    text: message.text,
                    // Chips from the restored workspace-relative paths; thumbnails re-mint from the
                    // workspace bytes at render time (attachmentPreview) — object URLs don't survive here.
                    ...(message.attachments !== undefined && message.attachments.length > 0
                        ? { attachments: message.attachments.map((path) => ({ name: path.split(`/`).at(-1) ?? path, path })) }
                        : {}),
                    ...(message.thinking !== undefined ? { thinking: message.thinking } : {}),
                    ...(message.tools !== undefined ? { tools: message.tools } : {}),
                }),
            emptyTurnState,
        );
        this.error.value = null;
        this.persist(true);
    }

    // Restore a past conversation pulled from the history menu: build bubbles from the stored transcript and
    // arm its session so the next turn resumes it in the sandbox. Unlike restoreMessages this also seeds the
    // conversation's identity, because the tab it lands in is a fresh one that has none.
    loadTranscript(messages: readonly RestoredMessage[], sessionId: string, title: string | null): void {
        this.restoreMessages(messages);
        // History-menu sessions live in the MAIN tree's session namespace — resuming one in a worktree would
        // miss it. The fleet's own open path rehydrates isolated conversations separately.
        this.isolated.value = false;
        // ...and a turn on the tree the user is looking at plans before it touches anything.
        this.mode.value = startingMode(false);
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
    }

    async send(prompt: string, settings: TurnSettings, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<void> {
        const text = prompt.trim();
        if ((text.length === 0 && attachments.length === 0) || this.streaming.value) {
            return;
        }
        // A pending reattach probe must not race this send's own stream over the same run.
        this.probe?.abort();
        // A turn is starting: whatever interrupted the last one is history, so this one's clean end may flush.
        this.interrupted = false;

        this.error.value = null;
        // A fresh turn supersedes a pending usage-limit resume — the daemon clears its side at turn start the
        // same way, so the offer banner and the probe must not outlive the failure they described.
        this.limitResume.value = undefined;
        clearTimeout(this.limitReattachTimer);
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
            // A turn that can't resume runs under a NEW sdk session, so it will run its Bash in a different
            // tmux session — the remembered one belongs to the segment that just ended, and offering to watch
            // it would point at a shell this conversation no longer uses.
            this.agentTerminal.value = undefined;
        }
        const history = resume === undefined ? transcriptOf(this.messages.value).slice(-200) : [];
        // The switch divider (if any) is frozen into the transcript — the segment cut happened.
        this.pendingSwitchNoticeId = undefined;
        // First message of a fresh conversation names it — free, no model call. An attachment-only send has no
        // prose to read, so it is named after what was dropped in.
        if (this.title.value === null) {
            this.title.value = deriveTitle(text.length > 0 ? text : attachments.map((file) => file.name).join(`, `));
        }
        const userMessageId = this.append({ role: `user`, text, ...(attachments.length > 0 ? { attachments } : {}) });
        // Streaming context for the turn: the current text bubble — a fresh empty assistant message (so the
        // typing indicator shows immediately; a plan card clears it so the post-decision continuation streams
        // into a new bubble below the card) — plus the provider/account attribution for the session frame.
        this.openBubble();
        const turn: TurnContext = { userMessageId, provider: agent, account, harness };
        // This turn starts from the user's pick; the previous turn's live posture (a plan it entered, a mode an
        // approval landed in) is history, and the daemon will echo this one back at init.
        this.liveMode.value = undefined;
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
            void this.drainQueue();
        }
    }

    /* The composer's one send path — the message is accepted whatever the conversation is doing, and the
     * conversation works out how to deliver it (Claude Code's queue-and-steer):
     *   idle          → it starts a turn immediately, together with anything already queued behind it;
     *   turn running  → it is handed to that turn where the harness takes mid-turn input (injected between
     *                   tool calls), and otherwise waits for the turn to settle and goes as the next one.
     * An empty message with a non-empty queue is the user pressing Send on the queue itself, so it just drains.
     */
    enqueue(text: string, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<void> {
        const trimmed = text.trim();
        // The user is driving again — a Stop's hold on the queue is released (see `interrupted`).
        this.interrupted = false;
        if (trimmed.length > 0 || attachments.length > 0) {
            this.queued.value = [
                ...this.queued.value,
                { id: crypto.randomUUID(), text: trimmed, attachments, ...(editorContext !== undefined ? { editorContext } : {}) },
            ];
        }
        return this.drainQueue();
    }

    // Drop a queued message before it reaches the agent (the × on its chip).
    removeQueued(id: string): void {
        this.queued.value = this.queued.value.filter((message) => message.id !== id);
    }

    // Take a user bubble the daemon turned away back OUT of the transcript and put it at the FRONT of the
    // queue. A turn refused before it ran produced nothing, so leaving the bubble in place would show a message
    // as said-and-answered when the agent never saw it — and a later replay would then say it twice.
    private requeueUndelivered(userMessageId: number): void {
        const index = this.messages.value.findIndex((message) => message.id === userMessageId);
        const bubble = this.messages.value[index];
        if (bubble === undefined || bubble.role !== `user`) {
            return;
        }
        this.state.value = {
            ...this.state.value,
            messages: this.state.value.messages.filter((message, at) => message.id !== userMessageId && !(at > index && blank(message))),
            bubbleId: null,
        };
        this.queued.value = [{ id: crypto.randomUUID(), text: bubble.text, attachments: bubble.attachments ?? [] }, ...this.queued.value];
    }

    // The user enabled auto-resume while this conversation's limit failure was still pending. The daemon's
    // scheduler owns the resume from here (it remembered the failed turn regardless of the toggle), so this
    // only reflects that: retire the offer, say when the chat continues, and arm the re-attach probe that
    // renders the resumed run in this window.
    armLimitResume(): void {
        const pending = this.limitResume.value;
        if (pending === undefined) {
            return;
        }
        this.limitResume.value = undefined;
        this.appendNotice(`Auto-resume enabled — this chat continues by itself around ${formatReset(pending.resetsAt + RESUME_DELAY_S)}.`);
        this.scheduleLimitReattach(pending.resetsAt);
        this.persist();
    }

    // Timer for the pending probe (armed by a scheduled resume, re-armed between attempts); one per
    // conversation, so a fresh failure's schedule replaces a stale one.
    private limitReattachTimer: ReturnType<typeof setTimeout> | undefined;

    // See the RESUME_* constants above: wait out the reset plus the daemon's fire delay, then re-attach on
    // its poll cadence until the resumed run answers (or the attempts run out).
    private scheduleLimitReattach(resetsAt: number): void {
        clearTimeout(this.limitReattachTimer);
        let attempts = 0;
        const probe = (): void => {
            if (this.streaming.value) {
                return;
            }
            attempts += 1;
            void this.reattach().then((attached) => {
                if (!attached && attempts < LIMIT_REATTACH_TRIES && !this.streaming.value) {
                    this.limitReattachTimer = setTimeout(probe, LIMIT_REATTACH_INTERVAL_MS);
                }
            });
        };
        this.limitReattachTimer = setTimeout(probe, Math.max(0, resetsAt * 1000 + LIMIT_REATTACH_DELAY_MS - Date.now()));
    }

    // Release a hold placed by a failure the user has now fixed (reconnecting a revoked account) and let
    // whatever was held ride immediately. Nothing happens when the queue is empty, so calling it on every
    // conversation after a reconnect is safe.
    resume(): Promise<void> {
        this.interrupted = false;
        this.error.value = null;
        return this.drainQueue();
    }

    // Move this conversation onto a re-connected credential for the SAME human account. The session ref moves
    // with it: a reconnect mints a new local account id, and leaving the old one on the session would read as a
    // deliberate account switch and retire a live session that resumes perfectly well — the user reconnected to
    // carry on, not to start over.
    rebindAccount(accountId: string): void {
        this.account.value = accountId;
        const session = this.session.value;
        if (session !== undefined) {
            this.session.value = { ...session, account: accountId };
        }
        // Not a switch the user made — the same human account, re-credentialled — so no "switched to…" divider.
        // A pending one is retracted: whatever it announced, the next send now just carries on.
        this.dropSwitchNotice();
    }

    /* Deliver what's waiting, oldest first. A running turn takes them one at a time over /agent/steer; the
     * daemon is the authority on whether it can (a native codex/grok/ACP turn has no steering queue and
     * answers NOT_FOUND), so a refusal simply leaves the message queued for the settle below rather than
     * needing this client to predict the harness. A turn parked on a card is skipped too: the card is what the
     * agent is waiting on, so the message goes in once it's answered (the decide* methods drain again).
     *
     * With nothing running, the whole queue rides ONE fresh turn — "also do Y", written while the agent worked,
     * belongs to the same request as "and Z", not to a turn each. Public so the card decisions can re-drive it:
     * answering a card un-parks the turn, which is a moment the queue can move that no send() covers. */
    async drainQueue(): Promise<void> {
        for (;;) {
            const next = this.queued.value[0];
            if (next === undefined) {
                return;
            }
            if (this.streaming.value) {
                if (this.awaitingDecision.value || !(await this.deliverSteer(next))) {
                    return;
                }
                continue;
            }
            // An interrupted turn doesn't flush: the queue waits for the user's next send instead of starting
            // a turn nobody asked for. Same for a flush already in flight — it owns these messages.
            if (this.interrupted || this.flushing) {
                return;
            }
            this.flushing = true;
            try {
                const pending = this.queued.value;
                this.queued.value = [];
                await this.send(
                    pending
                        .map((message) => message.text)
                        .filter((text) => text.length > 0)
                        .join(`\n\n`),
                    this.turnSettings(),
                    pending.flatMap((message) => [...message.attachments]),
                    pending.find((message) => message.editorContext !== undefined)?.editorContext,
                );
            } finally {
                this.flushing = false;
            }
        }
    }

    // The turn settings a message sends under: this conversation's own current selection, captured at delivery.
    // The composer writes provider/model/effort/thinking straight onto these refs, so a queued message rides
    // whatever is selected when it actually goes — the same rule a typed message follows.
    turnSettings(): TurnSettings {
        return {
            agent: this.provider.value,
            harness: this.harness.value,
            account: this.account.value,
            model: this.model.value,
            effort: this.effort.value,
            thinking: this.thinking.value,
        };
    }

    // Hand one queued message to the running turn (the daemon injects it between tool calls), moving it into
    // the transcript once the daemon has it. False when no steerable turn is live — the message stays queued.
    // The running turn keeps streaming into its current bubble (above this message — that output answers what
    // came before); the `usage` frame closing the current turn retires the bubble, so the answer to this
    // message opens a fresh one below it.
    private async deliverSteer(message: QueuedMessage): Promise<boolean> {
        const paths = message.attachments.map((file) => file.path);
        const delivered = await this.postTurnControl(`/agent/steer`, {
            conversationId: this.conversationId,
            text: message.text,
            ...(paths.length > 0 ? { attachments: paths } : {}),
            ...(message.editorContext !== undefined ? { editorContext: message.editorContext } : {}),
        });
        if (!delivered) {
            return false;
        }
        this.removeQueued(message.id);
        this.append({
            role: `user`,
            text: message.text,
            ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
        });
        return true;
    }

    // User-initiated Stop button: retire any card the turn was parked on, record a muted notice, hard-cancel
    // the turn daemon-side (/agent/stop — fire-and-forget; NOT_FOUND just means it already settled), then
    // abort the local stream.
    stop(): void {
        if (!this.streaming.value) {
            return;
        }
        this.cancelPendingCards();
        this.appendNotice(`Stopped.`);
        void this.postTurnControl(`/agent/stop`, { conversationId: this.conversationId });
        this.abort();
        this.persist();
    }

    // Freeze whatever the stopped turn was parked on. Stop is offered WHILE a plan / question / permission card
    // is open — a turn holding the user's attention is exactly when they most want out — and the daemon settles
    // its own waiter with an abort reply, so the local card must stop asking too: /agent/reply would 404 from
    // here on, and a card left `pending` would keep awaitingDecision (and with it the composer's plan-feedback
    // routing and the tab's "awaiting" status) wedged on a turn that no longer exists.
    private cancelPendingCards(): void {
        if (!this.awaitingDecision.value) {
            return;
        }
        const cancel = (message: ChatMessage): ChatMessage => {
            const cancelled: Pick<ChatMessage, "plan" | "question" | "permission"> = {
                ...(message.plan?.status === `pending` ? { plan: { ...message.plan, status: `cancelled` } } : {}),
                ...(message.question?.status === `pending` ? { question: { ...message.question, status: `cancelled` } } : {}),
                ...(message.permission?.status === `pending` ? { permission: { ...message.permission, status: `cancelled` } } : {}),
            };
            return Object.keys(cancelled).length > 0 ? { ...message, ...cancelled } : message;
        };
        this.state.value = { ...this.state.value, messages: this.state.value.messages.map(cancel) };
    }

    // Aborts this tab's attach stream; whatever streamed so far stays in the transcript. The run itself is
    // detached daemon-side, so this is soft BY DESIGN — stop() above pairs it with /agent/stop to hard-cancel.
    // Called bare by the manager when its tab is closed: the turn finishes and lands its work, and reopening
    // the conversation reattaches to it.
    abort(): void {
        // The turn is ending on someone's say-so, not its own — hold the queue back from the settle flush
        // (a closed tab must not fire a turn; a stopped agent must not be immediately restarted).
        this.interrupted = true;
        this.flushType();
        this.probe?.abort();
        this.inflight?.abort();
        // A closed tab (or a sandbox switch) takes its resume probe with it — the daemon still fires the
        // resume; reopening the conversation replays it like any other detached run.
        clearTimeout(this.limitReattachTimer);
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
            // This window is now watching a live turn — its clean end may flush the queue (see send).
            this.interrupted = false;
            this.error.value = null;
            this.turnStartedAt.value = head.startedAt;
            const userMessageId = this.append({ role: `user`, text: head.prompt });
            this.openBubble();
            return { userMessageId, provider: this.provider.value, account: this.account.value, harness: this.harness.value };
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
                void this.drainQueue();
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
            this.append({ role: `user`, text: trimmed });
        }
        // The turn is generating again, so anything queued behind the card can go in now.
        void this.drainQueue();
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
        void this.drainQueue();
    }

    // Dismisses a pending question AND stops the turn. This TELLS the daemon (cancelled), rather than just
    // dropping the stream: the agent is parked inside its `ask` tool holding the conversation's run lock, so a
    // client-side-only dismissal would wedge the conversation until the daemon restarted.
    //
    // Stopping is the point, not a side effect — it is what Claude Code does, and for the same reason. The card
    // was raised because the agent could not choose for itself; waving it away answers nothing, so letting the
    // turn run on means it guesses at exactly the fork it just said it could not guess at. The user gets the
    // wheel back instead, with the transcript recording both halves ("Question dismissed." then "Stopped.").
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
        // After the card is frozen, so it reads back as dismissed rather than as a card the Stop caught pending.
        this.stop();
    }

    // Answers a pending permission card. 'once' allows just this call, 'always' also persists the rules the
    // SDK suggested so the same tool stops asking, 'deny' blocks it — and stops the turn, for the same reason a
    // dismissed question does (see cancelQuestion). The card offers no free text, so a denial hands the agent
    // nothing to redirect with; Claude Code draws the line in exactly that place, aborting a denial that carries
    // no feedback and letting one that does carry some steer the turn onward.
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
        if (decision === `deny` && feedback === undefined) {
            this.stop();
            return;
        }
        void this.drainQueue();
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

    // One frame in: the transcript transition is the reducer's, and whatever the frame ALSO does — set a
    // conversation ref, touch a cross-conversation store, open a file — comes back as effects this applies.
    private handleEvent(event: AgentEvent, turn: TurnContext): void {
        const { state, effects } = applyTurnFrame(this.state.value, event, { userMessageId: turn.userMessageId });
        this.state.value = state;
        this.syncTypewriter();
        for (const effect of effects) {
            this.applyEffect(effect, turn);
        }
    }

    // Keep the animation clock in step with the buffer the reducer produced: start a loop when a frame left
    // text unrevealed, stop one whose buffer a flush (a card, an end-of-turn) already emptied.
    private syncTypewriter(): void {
        if (this.state.value.pending !== undefined) {
            if (this.rafId === null) {
                this.rafId = requestAnimationFrame(() => this.drainType());
            }
            return;
        }
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    private applyEffect(effect: TurnEffect, turn: TurnContext): void {
        switch (effect.kind) {
            case `session`:
                // Captured with the turn's provider/account so a later mismatch (a mid-chat switch) is
                // detectable at send time.
                this.session.value = { id: effect.sessionId, provider: turn.provider, account: turn.account, harness: turn.harness };
                return;
            case `worktree`:
                // First frame of an isolated turn: which branch/base this conversation works on.
                this.worktree.value = { branch: effect.branch, base: effect.base };
                return;
            case `liveMode`:
                // The turn's live posture — the user's pick echoed back at init, or a move the AGENT made
                // (EnterPlanMode / a plan approval). Drives the composer's selector so it never lies, without
                // overwriting the pick the NEXT turn starts from.
                this.liveMode.value = effect.mode;
                return;
            case `commands`:
                // The provider's slash commands (ACP agents), replaced whole — the composer's `/` popover.
                this.availableCommands.value = effect.items;
                return;
            case `activeModel`:
                this.activeModel.value = effect.model;
                return;
            case `contextUsage`:
                // Per-conversation context-window fill — held on this instance (not the singleton) so the
                // composer shows the active chat's meter for auto-compaction awareness.
                this.contextUsage.value = effect.usage;
                return;
            case `totals`:
                // The conversation's lifetime accounting (the fleet card's cost/token readout). The usage's
                // TRANSCRIPT attachment already happened — it is a change to a bubble, so the reducer made it.
                this.costUsd.value += effect.usage.costUsd ?? 0;
                this.inputTokens.value += effect.usage.inputTokens ?? 0;
                this.outputTokens.value += effect.usage.outputTokens ?? 0;
                return;
            case `accountUsage`:
                // Account-wide subscription headroom, keyed by the account that served the turn so switching
                // accounts shows the right one. Stamped with the read time so it can be compared against the
                // daemon's persisted snapshot on the next `/accounts` load — whichever is newer wins, and the
                // picker can say how stale a reading is.
                usageStatusByAccount.value = {
                    ...usageStatusByAccount.value,
                    [effect.account]: { windows: [...effect.windows], measuredAt: Date.now() },
                };
                return;
            case `followToolCall`: {
                // Auto-open the file an edit touches. Lazily imported so the chat model doesn't statically pull
                // in the workspace-tabs chain.
                const { call } = effect;
                void import(`../workspace/useFollowAlong`).then((m) => m.useFollowAlong().followToolCall(call));
                // A MAIN-TREE turn writes the files the Changes panel commits, so its paths are recorded for the
                // panel to warn against — per repo, so an agent working in one repo says nothing about the rest.
                // An isolated turn writes its own worktree and lands as a reviewable diff, so it records nothing:
                // that distinction is the whole reason the panel no longer blocks committing on "an agent is
                // running", which was true of both and meaningful for neither.
                if (!this.isolated.value && this.turnStartedAt.value !== undefined) {
                    const startedAt = this.turnStartedAt.value;
                    void import(`../workspace/liveWrites`).then((m) => m.recordTurnWrite(this.conversationId, startedAt, call));
                }
                return;
            }
            case `surfaceTerminal`: {
                // The agent started running Bash in its live `agent-<id>` tmux terminal. Remember it, so this
                // conversation's Bash cards can offer to watch it, and tell the terminal layer whose it is, so
                // its popover names the conversation instead of eight hex characters. The panel is then asked to
                // surface it, which tabs it only if the user opted into AI terminals — no auto-open, no focus
                // steal either way. Both imports are lazy so the chat model doesn't statically pull in the
                // xterm/terminal-panel chain.
                const { session } = effect;
                this.agentTerminal.value = session;
                const title = this.title.value;
                void import("../terminal/useAgentTerminals").then((m) => m.noteAgentTerminal(session, title));
                void import("../terminal/useTerminalPanel").then((m) => m.useTerminalPanel().surface(session));
                return;
            }
            case `error`:
                this.applyTurnError(effect, turn);
                return;
        }
    }

    // How a turn-level failure READS. Split out of the reducer because most of these codes need state it has no
    // business reaching for — the account's usage windows, the provider's account list — to phrase themselves,
    // and because the choice between a muted notice and the red error line is a product decision rather than a
    // transcript rule.
    private applyTurnError(error: Extract<TurnEffect, { kind: "error" }>, turn: TurnContext): void {
        const { message, code } = error;
        if (code === `claude-reauth`) {
            /* The Claude credential is dead and the daemon refused the turn before running any of it. Nothing
             * was processed, so the message is not part of the conversation yet — pull the bubble back out of
             * the transcript and return it to the queue, which is exactly what the queue means (written, not
             * delivered) and what makes reconnecting REPLAY it instead of asking the user to retype into every
             * chat that bounced. `interrupted` holds the drain until then, so it can't immediately re-fail. */
            this.requeueUndelivered(turn.userMessageId);
            this.interrupted = true;
            const provider = this.provider.value;
            const accounts = providerAccounts.value[provider] ?? [];
            const accountId = this.account.value ?? accounts[0]?.id;
            const markReauth = (account: OauthAccount): OauthAccount =>
                account.id === accountId ? { ...account, needsReauth: true, detail: message } : account;
            providerAccounts.value = { ...providerAccounts.value, [provider]: accounts.map(markReauth) };
            // Muted, like session-not-found: the condition has a one-click fix sitting right above the composer
            // (ChatPanel's reauth banner, which this needsReauth flag raises), so the red line would overstate it.
            this.appendNotice(`${message} Your message is held here and goes as soon as the account is back.`);
            return;
        }
        if (code === `session-not-found`) {
            // The sandbox no longer has this chat's transcript — drop the dead session so the next send starts
            // a fresh one instead of replaying the failure forever. A muted notice, not the error ref: the
            // condition is self-healed, so the red line + error tab status would overstate it.
            this.session.value = undefined;
            this.appendNotice(
                `This chat's server-side history is gone (the sandbox was rebuilt or the session was deleted). Your last message wasn't processed — send it again; a fresh session starts, seeded with this window's transcript.`,
            );
            return;
        }
        if (code === `codex-advisory`) {
            // Codex warned about the turn it then ran to completion (its pinned CLI has no metadata for a model
            // the subscription already serves, so the turn runs on fallback context/compaction limits). The red
            // line said the turn had failed, directly under the answer it had just produced. Muted, like the
            // other codes that describe a turn rather than end one.
            this.appendNotice(message);
            return;
        }
        if (code === `rate_limit`) {
            // Claude's subscription usage cap, not a crash — render the daemon's message as a muted notice
            // (like session-not-found) rather than the red error ref, so it reads as "wait and retry" instead
            // of "the workspace broke". The daemon says where the resume stands: "scheduled" means it re-runs
            // this turn by itself a minute after the reset (arm the re-attach probe so this window renders the
            // resumed run); "available" means it remembered the failed turn and enabling autoResumeOnLimit
            // arms that same resume — surfaced as the composer's offer banner. The frame's own reset instant
            // wins over the usage store's binding window (the frame names the pool that actually refused).
            const resetsAt = error.resetsAt ?? bindingWindow(usageStatusFor(this.account.value))?.resetsAt;
            if (error.autoResume === `scheduled` && resetsAt !== undefined) {
                this.appendNotice(`${message} Auto-resume is on — this chat continues by itself around ${formatReset(resetsAt + RESUME_DELAY_S)}.`);
                this.scheduleLimitReattach(resetsAt);
                return;
            }
            if (error.autoResume === `available` && resetsAt !== undefined) {
                this.limitResume.value = { resetsAt };
            }
            this.appendNotice(resetsAt !== undefined ? `${message} Resets ${formatReset(resetsAt)}.` : message);
            return;
        }
        if (code === `codex-reauth`) {
            // The daemon rejected this account's credential before the turn. Surface the red line AND light the
            // account's reauth badge immediately (the proactive probe confirms it on the next status load) by
            // marking the matching account in the shared list — no daemon round-trip.
            const provider = this.provider.value;
            const accounts = providerAccounts.value[provider] ?? [];
            const accountId = this.account.value ?? accounts[0]?.id;
            const markReauth = (account: OauthAccount): OauthAccount =>
                account.id === accountId ? { ...account, needsReauth: true, detail: message } : account;
            providerAccounts.value = { ...providerAccounts.value, [provider]: accounts.map(markReauth) };
            this.error.value = message;
            return;
        }
        if (code === `grok-model-invalid` || code === `codex-model-invalid`) {
            // The daemon rejected the pinned model. Grok self-heals mid-turn (re-prompting with a model xAI
            // named), so its code reaches us only when that failed; Codex can't (OpenAI names no alternative),
            // so its code always lands here. Either way: surface it (red) and reload the provider's live catalog
            // so the picker — and any conversation still pinning the dead id — repoints to what the daemon
            // actually serves. Dynamic import breaks the static cycle (useChat imports this module).
            const provider = this.provider.value;
            void import(`./useChat`).then((chat) => chat.loadProviderModels(provider));
            this.error.value = message;
            return;
        }
        this.error.value = message;
    }

    // --- transcript writes the conversation itself makes (control actions, restores) --------------------------
    // Each is one pure transition applied to the same state the reducer moves, so a notice a Stop appends and a
    // notice a frame appends allocate ids from one counter and land in one list.

    // Open the turn's first bubble: a fresh empty assistant message the frames stream into, so the typing
    // indicator shows the moment the turn starts rather than on the first delta.
    private openBubble(): void {
        const id = this.append({ role: `assistant`, text: ``, thinking: `` });
        this.state.value = { ...this.state.value, bubbleId: id };
    }

    private append(message: Omit<ChatMessage, "id">): number {
        const id = this.state.value.nextId;
        this.state.value = appendMessage(this.state.value, message);
        return id;
    }

    // A small muted system line marking a control action (dismissed / kept planning / approved / stopped).
    private appendNotice(text: string): void {
        this.state.value = appendNotice(this.state.value, text);
    }

    // Hang an interactive card (plan / question / permission) on a bubble — and, with the answered card, freeze
    // that answer into the transcript. One writer for all three: they differ in what they ask, not in how they
    // attach.
    private attachCard(id: number, card: Pick<ChatMessage, "plan" | "question" | "permission">): void {
        this.state.value = {
            ...this.state.value,
            messages: this.state.value.messages.map((message) => (message.id === id ? { ...message, ...card } : message)),
        };
    }

    // One typewriter tick: reveal a slice and schedule the next frame while text remains.
    private drainType(): void {
        this.rafId = null;
        this.state.value = revealPending(this.state.value);
        if (this.state.value.pending !== undefined) {
            this.rafId = requestAnimationFrame(() => this.drainType());
        }
    }

    // Drain the whole buffer at once and stop the loop — called when a turn ends or is stopped, so no text is
    // left mid-type. (A card taking the bubble over flushes inside the reducer, where the rule belongs.)
    private flushType(): void {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.state.value = flushPending(this.state.value);
    }
}
