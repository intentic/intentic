import type { AgentHarness, AgentProvider, EditorContext, PermissionMode } from "@intentic/sandbox-contract";

// The turn body the daemon receives: what a send carries, which session it may resume, and the shape that
// states both on the wire. Provider and harness are switchable mid-conversation; a session id only resumes on
// the runtime that minted it, so a switched turn omits it.

// Turn settings passed into a send: the active conversation's own provider/model/effort/thinking, captured at
// send time.
export interface TurnSettings {
    readonly agent: AgentProvider;
    // Which harness runs the turn (native runtime vs the Claude Code loop); orthogonal to `agent`.
    readonly harness: AgentHarness;
    // Which connected account of the provider serves the turn; undefined means the daemon's first account.
    readonly account: string | undefined;
    // Persona id the turn acts as; undefined means an ordinary chat with every connected account reachable.
    readonly actsAs: string | undefined;
    readonly model: string;
    readonly effort: string;
    readonly thinking: boolean;
    // Whether to ask for fast speed, already reconciled against the selected model (see turnSettings).
    readonly fast: boolean;
    // Keeps the picked model despite looking simple; sent even when false, to clear an earlier hold.
    readonly tierHold: boolean;
}

// A provider-minted resumable session and the runtime/account it belongs to; a mismatched selection at send
// time retires it.
export interface SessionRef {
    readonly id: string;
    readonly provider: AgentProvider;
    readonly account: string | undefined;
    // Harness that minted the session; a harness switch retires it too, same as runtime/account.
    readonly harness: AgentHarness;
}

// Builds a session ref from the turn that produced it and the daemon's own account for it. Account falls back
// to what was asked for only when the daemon named none (env-token or translator turns).
export const boundSession = (
    sessionId: string,
    turn: { readonly provider: AgentProvider; readonly account: string | undefined; readonly harness: AgentHarness },
    resolvedAccount: string | undefined,
): SessionRef => ({ id: sessionId, provider: turn.provider, account: resolvedAccount ?? turn.account, harness: turn.harness });

// True when a session's runtime, account and harness still match the current selection; any mismatch means the
// next turn starts fresh.
export const resumes = (
    session: SessionRef | undefined,
    selection: { agent: AgentProvider; account: string | undefined; harness: AgentHarness },
): boolean =>
    session !== undefined && session.provider === selection.agent && session.account === selection.account && session.harness === selection.harness;

// Builds the turn request body. An omitted `model`/`harness`/`sessionId` each resolve to the daemon's own
// default; `isolated` picks the conversation's worktree over /work.
export const turnRequestBody = (input: {
    readonly text: string;
    readonly conversationId: string;
    readonly title: string | null;
    readonly isolated: boolean;
    // Runner this conversation executes on, set on its first turn; the daemon latches it from there.
    readonly runner?: string | undefined;
    // Not a wire field: the address this body is posted to (Conversation.box). Fields scoped to one daemon's own
    // store must not cross to another box:
    //   account – a key in the box's credential store; omitted picks its first account.
    //   actsAs – a persona card in the box's record; unresolved names send an ordinary chat.
    //   editorContext – a path in this workspace, meaningless on another box.
    // Model and provider do cross: the target daemon resolves the model against its own catalog.
    readonly box?: string | undefined;
    readonly mode: PermissionMode;
    readonly settings: TurnSettings;
    // Session this turn resumes, if the selection still matches the runtime and account that minted it.
    readonly resume: SessionRef | undefined;
    // Fork point: the daemon copies rows from the source's record before running; `files` picks then or now.
    readonly forkOf: { readonly conversationId: string; readonly keep: number; readonly files: "then" | "now" } | undefined;
    // Uploaded attachments plus @-mentioned workspace paths; the daemon resolves both the same way.
    readonly attachmentPaths: readonly string[];
    readonly editorContext: EditorContext | undefined;
}) => {
    // Whether this body targets this sandbox; fields scoped to another box's store are dropped otherwise.
    const here = input.box === undefined;
    return {
        prompt: input.text,
        // Seeds a fresh registry entry's title; an existing entry keeps its own.
        ...(input.title !== null ? { title: input.title } : {}),
        ...(input.attachmentPaths.length > 0 ? { attachments: input.attachmentPaths } : {}),
        agent: input.settings.agent,
        // Isolated runs in this conversation's own worktree (branch agent/<conversationId>), not /work.
        conversationId: input.conversationId,
        ...(input.isolated ? { isolated: true } : {}),
        // Omitted for this sandbox; a runner is paired to one box, so it never rides another box's body.
        ...(here && input.runner !== undefined ? { placement: { kind: `runner` as const, id: input.runner } } : {}),
        // `native` is the daemon's default and stays unsent; only `claude-code` rides the wire.
        ...(input.settings.harness === `claude-code` ? { harness: input.settings.harness } : {}),
        // Omitted when this body targets another box, since that daemon holds no such selection.
        account: here ? input.settings.account : undefined,
        // Omitted rather than empty: an unresolved persona card gets an ordinary chat, not an error.
        ...(here && input.settings.actsAs !== undefined ? { actsAs: input.settings.actsAs } : {}),
        sessionId: input.resume?.id,
        ...(input.forkOf !== undefined ? { forkOf: input.forkOf } : {}),
        // Empty selection (catalog not yet loaded) is dropped; the daemon resolves its own live default.
        model: input.settings.model || undefined,
        effort: input.settings.effort,
        thinking: input.settings.thinking,
        // Sent only when true; the daemon treats false and unset the same way.
        ...(input.settings.fast ? { fast: true } : {}),
        // Always sent: unlike `fast`, unset would leave an earlier turn's veto standing on the conversation.
        tierHold: input.settings.tierHold,
        // Starting permission posture, passed straight to the SDK:
        //   plan – proposes then executes
        //   default – prompts per tool
        //   acceptEdits – auto-accepts edits
        //   bypassPermissions – asks nothing
        permissionMode: input.mode,
        // Opt-in file/selection chip; a path in this workspace, so it stays here.
        ...(here && input.editorContext !== undefined ? { editorContext: input.editorContext } : {}),
    };
};
