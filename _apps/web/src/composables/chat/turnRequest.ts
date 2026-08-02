import type { AgentHarness, AgentProvider, EditorContext, PermissionMode } from "@intentic/sandbox-contract";

/* THE TURN AS THE DAEMON RECEIVES IT — what a send carries, which session it may resume, and the body that
 * states both on the wire. Assembled as values here instead of inline in Conversation.send so the rules can be
 * read — and tested — without a conversation and a fetch wrapped around them.
 *
 * The provider (AgentProvider) and harness (AgentHarness) a turn runs on are the contract's wire enums — see
 * schemas.ts for their semantics. Both are switchable mid-conversation: a session id only resumes on the runtime
 * that minted it, so a switched turn retires the session and starts a fresh one seeded with the transcript so
 * far (see Conversation.send). */

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
    // Whether to ask for fast speed. Already reconciled against the selected model when it gets here (see
    // Conversation.turnSettings) — this is the answer to send, not the toggle's raw position.
    readonly fast: boolean;
}

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

/* WHETHER A SESSION SURVIVES THE NEXT SEND. A provider mints a session on one runtime under one credential, so
 * all three have to still match the selection for it to resume; any one of them moving retires it and the next
 * turn starts a fresh session seeded with the transcript so far. Written once because two places ask it about
 * two different things — the composer's "switched to…" divider asks BEFORE the send (is there anything to
 * announce), send() asks at the moment of truth — and a drift between them would show a divider promising a
 * fresh session for a turn that then resumed, or say nothing before one that didn't. */
export const resumes = (
    session: SessionRef | undefined,
    selection: { agent: AgentProvider; account: string | undefined; harness: AgentHarness },
): boolean =>
    session !== undefined && session.provider === selection.agent && session.account === selection.account && session.harness === selection.harness;

/* Every field here is a rule about what the daemon then does — an omitted `model` makes it resolve its own
 * live-catalog default, an omitted `harness` means the native loop, `history` and `sessionId` are mutually
 * exclusive (seed a fresh session, or resume an existing one), `isolated` decides whether the turn runs in this
 * conversation's worktree or on /work. Undefined keys drop out at JSON.stringify, which is what makes "omitted"
 * expressible at all. */
export const turnRequestBody = (input: {
    readonly text: string;
    readonly conversationId: string;
    readonly title: string | null;
    readonly isolated: boolean;
    readonly mode: PermissionMode;
    readonly settings: TurnSettings;
    // The session this turn resumes, when the selection still matches the runtime/account that minted it.
    readonly resume: SessionRef | undefined;
    // The transcript seeding a fresh-after-switch session; empty whenever `resume` carries one.
    readonly history: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
    // Uploaded attachments plus @-mentioned workspace paths — the daemon resolves both the same way.
    readonly attachmentPaths: readonly string[];
    readonly editorContext: EditorContext | undefined;
}) => ({
    prompt: input.text,
    // The display title (derived at send or user-chosen) seeds a fresh registry entry, so a renamed draft
    // keeps its title through its first turn; existing entries keep theirs.
    ...(input.title !== null ? { title: input.title } : {}),
    ...(input.attachmentPaths.length > 0 ? { attachments: input.attachmentPaths } : {}),
    agent: input.settings.agent,
    // The stable conversation identity + the worktree opt-in: an isolated turn runs in this conversation's
    // own git worktree (branch agent/<conversationId>) instead of /work.
    conversationId: input.conversationId,
    ...(input.isolated ? { isolated: true } : {}),
    // `native` is the daemon's default, so only `claude-code` rides the wire — that's what routes codex/grok
    // through the translator under the Claude Code loop.
    ...(input.settings.harness === `claude-code` ? { harness: input.settings.harness } : {}),
    // Which connected account of the provider serves the turn; omitted ⇒ the daemon picks the first.
    account: input.settings.account,
    sessionId: input.resume?.id,
    ...(input.history.length > 0 ? { history: input.history } : {}),
    // An empty selection (a catalog not yet loaded) is dropped from the wire; the daemon then resolves the
    // provider's live catalog default server-side.
    model: input.settings.model || undefined,
    effort: input.settings.effort,
    thinking: input.settings.thinking,
    // Sent only when asked for. `false` and "not asked" mean the same thing to the daemon, and omitting keeps
    // the body honest about which turns actually reached for a paid speed-up.
    ...(input.settings.fast ? { fast: true } : {}),
    // The turn's STARTING permission posture. The daemon hands it straight to the SDK, so all four modes are
    // real: 'plan' proposes-then-executes, 'default' prompts per tool on the permission card, 'acceptEdits'
    // auto-accepts edits, 'bypassPermissions' asks nothing.
    permissionMode: input.mode,
    // The opt-in editor-context chip: the file (and selection) the user chose to attach.
    ...(input.editorContext !== undefined ? { editorContext: input.editorContext } : {}),
});
