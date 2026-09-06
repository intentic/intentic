import type { AgentHarness, AgentProvider, EditorContext, PermissionMode } from "@intentic/sandbox-contract";

/* THE TURN AS THE DAEMON RECEIVES IT, what a send carries, which session it may resume, and the body that
 * states both on the wire. Assembled as values here instead of inline in Conversation.send so the rules can be
 * read, and tested, without a conversation and a fetch wrapped around them.
 *
 * The provider (AgentProvider) and harness (AgentHarness) a turn runs on are the contract's wire enums, see
 * schemas.ts for their semantics. Both are switchable mid-conversation: a session id only resumes on the runtime
 * that minted it, so a switched turn simply omits it. Seeding the replacement session with what came before is
 * the DAEMON's job, from its own record of the conversation, this client sends the prompt and nothing else. */

// The turn settings passed into a send, the active conversation's own selected provider/model/effort/thinking
// (see useChat's active-conversation facades), captured at send time.
export interface TurnSettings {
    readonly agent: AgentProvider;
    // Which harness runs the turn (native runtime vs the Claude Code loop). Orthogonal to `agent`.
    readonly harness: AgentHarness;
    // Which connected account of the provider serves the turn; undefined ⇒ the daemon's first account.
    readonly account: string | undefined;
    /* WHO THE TURN IS TO THE OUTSIDE WORLD, a persona id, and the one setting on this line that is not about
     * the model. `account` above pays for the turn; this decides whose logged-in accounts it may act through
     * and how big a toolbox it holds. Undefined is the ordinary chat: somebody is watching, so every connected
     * account stays reachable (the daemon's own rule, see turnPersona). */
    readonly actsAs: string | undefined;
    readonly model: string;
    readonly effort: string;
    readonly thinking: boolean;
    // Whether to ask for fast speed. Already reconciled against the selected model when it gets here (see
    // Conversation.turnSettings), this is the answer to send, not the toggle's raw position.
    readonly fast: boolean;
    // Keep the turn on the picked model even when it looks simple (the automatic-tier veto). Unlike `fast` it
    // is sent even when false: the daemon persists the hold per conversation, and only an explicit false can
    // clear one set on an earlier turn.
    readonly tierHold: boolean;
}

// A provider-minted resumable session and the runtime/account it belongs to, the trio is coherent by
// construction (captured together from the stream's session frame). A session only resumes on its own
// runtime/account; a mismatched selection at send time retires it.
export interface SessionRef {
    readonly id: string;
    readonly provider: AgentProvider;
    readonly account: string | undefined;
    // The harness that minted it, a session only resumes on the same runtime, so a harness switch retires it too.
    readonly harness: AgentHarness;
}

/* A SESSION, BOUND TO WHAT MINTED IT, from the turn that produced it and the daemon's own word on the account.
 *
 * The account is the only one of the three the client cannot state: a turn naming none is served by whichever
 * connected account has headroom (the daemon's rule), so the pick this turn went out with is a request, not an
 * answer. Taken from the `session` frame wherever the daemon named one, which is every turn served by a stored
 * account, and falling back to what was asked for only when it did not (an env-token or translator turn, where
 * there is no stored account either way). */
export const boundSession = (
    sessionId: string,
    turn: { readonly provider: AgentProvider; readonly account: string | undefined; readonly harness: AgentHarness },
    resolvedAccount: string | undefined,
): SessionRef => ({ id: sessionId, provider: turn.provider, account: resolvedAccount ?? turn.account, harness: turn.harness });

/* WHETHER A SESSION SURVIVES THE NEXT SEND. A provider mints a session on one runtime under one credential, so
 * all three have to still match the selection for it to resume; any one of them moving retires it and the next
 * turn starts a fresh session seeded with the transcript so far. Written once because two places ask it about
 * two different things, the composer's "switched to…" divider asks BEFORE the send (is there anything to
 * announce), send() asks at the moment of truth, and a drift between them would show a divider promising a
 * fresh session for a turn that then resumed, or say nothing before one that didn't. */
export const resumes = (
    session: SessionRef | undefined,
    selection: { agent: AgentProvider; account: string | undefined; harness: AgentHarness },
): boolean =>
    session !== undefined && session.provider === selection.agent && session.account === selection.account && session.harness === selection.harness;

/* Every field here is a rule about what the daemon then does, an omitted `model` makes it resolve its own
 * live-catalog default, an omitted `harness` means the native loop, an omitted `sessionId` means "start a fresh
 * session and seed it from the conversation's record", `isolated` decides whether the turn runs in this
 * conversation's worktree or on /work. Undefined keys drop out at JSON.stringify, which is what makes "omitted"
 * expressible at all. */
export const turnRequestBody = (input: {
    readonly text: string;
    readonly conversationId: string;
    readonly title: string | null;
    readonly isolated: boolean;
    // The runner this conversation executes on, on its FIRST turn; absent = this sandbox. The daemon latches
    // it with the conversation's identity, so later turns need not (and cannot usefully) repeat it.
    readonly runner?: string | undefined;
    /* WHICH SANDBOX IS BEING ASKED, which is not a field on the wire at all: it is the ADDRESS this body is
     * posted to (Conversation.box → sandboxRequestVia). It is here because three of the fields below name
     * things that exist in ONE daemon's stores, and a body assembled for another box must not carry them:
     *
     *   `account`   an account id is a key in the box's own credential store. Omitted, which already means
     *               "the daemon picks its first account for this provider", so the turn runs on the target
     *               box's own credentials, the only ones it has.
     *   `actsAs`    a persona is a card in the box's record. A named card that cannot be found is the one case
     *               the daemon answers with nothing at all, so the remote turn is an ordinary attended chat.
     *   `editorContext` the file open in THIS workspace's editor, at a path the other box has no reason to have.
     *
     * The model and provider DO cross, deliberately: a model id belongs to the provider, not to the box, and
     * the target daemon resolves it against its own catalog (or refuses at the door, in a sentence the composer
     * shows). `runner` is dropped for the same reason as `account`: runners are paired to one sandbox. */
    readonly box?: string | undefined;
    readonly mode: PermissionMode;
    readonly settings: TurnSettings;
    // The session this turn resumes, when the selection still matches the runtime/account that minted it.
    readonly resume: SessionRef | undefined;
    // Where this conversation was forked from, on a fork's first turn, the daemon copies that many rows of the
    // source's record into this one before running, and `files` tells it whether this fork starts on the files
    // as they were at the cut or as they are now (see Conversation.forkFrom).
    readonly forkOf: { readonly conversationId: string; readonly keep: number; readonly files: "then" | "now" } | undefined;
    // Uploaded attachments plus @-mentioned workspace paths, the daemon resolves both the same way.
    readonly attachmentPaths: readonly string[];
    readonly editorContext: EditorContext | undefined;
}) => {
    // Everything a conversation homed in another sandbox may not say about this one, in one place, so a field
    // added below cannot quietly start crossing (see `box` above).
    const here = input.box === undefined;
    return {
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
        // Where it runs. Omitted for this sandbox, which is what every conversation that never touches the
        // placement picker sends, so the ordinary chat's request is byte-for-byte what it always was. A runner
        // is one sandbox's paired machine, so it never rides a body addressed to another box.
        ...(here && input.runner !== undefined ? { placement: { kind: `runner` as const, id: input.runner } } : {}),
        // `native` is the daemon's default, so only `claude-code` rides the wire, that's what routes codex/grok
        // through the translator under the Claude Code loop.
        ...(input.settings.harness === `claude-code` ? { harness: input.settings.harness } : {}),
        // Which connected account of the provider serves the turn; omitted ⇒ the daemon picks the first, which
        // is also the only honest answer when the daemon being asked is not the one holding this selection.
        account: here ? input.settings.account : undefined,
        // The persona this turn wears. Omitted when none is picked, which for an attended chat means "every
        // connected account", sending an empty string instead would name a card that does not exist, and a named
        // card that cannot be found is the one case the daemon answers with nothing at all.
        ...(here && input.settings.actsAs !== undefined ? { actsAs: input.settings.actsAs } : {}),
        sessionId: input.resume?.id,
        ...(input.forkOf !== undefined ? { forkOf: input.forkOf } : {}),
        // An empty selection (a catalog not yet loaded) is dropped from the wire; the daemon then resolves the
        // provider's live catalog default server-side.
        model: input.settings.model || undefined,
        effort: input.settings.effort,
        thinking: input.settings.thinking,
        // Sent only when asked for. `false` and "not asked" mean the same thing to the daemon, and omitting keeps
        // the body honest about which turns actually reached for a paid speed-up.
        ...(input.settings.fast ? { fast: true } : {}),
        // Always sent, unlike `fast`: false and "not asked" mean DIFFERENT things here, because the daemon keeps
        // the hold on the conversation's entry and an omitted field would leave yesterday's veto standing.
        tierHold: input.settings.tierHold,
        // The turn's STARTING permission posture. The daemon hands it straight to the SDK, so all four modes are
        // real: 'plan' proposes-then-executes, 'default' prompts per tool on the permission card, 'acceptEdits'
        // auto-accepts edits, 'bypassPermissions' asks nothing.
        permissionMode: input.mode,
        // The opt-in editor-context chip: the file (and selection) the user chose to attach, which is a path in
        // THIS workspace and so stays here.
        ...(here && input.editorContext !== undefined ? { editorContext: input.editorContext } : {}),
    };
};
