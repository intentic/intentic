import type { AgentHarness, AgentProvider, EditorContext, PermissionMode } from "@intentic/sandbox-contract";
import type { ProcedureInput } from "../../sandbox/client/sandboxRpc";

// The turn body the daemon receives: what a send carries, which session it may resume, and the shape that
// states both on the wire. Provider and harness are switchable mid-conversation; a session id only resumes on
// the runtime that minted it, so a switched turn omits it.

// Where a fork was cut from, carried by its first turn: `keep` rows of `conversationId`, over `files` then or now.
export type ForkLink = NonNullable<ProcedureInput<`agent.run`>["forkOf"]>;

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
    // The folder the conversation opens in (the project it belongs to); undefined means the workspace root. The daemon
    // latches the first turn's answer.
    readonly startIn: string | undefined;
    readonly model: string;
    readonly effort: string;
    readonly thinking: boolean;
    // Whether to ask for fast speed, already reconciled against the selected model (see turnSettings).
    readonly fast: boolean;
    // Keeps the picked model despite looking simple; sent even when false, to clear an earlier hold.
    // This turn's model came from Auto's reading, not a hand. Absent on every other turn, which is the point: it
    // marks the one turn the judge decided.
    readonly autoPicked?: boolean;
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

// Flags that ride only when true, since the daemon reads false and unset the same way. `autoPicked` is deliberately not
// one of them: unset there would leave an earlier turn's veto standing on the conversation.
const setFlags = (settings: TurnSettings): { fast?: true; autoPicked?: true } => ({
    ...(settings.fast ? { fast: true as const } : {}),
    ...(settings.autoPicked === true ? { autoPicked: true as const } : {}),
});

// Two fields, not one: a chip is a file the user chose, so an unresolvable one refuses the send, while a mention is
// this tokenizer's reading of their words, so an unresolvable one is the daemon's to drop. Each omitted when empty.
const filePaths = (attachments: string[], mentions: string[]): Pick<ProcedureInput<`agent.run`>, "attachments" | "mentions"> => ({
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
});

// Builds the turn request body. An omitted `model`/`harness`/`sessionId` each resolve to the daemon's own
// default; `isolated` picks the conversation's worktree over /work.
export const turnRequestBody = (input: {
    // This window's name for the message, so the daemon recognises a resend of it and a Stop can name it.
    readonly messageId: string;
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
    readonly forkOf: ForkLink | undefined;
    // Files the user staged as chips. A path the daemon can't resolve refuses the send, since the user chose it.
    readonly attachmentPaths: string[];
    // Workspace paths read out of the text's own `@` tokens. Ride apart from the chips: nobody chose them, so the
    // daemon drops one that doesn't resolve rather than refusing the turn over a word in a paste.
    readonly mentionedPaths: string[];
    readonly editorContext: EditorContext | undefined;
}): ProcedureInput<`agent.run`> => {
    // Whether this body targets this sandbox; fields scoped to another box's store are dropped otherwise.
    const here = input.box === undefined;
    return {
        messageId: input.messageId,
        prompt: input.text,
        // Seeds a fresh registry entry's title; an existing entry keeps its own.
        ...(input.title !== null ? { title: input.title } : {}),
        ...filePaths(input.attachmentPaths, input.mentionedPaths),
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
        // Omitted for another box, whose projects are its own.
        ...(here && input.settings.startIn !== undefined ? { startIn: input.settings.startIn } : {}),
        sessionId: input.resume?.id,
        ...(input.forkOf !== undefined ? { forkOf: input.forkOf } : {}),
        // Empty selection (catalog not yet loaded) is dropped; the daemon resolves its own live default.
        model: input.settings.model || undefined,
        effort: input.settings.effort,
        thinking: input.settings.thinking,
        ...setFlags(input.settings),
        // Always sent: unlike the flags above, unset would leave an earlier turn's veto standing on the conversation.
        // Starting permission posture, passed straight to the SDK:
        //   plan – proposes then executes
        //   default – prompts per tool
        //   bypassPermissions – asks nothing
        permissionMode: input.mode,
        // Opt-in file/selection chip; a path in this workspace, so it stays here.
        ...(here && input.editorContext !== undefined ? { editorContext: input.editorContext } : {}),
    };
};
