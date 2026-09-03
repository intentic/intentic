import { z } from "zod";
import { AgentPlacementSchema } from "../runner-protocol.js";
import { entryId } from "./internal.js";
// The agent runtimes the daemon can serve, the vocabulary every surface that picks an agent shares (chat
// turns, automations). The NATIVE providers have dedicated adapters (and their ids are reserved); an
// `endpoint/<id>` value names an installed `endpoint`-kind capability (a model API the user pointed us at,
// see EndpointConfigSchema); any other value is the id of an installed `agent`-kind capability served over
// ACP (Agent Client Protocol).
// Kept as a bare string on the wire (not an enum) so an unknown id is a clean error frame from the agent
// route, the same bet RepoParamSchema makes, and adding an ACP agent needs no contract change.
export const NATIVE_PROVIDERS = ["claude", "codex", "grok", "kimi", "gemini", "cursor"] as const;
export type NativeProvider = (typeof NATIVE_PROVIDERS)[number];
export const AgentProviderSchema = z.string().min(1);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;
// The provider naming a catalog in the one route every native provider shares (providers.contract.ts). An ENUM
// rather than the bare-string schema above, and deliberately so: the open vocabulary exists because an ACP agent
// or an endpoint can be added without a contract change, but neither has a daemon-held catalog, this route's
// subjects are exactly the five the daemon keeps one for. Closing it here is what makes an unknown id a 400 from
// the contract instead of a registry lookup that reads back `undefined` and serves an empty list.
export const NativeProviderParamSchema = z.object({ provider: z.enum(NATIVE_PROVIDERS) });
// The harness (agentic loop) a turn runs on, orthogonal to the provider. See AgentTurnSchema.harness.
export const AgentHarnessSchema = z.enum(["native", "claude-code"]);
export type AgentHarness = z.infer<typeof AgentHarnessSchema>;
// One repository at one immutable commit. Workflow runs use this both as the checkout instruction for every
// candidate and as the comparison base written into handoffs, so a multi-repo run has one provenance record
// rather than a hard-coded branch name that only happens to work in the root repository.
export const RepoBaseSchema = z.object({ repo: z.string(), base: z.string().min(1) });
export type RepoBase = z.infer<typeof RepoBaseSchema>;
// What the user is looking at in the editor, attached to a turn only when they explicitly opt in (the
// composer chip, off by default). The daemon folds it into the prompt as a context note, so deictic
// prompts ("fix this") resolve without an @-mention. Selection is bounded, it's context, not an upload.
export const EditorContextSchema = z.object({
    // Workspace-relative path of the file open in the editor.
    file: z.string().min(1).describe("The file open in the editor, as a workspace path."),
    // 1-based line range of the selection; absent when the whole file is the context.
    startLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("First line of the selection, counting from one. Leave both out when the whole file is the context."),
    endLine: z.number().int().min(1).optional().describe("Last line of the selection, counting from one."),
    // The selected text itself, truncated client-side to the cap.
    selection: z
        .string()
        .max(20_000)
        .optional()
        .describe("The selected text itself. Cut it down before sending if it is long: this is context, not an upload."),
});
export type EditorContext = z.infer<typeof EditorContextSchema>;
// The client-minted stable conversation identity. Constrained because isolated conversations also use it in
// branch names (agent/<id>) and filesystem paths, the regex is the injection guard. Shared by turn + attach,
// and by the workspace scope (WorkspaceScopeSchema), which names a conversation to read a file tree AS.
export const ConversationIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
// Where a conversation came from when nobody typed it into the browser: an automation wake carrying a message
// from OUTSIDE the sandbox (a Discord mention, a web-chat visitor, a webhook). Such a wake runs as an ordinary
// isolated conversation, registry entry, worktree, chat tab, land flow, and this is the only thing that
// distinguishes it on the surface: the card's provenance line and the reason its first prompt is not the
// user's. Set daemon-side by the dispatcher that received the message; the browser never sends one.
export const AgentOriginSchema = z.object({
    // The automation whose configured prompt opened the conversation.
    automationId: z.string(),
    // The listener provider that received the message ("discord", "webchat", …) or "webhook" for an event
    // trigger. An open string for the same reason Trigger.provider is: sources are extension-declared.
    provider: z.string(),
    // The external thread it arrived on, a Discord channel id, a widget conversation id. Absent for webhooks.
    channelId: z.string().optional(),
    // Who sent it, as the source names them.
    author: z.string().optional(),
});
export type AgentOrigin = z.infer<typeof AgentOriginSchema>;
/* The class of thing asking to START a session, the admission policy's key space. Derived daemon-side from
 * the automation's trigger (guard/actions.ts wakeSourceOf) or named by the door itself (the workflow release
 * gate); never sent by a client. Chat and loops are absent deliberately: both begin with the owner's own
 * click, and holding the owner's work in their own queue is a queue entry that says nothing (the same argument
 * fireAutomation's `cleared` makes about a by-hand fire). */
export const WakeSourceSchema = z.enum(["schedule", "event", "listener", "webchat", "issues", "workspace", "workflow"]);
export type WakeSource = z.infer<typeof WakeSourceSchema>;
// One admission verdict the owner can configure: let it run, hold it for approval, or refuse it outright.
export const AdmissionRuleSchema = z.enum(["allow", "hold", "deny"]);
export type AdmissionRule = z.infer<typeof AdmissionRuleSchema>;
/* WHAT KIND OF THING A SHELL COMMAND IS, the command gate's key space, the second layer under the admission
 * floor above. The floor decides whether a session may START; these decide whether one PARTICULAR command
 * inside a running session may go ahead, which is the only question left once the agent is already working.
 *
 * Five, chosen for one property: everything in them is hard or impossible to take back, so a person seeing it
 * once beats an audit trail read afterwards. Everything else an agent runs, builds, tests, greps, edits, is
 * recoverable in a container that is itself disposable, and gating it would be friction bought with nothing. */
export const CommandClassSchema = z.enum([
    // Rewrites or discards committed work: force-push, hard reset, force-delete a branch, clean -f, filter-branch.
    "git.destructive",
    // Recursive-force deletion (`rm -rf`), and its spelling in a script (`fs.rm(p, { recursive: true })`).
    "files.destructive",
    /* State nothing here brings back: a formatted or overwritten disk, a deleted Docker volume, a recursive
     * delete aimed at a root rather than at something inside one. The only class the daemon holds where the
     * owner wrote no rule, which is why it is separate from files.destructive rather than a shade of it:
     * `rm -rf build` is ordinary work in a disposable container and `rm -rf /` is the end of the machine. */
    "system.destructive",
    /* READS credential material: a `{{secret:NAME}}` reference (which becomes the value on the way into the
     * process), or a file that actually holds one — a dotenv, a private key, ~/.aws/credentials, an npmrc.
     * "Actually" is load-bearing and is checked rather than assumed where the caller can open the file: an
     * npmrc with no token in it, a dotenv of ports, a public key, a path that is not there, are none of them
     * this class, however much they look like it from the command line. See command-classes.ts. */
    "secrets.access",
    // Publishes outward and irreversibly: npm/pnpm/yarn/cargo publish, gh release create, docker push.
    "package.publish",
    // curl/wget to a non-local address, the general exfiltration channel under the per-provider actionRules.
    "network.outbound",
]);
export type CommandClass = z.infer<typeof CommandClassSchema>;
/* THE ADMISSION FLOOR, the workspace-wide rule per wake source, consulted by the session.start guard on every
 * outside-driven wake. Per-automation `requireApproval` / `holdForSeconds` remain the per-object override; the
 * floor composes with them most-restrictive-wins, so "hold every webchat session" needs no edit to each
 * automation. `workflow` is allow|deny only: the release gate answers a CI runner holding a connection with a
 * deadline, so a hold there is indistinguishable from a timeout, deny is the honest refusal. */
export const AdmissionPolicySchema = z.object({
    schedule: AdmissionRuleSchema.default("allow"),
    event: AdmissionRuleSchema.default("allow"),
    listener: AdmissionRuleSchema.default("allow"),
    webchat: AdmissionRuleSchema.default("allow"),
    /* THE ONE SOURCE THAT HOLDS BY DEFAULT, and the exception is argued rather than assumed. A Front Desk wake
     * runs the read-only Front Desk persona: a stranger drives the prompt and the toolbox is a shelf of two.
     * A bug-report wake is the opposite on both counts, it is pointed at the repository with the powers to
     * change it, and the brief is a stack trace and a sentence somebody else's browser wrote.
     *
     * Held is not blocked: the wake sits in the same approvals queue every other hold uses, with the issue's
     * own title on the card, and one click runs it. An owner who wants their crashes fixed while they sleep
     * sets this to `allow` deliberately, which is the direction that decision should have to be made in. */
    issues: AdmissionRuleSchema.default("hold"),
    workspace: AdmissionRuleSchema.default("allow"),
    workflow: z.enum(["allow", "deny"]).default("allow"),
});
export type AdmissionPolicy = z.infer<typeof AdmissionPolicySchema>;
// How tool calls are gated, the Claude Agent SDK's PermissionMode, narrowed to the four the composer offers
// (the SDK also has 'dontAsk'/'auto', which have no UI here). The user picks one per turn AND the agent can
// move itself between them mid-turn, so this is both a turn input and the payload of the `mode` frame.
export const PermissionModeSchema = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
/* WHERE A CONVERSATION WAS CUT FROM, the durable half of a fork, carried on the registry entry so both ends
 * can find each other. `index` is the message the cut sat above in the SOURCE, which is what lets the source's
 * transcript put the mark back in the right gap. */
export const ForkedFromSchema = z.object({
    conversationId: ConversationIdSchema,
    index: z.number().int().nonnegative(),
    // Which files this fork opened on, the half of the choice that used to be silent, kept so the fork can
    // still say it tomorrow rather than only in the seconds after the click.
    files: z.enum(["then", "now"]),
});
export type ForkedFrom = z.infer<typeof ForkedFromSchema>;
export const AgentTurnSchema = z
    .object({
        prompt: z.string().describe("What to say to the agent. May be empty if you are only attaching files."),
        // The client's display title for the conversation, seeds a FRESH registry entry (so a renamed draft's
        // first turn keeps its user-chosen title); an existing entry's title always wins.
        title: z
            .string()
            .max(80)
            .optional()
            .describe("A title for a conversation this turn is opening. Ignored for a conversation that already has one."),
        // Workspace-relative paths of files the user attached, already uploaded via /workspace/upload
        // (the browser puts them under .intentic/records/artifacts/attachments/<uuid>/<name>). The daemon hands them to the
        // provider: Claude reads them from disk via its Read tool; Codex gets images as native inputs.
        attachments: z
            .array(z.string().min(1))
            .max(20)
            .optional()
            .describe("Files to hand the agent along with the prompt, as workspace paths. Upload them first."),
        // Which provider (model + account) serves the turn; absent = claude. A sessionId only resumes on the
        // provider that minted it (Claude Code sessions vs Codex threads vs Grok/OpenCode sessions are separate
        // stores), a mid-conversation provider/account/harness switch sends `history` instead of resuming.
        agent: AgentProviderSchema.optional().describe("Which model provider serves this turn. Leave it out for Claude."),
        // Which harness (agentic loop) runs the turn, orthogonal to the provider above. Absent = "native": each
        // provider on its own runtime (Claude Code SDK / Codex CLI / opencode) with its subscription OAuth.
        // "claude-code" forces the Claude Code Agent SDK loop for ANY provider, codex/grok then drive their model
        // through the sandbox's bundled Anthropic↔OpenAI translator, which needs that provider's API key (its
        // subscription OAuth can't reach a gateway). For the claude provider the two are identical.
        harness: AgentHarnessSchema.optional().describe("Which agentic loop runs the turn. Leave it out to use each provider's own."),
        // Which connected account of that provider serves the turn; absent = the provider's first account.
        account: z.string().optional().describe("Which of that provider's connected accounts pays for the turn. Leave it out for the first one."),
        /* WHICH PERSONA THE TURN SHOWS THE OUTSIDE WORLD, a PersonaSchema id, deliberately NOT the `account`
         * directly above it. The two words are one letter apart in meaning and a world apart in consequence:
         * `account` is which subscription PAYS for the turn, `actsAs` is whose name is on what the turn posts.
         * Naming both "account" is how someone eventually pins a nightly job to the right billing and the wrong
         * Reddit.
         *
         * Absent means opposite things either side of the "is anyone watching" line, which is the owner's chosen
         * posture and the reason this is resolved in one place (turnPersona): an ordinary chat with no persona
         * keeps every connected account, because a person is there to catch a mistake; an `unattended` turn with
         * no persona gets NONE, because at 3am the prompt's wording is the only thing left and that is not
         * enough to bet an unrepeatable post on. */
        actsAs: entryId.optional().describe("Which persona the turn speaks as out in the world. Not the same as which account pays for it."),
        sessionId: z.string().optional().describe("Resume this provider session instead of starting a fresh one."),
        // The client-minted stable conversation identity (survives provider/account/harness switches, which
        // retire sessions). Keys the fleet registry entry and turn run, plus the worktree when isolated.
        conversationId: ConversationIdSchema.optional().describe(
            "The conversation this turn belongs to. You choose it, it survives model switches, and it is how you address the conversation later. Naming one that does not exist opens it.",
        ),
        // When true, the turn runs in the conversation's isolated git worktree (created lazily on first use)
        // instead of the shared /work tree, the parallel-agents mode. Requires conversationId.
        isolated: z
            .boolean()
            .optional()
            .describe(
                "Work in this conversation's own private copy of the repos rather than the shared tree, so several agents can work at once. Needs a conversation id.",
            ),
        /* WHERE the conversation executes, decided like `isolated` directly above: the request's choice on the
         * first turn, the registry entry's on every turn after. `runner` implies isolation (the branch is what
         * moves between machines) and needs a conversation id for the same reason `isolated` does. Absent =
         * local. Design: docs/remote-runners-plan.md; refused until runners ship. */
        placement: AgentPlacementSchema.optional().describe(
            "Where this conversation runs: this sandbox (leave it out), or a paired runner by id. Decided on the first turn; later turns follow the conversation.",
        ),
        /* Pin a NEW isolated conversation's worktree composition to these repository commits. Daemon-owned:
         * ordinary chats omit it and keep rebasing onto the current workspace; a workflow supplies the one
         * snapshot all of its candidates must share. Repeated iterations carry it too, which suppresses the
         * ordinary pre-turn rebase for the lifetime of that workflow step. */
        worktreeBase: z
            .array(RepoBaseSchema)
            .min(1)
            .max(50)
            .optional()
            .describe(
                "Pin a new private copy to these exact commits instead of today's workspace. Used when several agents must start from identical files.",
            ),
        // Override landing for this turn only. Workflow steps set false so candidate branches cannot leak into
        // the workspace before the synthesis step has compared them; ordinary turns inherit agent/workspace
        // posture exactly as before.
        autoLand: z
            .boolean()
            .optional()
            .describe(
                "Whether this turn's work merges into the workspace when it finishes. Overrides the conversation's own setting for this turn only.",
            ),
        // Set ONLY by the daemon's own automation dispatchers: this turn opens a conversation on behalf of an
        // outside message rather than a user. Recorded on the registry entry so the fleet can say where the
        // agent came from. Requires conversationId, there is nothing to record it on otherwise.
        origin: AgentOriginSchema.optional().describe(
            "Set by the sandbox alone: this turn opened a conversation on behalf of a message from outside rather than a person.",
        ),
        // No `history` field: a turn that switched provider/account/harness carries no transcript up the wire.
        // The daemon seeds the replacement session from its OWN record of the conversation, which is keyed by
        // conversationId and outlives every session (sessions/turn-transcript.ts → handoffHistory).
        /* WHERE A FORK WAS CUT FROM, on its first turn, the one case the daemon cannot work out for itself,
         * because a fork is a NEW conversation whose record is empty and the cut is a gesture only the client
         * saw. `keep` counts the source's RECORD rows to copy, not its bubbles (see the web transcript's
         * recordedRows). The daemon copies that prefix into the new conversation's record before the turn runs,
         * after which a fork is an ordinary conversation: it seeds like any other and reads back in full.
         * Requires conversationId, the fork it describes IS that conversation.
         *
         * `files` is the half the user actually chooses between, and the half that used to be silent. "now"
         * inherits the workspace as it stands (the fork is a fresh line of conversation over today's files);
         * "then" puts the fork on the files as they were AT THE CUT, which it can only do in a checkout of its
         * own, so it implies `isolated`, and the daemon resolves the cut's per-repo commits from the source's
         * own turn anchors rather than trusting the client with shas. A "then" fork of a conversation that has
         * no anchor at that index falls back to "now" and says so on the turn, because silently starting from
         * the wrong files is the failure this whole field exists to prevent. */
        forkOf: z
            .object({
                conversationId: ConversationIdSchema.describe("The conversation this one was cut from."),
                keep: z.number().int().nonnegative().describe("How many of that conversation's messages to copy in before this turn runs."),
                files: z
                    .enum(["then", "now"])
                    .describe(
                        'Which files the fork opens on: "now" is the workspace as it stands, "then" is the files as they were at the cut, which needs a private copy.',
                    ),
            })
            .optional()
            .describe("Where this conversation was cut from, on its first turn only. Only the client knows this, so only the client can say it."),
        // The browser sends the chosen model per turn; the provider token is the sandbox's own stored credential.
        model: z.string().optional().describe("Which model to use. Leave it out for the provider's default."),
        /* NOBODY PICKED A MODEL FOR THIS TURN, a surface started it (Fix with agent, a Maintenance chore, a
         * Documentation or Acceptance run, the fix a failed pre-push check proposes) rather than a person at a
         * composer. That is the whole distinction the flag carries, and it is why it cannot be inferred: a chat
         * turn ALSO arrives with no `model` whenever the live catalog hasn't loaded yet, and the two want
         * opposite defaults, the chat wants the provider's own catalog default, an unattended run wants the
         * tier its owner chose for work that spends money while they are not watching.
         *
         * The daemon fills `agent`/`model` and the pinned entry's own knobs from agentRunModels for any turn that says
         * this and names none of them (startConversationTurn), walking that list until one can actually be
         * started. Naming one still wins: every surface-started run now carries a caret that overrides the list
         * for that run alone, and Acceptance picks per run because it fans a session out per story. Either way
         * the pick is the user's, made a second ago. */
        unattended: z
            .boolean()
            .optional()
            .describe(
                "Nobody chose a model for this turn because a screen started it rather than a person. The sandbox then fills in the model its owner picked for unwatched work.",
            ),
        /* OUTSIDE CONTENT CAUSED THIS TURN, and what to call the source, "discord", "webchat", whichever
         * listener provider carried the message. Set by the dispatchers that wake an agent on somebody else's
         * words; absent for a turn the owner started, a schedule, or a workspace event.
         *
         * It is the birth half of the turn's taint (guard/turn-taint.ts). The other half marks itself as the
         * turn works, a fetched page, a foreign MCP server's answer, and together they are what the command
         * gate reads before letting a command read credential material unasked. Distinct from `unattended`,
         * which is about whether anyone is WATCHING: a Front Desk wake is both, an owner asking the agent to read
         * a web page is neither, and each flag governs a different decision. */
        outsideWake: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Content from outside caused this turn, and what to call the source. It is what makes the sandbox treat the turn as carrying somebody else's words.",
            ),
        // How tool calls are gated for this turn (the SDK's permissionMode, verbatim). 'plan' runs the
        // propose → approve → execute flow; 'default' prompts per tool on the permission side channel;
        // 'acceptEdits' auto-accepts file edits; 'bypassPermissions' runs everything. The agent can move
        // itself between modes mid-turn (EnterPlanMode/ExitPlanMode), which rides back as a `mode` frame.
        permissionMode: PermissionModeSchema.optional().describe(
            "How tool calls are gated: ask each time, accept file edits, propose a plan first, or run everything. The agent can move itself between these mid-turn.",
        ),
        /* Narrows the turn to these tool names (the SDK option of the same name, not to be confused with the
         * daemon's MCP `tools`, which are servers). Absent ⇒ every tool the runtime has, which is what an
         * owner-driven chat wants. Set by the automation dispatchers from Automation.allowedTools: a wake driven
         * by an OUTSIDE message runs bypassPermissions like any other automation turn, so for a public Front Desk
         * this list is the actual boundary, prompt wording is advice, an empty toolbox is not. */
        allowedTools: z
            .array(z.string().min(1))
            .optional()
            .describe(
                "Narrow the turn to these tools. Leave it out for everything the runtime has. For a turn driven by an outside message this list is the real boundary, because prompt wording is only advice.",
            ),
        effort: z.string().optional().describe("How hard the model should think, where the provider offers a choice."),
        thinking: z.boolean().optional().describe("Whether to show the model's reasoning as it works."),
        /* Ask the harness to serve this turn at fast speed, the same tokens at a higher rate, for a higher
         * per-token price. A REQUEST, never a promise: the harness answers it against the plan, the model and
         * the endpoint, and reports what it actually did on the `fast_mode` frame. Absent/false ⇒ standard
         * speed, which is also what a runtime that doesn't declare the capability gets (turn-plan drops it).
         *
         * Not a sandbox setting, for the same reason effort isn't: it changes what a turn COSTS, so it belongs
         * to the turn that spends it rather than to the workspace it ran in. */
        fast: z
            .boolean()
            .optional()
            .describe(
                "Ask for the same work at a higher rate for a higher price. A request rather than a promise: the answer says what actually happened.",
            ),
        /* KEEP THIS TURN ON THE MODEL I PICKED: the user's veto over automatic tier selection, riding the turn
         * like `fast` does because it changes what the turn costs and so belongs to the turn rather than to the
         * workspace. The judge still runs and the verdict is still recorded — a deny is the strongest label the
         * calibration ledger ever gets (UsageTurn.tierDenied) — but nothing is substituted. The composer sends
         * its conversation-level toggle here every turn, and the registry persists it beside `fast`, so the
         * choice survives reopening the tab. Absent ⇒ no opinion, routing follows settings.autoTier. */
        tierHold: z
            .boolean()
            .optional()
            .describe(
                "Run exactly the model that was picked, even when the turn looks simple enough for a cheaper one. The judgement is still recorded; nothing is substituted.",
            ),
        // The opt-in editor context chip: what the user is looking at, folded into the prompt daemon-side.
        editorContext: EditorContextSchema.optional().describe(
            'What the user has open in their editor, folded into the prompt so that pointing words like "this" resolve.',
        ),
    })
    // An attachment-only send (no text) is legal; an entirely empty turn is not.
    .refine((turn) => turn.prompt.trim().length > 0 || (turn.attachments?.length ?? 0) > 0, {
        message: "prompt or attachments required",
    })
    .refine((turn) => turn.isolated !== true || turn.conversationId !== undefined, {
        message: "isolated requires conversationId",
    })
    .refine((turn) => turn.worktreeBase === undefined || (turn.isolated === true && turn.conversationId !== undefined), {
        message: "worktreeBase requires an isolated conversationId",
    })
    .refine((turn) => turn.origin === undefined || turn.conversationId !== undefined, {
        message: "origin requires conversationId",
    })
    .refine((turn) => turn.forkOf === undefined || turn.conversationId !== undefined, {
        message: "forkOf requires conversationId",
    })
    // A fork that wants the files as they were needs a checkout of its own to put them in, the shared tree is
    // everyone else's too, and rolling it back under them is what `files: "then"` must never mean.
    .refine((turn) => turn.forkOf?.files !== "then" || turn.isolated === true, {
        message: 'forkOf.files "then" requires isolated',
    });
export type AgentTurn = z.infer<typeof AgentTurnSchema>;
/* A MODEL CHOSEN FOR ONE SURFACE-STARTED RUN, what the caret on the shared run button (<AgentRunButton>) sends
 * along with the click that starts it.
 *
 * Shared rather than re-declared per route because every surface that starts an agent for the user now carries
 * that caret, and they must all mean the same thing by it: the pair rides onto the turn as `agent`/`model`, and
 * the daemon's own fill step then leaves it alone (turn-resume.ts fills only what is absent). ABSENT is the
 * ordinary case and the one to keep cheap, nobody touched the caret, so `agentRunModels` answers.
 *
 * Both halves or neither, because a model id is only meaningful to the provider that vends it: half a pick
 * would send a Codex model id to Claude. Routes that accept this pass it through verbatim; a model this build
 * has never heard of is a supported pick, since the picker offers a custom-id escape hatch. */
export const AgentRunPickSchema = z
    .object({
        agent: z.string().min(1).describe("Which provider."),
        model: z
            .string()
            .min(1)
            .describe("Which of its models. Both or neither, because a model name only means anything to the provider that serves it."),
    })
    .optional();
export type AgentRunPick = z.infer<typeof AgentRunPickSchema>;
/* A MODEL PINNED FOR EVERY SURFACE-STARTED RUN, one entry of settings.agentRunModels: the standing version of
 * the pick above, and not merely which model but HOW it is to be run.
 *
 * THE KNOBS RIDE THE ENTRY RATHER THAN THE LIST, which is the whole reason this is an object where the setting
 * used to hold a `${provider}:${model}` string. The reasoning effort was a single field beside the list, so one
 * tier answered for every model in it — and the entries of that list are deliberately NOT interchangeable: it
 * is a frontier pin with the cheap account underneath that catches it when the first is spent. A tier scale is
 * a property of the MODEL as well ('max' is off Kimi's scale entirely, and off Claude's own the moment thinking
 * is switched off), so a shared effort was either off-scale for half the list or the lowest common rung for all
 * of it. Each entry now carries what the composer's picker configures for the turn in front of you.
 *
 * EVERY FIELD BUT THE PAIR IS OPTIONAL, AND ABSENT MEANS ABSENT: the turn goes out without the field and the
 * provider's own default answers, exactly as an unconfigured pin always did. Nothing here invents a "low".
 *
 * NO TIER HOLD, and its absence is the rule rather than an omission: automatic tier selection gates on
 * `unattended` (prompt-complexity.ts), so a surface-started run is never downgraded in the first place and a
 * veto over it would be a control whose state can make no difference to anything.
 *
 * The pair is BOTH HALVES for the reason the pick above is: a model id is only meaningful to the provider that
 * vends it, so half a pin would send a Codex id to Claude. Taken verbatim, never validated against a catalog:
 * the picker offers a custom-id escape hatch, so a model this build has never heard of is a supported pin. */
export const AgentRunPinSchema = z.object({
    provider: AgentProviderSchema.describe("Which provider serves the run."),
    model: z.string().min(1).describe("Which of its models. Both halves, because a model name only means anything to the provider that serves it."),
    effort: z
        .string()
        .optional()
        .describe("How hard this model should think, where it offers a choice. Leave it out to take the model's own default."),
    thinking: z.boolean().optional().describe("Whether this model reasons before it answers, where that is a choice it offers."),
    fast: z.boolean().optional().describe("Ask for this model's work at a higher rate for a higher price. A request rather than a promise."),
    harness: AgentHarnessSchema.optional().describe("Which agentic loop runs it. Leave it out to use the provider's own."),
});
export type AgentRunPin = z.infer<typeof AgentRunPinSchema>;
// POST /agent's ack: the daemon-minted id of the detached turn run it started. The turn executes daemon-side
// regardless of any client connection; every window, the initiator included, renders it via /agent/attach.
export const StartedTurnSchema = z.object({
    run: z.string().describe("The id of the run that just started. Hand it back when you attach, so the stream resumes rather than replaying."),
});
export type StartedTurn = z.infer<typeof StartedTurnSchema>;
// Attach to a conversation's turn run (live, or finished within the retention window). The head carries the
// run's rows whole, so there is no cursor to resume from: a client that reconnects takes the rows again and
// applies what follows. `run` names the run the client was watching, so the head's own id tells it whether a
// newer turn has started meanwhile.
export const AttachTurnSchema = z.object({
    conversationId: ConversationIdSchema.describe("Which conversation to watch."),
    run: z
        .string()
        .optional()
        .describe("The run you were watching. If a newer turn has started since, the head names that one instead, and its rows are that turn's."),
});
export type AttachTurn = z.infer<typeof AttachTurnSchema>;
