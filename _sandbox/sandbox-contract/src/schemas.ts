import { STATE_DIR } from "@intentic/constants";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { RegistryEntrySchema } from "@intentic/registry";
import { z } from "zod";
import { OutputFieldsSchema } from "./output-fields.js";

// All request/response wire schemas for the sandbox daemon. Inputs that carry a `{param}` in their route path
// (repo / id / name) merge the path param into the same flat object — oRPC fills the path placeholder from the
// matching key and routes the rest to the body (POST/PUT) or query (GET).

// ---- shared ----

// Success ack for routes that only report completion (push / disconnect / self-host register). A turn paused on
// a plan/question that no longer exists, or a missing repo/path, is an ORPCError thrown by the handler instead.
export const OkSchema = z.object({ ok: z.literal(true) });

// The trust tiers of everyone who can open this sandbox, ordered. `owner` is the one bound identity
// (auth/auth.ts); the other three are granted per email on the daemon's /members list. viewer watches,
// collaborator drives agents (outward actions become requests), maintainer ships and operates. The daemon
// enforces these as route floors (auth/role-floor.ts); the platform's invite records mirror them.
export const MemberRoleSchema = z.enum(["viewer", "collaborator", "maintainer", "owner"]);
export type MemberRole = z.infer<typeof MemberRoleSchema>;
// The roles an invite can grant — everything but `owner`, which is bound at first sign-in, never granted.
export const GrantedRoleSchema = z.enum(["viewer", "collaborator", "maintainer"]);
export type GrantedRole = z.infer<typeof GrantedRoleSchema>;

// Shared by every surface that gates on a role (daemon route floors, web affordances) so the order lives in
// exactly one place.
const MEMBER_ROLE_RANK: Record<MemberRole, number> = { viewer: 0, collaborator: 1, maintainer: 2, owner: 3 };
export const roleAtLeast = (role: MemberRole, floor: MemberRole): boolean => MEMBER_ROLE_RANK[role] >= MEMBER_ROLE_RANK[floor];

// Which repo a git route targets: "root" (the /work workspace repo) or a repo id — the repo's root-relative
// dir, which may be nested ("clients/foo"; URL-encoded in the path param). Kept as a bare string on the wire
// (not an enum) so an unknown repo is a handler-thrown NOT_FOUND — matching the daemon's prior 404 — rather
// than an input-validation rejection.
export const RepoParamSchema = z.object({ repo: z.string() });

// ---- agent ----

// The agent runtimes the daemon can serve — the vocabulary every surface that picks an agent shares (chat
// turns, automations). The NATIVE providers have dedicated adapters (and their ids are reserved); an
// `endpoint/<id>` value names an installed `endpoint`-kind capability (a model API the user pointed us at,
// see EndpointConfigSchema); any other value is the id of an installed `agent`-kind capability served over
// ACP (Agent Client Protocol).
// Kept as a bare string on the wire (not an enum) so an unknown id is a clean error frame from the agent
// route — the same bet RepoParamSchema makes — and adding an ACP agent needs no contract change.
export const NATIVE_PROVIDERS = ["claude", "codex", "grok", "kimi", "gemini"] as const;
export type NativeProvider = (typeof NATIVE_PROVIDERS)[number];
export const AgentProviderSchema = z.string().min(1);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

// The provider naming a catalog in the one route every native provider shares (providers.contract.ts). An ENUM
// rather than the bare-string schema above, and deliberately so: the open vocabulary exists because an ACP agent
// or an endpoint can be added without a contract change, but neither has a daemon-held catalog — this route's
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
// composer chip — off by default). The daemon folds it into the prompt as a context note, so deictic
// prompts ("fix this") resolve without an @-mention. Selection is bounded — it's context, not an upload.
export const EditorContextSchema = z.object({
    // Workspace-relative path of the file open in the editor.
    file: z.string().min(1),
    // 1-based line range of the selection; absent when the whole file is the context.
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    // The selected text itself, truncated client-side to the cap.
    selection: z.string().max(20_000).optional(),
});
export type EditorContext = z.infer<typeof EditorContextSchema>;

// The client-minted stable conversation identity. Constrained because isolated conversations also use it in
// branch names (agent/<id>) and filesystem paths — the regex is the injection guard. Shared by turn + attach,
// and by the workspace scope (WorkspaceScopeSchema), which names a conversation to read a file tree AS.
export const ConversationIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

// A manifest entry id (capabilities + automations + personas) — also the `mcp__<id>__…` server name for mcp
// capabilities, so it's a safe identifier. Up here beside the other id primitives because a turn names a
// persona by one (AgentTurnSchema.actsAs), hundreds of lines above the manifest section that consumes it.
const entryId = z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

// Where a conversation came from when nobody typed it into the browser: an automation wake carrying a message
// from OUTSIDE the sandbox (a Discord mention, a web-chat visitor, a webhook). Such a wake runs as an ordinary
// isolated conversation — registry entry, worktree, chat tab, land flow — and this is the only thing that
// distinguishes it on the surface: the card's provenance line and the reason its first prompt is not the
// user's. Set daemon-side by the dispatcher that received the message; the browser never sends one.
export const AgentOriginSchema = z.object({
    // The automation whose configured prompt opened the conversation.
    automationId: z.string(),
    // The listener provider that received the message ("discord", "webchat", …) or "webhook" for an event
    // trigger. An open string for the same reason Trigger.provider is: sources are extension-declared.
    provider: z.string(),
    // The external thread it arrived on — a Discord channel id, a widget conversation id. Absent for webhooks.
    channelId: z.string().optional(),
    // Who sent it, as the source names them.
    author: z.string().optional(),
});
export type AgentOrigin = z.infer<typeof AgentOriginSchema>;

/* The class of thing asking to START a session — the admission policy's key space. Derived daemon-side from
 * the automation's trigger (guard/actions.ts wakeSourceOf) or named by the door itself (the workflow release
 * gate); never sent by a client. Chat and loops are absent deliberately: both begin with the owner's own
 * click, and holding the owner's work in their own queue is a queue entry that says nothing (the same argument
 * fireAutomation's `cleared` makes about a by-hand fire). */
export const WakeSourceSchema = z.enum(["schedule", "event", "listener", "webchat", "workspace", "workflow"]);
export type WakeSource = z.infer<typeof WakeSourceSchema>;

// One admission verdict the owner can configure: let it run, hold it for approval, or refuse it outright.
export const AdmissionRuleSchema = z.enum(["allow", "hold", "deny"]);
export type AdmissionRule = z.infer<typeof AdmissionRuleSchema>;

/* WHAT KIND OF THING A SHELL COMMAND IS — the command gate's key space, the second layer under the admission
 * floor above. The floor decides whether a session may START; these decide whether one PARTICULAR command
 * inside a running session may go ahead, which is the only question left once the agent is already working.
 *
 * Five, chosen for one property: everything in them is hard or impossible to take back, so a person seeing it
 * once beats an audit trail read afterwards. Everything else an agent runs — builds, tests, greps, edits — is
 * recoverable in a container that is itself disposable, and gating it would be friction bought with nothing. */
export const CommandClassSchema = z.enum([
    // Rewrites or discards committed work: force-push, hard reset, force-delete a branch, clean -f, filter-branch.
    "git.destructive",
    // Recursive-force deletion (`rm -rf`).
    "files.destructive",
    // Names credential material: a .env file, an ssh key, ~/.aws/credentials, .npmrc, a stored token file.
    "secrets.access",
    // Publishes outward and irreversibly: npm/pnpm/yarn/cargo publish, gh release create, docker push.
    "package.publish",
    // curl/wget to a non-local address — the general exfiltration channel under the per-provider actionRules.
    "network.outbound",
]);
export type CommandClass = z.infer<typeof CommandClassSchema>;

/* THE ADMISSION FLOOR — the workspace-wide rule per wake source, consulted by the session.start guard on every
 * outside-driven wake. Per-automation `requireApproval` / `holdForSeconds` remain the per-object override; the
 * floor composes with them most-restrictive-wins, so "hold every webchat session" needs no edit to each
 * automation. `workflow` is allow|deny only: the release gate answers a CI runner holding a connection with a
 * deadline, so a hold there is indistinguishable from a timeout — deny is the honest refusal. */
export const AdmissionPolicySchema = z.object({
    schedule: AdmissionRuleSchema.default("allow"),
    event: AdmissionRuleSchema.default("allow"),
    listener: AdmissionRuleSchema.default("allow"),
    webchat: AdmissionRuleSchema.default("allow"),
    workspace: AdmissionRuleSchema.default("allow"),
    workflow: z.enum(["allow", "deny"]).default("allow"),
});
export type AdmissionPolicy = z.infer<typeof AdmissionPolicySchema>;

// How tool calls are gated — the Claude Agent SDK's PermissionMode, narrowed to the four the composer offers
// (the SDK also has 'dontAsk'/'auto', which have no UI here). The user picks one per turn AND the agent can
// move itself between them mid-turn, so this is both a turn input and the payload of the `mode` frame.
export const PermissionModeSchema = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/* WHERE A CONVERSATION WAS CUT FROM — the durable half of a fork, carried on the registry entry so both ends
 * can find each other. `index` is the message the cut sat above in the SOURCE, which is what lets the source's
 * transcript put the mark back in the right gap. */
export const ForkedFromSchema = z.object({
    conversationId: ConversationIdSchema,
    index: z.number().int().nonnegative(),
    // Which files this fork opened on — the half of the choice that used to be silent, kept so the fork can
    // still say it tomorrow rather than only in the seconds after the click.
    files: z.enum(["then", "now"]),
});
export type ForkedFrom = z.infer<typeof ForkedFromSchema>;

export const AgentTurnSchema = z
    .object({
        prompt: z.string(),
        // The client's display title for the conversation — seeds a FRESH registry entry (so a renamed draft's
        // first turn keeps its user-chosen title); an existing entry's title always wins.
        title: z.string().max(80).optional(),
        // Workspace-relative paths of files the user attached, already uploaded via /workspace/upload
        // (the browser puts them under .intentic/artifacts/attachments/<uuid>/<name>). The daemon hands them to the
        // provider: Claude reads them from disk via its Read tool; Codex gets images as native inputs.
        attachments: z.array(z.string().min(1)).max(20).optional(),
        // Which provider (model + account) serves the turn; absent = claude. A sessionId only resumes on the
        // provider that minted it (Claude Code sessions vs Codex threads vs Grok/OpenCode sessions are separate
        // stores) — a mid-conversation provider/account/harness switch sends `history` instead of resuming.
        agent: AgentProviderSchema.optional(),
        // Which harness (agentic loop) runs the turn, orthogonal to the provider above. Absent = "native": each
        // provider on its own runtime (Claude Code SDK / Codex CLI / opencode) with its subscription OAuth.
        // "claude-code" forces the Claude Code Agent SDK loop for ANY provider — codex/grok then drive their model
        // through the sandbox's bundled Anthropic↔OpenAI translator, which needs that provider's API key (its
        // subscription OAuth can't reach a gateway). For the claude provider the two are identical.
        harness: AgentHarnessSchema.optional(),
        // Which connected account of that provider serves the turn; absent = the provider's first account.
        account: z.string().optional(),
        /* WHICH PERSONA THE TURN SHOWS THE OUTSIDE WORLD — a PersonaSchema id, deliberately NOT the `account`
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
        actsAs: entryId.optional(),
        sessionId: z.string().optional(),
        // The client-minted stable conversation identity (survives provider/account/harness switches, which
        // retire sessions). Keys the fleet registry entry and turn run, plus the worktree when isolated.
        conversationId: ConversationIdSchema.optional(),
        // When true, the turn runs in the conversation's isolated git worktree (created lazily on first use)
        // instead of the shared /work tree — the parallel-agents mode. Requires conversationId.
        isolated: z.boolean().optional(),
        /* Pin a NEW isolated conversation's worktree composition to these repository commits. Daemon-owned:
         * ordinary chats omit it and keep rebasing onto the current workspace; a workflow supplies the one
         * snapshot all of its candidates must share. Repeated iterations carry it too, which suppresses the
         * ordinary pre-turn rebase for the lifetime of that workflow step. */
        worktreeBase: z.array(RepoBaseSchema).min(1).max(50).optional(),
        // Override landing for this turn only. Workflow steps set false so candidate branches cannot leak into
        // the workspace before the synthesis step has compared them; ordinary turns inherit agent/workspace
        // posture exactly as before.
        autoLand: z.boolean().optional(),
        // Set ONLY by the daemon's own automation dispatchers: this turn opens a conversation on behalf of an
        // outside message rather than a user. Recorded on the registry entry so the fleet can say where the
        // agent came from. Requires conversationId — there is nothing to record it on otherwise.
        origin: AgentOriginSchema.optional(),
        // No `history` field: a turn that switched provider/account/harness carries no transcript up the wire.
        // The daemon seeds the replacement session from its OWN record of the conversation, which is keyed by
        // conversationId and outlives every session (sessions/turn-transcript.ts → handoffHistory).
        /* WHERE A FORK WAS CUT FROM, on its first turn — the one case the daemon cannot work out for itself,
         * because a fork is a NEW conversation whose record is empty and the cut is a gesture only the client
         * saw. `keep` counts the source's RECORD rows to copy, not its bubbles (see the web transcript's
         * recordedRows). The daemon copies that prefix into the new conversation's record before the turn runs,
         * after which a fork is an ordinary conversation: it seeds like any other and reads back in full.
         * Requires conversationId — the fork it describes IS that conversation.
         *
         * `files` is the half the user actually chooses between, and the half that used to be silent. "now"
         * inherits the workspace as it stands (the fork is a fresh line of conversation over today's files);
         * "then" puts the fork on the files as they were AT THE CUT, which it can only do in a checkout of its
         * own — so it implies `isolated`, and the daemon resolves the cut's per-repo commits from the source's
         * own turn anchors rather than trusting the client with shas. A "then" fork of a conversation that has
         * no anchor at that index falls back to "now" and says so on the turn, because silently starting from
         * the wrong files is the failure this whole field exists to prevent. */
        forkOf: z
            .object({
                conversationId: ConversationIdSchema,
                keep: z.number().int().nonnegative(),
                files: z.enum(["then", "now"]),
            })
            .optional(),
        // The browser sends the chosen model per turn; the provider token is the sandbox's own stored credential.
        model: z.string().optional(),
        /* NOBODY PICKED A MODEL FOR THIS TURN — a surface started it (Fix with agent, a Maintenance chore, a
         * Documentation or Acceptance run, the fix a failed pre-push check proposes) rather than a person at a
         * composer. That is the whole distinction the flag carries, and it is why it cannot be inferred: a chat
         * turn ALSO arrives with no `model` whenever the live catalog hasn't loaded yet, and the two want
         * opposite defaults — the chat wants the provider's own catalog default, an unattended run wants the
         * tier its owner chose for work that spends money while they are not watching.
         *
         * The daemon fills `agent`/`model`/`effort` from agentRunModels/agentRunEffort for any turn that says
         * this and names none of them (startConversationTurn), walking that list until one can actually be
         * started. Naming one still wins: every surface-started run now carries a caret that overrides the list
         * for that run alone, and Acceptance picks per run because it fans a session out per story. Either way
         * the pick is the user's, made a second ago. */
        unattended: z.boolean().optional(),
        /* OUTSIDE CONTENT CAUSED THIS TURN, and what to call the source — "discord", "webchat", whichever
         * listener provider carried the message. Set by the dispatchers that wake an agent on somebody else's
         * words; absent for a turn the owner started, a schedule, or a workspace event.
         *
         * It is the birth half of the turn's taint (guard/turn-taint.ts). The other half marks itself as the
         * turn works — a fetched page, a foreign MCP server's answer — and together they are what the command
         * gate reads before letting a command read credential material unasked. Distinct from `unattended`,
         * which is about whether anyone is WATCHING: a Doorbell wake is both, an owner asking the agent to read
         * a web page is neither, and each flag governs a different decision. */
        outsideWake: z.string().min(1).optional(),
        // How tool calls are gated for this turn (the SDK's permissionMode, verbatim). 'plan' runs the
        // propose → approve → execute flow; 'default' prompts per tool on the permission side channel;
        // 'acceptEdits' auto-accepts file edits; 'bypassPermissions' runs everything. The agent can move
        // itself between modes mid-turn (EnterPlanMode/ExitPlanMode), which rides back as a `mode` frame.
        permissionMode: PermissionModeSchema.optional(),
        /* Narrows the turn to these tool names (the SDK option of the same name — not to be confused with the
         * daemon's MCP `tools`, which are servers). Absent ⇒ every tool the runtime has, which is what an
         * owner-driven chat wants. Set by the automation dispatchers from Automation.allowedTools: a wake driven
         * by an OUTSIDE message runs bypassPermissions like any other automation turn, so for a public Doorbell
         * this list is the actual boundary — prompt wording is advice, an empty toolbox is not. */
        allowedTools: z.array(z.string().min(1)).optional(),
        effort: z.string().optional(),
        thinking: z.boolean().optional(),
        /* Ask the harness to serve this turn at fast speed — the same tokens at a higher rate, for a higher
         * per-token price. A REQUEST, never a promise: the harness answers it against the plan, the model and
         * the endpoint, and reports what it actually did on the `fast_mode` frame. Absent/false ⇒ standard
         * speed, which is also what a runtime that doesn't declare the capability gets (turn-plan drops it).
         *
         * Not a sandbox setting, for the same reason effort isn't: it changes what a turn COSTS, so it belongs
         * to the turn that spends it rather than to the workspace it ran in. */
        fast: z.boolean().optional(),
        // The opt-in editor context chip: what the user is looking at, folded into the prompt daemon-side.
        editorContext: EditorContextSchema.optional(),
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
    // A fork that wants the files as they were needs a checkout of its own to put them in — the shared tree is
    // everyone else's too, and rolling it back under them is what `files: "then"` must never mean.
    .refine((turn) => turn.forkOf?.files !== "then" || turn.isolated === true, {
        message: 'forkOf.files "then" requires isolated',
    });
export type AgentTurn = z.infer<typeof AgentTurnSchema>;

/* A MODEL CHOSEN FOR ONE SURFACE-STARTED RUN — what the caret on the shared run button (<AgentRunButton>) sends
 * along with the click that starts it.
 *
 * Shared rather than re-declared per route because every surface that starts an agent for the user now carries
 * that caret, and they must all mean the same thing by it: the pair rides onto the turn as `agent`/`model`, and
 * the daemon's own fill step then leaves it alone (turn-resume.ts fills only what is absent). ABSENT is the
 * ordinary case and the one to keep cheap — nobody touched the caret, so `agentRunModels` answers.
 *
 * Both halves or neither, because a model id is only meaningful to the provider that vends it: half a pick
 * would send a Codex model id to Claude. Routes that accept this pass it through verbatim; a model this build
 * has never heard of is a supported pick, since the picker offers a custom-id escape hatch. */
export const AgentRunPickSchema = z.object({ agent: z.string().min(1), model: z.string().min(1) }).optional();
export type AgentRunPick = z.infer<typeof AgentRunPickSchema>;

// POST /agent's ack: the daemon-minted id of the detached turn run it started. The turn executes daemon-side
// regardless of any client connection; every window — the initiator included — renders it via /agent/attach.
export const StartedTurnSchema = z.object({ run: z.string() });
export type StartedTurn = z.infer<typeof StartedTurnSchema>;

// Attach to a conversation's turn run (live, or finished within the retention window). `run`+`after` is the
// resume cursor of a client whose stream dropped: frames after `after` replay when `run` still names the
// current run; a mismatch (a newer turn started meanwhile) replays that run from its first frame instead.
export const AttachTurnSchema = z.object({
    conversationId: ConversationIdSchema,
    run: z.string().optional(),
    after: z.number().int().min(0).optional(),
});
export type AttachTurn = z.infer<typeof AttachTurnSchema>;

// ---- loops: run a conversation again, and again, until a goal is met ----
/* THE RALPH LOOP. An automation answers "run this at 3am"; a loop answers "run this until it is actually done".
 * The two are the opposite question and neither substitutes for the other: a schedule repeats on CADENCE and
 * never converges, a loop repeats on CONVERGENCE and stops the moment its goal is met.
 *
 * A loop is an ATTRIBUTE OF A CONVERSATION, not a new kind of object. It drives ordinary turns on an ordinary
 * fleet agent, which is what makes the worktree, the cost ledger, the transcript, the /agents card and the Stop
 * button work on it without a line of new code — the same bet the acceptance extension makes when it derives
 * conversation ids instead of owning session machinery.
 */

// How the next iteration meets its context, and the single most consequential field here.
//
// `fresh` is the canonical Ralph and the default: each iteration is a NEW provider session against the SAME
// worktree, so the filesystem — not the transcript — is the memory. Immune to context rot, so iteration 20 reads
// the tree as clearly as iteration 1, and it costs a re-read each time. The loop keeps a progress file for it
// (see LOOP_DIR) precisely because nothing else carries forward.
//
// `continue` resumes the provider session, so an iteration is a follow-up prompt. Cheaper (the prefix caches)
// and it keeps the reasoning, which is what a short refine-this loop wants. It degrades on long runs, and it
// degrades in the direction that matters: a session that has spent eleven turns arguing for its own approach is
// the worst available judge of whether that approach is finished.
export const LoopContextSchema = z.enum(["fresh", "continue"]);
export type LoopContext = z.infer<typeof LoopContextSchema>;

/* WHAT THE LOOP PRODUCES — asked separately from what ends it, because they are separate questions and
 * conflating them is what makes a chain of sessions impossible to build.
 *
 * `none` — the loop produces nothing but its work. The classic "make the suite green": what it leaves behind
 *   is a green suite, and asking it to also file a report is asking it to spend a turn on paperwork.
 * `claim` — the iteration writes `{done, reason, evidence?}`. Prose, but STRUCTURED prose: `done` is a boolean
 *   the daemon reads rather than a sentence it has to interpret. Self-assessment, so advisory by construction —
 *   it exists because plenty of goals have no command that can check them ("the README explains the auth
 *   flow"), not because a model's word for it is worth much.
 * `json` — the iteration writes `{done, reason, data}` where `data` matches a declared field list. This is the
 *   one that makes a step's output usable as the next step's input: a paragraph mentioning three files cannot
 *   be fed to anything, `{files: [...]}` can.
 *
 * All three land in ONE file per iteration, with one shape, differing only in strictness. See LoopDocumentSchema.
 */
export const LoopOutputSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("claim") }),
    z.object({ kind: z.literal("json"), fields: OutputFieldsSchema }),
]);
export type LoopOutput = z.infer<typeof LoopOutputSchema>;

/* WHAT ELSE HAS TO BE TRUE — checks that are not the worker's own word, ANDed with the output above.
 *
 * `command` is a shell one-liner run in the conversation's tree; exit 0 ⇒ satisfied. Deterministic, free, and
 * the only signal here whose answer does not come from a model. It is the automation `guard` with the sign
 * flipped, and it runs through the same runner. `pnpm test` passing beats any amount of self-report.
 *
 * `judge` puts a SEPARATE, tool-less call on the question: it reads the iteration's own report and rules
 * against a rubric, having done none of the work and nothing invested in it being finished.
 *
 * The rule both encode, and the reason they are kept apart from the output: the check must be a DIFFERENT CALL
 * from the work, or it is not a check. An output is what the worker says; a check is what someone else says.
 */
export const LoopCheckSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("command"), command: z.string().min(1) }),
    // The rubric is what the judge is asked; absent `model` runs it on the quick rung the other helpers use.
    z.object({ kind: z.literal("judge"), rubric: z.string().min(1), model: z.string().optional() }),
]);
export type LoopCheck = z.infer<typeof LoopCheckSchema>;

/* THE VERDICT FILE an iteration writes — one shape for all three output kinds, because the loop reads it the
 * same way whatever was declared and only the validation of `data` differs.
 *
 * It is a FILE rather than a sentence in the reply for the reason every structured output in this codebase is
 * a file: a reply has to be parsed out of prose the model is simultaneously using to talk to a person, and the
 * two demands pull against each other until neither is served. A file has one job.
 */
export const LoopDocumentSchema = z.object({
    // Whether the goal is met NOW. The loop's own reading of this is the whole point of the file.
    done: z.boolean(),
    // One line: why it is or is not met. The single most-read string in the feature — it is what the next
    // iteration reads first and what the history row shows.
    reason: z.string(),
    // What the iteration checked to know that. Optional because a model with nothing to point at should say so
    // by omitting it rather than by inventing a sentence.
    evidence: z.string().optional(),
    // The declared fields, present only for a `json` output and validated against them there.
    data: z.record(z.string(), z.unknown()).optional(),
});
export type LoopDocument = z.infer<typeof LoopDocumentSchema>;

// Enough iterations for a real convergence, few enough that a misconfigured loop is a bounded mistake. A loop
// that has not converged in 50 turns is not one iteration short of it.
const LOOP_ITERATIONS_MAX = 50;

export const LoopSchema = z.object({
    // The conversation the loop drives — its fleet card, its worktree, its transcript.
    conversationId: ConversationIdSchema,
    // What "done" means, in the user's words. Rides into every iteration's prompt (and into the judge's
    // question) so the model is told the goal it is being measured against rather than left to infer it.
    goal: z.string().min(1),
    // What each iteration is asked to DO. Separate from `goal` because they are different sentences: "make the
    // suite green" is the goal, "run the tests, pick the top failure, fix it" is the instruction.
    prompt: z.string().min(1),
    context: LoopContextSchema,
    output: LoopOutputSchema,
    /* Everything besides the worker's own word that has to hold before the loop may end. Ordinarily one or
     * none; a list because "the suite is green AND the report is written" is a real completion bar and
     * expressing it as two loops would run the work twice. */
    checks: z.array(LoopCheckSchema),
    maxIterations: z.number().int().min(1).max(LOOP_ITERATIONS_MAX),
    // The spend ceiling in USD across the whole loop, summed from the turns' own usage frames. Optional because
    // a 3-iteration loop does not need one; strongly wanted on anything unattended, since this is the first
    // feature in the sandbox that can spend without a person pressing anything between turns.
    maxSpendUsd: z.number().positive().optional(),
    /* Stop after this many CONSECUTIVE iterations that changed nothing in the tree.
     *
     * The guard that matters most in practice, and the one whose absence is expensive. The failure mode of a
     * loop is not runaway success, it is an agent that re-reads the same three files, restates the same plan,
     * declares more work remains, and does that eleven times. Nothing about that is an error — every turn
     * succeeds — so only "the tree did not move" catches it. */
    stallLimit: z.number().int().min(1),
    // Whether the iterations run in the conversation's own worktree or on the shared tree. Recorded on the loop
    // rather than read off the conversation because a loop can OPEN one, and because it decides where the stop
    // command runs: a check against /work would be testing code an isolated loop has not landed yet.
    isolated: z.boolean(),
    // Which provider / harness / model the iterations run on; absent ⇒ the conversation's own last choice, then
    // the provider default. The same three passthroughs an automation carries, for the same reason: a headless
    // driver has no composer to read them from.
    agent: AgentProviderSchema.optional(),
    harness: AgentHarnessSchema.optional(),
    account: z.string().optional(),
    model: z.string().optional(),
    // Which persona the iterations act as (AgentTurnSchema.actsAs — read its note for why this is not spelled
    // `account`). The fourth passthrough an automation carries, and it matters here for the automation's
    // reason: every iteration is unattended, and an unattended turn with no persona reaches no logged-in
    // account at all — pinning a card is the one way a loop gets hands.
    actsAs: entryId.optional(),
    // A workflow persists these on its underlying loop so restart recovery cannot silently change the checkout
    // or let a candidate inherit the sandbox's global auto-land posture on a later iteration.
    worktreeBase: z.array(RepoBaseSchema).min(1).max(50).optional(),
    autoLand: z.boolean().optional(),
});
export type Loop = z.infer<typeof LoopSchema>;

// Can this loop ever end on its own terms? A loop with nothing to produce and nothing to check runs to its
// iteration ceiling and reports `exhausted`, having been unable to succeed from the moment it was configured.
// A predicate rather than a schema refinement because two routes want it as one, at different moments: `start`
// refuses an ad-hoc loop, and `saveDesign` refuses a SAVED one — which is the more valuable of the two, since a
// saved loop that cannot converge is a trap everyone who picks it afterwards pays a full run to discover.
export const loopCanConverge = (loop: Pick<Loop, "output" | "checks">): boolean => loop.output.kind !== "none" || loop.checks.length > 0;

/* Where a loop keeps what it must not lose between iterations: <workspace>/.intentic/artifacts/loops/<conversationId>/.
 *
 * Under `.intentic` for the reason the acceptance runs are — it is outside every repo and bound back SHARED
 * into an isolated turn's worktree, so the agent writes and the browser reads the same tree, with nothing to
 * land and no git noise. `progress.md` is the loop's memory in `fresh` mode and its audit trail in `continue`
 * mode; `iteration-<n>.json` is the verdict a `claim` stop reads. */
export const LOOP_DIR = `${STATE_DIR}/artifacts/loops`;

// Why an iteration ended, which is not the same question as how the LOOP ended. `continue` is the ordinary
// "not done yet"; `error` is a turn that surfaced an error frame, which does NOT end the loop by itself — a
// failing turn is often exactly what the next iteration is supposed to fix.
export const LoopIterationSchema = z.object({
    n: z.number().int().min(1),
    at: z.number(),
    outcome: z.enum(["continue", "done", "error"]),
    // The stop check's own words — the guard's output tail, the claim's reason, the judge's verdict. What the
    // run history is actually read for: "why did it keep going" and "why did it stop".
    detail: z.string().optional(),
    costUsd: z.number().optional(),
    // Whether the tree moved this iteration. Feeds the stall detector, and is worth showing per row: three
    // unchanged iterations in a history is the shape of a loop that is not working.
    changed: z.boolean(),
    // The provider session this iteration ran on — the door from a history row to a readable transcript.
    sessionId: z.string().optional(),
});
export type LoopIteration = z.infer<typeof LoopIterationSchema>;

/* How a loop ended, and every one of these is a distinct thing to tell the user.
 *
 * `done` — the stop condition was met. The only success.
 * `exhausted` — maxIterations ran out with the goal unmet.
 * `stalled` — stallLimit consecutive iterations changed nothing. Reported apart from `exhausted` because the
 *   remedy is different: exhausted says "give it more room", stalled says "it is not making progress and more
 *   room will not help".
 * `overspent` — maxSpendUsd was reached.
 * `stopped` — the user pressed Stop.
 * `error` — the loop itself failed (not a turn inside it; see LoopIteration.outcome).
 */
export const LoopStateSchema = z.enum(["running", "done", "exhausted", "stalled", "overspent", "stopped", "error"]);
export type LoopState = z.infer<typeof LoopStateSchema>;

export const LoopRecordSchema = LoopSchema.extend({
    state: LoopStateSchema,
    startedAt: z.number(),
    endedAt: z.number().optional(),
    /* How many times a daemon BOOT has picked this loop back up. The record is its own journal: a loop still
     * marked `running` at boot is exactly one the daemon died under, which is the same trick turn-journal.ts
     * plays with its files and needs no second store to play it.
     *
     * Counted, not just flagged, for the reason the turn journal counts its attempts — a loop whose iteration
     * reliably kills the daemon (an OOM in a test it keeps running) would otherwise be resurrected on every
     * boot forever, and the container is recreated on every sandbox update. */
    resumed: z.number().int().min(0),
    // Why the loop ended, for the states whose reason isn't in their name (`error`, and a `done` whose stop
    // check said something worth keeping).
    detail: z.string().optional(),
    iterations: z.array(LoopIterationSchema),
});
export type LoopRecord = z.infer<typeof LoopRecordSchema>;

export const LoopsListSchema = z.object({ loops: z.array(LoopRecordSchema) });
export const LoopIdParamSchema = z.object({ conversationId: ConversationIdSchema });

/* ---- saved loops: the machinery, kept; the job, typed fresh each time ----
 *
 * A SAVED LOOP IS A LOOP WITH ITS GOAL TAKEN OUT, and that subtraction is the whole idea. Everything a loop
 * needs besides "what are we doing" is the same every time somebody sets one up — end on `pnpm test`, fresh
 * context, eight rounds, five dollars, stop after two idle ones — and every one of those was being retyped, in
 * a modal, before any work could begin. The goal is the only field that is genuinely new each time, and it is
 * the one field the user has ALREADY WRITTEN: it is sitting in the composer.
 *
 * So this holds the machinery and the composer holds the job, which makes a loop the same gesture as a
 * workflow — pick the shape, type the request, send. `WorkflowSchema` and this are deliberately siblings: both
 * are designs, both are picked from the composer, both leave the sentence to the message. What a workflow
 * spreads across sessions, a loop repeats in one.
 *
 * NO `conversationId` AND NO `isolated`, unlike the Loop this becomes. Both are facts about the agent the loop
 * is aimed at, decided at the moment of sending and unknowable when the design is written — a saved loop that
 * remembered a conversation would be a loop that could only ever be run once.
 */
export const LoopDesignSchema = z.object({
    id: entryId,
    // What it is called on the composer badge and in the picker — so it has to survive being read at pill width.
    name: z.string().min(1).max(60),
    // One line: what this loop is FOR. Optional, because a well-named loop has already said it.
    description: z.string().max(280).optional(),
    /* What each iteration is asked to do, when that is worth saying twice. Optional for the reason the ad-hoc
     * form made it optional: `goal` and `prompt` are different sentences, but making somebody write both before
     * anything runs doubles the cost of trying a loop at all. Absent ⇒ the iteration works towards the goal
     * however it sees fit. */
    prompt: z.string().optional(),
    context: LoopContextSchema,
    output: LoopOutputSchema,
    checks: z.array(LoopCheckSchema),
    maxIterations: z.number().int().min(1).max(LOOP_ITERATIONS_MAX),
    maxSpendUsd: z.number().positive().optional(),
    stallLimit: z.number().int().min(1),
});
export type LoopDesign = z.infer<typeof LoopDesignSchema>;

export const LoopDesignsListSchema = z.object({ designs: z.array(LoopDesignSchema) });
// Create and update on one route with the intent spelled out, exactly as a workflow saves — so an id collision
// cannot silently turn "new loop" into "replace the one you had".
export const LoopDesignSaveSchema = z.object({ design: LoopDesignSchema, create: z.boolean() });
export const LoopDesignIdParamSchema = z.object({ id: entryId });

/* The design, aimed at an agent — the one conversion in the feature, kept here so the composer and anything
 * else that starts a saved loop cannot disagree about what a saved loop MEANS. The goal is the message the user
 * typed; `isolated` is a fact about the agent it is aimed at. */
export const loopFromDesign = (design: LoopDesign, aim: { conversationId: string; goal: string; isolated: boolean }): Loop => ({
    conversationId: aim.conversationId,
    goal: aim.goal,
    prompt: design.prompt ?? "Work towards the goal above. Do the next most useful thing.",
    context: design.context,
    output: design.output,
    checks: design.checks,
    maxIterations: design.maxIterations,
    ...(design.maxSpendUsd === undefined ? {} : { maxSpendUsd: design.maxSpendUsd }),
    stallLimit: design.stallLimit,
    isolated: aim.isolated,
});

/* HOW A SAVED LOOP ENDS, IN ONE LINE — the sentence under its name in the picker and on its card, computed
 * rather than stored so the two can never describe the same loop differently. Ordered as it is read: the bar it
 * has to clear first, then how far it may go trying. */
export const loopDesignLine = (design: LoopDesign): string => {
    const command = design.checks.find((check) => check.kind === "command");
    const ends =
        command !== undefined
            ? command.command
            : design.checks.some((check) => check.kind === "judge")
              ? "a reviewer agrees"
              : design.output.kind === "none"
                ? "nothing checks it"
                : "the agent says so";
    const ceilings = [`${design.maxIterations} rounds`, design.maxSpendUsd === undefined ? `` : `$${design.maxSpendUsd}`].filter(
        (part) => part !== ``,
    );
    return [ends, ...ceilings].join(" · ");
};

// ---- agents: the conversation fleet ----
// A "fleet agent" is any conversation with a registry entry, keyed by its conversationId. Isolated ones own a
// git worktree (branch agent/<id> in every workspace repo); workspace conversations have no branch. The fleet
// surface shows both through the same status/activity/cost lifecycle.

// idle/running/awaiting are the turn lifecycle (awaiting = paused on a plan approval or question); ready /
// landed / conflict are outcomes of the land flow — `ready` is a clean completion whose delta stayed on the
// agent's branch because auto-land is off (the user lands it deliberately, from the review panel or the card);
// error is a terminal turn failure surfaced on the card.
//
// `interrupted` is the turn that never got to report ANY of those: the daemon died under it (a container
// rebuild, a crash, an OOM kill), taking the provider process and the whole runtime half of the fleet — status,
// attention flags, the park a question raised — with it. It exists because the alternative is worse than
// unlabelled: without it such a turn rehydrates as `idle`, which is the resting status of a turn that finished
// CLEANLY, so the board files a killed agent under Finished and the question it was holding disappears with the
// process that asked it. See agents-store.ts — this is the status a live turn leaves on disk.
//
/* `stopping` and `stopped` are the two halves of a user's Stop, and they exist because a hard-cancel is NOT
 * instant: /agent/stop aborts the provider and then waits for the turn's generator to unwind (worktree and
 * registry cleanup), which is seconds of real time. For that whole window the runtime half still said
 * `running`, so every surface kept its spinner turning on a turn the user had already killed — and then the
 * card jumped to a settled state out of nowhere. `stopping` is what the daemon knows the instant the abort
 * lands, published immediately so the press has a visible result; `stopped` is where the turn comes to rest.
 *
 * `stopped` is deliberately its own value rather than `interrupted` or `error`. Not `error`, which is what a
 * stopped turn used to report (every provider adapter surfaces the abort's unwind as an error frame) — a card
 * accusing the user's own deliberate press of being a failure. Not `interrupted` either: that one means the
 * daemon died under the turn, and a boot pass may re-run it, which is precisely what must never happen to a
 * turn a person chose to end. */
/* `resuming` is the same argument as `stopping`, made about the other end of a turn's life: the turn was killed
 * by something the daemon is ALREADY undoing (a rotated credential being re-minted, a provider outage being
 * waited out — turn-resume.ts), so it has stopped without having ended. The gap is real time — a few seconds for
 * a re-mint, minutes for an outage's backoff — and for that whole window the turn reported the resting `idle`,
 * which the board reads as finished. So a 401 that nobody caused and nobody has to fix filed the card under
 * Finished and then pulled it back into Active a moment later, which is the fleet contradicting itself in front
 * of the user about work that never stopped being in progress.
 *
 * Never persisted (see PersistedAgentStatusSchema): what is coming back is remembered in the daemon's memory
 * alone, and a daemon that dies mid-wait takes the resume with it — so the card falls back to the ending its
 * killed turn actually wrote and reads as finished, which by then is true. Nothing is left to bring it back. */
export const AgentStatusSchema = z.enum([
    "idle",
    "running",
    "awaiting",
    "stopping",
    "stopped",
    "resuming",
    "ready",
    "landed",
    "conflict",
    "error",
    "interrupted",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
// The card's live activity snippet: the last tool the agent used (with its target) and the in-progress todo.
export const AgentActivitySchema = z.object({
    tool: z.string().optional(),
    target: z.string().optional(),
    todo: z.string().optional(),
});
export type AgentActivity = z.infer<typeof AgentActivitySchema>;
// Which "needs you" flags are raised — the fleet badge aggregates these across all agents.
export const AgentAttentionSchema = z.object({
    plan: z.boolean(),
    question: z.boolean(),
    permission: z.boolean(),
    // A priced service run parked on the owner's click (platform/service-offer.ts) — the one card where
    // waiting costs the agent its whole call, so the lane says "spend approval" rather than a generic pause.
    service: z.boolean(),
    // A missing capability parked on the owner's setup (capabilities/capability-offer.ts) — the agent is
    // waiting for something to be connected, so the lane can say "setup needed" rather than a generic pause.
    capability: z.boolean(),
    conflict: z.boolean(),
});
export type AgentAttention = z.infer<typeof AgentAttentionSchema>;

/* WHAT A LANDING IS CALLED — the commit message drafted from the landed diff (agents/landed-subject.ts), and
 * the whole of it: a subject, and the two trailer sentences a repo that keeps a changelog gets.
 *
 * ONE SHAPE, TWO CARRIERS, and that is the reason it is a schema of its own rather than three fields written
 * out twice. The same sentence reaches the Changes panel down two roads — the fleet roster, which is live and
 * drops archived agents, and the review, which is a rescan and outlives the card (OriginAgent) — so the panel
 * takes whichever answers first and must not care which one did. Two hand-kept copies of these three fields
 * would be two things to keep in step, and the one that drifted would be the one nobody was looking at.
 *
 * THE PARTS STAY APART. A subject is one bounded line everywhere it is stored and shown; the notes are
 * sentences for the people who read a release. Flattening them into one string would produce a run-on subject
 * in the commit box and a truncated note in the changelog, so they are joined only at the moment of the fill —
 * where they become a commit message with its trailers and nowhere before it. */
export const LandedMessageSchema = z.object({
    /* WHAT THIS AGENT'S LANDED WORK DID, as a commit subject — written from the landed diff when the work
     * arrived, which is why it can say what a title cannot.
     *
     * A title names the ASK, and it is written once, from the opening prompt, a second into the first turn. A
     * conversation that opens "audit the review panel" and then spends four turns fixing what the audit found
     * still answers to "Review panel · audit" — a good name for the session and a wrong subject for the
     * commit. This is read off the code instead, so it describes the change the user is about to record. */
    subject: z.string(),
    /* THE SAME LANDING, SAID TO A USER — the `Release-Note:` sentence the chip files in under the subject, for
     * a repo that keeps a changelog (SandboxSettings.changelogRepos).
     *
     * Usually absent, and that is the design: most landings change nothing a user would notice, and the model
     * is told to omit the note for those rather than to invent one. */
    note: z.string().optional(),
    /* WHAT THE SAME LANDING TAKES AWAY — the `Breaking-Note:` sentence, filed as its own trailer so the
     * release harvest can put it under "Breaking changes" and the update card can warn with it before the
     * update rather than after. Nearly always absent: the model is told a breaking note is for removals only,
     * and to omit it when in doubt — except when the landing shrinks a wire-contract lock, where the sentence
     * is REQUIRED and mechanically guaranteed (the daemon's git/contract-shrink.ts) rather than judged. */
    breaking: z.string().optional(),
});
export type LandedMessage = z.infer<typeof LandedMessageSchema>;

/* ONE MODEL'S TURN IN THE DRAFTING WALK — asked, and what became of the ask. The quick-model chain tries the
 * connected models in order (agent/quick-model.ts), and each rung ends one of four ways:
 *   asking   — in flight right now; `ms` absent because it is still being spent.
 *   answered — it wrote the sentence, in `ms`.
 *   refused  — it failed or declined, in `ms`, with its own words in `reason`.
 *   skipped  — not asked at all: it refused within the last few minutes and the walk stepped over it, with the
 *              reason it gave back then. Skipping is the memo working, and it reads as such.
 * The steps arrive in the order they were spent, so the list IS the timeline. */
export const LandedMessageStepSchema = z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    status: z.enum(["asking", "answered", "refused", "skipped"]),
    // When this rung started being asked, ms since epoch — what an in-flight step's ticking "12s…" is measured
    // from, client-side, without a frame per second. Absent for `skipped`, which cost no time at all.
    at: z.number().optional(),
    ms: z.number().optional(),
    reason: z.string().optional(),
});
export type LandedMessageStep = z.infer<typeof LandedMessageStepSchema>;

/* THE FULL ACCOUNT OF ONE LANDING'S COMMIT MESSAGE BEING DRAFTED — everything a user waiting at the commit box
 * is owed: that the draft started, which models have been asked, how each one went, and how it ended.
 *
 * `outcome` is absent while the draft is RUNNING, which is what "a sentence is on its way" now means — the
 * boolean flag this replaces could say only that, and nothing else this schema carries. Ended, it is:
 *   written — the sentence is on the card (`landedMessage`) and in the box; the steps say who wrote it.
 *   failed  — nothing usable came back. The steps carry each model's own words; `reason` is the one-line
 *             account for the surfaces with a single line to spend (an answer that was itself a refusal
 *             sentence, or the whole chain spent).
 * An empty `steps` with no outcome is the moment before the first model is asked — the diff is being read. */
export const LandedMessageDraftSchema = z.object({
    startedAt: z.number(),
    steps: z.array(LandedMessageStepSchema),
    outcome: z.enum(["written", "failed"]).optional(),
    reason: z.string().optional(),
    finishedAt: z.number().optional(),
});
export type LandedMessageDraft = z.infer<typeof LandedMessageDraftSchema>;

export const AgentSummarySchema = z.object({
    // The conversationId.
    id: z.string(),
    sessionId: z.string().optional(),
    // First prompt, sanitized to one bounded line.
    title: z.string().optional(),
    status: AgentStatusSchema,
    /* WHY THE LAST TURN FAILED — the sentence it died on, carried beside the `error` status because that word
     * on its own is not an answer. A session refused on its first request (an organization with Claude Code
     * switched off, a spent allowance, a model the endpoint has never heard of) reached every surface as a grey
     * "error" and a link into the transcript, so the one place the reason existed was the dead conversation
     * itself — which is exactly where an unattended run, started from a fan-out nobody is watching, is least
     * likely to be read. Absent unless the last turn ended in failure, and cleared the moment it runs again. */
    failure: z.string().optional(),
    provider: AgentProviderSchema,
    harness: AgentHarnessSchema,
    // What the agent's last turn ran with — the model, its reasoning effort, whether extended thinking was on,
    // and whether fast speed was asked for. Recorded per agent because they are facts about THIS conversation: a
    // client opening it seeds its composer from them, rather than from whatever that browser last picked in some
    // other tab. Absent for an agent whose turns predate the record (model has always been kept; the rest are
    // newer). `fast` is what was REQUESTED, not what was served — the served answer belongs to a turn and rides
    // its `fast_mode` frame, while this is the composer's memory of the user's own choice.
    model: z.string().optional(),
    effort: z.string().optional(),
    thinking: z.boolean().optional(),
    fast: z.boolean().optional(),
    account: z.string().optional(),
    // The worktree branch (agent/<id>); absent for a non-isolated (main-tree) conversation.
    branch: z.string().optional(),
    // This agent's own answer to "land automatically at turn completion?" — an explicit per-agent override of
    // the sandbox-wide `autoLand` setting. ABSENT ⇒ inherit, which is the common case and the one that keeps
    // the global toggle meaningful: an agent that never expressed an opinion follows the sandbox wherever it
    // is pointed next. Written by `agents.autoLand`; the UI shows the EFFECTIVE value (this ?? the setting).
    autoLand: z.boolean().optional(),
    /* This agent's own answer to "re-run my turn when the model provider was what failed?" — the same
     * two-level shape as `autoLand` above, and here for a sharper reason than symmetry.
     *
     * The press that writes this is offered INSIDE one conversation, at the moment that conversation's turn
     * died, and what a person means by it is "finish THIS piece of work". It used to write the sandbox-wide
     * setting, so one impatient click at 2 a.m. quietly armed every agent on the board — a blast radius
     * nothing on screen had asked about. So the chat's offer writes this, the settings toggle writes the
     * default, and the two stay honestly different things.
     *
     * ABSENT ⇒ inherit the sandbox setting, which is what keeps that default meaningful: a conversation that
     * never expressed an opinion follows the sandbox wherever it is pointed next. Written by
     * `agents.resumeAfterOutage`; every surface shows the EFFECTIVE value (this ?? the setting). */
    resumeAfterOutage: z.boolean().optional(),
    // A collaborator asked for this agent's work to be landed (agents.requestLand) — collaborators may drive
    // agents but not merge into the main tree, so the ask rides the summary where every maintainer's board
    // sees it. Cleared by the land or discard that answers it. Absent ⇒ nobody is waiting.
    landRequested: z.object({ email: z.string(), name: z.string().optional(), at: z.number() }).optional(),
    // Present when the conversation was opened by an outside message rather than by the user (see
    // AgentOriginSchema) — the card's provenance line. Absent ⇒ the user started it.
    origin: AgentOriginSchema.optional(),
    /* Where this conversation was cut from, when it was cut from another. Recorded once, from the fork's very
     * first turn, and never cleared — it is the relationship, not a pending state.
     *
     * It rides the SUMMARY rather than living in the client's tabs because a fork and its source are two chats
     * that are obviously related and, without this, had no way to say how: the link has to survive closing
     * either tab and reopening it from history, and it has to be readable from the OTHER side — the source's
     * own transcript marks its cut points by looking for the conversations that name it. */
    forkedFrom: ForkedFromSchema.optional(),
    // The ROOT repo's short base sha — the checkout moment's display identity. Per-repo bases stay
    // daemon-internal (agents.diff already reports against them).
    base: z.string().optional(),
    costUsd: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    contextTokens: z.number().optional(),
    contextWindow: z.number().optional(),
    activity: AgentActivitySchema.optional(),
    /* THE WHOLE STORY OF THIS LANDING'S COMMIT MESSAGE BEING WRITTEN — present from the moment the land starts
     * the draft, updated on every transition, and kept after it ends until the next land replaces it.
     *
     * This used to be one boolean ("a model is writing"), and a boolean is exactly one fact short of every
     * question the wait raises: WHICH model, for how long, what refused and in what words, what finally
     * answered. All of that was known in the daemon and thrown away at the door — a first-pinned model that
     * burned 58 seconds refusing on every landing had to be caught by watching CLI processes by hand, because
     * nothing on any screen could have shown it.
     *
     * Runtime only: nothing about it is persisted, so a daemon restart forgets it. That is correct rather than
     * lossy — a restart also killed the draft it would have been describing. */
    landedMessageDraft: LandedMessageDraftSchema.optional(),
    /* AND THE SENTENCE ITSELF, once the flag above clears — what this agent's landed work is called, for the
     * Changes panel's "From" chip to file into the commit box.
     *
     * IT RIDES THE ROSTER because the roster is the channel that is already live for it. The review carries the
     * same fact (OriginAgent.subject) and has to, for an archived agent whose lines are still in the tree — but
     * the review is a workspace-wide rescan, coalesced daemon-side and refetched only when something asks, and
     * this sentence arrives ALONE, seconds after the work it describes, with nothing else moving. Every link in
     * that chain has to hold for a message that exists to become a message the user can see, and when one of
     * them doesn't, the box stays empty with nothing to say why — while the flag above, which travels on THIS
     * frame, has already told them a sentence was coming.
     *
     * So the fact goes where the promise went. Same push, same instant: the frame that ends `landedMessageDraft`
     * is the frame that carries the answer, which is also what makes "your commit message is ready" honest.
     *
     * Absent for every agent that has not landed, and for a landing nothing could be written about. Replaced
     * wholesale by the next land — the claim grows and so does the sentence about it. */
    landedMessage: LandedMessageSchema.optional(),
    // Present while a turn runs: its start, ms since epoch.
    startedAt: z.number().optional(),
    updatedAt: z.number(),
    // When the agent was last OPENED, ms since epoch — the unread badge's reference point (`updatedAt >
    // seenAt` ⇒ the agent has done something you haven't looked at). Absent ⇒ never opened. Daemon-side on
    // purpose: read state is a fact about the WORK, not about one browser profile, so clearing site data or
    // picking up the phone must not resurrect every badge.
    seenAt: z.number().optional(),
    attention: AgentAttentionSchema,
    // Completed turns and lifetime tool calls — the card's msgs/tools counters.
    turns: z.number().optional(),
    toolUses: z.number().optional(),
    /* The agents THIS agent started (SubagentSessionSchema), live and lifetime. Absent ⇒ it has never delegated,
     * which is most agents — so the card's chip appears on content rather than reading "0" down the board.
     *
     * THE TWO HALVES COME FROM DIFFERENT PLACES, and have to: `running` is read off the live subagent registry,
     * which sweeps a child five minutes after it reports and remembers nothing across a restart, while `total`
     * is counted onto the agent's own entry as each child is born. Deriving both from the live registry is what
     * used to take the count off a card while the agent that earned it was still on the board.
     *
     * It earns a place on a card because a fleet card is the answer to "what is this agent up to", and an agent
     * running five children looked exactly like an agent running none: the work was real, the spend was real, and
     * the board said nothing. The tokens are NOT folded into the parent's cost — a child's spend is its own, and
     * the Subagents area is where it is attributed. */
    subagents: z.object({ running: z.number(), total: z.number() }).optional(),
    // The agent's cumulative output (base → branch tip across every repo), refreshed on each land —
    // the card's "12 files · +412 −96" readout. Independent of what has landed.
    diff: z.object({ files: z.number(), insertions: z.number(), deletions: z.number() }).optional(),
    /* HOW MUCH OF WHAT THIS AGENT LANDED IS STILL IN YOUR WORKING TREE — present only when some of it ISN'T.
     *
     * A land applies its delta to the main tree as uncommitted changes, so the user can discard it there like
     * any other change, and every other reading on this card is measured between commits and cannot see that
     * happen (landed-presence.ts). Left unsaid, the card goes on wearing a landed chip and the session menu
     * goes on saying "Already in your workspace" over a tree that no longer holds it — and the next land
     * carries only the NEW delta, dropping turn 2 onto a tree missing turn 1.
     *
     * `present` counts the landed paths still there: dirty, or committed into history — a commit is the
     * strongest form of still-there, which is why this cannot be folded into the Changes panel's own
     * attribution, where a commit is what ENDS the agent's claim (origins.ts).
     *
     * Absent is the steady state and the quiet one: an agent that never landed and an agent whose work is
     * exactly where it left it both say nothing. Its PRESENCE is the signal, which is what keeps the board
     * from spending a line per card on the ordinary case. */
    landedPresence: z.object({ landed: z.number(), present: z.number() }).optional(),
    /* The loop driving this conversation, when one is (or was) — "iteration 3/12, until the suite is green".
     *
     * PROJECTED onto the card rather than fetched beside it, and that is the whole reason a loop needed no
     * surface of its own: a looping agent is an agent, so the board's status, spend, unread badge and Stop
     * button already describe it, and one extra line is the difference between a card that says `running` for
     * forty minutes and one that says what it is running towards. A second query joined client-side would have
     * paid for the same line with a poll that can disagree with the roster.
     *
     * Absent ⇒ an ordinary conversation, which is nearly all of them. */
    loop: z
        .object({ state: LoopStateSchema, iteration: z.number().int().min(0), maxIterations: z.number().int().min(1), goal: z.string() })
        .optional(),
    /* The workflow run this conversation is a step of — "Ship the feature · step 3 of 4 · Review the change".
     *
     * Projected for the same reason the loop above is, and it answers a question only the board can be asked. A
     * run of four `fresh` steps IS four conversations, so it arrives on the board as four unrelated cards that
     * started a few minutes apart — the work reads as four people who happen to be busy rather than as one job
     * with a shape. Naming the run on each card is what makes them one block, and `runId` is what lets the board
     * order them together and link every one of them at the run's own graph.
     *
     * POSITION IS A FACT ABOUT THE STEP, not a running total: `index`/`total` are its place in the workflow's own
     * step order, so a card is published once when its step starts and never has to be rewritten because a
     * sibling advanced. How the run as a whole is going is the run page's job, and how THIS step is going is
     * already the card's status and the loop line above.
     *
     * `step` moves within one conversation when steps are chained with `continue` — they share it, which is the
     * point of chaining — so this says which one is on it NOW.
     *
     * Absent ⇒ an ordinary conversation. */
    workflow: z
        .object({
            runId: z.string(),
            name: z.string(),
            step: z.string(),
            index: z.number().int().min(1),
            total: z.number().int().min(1),
        })
        .optional(),
    // When the agent was ARCHIVED (ms epoch) — off the board, but nothing lost: its checkout was retired
    // (worktree removed) while the agent/<id> branch, the transcript, and every counter stayed. Absent ⇒ live
    // on the board. Archived agents are excluded from the roster the fleet renders; `agents.archived` lists
    // them, `agents.unarchive` brings one back, and the next turn re-attaches its worktree from the branch.
    archivedAt: z.number().optional(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
// AgentsListSchema lives further down, after AutomationApprovalSchema — the fleet list carries the held wakes,
// and zod declaration order forces the ride-along to be declared first.
export const AgentIdSchema = z.object({ id: z.string().min(1) });
// archive's input: the agents to take off the board. Absent `ids` ⇒ every finished agent that is archivable
// right now (the lane header's "Clear"); unarchive always names its ids (a restore, or a bulk archive's undo).
export const AgentArchiveSchema = z.object({ ids: z.array(z.string().min(1)).max(500).optional() });
export const AgentIdsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });
// What actually MOVED, and deliberately NOT the roster afterwards. Two archives in flight at once each finish
// holding a full-roster snapshot from a different instant, so a client that swapped one in wholesale would let
// the slower response resurrect what the faster one just filed away — a delta composes where a snapshot races.
// Whole summaries rather than ids because the receiving side has to SHOW them (the archive list, and the agent
// detail page addressed by id); the ids "Undo" needs come off them for free.
// The agents an archive/unarchive actually moved, plus the registry revision that applied the move — the
// browser holds its optimistic add/remove of exactly these ids until it sees a roster at or past `rev`.
export const AgentsMovedSchema = z.object({ moved: z.array(AgentSummarySchema), rev: z.number() });
export type AgentsMoved = z.infer<typeof AgentsMovedSchema>;
// What a purge actually deleted. Ids, not summaries: these agents no longer exist anywhere — there is nothing
// left to show and nothing to put back, so the only thing the caller can do with the answer is drop those rows
// and count them. No revision either: archived agents are already off the broadcast roster (see `list`), so a
// purge changes nothing the board's pending-move machinery has to hold a card against.
export const AgentsRemovedSchema = z.object({ removed: z.array(z.string()) });
export type AgentsRemoved = z.infer<typeof AgentsRemovedSchema>;
/* Search the fleet by what was SAID in it — the board's filter (and the popped-out rail's).
 *
 * Both sides of the conversation, and nothing else: the user's own prompts and the agent's chat bubbles. What
 * an agent ANSWERED is half of what a chat is remembered by — the name it found, the file it named, the number
 * it reported — and a filter that could not reach it sent people back to opening chats one at a time.
 *
 * What stays out is everything that is not speech: extended thinking, tool calls and their output, and the
 * daemon's own protocol (preambles, attachment notes). That is the line the old user-only rule was really
 * drawing — tool output alone names nearly every identifier in the workspace, so matching it returns most of
 * the board and the filter stops filtering. Prose is a fraction of a transcript and reads like a sentence
 * someone wrote, which is why it can be searched when a diff dump cannot.
 *
 * The card TITLE is the first prompt (sanitized), so a title match and a prompt match are one rule, not two.
 *
 * Two chars minimum: below that every agent matches and the scan is pure cost.
 *
 * `caseSensitive` is the field's Aa switch — the same name and the same default as the workspace search's, so
 * one word means one thing across the daemon's search routes. Off is case-INSENSITIVE rather than smart case:
 * a filter that quietly changed rule when a capital was typed would make the switch beside it a lie.
 */
export const AgentSearchQuerySchema = z.object({ query: z.string().trim().min(2), caseSensitive: z.stringbool().optional() });
/* WHY a row survived the filter: the matched line, windowed around the hit, and which side of the conversation
 * said it. A result that matches for a reason the reader cannot see is worse than no filter at all.
 *
 * `speaker` rides WITH the text rather than beside it because the two are never separately true — every line is
 * someone's — and because the words alone stopped being self-identifying the moment agent prose became
 * matchable: "landAgent lives in laneDrop.ts" under a card reads as something the user typed until the row
 * says otherwise.
 */
export const SpeakerSchema = z.enum(["user", "agent"]);
export type Speaker = z.infer<typeof SpeakerSchema>;
export const MatchSnippetSchema = z.object({ text: z.string(), speaker: SpeakerSchema });
export type MatchSnippet = z.infer<typeof MatchSnippetSchema>;
// One matching agent, and the evidence for it. `snippet` is absent when the match is the TITLE, which the card
// already shows — repeating it underneath is noise where evidence was wanted.
export const AgentMatchSchema = z.object({ id: z.string(), snippet: MatchSnippetSchema.optional() });
export type AgentMatch = z.infer<typeof AgentMatchSchema>;
// `scanned` is how many agents the daemon actually read prompts for, so the board can say when a query saw
// less than the whole fleet rather than implying it saw all of it.
export const AgentSearchResultSchema = z.object({ matches: z.array(AgentMatchSchema), scanned: z.number() });
export type AgentSearchResult = z.infer<typeof AgentSearchResultSchema>;
// rename's input: the user-chosen display title (bounded like sanitizeTitle's cap).
export const AgentRenameSchema = z.object({ id: z.string().min(1), title: z.string().trim().min(1).max(80) });
/* place's input: words the user writes INTO the transcript wearing the agent's voice (see agentsContract.place).
 * Bounded well above anything a person types by hand and just above the handoff's per-message render cap
 * (runtime-history's MESSAGE_CHAR_CAP) — a placed line longer than that would reach the agent truncated, which
 * silently breaks "it thinks these are its own words". Better to refuse at the door with a reason. */
export const AgentPlaceSchema = z.object({ id: z.string().min(1), text: z.string().trim().min(1).max(8_000) });
// autoLand's input: this agent's own land-at-completion posture. `null` CLEARS the override back to "inherit
// the sandbox setting" — the browser sends it whenever the user toggles back to what the global already says,
// so agents don't accumulate frozen overrides that quietly stop following the global toggle.
export const AgentAutoLandSchema = z.object({ id: z.string().min(1), autoLand: z.boolean().nullable() });
// resumeAfterOutage's input: this ONE conversation's answer to a provider outage. `null` clears the override
// back to "inherit the sandbox setting" — sent whenever the user toggles back to what the global already says,
// on the same reasoning as autoLand's null: an agent holding a frozen copy of a default has quietly stopped
// following it, and nothing on screen would say so.
export const AgentResumeAfterOutageSchema = z.object({ id: z.string().min(1), resumeAfterOutage: z.boolean().nullable() });
export const AgentFileDiffQuerySchema = z.object({ id: z.string().min(1), repo: z.string().min(1), path: z.string().min(1) });
/* WHY a path would not land. The distinction is the whole difference between an actionable report and a dead
 * end, because the three have nothing in common but their symptom:
 *   `workspace` — you have uncommitted edits on that path. Yours is the copy at risk; commit or stash it.
 *   `diverged`  — the main tree's COMMITTED content moved under the agent since it branched. Nothing of
 *                 yours is at risk; the agent's delta is simply written against an older file.
 *   `binary`    — git cannot three-way merge the file at all, so no automatic resolution exists.
 * The old report named only the first, which is the rarest of the three. */
export const LandConflictReasonSchema = z.enum(["workspace", "diverged", "binary"]);
export type LandConflictReason = z.infer<typeof LandConflictReasonSchema>;
export const LandConflictPathSchema = z.object({ path: z.string(), reason: LandConflictReasonSchema });

/* land's outcome, per repo of the composition. `paths` is the set that genuinely failed to apply — NOT the
 * whole delta, which is what the first version reported whenever it could not pin the cause down, turning
 * four real conflicts into a wall of fourteen. `clean` counts what would land regardless, so the UI can say
 * how much is being held back by how little, and offer to take it. An empty `paths` with `clean: 0` is the
 * repo-unavailable case: the main checkout is gone, and no path-level account exists. */
export const LandConflictSchema = z.object({
    repo: z.string(),
    paths: z.array(LandConflictPathSchema),
    clean: z.number(),
    // The branch the user's checkout is on — the thing the agent has to rebase onto. Carried because only the
    // daemon can see it: an isolated turn's worktree is mounted over the agent's whole view, so the resolution
    // errand could otherwise only tell it to go and read the name off `git worktree list`. Absent on a detached
    // HEAD or a vanished checkout, where there is no name to give.
    mainBranch: z.string().optional(),
});
export type LandConflict = z.infer<typeof LandConflictSchema>;

// land's outcome; landed only when every repo with changes applied cleanly. Conflicted repos keep their
// worktree state — nothing is lost, and "Land now" stays available. `resolving` is populated only by a
// `merge` land: the paths written into the workspace carrying conflict markers, which the user finishes by
// hand in their own editor exactly as they would any merge.
export const LandResultSchema = z.object({
    landed: z.boolean(),
    conflicts: z.array(LandConflictSchema).optional(),
    resolving: z.array(z.object({ repo: z.string(), paths: z.array(z.string()) })).optional(),
    // A `measure` outcome with an outstanding delta: nothing was applied and nothing failed — the work is
    // waiting on the branch for a deliberate Land. `landed: false` alone can't say that (it means refusal).
    held: z.boolean().optional(),
});
export type LandResult = z.infer<typeof LandResultSchema>;

/* land's input. `check` is the safe default and the historical behaviour: the delta is applied only if ALL of
 * it applies, so a refusal leaves the workspace byte-identical. `merge` is the escape hatch the conflict
 * report offers — a three-way apply that lands every clean path and leaves the rest with conflict markers to
 * resolve in place. It is opt-in because it WRITES on failure, which is the one thing `check` promises not
 * to do. `measure` is the auto-land-off mode: everything a land does EXCEPT touching the main tree — the
 * provenance commit onto agent/<id>, the cumulative diffstat, and the bookkeeping for work that reached the
 * main line by another road — so a held agent's card stays as current as a landed one's while its delta waits
 * on the branch for a deliberate Land. */
export const LandModeSchema = z.enum(["check", "merge", "measure"]);
export type LandMode = z.infer<typeof LandModeSchema>;
/* WHICH RUNG OF AN AGENT'S HISTORY A READING — or a land — STARTS AT.
 *
 *   outstanding — only what has not landed yet, measured from the last landed tip. The default, and what a
 *                 land carries: a second land applies only what the agent has done since the first.
 *   cumulative  — the agent's WHOLE output, from where its branch left the main line. What the review lists
 *                 (landed work stays inspectable), and what "Land again" applies.
 *
 * A CUMULATIVE LAND IS NOT A DOUBLE APPLICATION. It is the way back when a land's work was discarded from the
 * workspace: the outstanding span is empty then — every sha says the work landed, because it did — so only a
 * reading from the base can still see the part that is missing. Paths the tree already holds drop out of it
 * per file, by the same reverse probe that keeps work which reached main by another road out of a conflict
 * report (land.ts, classifyDelta), so what actually applies is exactly what is gone. */
export const AgentSpanSchema = z.enum(["cumulative", "outstanding"]);
export type AgentSpan = z.infer<typeof AgentSpanSchema>;
/* LAND WHILE THE AGENT IS STILL WRITING — the user's deliberate override of the turn guard, and the only
 * input here that is about WHEN a land may run rather than what it carries.
 *
 * A land snapshots the agent's checkout, so mid-turn it can catch work half-done: one leg of a rename, three
 * files of a five-file change. The guard exists for that, and it stays the default. What makes the override
 * defensible rather than reckless is that neither half of the damage is permanent — a land arrives as
 * UNCOMMITTED changes the user reviews before committing, and the rest of the turn lands on top of it at
 * completion like any other incremental land. So a premature land is a mess the user can see and one the next
 * land repairs, which is a thing to warn about; it is not a thing to forbid.
 *
 * It does NOT cover a turn PARKED on a question or a permission card — nothing is being written there, so that
 * land needs no override and takes none (agents.routes.ts). This flag means "yes, mid-write, I know". */
export const AgentLandSchema = z.object({
    id: z.string().min(1),
    mode: LandModeSchema.optional(),
    span: AgentSpanSchema.optional(),
    force: z.boolean().optional(),
});

// ---- routed-provider subscriptions ----

// The providers whose model can run UNDER the Claude Code harness through the bundled translator (CLIProxyAPI),
// which holds their SUBSCRIPTION OAuth and re-serves it behind an Anthropic endpoint. The `claude` provider is
// absent — native Anthropic OAuth serves it directly, without the translator. Codex, Grok and Gemini also have a
// native runtime and so carry the harness axis; Kimi is routed-only, so its turns always use Claude Code.
//
// Gemini is in BOTH camps and that is not a contradiction: its native runtime (OpenCode) reaches Google through
// this same translator and these same auth files. The harness axis picks the loop; the translator is the road
// under either.
export const KeyedProviderSchema = z.enum(["codex", "grok", "kimi", "gemini"]);
export type KeyedProvider = z.infer<typeof KeyedProviderSchema>;

// ---- plan-limit usage ----
// Declared ABOVE both account shapes because both carry it: headroom is one idea in this product, not a Claude
// idea that other providers imitate. A native account (OauthAccount) and a routed subscription
// (TranslatorAccount) differ in who holds the credential and how the reading is taken — never in what a
// reading IS — so every surface that draws a percentage reads this one type and no other.

// One plan-limit pool. `kind` is the provider's own key ('five_hour' | 'seven_day' | 'seven_day_opus' |
// 'seven_day_sonnet' | 'model:Fable' | …) rather than an enum we'd have to keep in step with the provider: an
// unrecognised pool is shown under its raw key, which is far better than being silently folded into a
// neighbour. `label` is the provider's OWN display name where it supplies one (the per-model buckets do) — it
// wins over anything we'd infer, because the model names in a plan's limits are the provider's to rename.
// `resetsAt` is epoch SECONDS (matching the SDK's frame).
export const UsageWindowSchema = z.object({
    kind: z.string(),
    label: z.string().optional(),
    utilization: z.number(), // 0-100
    resetsAt: z.number().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

// An account's headroom: EVERY window the provider reports, read together, plus when the reading was taken.
// All of them, not the binding one, because "which pool is binding" changes between turns and a reader
// comparing accounts needs the same pools on every row. How the reading is TAKEN is per provider and stops at
// the daemon's readers: Claude's rides the turn's own stream, ChatGPT's, Google's and Kimi's are pulled through
// CLIProxyAPI's credential-scoped management call. All of them are control requests, so none costs tokens.
//
// Within one window utilization only climbs, so an un-reset window stays a valid FLOOR however old it is; past
// its `resetsAt` it describes a pool that no longer exists and the store drops it. `measuredAt` is epoch MS
// (matching connectedAt) — deliberately a different unit from the windows' seconds.
export const AccountUsageSchema = z.object({
    windows: z.array(UsageWindowSchema),
    measuredAt: z.number(),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

/* THE LAST TIME A PROVIDER ACTUALLY REFUSED A TURN — the other half of "can I run on this", and the half no
 * meter can supply.
 *
 * A snapshot above is POLLED and therefore always a floor: read at turn end (Claude) or on a five-minute sweep
 * (the routed subscriptions), and account-wide, so every other client on the plan spends the same pools without
 * this sandbox hearing about it. A refusal is the opposite kind of fact — observed, exact, and timestamped by
 * the only event that proves the plan said no. Between them they answer a question neither can alone: a green
 * meter beside "refused a turn 4 minutes ago" means the reading is stale, not that the account has room.
 *
 * Keyed by PROVIDER rather than by account, because that is the resolution the daemon honestly has. A native
 * Claude turn knows which account served it and names it; a routed turn does not — CLIProxyAPI picks the auth
 * file itself and only refuses once every credential it holds is cooling down, which makes the refusal a fact
 * about the provider in the first place.
 *
 * `kind` is read off what the provider SAID, not off the frame code the harness filed it under, because those
 * two disagree: Kimi answers a spent plan with `403 You've reached your usage limit for this billing cycle`,
 * which the CLI prints under "Failed to authenticate" and the stream codes as a refused credential. Sending
 * someone to reconnect a perfectly good account is the cost of believing the code over the sentence. */
export const ProviderRefusalSchema = z.object({
    // Epoch MS, matching AccountUsage.measuredAt — the two are read side by side.
    at: z.number(),
    /* Three ways a plan says no, kept apart because WHAT ANSWERS EACH is different and a screen that conflates
     * them tells the user to do the wrong thing. A spent allowance is answered by a later reading with room in
     * it; a refused credential by the account being read at all through it; and an entitlement refusal — an
     * organization that has turned Claude Code off for this seat — by NOTHING either of those can produce. Its
     * token authenticates and its usage endpoint answers with real pools the whole time it cannot run a turn,
     * so filing it as `auth` let the very next quota sweep dismiss it and leave a full green ring over an
     * account that refused everything asked of it. Only a turn that actually runs settles this one. */
    kind: z.enum(["limit", "auth", "entitlement"]),
    // The provider's own sentence, verbatim. It is the only part that says WHICH pool or WHICH credential.
    message: z.string(),
    // The account that was serving, when the daemon knows it (native turns only — see above).
    account: z.string().optional(),
});
export type ProviderRefusal = z.infer<typeof ProviderRefusalSchema>;

export const ProviderRefusalsSchema = z.object({ refusals: z.record(z.string(), ProviderRefusalSchema) });
export type ProviderRefusals = z.infer<typeof ProviderRefusalsSchema>;

// One connected subscription in the translator. `name` is CLIProxyAPI's auth-file name — the stable store key a
// disconnect addresses — and `label` the sign-in identity it reported (the account email, else the file name).
export const TranslatorAccountSchema = z.object({
    name: z.string(),
    label: z.string(),
    // The same headroom an OauthAccount carries, on the same field, for the same reason: the account rows are
    // one list to the reader. Optional because a provider whose quota this sandbox cannot read (Grok) —
    // or one that did not answer — must still render as the connected account it is, with a dot instead of a
    // ring.
    usage: AccountUsageSchema.optional(),
});
export type TranslatorAccount = z.infer<typeof TranslatorAccountSchema>;
// Which routed-provider subscriptions are connected in the translator, per provider — a LIST per provider, not
// a flag: CLIProxyAPI holds any number of auth files per provider side by side and balances requests across
// them, so connecting a second ChatGPT or Google account is more headroom, and each is disconnectable on its
// own. Drives the account rows in Sandbox ▸ Agent.
export const TranslatorAccountsSchema = z.object({
    codex: z.array(TranslatorAccountSchema),
    grok: z.array(TranslatorAccountSchema),
    kimi: z.array(TranslatorAccountSchema),
    gemini: z.array(TranslatorAccountSchema),
});
export type TranslatorAccounts = z.infer<typeof TranslatorAccountsSchema>;

// The side-channel body that un-parks a turn waiting on the user. Every interactive card — plan approval,
// clarifying questions, a per-tool permission prompt — parks on the SAME registry keyed by `requestId`, so
// one route resolves all three; the `kind` says which card answered and carries its payload.
export const AgentReplySchema = z.discriminatedUnion("kind", [
    // ExitPlanMode approval. Approving carries NO posture: an approved plan executes under bypassPermissions,
    // set on the SDK session by the gate that raised the card. The container is the isolation boundary, so a
    // plan the user has read and approved is exactly the point where per-tool prompts stop earning their
    // interruption — landing anywhere else means approving a plan to run `git log` and then being asked whether
    // `git log` may run. Rejection feedback loops back into the model as the denial reason.
    z.object({
        kind: z.literal("plan"),
        requestId: z.string().min(1),
        approve: z.boolean(),
        feedback: z.string().optional(),
    }),
    // AskUserQuestion picks: question text → chosen option label(s) (+ any free-text "Other"). `cancelled`
    // is the dismissal, which tells the model to proceed on sensible defaults rather than leaving it parked.
    z.object({
        kind: z.literal("question"),
        requestId: z.string().min(1),
        answers: z.record(z.string(), z.array(z.string())).optional(),
        cancelled: z.boolean().optional(),
    }),
    // A per-tool permission prompt. 'once' allows this call only; 'always' allows the whole TOOL for the rest
    // of the session (plus the SDK's own narrower suggestions), which is what the card's label promises;
    // 'deny' blocks it and feeds `feedback` back as the reason.
    z.object({
        kind: z.literal("permission"),
        requestId: z.string().min(1),
        decision: z.enum(["once", "always", "deny"]),
        feedback: z.string().optional(),
    }),
    // A browser help request (the agent parked mid-sign-in on something only a person can clear — a captcha, a
    // password it does not hold). `helped: true` is "done, hand back": the user took control of the agent's
    // browser, fixed the step, and the turn continues from the page as they left it. `helped: false` is "can't
    // help now" — the agent is told so and moves on rather than waiting forever. `note` rides back to the model
    // either way ("typed the password, don't touch the remember-me box").
    z.object({
        kind: z.literal("browser_help"),
        requestId: z.string().min(1),
        helped: z.boolean(),
        note: z.string().optional(),
    }),
    // A terminal help request — the same two answers as the browser's, for a command parked at a prompt only a
    // person can answer. `helped: true` is "typed it, carry on"; false is "can't right now". `note` rides back
    // either way, and on `helped` the daemon adds what the pane SAYS to the tool result: the user answering the
    // prompt is exactly the moment the agent cannot see, and it would otherwise have to ask them how it went.
    z.object({
        kind: z.literal("terminal_help"),
        requestId: z.string().min(1),
        helped: z.boolean(),
        note: z.string().optional(),
    }),
    // A premium service run's yes or no. The click is the ONLY way the spend can happen — the daemon holds the
    // agent's run request parked until this settles it (platform/service-offer.ts) — so `approve` carries no
    // qualifiers: one true releases exactly one run, and anything else charges nothing.
    z.object({
        kind: z.literal("service_offer"),
        requestId: z.string().min(1),
        approve: z.boolean(),
    }),
    // A missing-capability ask's yes or no. `connect: true` is "I'll set it up" — it opens the card's setup
    // and keeps the agent's request parked while the daemon watches for the connection to come live
    // (capabilities/capability-offer.ts); false tells the agent to continue without it. The click decides
    // only the WATCHING: nothing is connected by the reply itself — the setup is the owner's own flow.
    z.object({
        kind: z.literal("capability_offer"),
        requestId: z.string().min(1),
        connect: z.boolean(),
    }),
]);
export type AgentReply = z.infer<typeof AgentReplySchema>;
// Steering: a user message delivered INTO the running turn (injected between tool calls, Claude Code style),
// keyed by the conversation whose turn is in flight. NOT_FOUND when no steerable turn is running — the client
// then holds the message in its queue and sends it as the next turn instead. Carries everything a turn's own
// prompt can carry (files, the editor-context chip), because "add more while it works" is worth nothing if it
// only takes bare text: the daemon folds the same notes into the injected message that a fresh turn gets.
export const SteerSchema = z
    .object({
        conversationId: z.string().min(1),
        text: z.string().max(20_000),
        attachments: z.array(z.string().min(1)).max(20).optional(),
        editorContext: EditorContextSchema.optional(),
    })
    // An attachment-only steer (a screenshot dropped in mid-turn) is legal; an entirely empty one is not.
    .refine((steer) => steer.text.trim().length > 0 || (steer.attachments?.length ?? 0) > 0, {
        message: "text or attachments required",
    });
// True cancel for the conversation's in-flight turn — aborts the agent daemon-side, unlike closing the
// /agent fetch (which sends no cancel frame).
export const StopTurnSchema = z.object({ conversationId: z.string().min(1) });

// ---- claude rate-limit gate ----
// The GATE signal: whether the provider is letting turns through right now, and — when it is refusing — which
// window is binding and when it lifts. This is the SDK's rate_limit_event, mapped one-to-one, and it is only
// ever about the CURRENT moment. It is deliberately NOT the thing the headroom displays read: the event names a
// single window (whichever the CLI considered binding), which is how "weekly 1%" ended up standing in for an
// account that was really at 98% on another weekly pool.
export const RateLimitInfoSchema = z.object({
    status: z.enum(["allowed", "allowed_warning", "rejected"]),
    resetsAt: z.number().optional(), // epoch seconds
    rateLimitType: z.string().optional(), // 'five_hour' | 'seven_day' | 'seven_day_opus' | ...
    utilization: z.number().optional(), // 0-100, how much of the window is used
});
export type RateLimitInfo = z.infer<typeof RateLimitInfoSchema>;

// ---- fast mode ----
// What speed a turn is actually being served at. `cooldown` is its own state rather than a flavour of `off`
// because it is the only one that lifts by itself: fast mode draws on a rate-limit pool separate from the
// model's, and a turn that exhausts it drops to standard speed and stays there until the pool reopens. The
// distinction is what lets the client say "not right now" instead of "not available", which are different
// answers to "why am I not getting what I asked for". Mirrors the harness's own vocabulary (SDK: FastModeState).
export const FastModeStateSchema = z.enum(["off", "cooldown", "on"]);
export type FastModeState = z.infer<typeof FastModeStateSchema>;

// ---- provider oauth ----
// Claude uses the PKCE authorize-URL + paste-back handshake (start → exchange). Codex uses OpenAI's device-code
// flow (start → poll): the browser signs in at verificationUri and enters userCode; the daemon polls until done.
// A sandbox can hold several accounts per provider side by side: `id` is the daemon-minted store key, `label`
// the user's display name (auto-filled from the sign-in identity where the token carries one). Tokens never
// ride this shape — connection status is existence in the list.

export const OauthAccountSchema = z.object({
    id: z.string(),
    label: z.string(),
    // WHO this account signs in as, in the provider's own words — Anthropic returns the email and the
    // organization alongside the tokens, so a connection can name itself instead of arriving as a second row
    // called "Claude". Kept BESIDE `label` rather than folded into it: the label is the user's to rename, and a
    // renamed account still has to be able to say whose it is. Absent when the provider tells us nothing (a
    // pasted API key carries no identity) — which is exactly when renaming is the only answer, so every
    // sandbox-owned account can be renamed.
    email: z.string().optional(),
    organization: z.string().optional(),
    scope: z.string().optional(),
    connectedAt: z.number(), // epoch ms
    // Set only when the account's stored credential can no longer be refreshed (revoked/expired refresh token)
    // — the user must reconnect. Absent ⇒ healthy or not-yet-probed; `detail` carries the reason for the UI.
    // Provider-agnostic; only Codex probes it today (Claude refreshes on-demand, Grok's tokens are OpenCode's).
    needsReauth: z.boolean().optional(),
    detail: z.string().optional(),
    // The account's last known subscription-usage snapshot, so the picker can show what's left on each account
    // before the user commits a turn to one. Absent until a reading exists for it — an unmeasured account reads
    // as unknown, never 0%. Claude is the provider that fills it here, because its stream reports the windows;
    // the routed subscriptions carry the identical field on TranslatorAccount, filled by a pulled reading.
    usage: AccountUsageSchema.optional(),
});
export type OauthAccount = z.infer<typeof OauthAccountSchema>;
export const OauthAccountListSchema = z.object({ accounts: z.array(OauthAccountSchema) });
export type OauthAccountList = z.infer<typeof OauthAccountListSchema>;
/* RE-MEASURE THIS PROVIDER'S PLAN LIMITS BEFORE ANSWERING, rather than serving whatever reading is current
 * enough by the daemon's own bound. Every ordinary read of the list wants that bound — it is what keeps a page
 * load off the upstream quota endpoint — but a person who has just changed something about the account
 * (a seat downgraded, a plan swapped, another device's spend) is asking precisely whether the reading they can
 * see is still true, and an answer from the last minute cannot tell them. Read off the query string, so the
 * caller says it as `?force=1`. */
export const AccountListQuerySchema = z.object({ force: z.stringbool().default(false) });
// Address one account of a provider (disconnect, and the turn's `account`).
export const AccountIdSchema = z.object({ id: z.string().min(1) });
// Rename one account of a provider whose credential the sandbox owns (Claude, Kimi). Blank ⇒ the daemon falls
// back to the derived name, so clearing a label restores the sign-in identity rather than leaving a nameless
// row. Grok is absent for the same reason it holds one account: OpenCode owns that credential, not this store.
export const AccountRenameSchema = z.object({ id: z.string().min(1), label: z.string().max(80) });
// The completing calls carry the user-chosen label (blank ⇒ the daemon derives one from the sign-in identity
// or a provider default).
export const OauthExchangeSchema = z.object({
    code: z.string().min(1),
    verifier: z.string().min(1),
    state: z.string().min(1),
    label: z.string().optional(),
});
export const AuthorizeChallengeSchema = z.object({ authorizeUrl: z.string(), verifier: z.string(), state: z.string() });
// xAI Grok (via OpenCode) uses subscription OAuth via the headless device-code method. `start` returns the
// `url` the user opens (xAI's verification_uri_complete, which pre-fills the code) and `code` — the same
// one-time code, surfaced so the card matches x.ai exactly. There is no paste-back: OpenCode polls to
// completion and the UI polls `/grok/accounts`.
// ponytail: OpenCode holds one xAI auth per data dir, so Grok stays single-account — the list is 0 or 1. Per
// account would need an OpenCode server per data dir; add when there's demand.
// A device-code login start: the verification URL + the one-time code the user enters there. The native Grok
// flow (via OpenCode) — see TranslatorStartSchema for the routed-provider connect, which adds `state`.
export const DeviceStartSchema = z.object({ url: z.string(), code: z.string() });
// A routed-provider subscription login start (codex/grok/kimi/gemini via CLIProxyAPI). Device flows poll to
// completion after the user approves upstream; redirect flows need the browser's landing URL pasted back. The
// explicit flow discriminator matters even when a provider's verification URL already embeds its optional code.
export const TranslatorStartSchema = z.object({
    url: z.string(),
    code: z.string(),
    state: z.string(),
    flow: z.enum(["device", "redirect"]),
});
// The paste-back half of a redirect login: the URL the provider sent the browser to, carrying the grant as
// ?code=&state=. `state` ties it to the handshake that issued it — the translator rejects a mismatch.
export const TranslatorCompleteSchema = z.object({
    provider: KeyedProviderSchema,
    redirectUrl: z.string().min(1),
    state: z.string().min(1),
});
// A provider's model catalog, resolved daemon-side from live discovery with a persisted last-known-good list and
// a seed floor (Grok via opencode.ts xaiModels, Codex via codex-models.ts, Claude via the Agent SDK's
// supportedModels) — never empty, so the picker is never blank. `label` is the provider's display name; `default`
// is the model a fresh chat on that provider seeds (always present). Served by the one catalog route every
// provider shares. `efforts` is the reasoning-effort tiers the model accepts (Claude reports them per model);
// empty ⇒ the client's default tiers.
//
// EVERY field here is provider-reported — nothing about a model is curated in this repo, so a new release or a
// renamed family flows to the UI with no code change. Providers differ in how much they publish: the Claude
// Agent SDK reports a display name, a capability description, effort tiers, and capability flags, while the
// Some OpenAI-compatible /v1/models endpoints report ids only — those rows render label-only, and that absence
// is the honest answer rather than something to paper over with a hand-written table.
//
// ORDER IS MEANINGFUL: `models` arrives in the provider's own preference order, which is what the picker sorts
// by, and `default` is the provider's own default. Neither is re-ranked locally.
export const ModelBadgeSchema = z.enum(["reasoning", "fast"]);
export type ModelBadge = z.infer<typeof ModelBadgeSchema>;
export const ModelSchema = z.object({
    id: z.string(),
    label: z.string(),
    efforts: z.array(z.string()).optional(),
    description: z.string().optional(),
    badges: z.array(ModelBadgeSchema).optional(),
});
export type Model = z.infer<typeof ModelSchema>;
export const ModelsSchema = z.object({ models: z.array(ModelSchema), default: z.string() });

// ---- sessions ----

export const SessionIdParamSchema = z.object({ id: z.string() });
export const SessionSummarySchema = z.object({
    id: z.string(),
    title: z.string(),
    updatedAt: z.number(),
    // Why a searched session matched: the line the query hit, windowed around it, and who said it. Absent on an
    // unfiltered list, and on a match the title already shows — a snippet repeating the row's own heading is
    // noise, not evidence. See AgentMatchSchema for the same field on the fleet's side.
    snippet: MatchSnippetSchema.optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export const SessionsListSchema = z.object({ sessions: z.array(SessionSummarySchema) });

// ---- settings: per-sandbox agent settings (.intentic/settings.json) ----

// Which prompt the agent is, before this turn composes anything on top. Two built-in bases and an escape
// hatch: Intentic's own (the default), Claude Code's preset, or the owner's text. Declared out here rather
// than inline in the settings object because both sides of the wire branch on it — the daemon to build the
// turn, the browser to decide which base it can show you.
export const SystemPromptModeSchema = z.enum(["intentic", "claude", "custom"]);
export type SystemPromptMode = z.infer<typeof SystemPromptModeSchema>;
// The two bases a user can READ and fork — "custom" is excluded because there is nothing to fetch: it is
// whatever they have already typed into the settings field.
export const BuiltinPromptSchema = z.object({ base: z.enum(["intentic", "claude"]) });

/* ---- rules: "at this moment, if this is true, do this" ------------------------------------------------------
 *
 * The one table behind every standing instruction the owner gives the sandbox about its own work. It replaces
 * three settings that were the same idea built three ways — ask for proof before a turn ends, run a command
 * before a push, hold or release finished work — and the point of replacing them is that a FOURTH is now a row
 * in this table rather than a release.
 *
 * The moments are named to sit in one family with WorkspaceEventKind (`turn.settled`, `agent.landed`), because
 * chores already wake on those and folding them into this table later must not mean renaming what users wrote.
 */

// WHERE a rule can stand. Three, and each is a place the daemon already stopped to make a decision — this
// names those decisions rather than inventing new ones.
export const RuleMomentSchema = z.enum([
    // The assistant is about to stop. A rule here can send it back to work, which is the only moment that can.
    "turn.ending",
    // Code is about to leave the machine. A rule here gates the push on its own exit code.
    "push.starting",
    // An agent's turn is over and its delta is sitting on its branch. A rule here decides whether it lands.
    "agent.finished",
]);
export type RuleMoment = z.infer<typeof RuleMomentSchema>;

/* WHAT A RULE DOES. Four shapes, and the split is load-bearing rather than tidy: the three settings this table
 * replaces need three DIFFERENT ones, which is the evidence that a single "run this command" table would have
 * mangled at least two of them.
 *
 *   command — run a shell command; its exit code is the verdict. What the pre-push check always was.
 *   instruct — say something to the assistant, so it acts before it finishes.
 *   verdict — allow or hold the thing that is about to happen. The vocabulary the permission rules already
 *             speak, and the honest shape of "land finished work automatically": nothing extra RUNS at that
 *             moment, a pass that always runs is told which way to go.
 *   builtin — invoke a named daemon behaviour. The escape hatch that keeps this table from having to express
 *             machinery it has no business expressing: the proof ledger behind "verify before finishing"
 *             tracks what a turn edited against what it ran, which is not a shell command and never will be.
 */
export const RuleBuiltinSchema = z.enum(["verify-edits"]);
export type RuleBuiltin = z.infer<typeof RuleBuiltinSchema>;

export const RuleActionSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("command"),
        command: z.string().max(500),
        // Ceiling on one run, after which the child's whole process group is killed and the run is `failed`.
        // Never a pass: a command that did not finish has said nothing, and a green light nobody earned is the
        // one outcome a check exists to prevent.
        timeoutMs: z.number().min(60_000).max(3_600_000).default(900_000),
    }),
    z.object({ kind: z.literal("instruct"), text: z.string().min(1).max(4000) }),
    z.object({ kind: z.literal("verdict"), verdict: z.enum(["allow", "hold"]) }),
    z.object({ kind: z.literal("builtin"), name: RuleBuiltinSchema }),
]);
export type RuleAction = z.infer<typeof RuleActionSchema>;

// WHEN a rule narrows. Three keys, chosen because they cover the two things people reach for on day one —
// "only this repo" and "don't bother for a docs-only change" — without opening a query language. Every key
// absent ⇒ the rule always matches at its moment, which is what the three replaced settings each did.
export const RuleConditionSchema = z.object({
    // A workspace repo id, or "root". Absent ⇒ any.
    repo: z.string().min(1).optional(),
    // Globs the change has to touch for the rule to fire. Absent/empty ⇒ any.
    paths: z.array(z.string().min(1)).max(20).optional(),
    // How the turn ended. Absent/empty ⇒ any.
    outcome: z.array(z.enum(["clean", "error", "conflict"])).optional(),
});
export type RuleCondition = z.infer<typeof RuleConditionSchema>;

/* ONE RULE. `id` is stable and owner-visible: it is what the activity feed names when the rule fires and what
 * the last-fired store is keyed by, so it survives a relabel.
 *
 * WHICH ACTIONS FIT WHICH MOMENT is checked here rather than left to the consumer, because the alternative is
 * a rule that saves cleanly and then quietly does nothing — the failure mode a settings screen can least
 * afford. A verdict at `turn.ending` has nothing to decide; a command at `agent.finished` has no defined place
 * in the landing pass and would be a promise this stage cannot keep. */
const MOMENT_ACTIONS: Record<RuleMoment, readonly RuleAction["kind"][]> = {
    "turn.ending": ["builtin", "instruct", "command"],
    "push.starting": ["command"],
    "agent.finished": ["verdict"],
};

export const RuleSchema = z
    .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        label: z.string().min(1).max(80),
        moment: RuleMomentSchema,
        when: RuleConditionSchema.optional(),
        action: RuleActionSchema,
        enabled: z.boolean().default(true),
    })
    .refine((rule) => MOMENT_ACTIONS[rule.moment].includes(rule.action.kind), {
        message: "that action cannot stand at that moment",
        path: ["action"],
    });
export type Rule = z.infer<typeof RuleSchema>;

// When a rule last did something, keyed by rule id — read by the settings list so a rule nobody has seen fire
// in three weeks is visible as such. Kept out of the settings object on purpose: a firing is not an edit, and
// writing the owner's config on every push would make every run a settings save.
export const RuleFiringsSchema = z.record(z.string(), z.number());
export type RuleFirings = z.infer<typeof RuleFiringsSchema>;

/* WHERE A SKILL CAME FROM — the fact that decides everything else about its row.
 *
 * A skill is inert text the agent reads, and this sandbox grows them from seven directions at once: the daemon
 * writes one per baked tool and one per core feature that has a cheatsheet, connecting a tool or a machine
 * writes one for that connection, the owner writes their own, a persona carries its own in its kit, an
 * installed extension ships some inside its checkout, and a plugin capability clones a repo full of them.
 * Nothing used to LIST the result, which is the whole gap this vocabulary closes — "what does my agent know
 * right now" had no answer on screen, and a skill spends the agent's attention whether or not anyone remembers
 * adding it.
 *
 *   builtin      this image ships it — a baked tool's cheatsheet, or a core feature's
 *   own          the owner wrote it (.intentic/skills/), and only these are editable here
 *   capability   something connected brought it: a CLI tool, a machine, a browser account, a VPN
 *   extension    an installed extension ships it inside its checkout
 *   plugin       a plugin capability cloned a repo that holds it
 *   persona      one card's own kit carries it, and only turns wearing that card ever see it
 *   dropped      it is simply sitting in the loaded folder — put there by hand, or by the agent itself
 *
 * `persona` is the one origin that is not on for everybody, which is why it needs its own word rather than
 * being filed under `own`: it says "the agent knows this when it is wearing that card", and a list that showed
 * it as an ordinary skill of the owner's would be claiming it applies to every chat.
 *
 * `dropped` is the honest bottom of the list rather than a category anything creates on purpose: the promise
 * this surface makes is that it shows EVERYTHING the agent knows, so a file nothing else claims has to list as
 * the loose file it is instead of being quietly left out.
 *
 * Deliberately NOT a capability kind. A capability holds a credential, can be broken right now, and wants a
 * status light; a skill either exists or it does not. See _sandbox/sandbox/src/settings/skill-inventory.ts. */
export const SkillOriginSchema = z.enum(["builtin", "own", "capability", "extension", "plugin", "persona", "dropped"]);
export type SkillOrigin = z.infer<typeof SkillOriginSchema>;

/* A skill's own name — the directory it lives in and the word the agent invokes it by. Same slug shape the SDK's
 * loader accepts, checked here so a bad name is a refused save rather than a skill that silently never loads. */
export const SkillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a skill name is lowercase letters, digits and dashes");

export const SkillSummarySchema = z.object({
    /* The handle the read/remove routes take. An `own` or `builtin` skill IS its name (they share one directory,
     * so names there are already unique); one that belongs to something else is `<origin>:<owner>:<name>`,
     * because two plugins may each ship a `review` and the list has to be able to tell them apart. */
    id: z.string(),
    name: z.string(),
    // The frontmatter line the agent routes on — empty when a shipped skill declares none, which is worth
    // showing as the blank it is rather than papering over: a skill with no description is rarely picked.
    description: z.string(),
    origin: SkillOriginSchema,
    // Who ships it, as the row names it — an extension's title, a plugin capability's id, a setting's name.
    owner: z.string().optional(),
    enabled: z.boolean(),
    /* Whether THIS surface can switch it. True only for the skills the settings `skills` list governs (baked
     * tools and the owner's own): everything else is on because its extension, its plugin or another setting is,
     * and a switch here that silently did nothing would be worse than no switch at all — the row names its
     * owner instead. */
    switchable: z.boolean(),
    // Whether the owner may rewrite the text here. Their own skills only — a shipped one is its author's, and
    // editing it in place would be undone the next time the thing that ships it reconciles.
    editable: z.boolean(),
    /* Whether it can be deleted from this surface. Wider than `editable` by exactly one case: a skill someone
     * dropped into the loaded folder is not the owner's to edit (its home is that folder, not their store) but is
     * absolutely theirs to clear out, and with no switch and no owning extension there would otherwise be no way
     * to get rid of it short of the file tree. */
    removable: z.boolean(),
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

export const SkillsListSchema = z.array(SkillSummarySchema);

// One skill's full text, for reading it on screen. Its own route rather than a field on the summary: bodies run
// to thousands of words and a list of twenty would cost a hundred kilobytes to draw a group of one-line rows.
export const SkillBodySchema = z.object({
    id: z.string(),
    name: z.string(),
    // Everything after the frontmatter — the instructions themselves, as written.
    body: z.string(),
});
export type SkillBody = z.infer<typeof SkillBodySchema>;

export const SkillIdSchema = z.object({ id: z.string().min(1) });

/* A skill the owner writes. Three fields because a skill IS three things — what it is called, when to reach for
 * it, and what to do — and the daemon assembles the frontmatter from the first two so a saved skill can never
 * be one the loader skips over. `description` is required for the reason above: it is the only part the model
 * reads before deciding whether to open the rest. */
export const SkillDraftSchema = z.object({
    name: SkillNameSchema,
    description: z.string().min(1).max(1024),
    body: z.string().min(1),
});
export type SkillDraft = z.infer<typeof SkillDraftSchema>;

export const SkillRemoveSchema = z.object({ name: SkillNameSchema });

// Small user-owned config the /settings routes edit and streamAgent reads — all opt-in booleans the owner
// toggles in the UI (so each can be A/B benchmarked):
//   stableSystemPrompt — keeps the system prompt byte-stable across turns (the delegation note rides the user
//                        message instead of the preset `append`) so the provider prompt cache survives.
//   skills            — names of baked-tool skills to load into .agents/skills so the agent reaches for them
//                        (e.g. "lsp" — TS rename + diagnostics over the language service); a name absent ⇒ its
//                        skill file isn't written, so the agent doesn't reach for it. Data-driven: a new baked
//                        tool is one daemon-side registry entry, not a new settings field.
//   hashlineEdits     — swaps the native Read/Edit/Write for hash-anchored edits on the Claude path (stale-file
//                        guard + fewer output tokens); off ⇒ the native file tools.
//   terseOutput       — appends a concise-response steer to the end of the system prompt (a stable suffix, so it
//                        composes with stableSystemPrompt) to cut the model's OWN output tokens.
//   systemPromptMode  — which base the agent's prompt is: "intentic" (default), "claude", or "custom".
//   systemPrompt      — the owner's own prompt text, used only by "custom" mode, where it is the ENTIRE system
//                        prompt and nothing the daemon would otherwise append rides with it — see its own note.
//   iqSearch          — loads the image-baked iq Claude Code plugin (skill + SessionStart nudge) so the agent
//                        prefers the iq CLI over grep/find/Glob; off ⇒ plugin not loaded, native search tools
//                        only. Opt-in (default off); the browser Search box uses iq regardless.
//   iqSearchHoldout   — conversation-level measurement control for iqSearch (UsageTurn.iqSearchArm). The arm
//                        stays fixed because teaching already loaded into a session cannot be removed next turn.
//   iqContext         — retrieves for the user's message BEFORE the turn starts and prepends the ranked answer
//                        to it, so the model opens with the anchors instead of paying a search round-trip to
//                        find them. Independent of iqSearch: that one teaches the agent to search, this one
//                        answers ahead of it.
//   iqContextHoldout  — measurement control for iqContext, same shape as terseHoldout (UsageTurn.iqContext).
//   outputCleaners    — the Bash output-cleaner spec (agent-output-filter): "off" = filter disabled (default),
//                        "" = all cleaners on, else an iq-style allow-list / default-minus
//                        spec ("git,pnpm" = only those; "-cap" = all except). Threaded to the filter via env.
//   outputHoldout     — measurement control: a fraction [0,1] of Bash commands whose output bypasses cleaning
//                        (recorded raw as `heldOut`), so the savings report compares a real cleaned-vs-raw
//                        population instead of an estimate. 0 = no holdout (default).
//   rules             — the standing "at this moment, if this is true, do this" table (RuleSchema): what proves
//                        a turn's work, what runs before a push, whether finished work lands by itself. Empty
//                        (the default) means none of those happen, which is the shape a fresh sandbox has.
//   automationFailureLimit — consecutive `error` runs after which an automation is disabled rather than left
//                        firing forever; 0 (default) ⇒ never.
//   subagentsAtOnce / subagentsPerTurn / subagentDepth — the harness's own ceilings on delegation, raised or
//                        lowered from one place; each defaults to what the CLI enforces on its own.
// The booleans default off, outputCleaners defaults "off" (cleaning off) and outputHoldout 0 — a fresh sandbox
// starts with cleaning and iq off until the owner enables them. `skills` is the exception and defaults to the
// baked tools worth having on: a skill file is the ONLY thing that tells the agent a baked binary exists, and
// with the list empty `lsp` went used once in 866 sessions — not declined, never learned about.
//
// Every field carries that default IN THE SCHEMA, so a settings object written before a field existed still
// parses — the absent key reads as its default. That is not a compatibility layer, it is the seam this shape
// spans: the browser ships with the platform while the daemon ships inside the user's sandbox image, so a web
// build is routinely NEWER than the daemon answering it. Requiring the key instead makes the whole settings
// surface fail to parse the moment a toggle is added — which reaches the user as a page of switches that are
// silently dead, not as an error. It also means an older on-disk manifest keeps the owner's other picks rather
// than being discarded whole.

export const SandboxSettingsSchema = z.object({
    stableSystemPrompt: z.boolean().default(false),
    skills: z.array(z.string()).default(["lsp"]),
    hashlineEdits: z.boolean().default(false),
    terseOutput: z.boolean().default(false),
    /* Measurement control for the terse steer, at TURN level — the same trick `outputHoldout` plays over
     * commands, one layer up. A fraction [0,1] of otherwise-eligible turns run WITHOUT the steer and record
     * which arm they ran on (UsageTurn.terse), so the savings report can compare two real populations.
     *
     * It has to be an experiment: unlike a cleaned command, which yields its own raw baseline in the same
     * event, a turn cannot be re-run to see what it would have said unsteered. 0 ⇒ no measurement (every
     * eligible turn is steered), which is the default because the control costs the very tokens it measures. */
    terseHoldout: z.number().min(0).max(1).default(0),
    /* WHICH SYSTEM PROMPT THE AGENT RUNS ON — the base, before anything this turn composes.
     *
     *   intentic — Intentic's own prompt, tuned for this harness (intentic-prompt.ts). The default.
     *   claude   — Claude Code's preset, as shipped in the CLI this sandbox runs. Not a copy stored here, so
     *              picking it tracks whatever the installed CLI's prompt is rather than freezing at a snapshot.
     *   custom   — `systemPrompt` below, and nothing else at all.
     *
     * The first two are peers: both get the harness's own guidance appended (the AskUserQuestion/plan blocks
     * the chat's cards need, the checklist guidance behind the todo panel, the browser-tool guidance), plus the
     * delegation note and the terse steer. `custom` is the one that does not, by the owner's explicit choice —
     * see the field below. */
    systemPromptMode: SystemPromptModeSchema.default("intentic"),
    /* The owner's own prompt, used only when `systemPromptMode` is "custom". Then it is the ENTIRE system
     * prompt: both built-in bases are gone and so is everything the daemon would otherwise append — the widget
     * guidance the chat's cards are driven by, and the terse-output steer (whose toggle goes inert). That is
     * the price of total control, and the UI states it at the moment of the edit rather than letting the
     * widgets go quietly dark. Only the cross-provider delegation note survives, because it has a home outside
     * the system prompt already (the user-message preamble stableSystemPrompt puts it in).
     *
     * Cap is roomy — the bases it stands in for are ~6.8k characters — but finite, because every turn pays it. */
    systemPrompt: z.string().max(20000).default(""),
    iqSearch: z.boolean().default(false),
    /* Measurement control for the iq search teaching, at CONVERSATION level. A fraction [0,1] of conversations
     * run without the plugin/instruction and stamp that stable arm on every turn. Per-turn randomization is not
     * a valid control here: once the teaching enters a provider session, withholding it from the next request
     * does not make the model forget it. 0 ⇒ no measurement and every conversation receives the teaching. */
    iqSearchHoldout: z.number().min(0).max(1).default(0),
    /* RETRIEVE BEFORE THE TURN, don't wait to be asked. The daemon runs the user's message through the resident
     * iq engine and prepends the ranked answer to it, so a turn that would have opened with two or three search
     * calls opens with the anchors already in hand. Independent of `iqSearch`, which only teaches the agent to
     * reach for the CLI once it decides to search — this one answers ahead of that decision, and the two
     * compose: the injected capsule names the anchors, the CLI is there for what it missed.
     *
     * It rides the USER message (turn-context.ts), never the system prompt, for the same reason the setup
     * notice does: it changes every turn, and the system prefix is kept byte-stable for the prompt cache.
     * Off by default — it spends input tokens on every eligible turn, and whether that trade pays is exactly
     * what the holdout below is for. */
    iqContext: z.boolean().default(false),
    // Measurement control for the pre-injection, identical in shape to `terseHoldout`: a fraction [0,1] of
    // otherwise-eligible turns run WITHOUT the retrieved context and stamp their arm onto the ledger
    // (UsageTurn.iqContext), so the report compares two real populations of turns instead of asserting a saving.
    iqContextHoldout: z.number().min(0).max(1).default(0),
    outputCleaners: z.string().default("off"),
    outputHoldout: z.number().min(0).max(1).default(0),
    /* The models behind the small automatic jobs that are not a conversation — today the commit message
     * written when an agent's work lands. An ORDERED list of `${provider}:${modelId}`, tried top to bottom, or
     * EMPTY for Auto.
     *
     * A LIST rather than a pick, because the single interesting failure of this feature is a model that is
     * connected and simply will not answer today: the account's allowance went on the chat, and one spent
     * provider then takes the job down for hours while the others sit idle. Written in order, the daemon steps
     * over the spent one and the message still gets written (agent/quick-model.ts walks it).
     *
     * Empty is the default and still the interesting case: Auto is resolved from whatever accounts are
     * connected at the moment it is read (resolveQuickModels), so it can never name a provider this sandbox has
     * no credential for, it improves by itself when one is added, and it is a ladder too — the cheapest rung of
     * every connected provider, best first. Storing resolved ids here instead would go stale exactly like a
     * pinned model does. */
    quickModel: z.array(z.string()).max(10).default([]),
    /* WHICH REPOS KEEP A CHANGELOG — the repos whose commits carry a `Release-Note:` trailer, written by the
     * same quick model that drafts the subject (git/commit-message.ts) and harvested at release time.
     *
     * A LIST OF REPOS RATHER THAN A FLAG, and EMPTY BY DEFAULT, because this daemon runs on the user's repos
     * rather than on ours. The commit drafter's one standing rule is that house style is INFERRED, never
     * prescribed — it reads the last handful of subjects and matches them, so a repo that spells its commits
     * some other way is never argued with. A note trailer is the one thing that cannot be inferred that way: a
     * repo which has never written one gives the model nothing to copy, so asking for it has to be somebody's
     * explicit decision. Empty means every repo behaves exactly as it did before this existed.
     *
     * Named by repo id ("root", or the root-relative dir discoverRepos reports), because a workspace holds
     * several repos and a commit can span them: the trailer is written when the commit touches a repo that
     * asked for one, and a repo that did not ask never gets a line it has to explain to its reviewers. */
    changelogRepos: z.array(z.string()).max(50).default([]),
    /* WHAT AN AGENT RUN OPENS ON — the tier above quickModel, and the answer for every turn a SURFACE starts
     * rather than a person at a composer: Fix with agent on a pipeline or a deployment, a Maintenance chore, a
     * Documentation or Acceptance run, the fix a failed pre-push check proposes. An ORDERED list of
     * `${provider}:${model}` (quickModelKey) plus the reasoning effort beside it; EMPTY ⇒ whatever the chat
     * composer would have started with, which is the honest floor because it is the model the user already
     * chose to work with.
     *
     * A LIST, for the reason quickModel is one: the account at the head runs out, and every surface-started run
     * in the sandbox then fails on a credential the user cannot see from the row they pressed. Written in order,
     * the next one down catches it (turn-resume.ts walks it).
     *
     * PINNED, NOT DERIVED — the deliberate difference from quickModel one line above, and the reason these are
     * two settings rather than one. A quick helper exists to stay OFF the frontier tier, so cheapest-connected
     * is the right automatic answer and an empty list resolves to Auto. An agent run has to read a failing
     * suite, or a container log, or a story, and repair the thing: the tier is a judgement about how much the
     * job is worth, nothing here can make it, and a wrong guess is billed in whole sessions rather than in
     * tokens. So an empty list here resolves to NOTHING and the composer's own pick answers instead.
     *
     * The daemon applies this to any turn flagged `unattended` that names no model of its own — one rule, so a
     * surface added tomorrow inherits it by saying what it is instead of re-deriving where models come from. A
     * surface MAY still name one (the shared run button's caret, Acceptance's per-run pick), and that wins. */
    agentRunModels: z.array(z.string()).max(10).default([]),
    agentRunEffort: z.string().default(""),
    // How long a finished agent stays on the board before it is archived automatically (days; 0 ⇒ never).
    // Unlike every other flag here this one defaults ON, because the lane it governs is the board's only
    // terminal state: without a sweep the Finished lane grows for the life of the sandbox, and each card it
    // holds is a live worktree checkout, not just a row.
    agentRetentionDays: z.number().min(0).max(365).default(3),
    /* THE SANDBOX-WIDE DEFAULT for "when a turn dies because the MODEL PROVIDER was failing (500/502/503, a
     * 529 at capacity, a dropped socket), re-run it on an escalating backoff until it goes through or the
     * attempts are spent".
     *
     * A DEFAULT, not the whole answer: any one conversation may override it (AgentSummarySchema
     * .resumeAfterOutage), and the chat's own offer at the moment of failure writes THAT rather than this.
     * This toggle is the standing policy for every agent that has not said otherwise, which is why it lives in
     * settings and is not reachable by a single press from inside one chat — flipping how the whole board
     * behaves should be a thing somebody went to do.
     *
     * OFF by default, on the same reasoning that keeps a spent usage limit out of this pair entirely: a resume
     * re-runs a turn the user sent once, on their own allowance, and only they can say whether the turn was
     * worth paying for twice. Starting off costs nothing, because the failed turn is remembered whatever the
     * toggle says (recordOutageFailure) — the failure frame reports an "available" resume and the chat's offer
     * arms that very turn the moment it is armed for that conversation. Worth turning ON for a sandbox whose
     * turns mostly have nobody in the room (automation wakes, Discord, webhooks), which is the case no browser
     * could rescue and the case a per-conversation press cannot reach. */
    resumeAfterOutage: z.boolean().default(false),
    /* When the daemon dies under a running turn, re-run that turn once it is back (agent/turn-journal.ts records
     * every in-flight turn; the boot pass in agent/turn-resume.ts re-runs what survived). OFF by default, like
     * the outage resume above and for the same reason: a boot that re-runs turns spends the user's allowance on
     * work they are not watching, and edits the workspace while they are still waiting for the sandbox to come
     * back. Worth turning on for the case it was built for — the container is recreated on every update, every
     * environment approval and every dev-sandbox.sh swap, so approving the Dockerfile change an agent asked for
     * otherwise costs the run that asked for it.
     *
     * OFF still records the interruption: the fleet card reads `interrupted` (see AgentStatusSchema) and an
     * automation's row shows an `interrupted` run — nothing is re-run, but nothing is silently lost either. */
    autoResumeOnRestart: z.boolean().default(false),
    /* THE RULE TABLE — every standing instruction the owner gives the sandbox about its own work: ask for
     * proof before a turn ends, run a command before a push, hold or release finished work, and whatever they
     * add next. See RuleSchema for the shape and for why the four action kinds are four.
     *
     * EMPTY IS THE DEFAULT, and it is exactly the behaviour a fresh sandbox had when these were three separate
     * flags: no proof is asked for, no command runs at a push, and finished work waits on its branch. That is
     * not a coincidence to preserve by hand — each of those defaults is what "no rule matched" means at its
     * moment, so the empty table IS the old default rather than a reconstruction of it.
     *
     * Rules live here, in the owner's own settings, rather than in the workspace: a rule can hold work back and
     * gate a push, so the first version answers to the person whose sandbox it is and to nobody else. Repo-
     * committed and extension-contributed rules are worth having and are deliberately not here yet — they need
     * the question of what a rule from somewhere else may WIDEN answered first. */
    rules: z.array(RuleSchema).max(50).default([]),
    /* STOP AN AUTOMATION THAT ONLY EVER FAILS. After this many consecutive `error` runs the scheduler disables
     * it and says so on the row, instead of firing a job that has proven it cannot succeed every minute until
     * someone notices. 0 ⇒ never, which is the default.
     *
     * Off by default because quarantining edits the USER'S OWN configuration, and the failure it reacts to is
     * not always the automation's fault: an hourly poll against an API having a bad afternoon is broken for
     * three fires and fine on the fourth, and a job disabled at 3 a.m. is one nobody re-enables until they
     * notice it stopped. So the mechanism exists for the case it is unambiguously right for — a misconfigured
     * job burning a turn's worth of tokens on every tick — and the owner is the one who decides their
     * automations are the kind that should be stopped rather than retried.
     *
     * Only `error` counts. A `skipped` run is a guard doing its job, and an `interrupted` one means the daemon
     * died mid-fire, which says nothing about the automation — counting either would quarantine healthy jobs. */
    automationFailureLimit: z.number().min(0).max(20).default(0),
    /* WHO MAY START A SESSION WITHOUT YOU — the admission floor, per wake source (see AdmissionPolicySchema).
     * Defaults all-allow, so a fresh sandbox behaves exactly as before the floor existed and the per-automation
     * `requireApproval` stays the way most owners meet holds. */
    admission: AdmissionPolicySchema.prefault({}),
    /* THE SNIFFER'S RULEBOOK — verdicts for in-turn actions the outbound gate classifies, keyed by
     * `<provider>.<type>` ("discord.message.send") with `<provider>.*` as the per-provider wildcard; exact key
     * wins. An action with no rule is allowed — the empty default wires no hook at all, so an unconfigured
     * workspace pays nothing. "hold" cannot park a running turn (nobody may be there to answer); it refuses the
     * live call and points the agent at the drafts outbox, which IS the held form of a send. */
    actionRules: z.record(z.string(), AdmissionRuleSchema).default({}),
    /* THE COMMAND GATE'S RULEBOOK — a verdict per CommandClass, for shell commands the agent runs itself. This
     * is the layer that still applies once a session is already running: the admission floor above decides who
     * may wake the agent, and after that every command it types is inside one already-admitted session.
     *
     * "hold" means what it says here, unlike in actionRules: the gate raises a permission card and the command
     * waits for a real answer, in EVERY posture — hooks fire under bypassPermissions, where the card machinery
     * on its own never would. An UNATTENDED turn has nobody to answer, so a hold there refuses instead and says
     * why; that is the honest form of "ask me" when there is no me.
     *
     * An unlisted class is allowed, and an empty rulebook wires no hook at all — an owner who has never opened
     * this pays nothing for it. Keys are the CommandClass enum, so a typo is a settings error rather than a rule
     * that silently never matches. */
    commandRules: z.partialRecord(CommandClassSchema, AdmissionRuleSchema).default({}),
    /* HOW MUCH AN AGENT MAY DELEGATE — the three ceilings the Claude Code harness enforces on its own Agent
     * tool, surfaced here because their defaults are tuned for a laptop and this is a container the owner sized.
     *
     * They are three settings rather than one because they stop different things, and a fan-out that clears one
     * lands on the next: `subagentsAtOnce` is the parallel width of a single fan-out, `subagentsPerTurn` is the
     * lifetime budget of one conversation, and `subagentDepth` is how far a child may itself delegate. Raising
     * the width alone is what makes a wide sweep hit the lifetime cap two rounds later, which reads to the user
     * as the same wall in a new place.
     *
     * Each default is what the CLI does with no env set, so a sandbox that has never opened this group behaves
     * exactly as it always did — these are not our numbers, they are the harness's, restated so they can move.
     * The ceilings are ours: an agent is told to stop and NOT retry when it hits one, so the cost of a number
     * set too high is a real fleet of models running at once, and the cost of one set too low is a wall.
     *
     * The refusal an agent sees names the env var (`ask them to raise CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`),
     * which is why these three exist as settings at all: without them the only answer to that ask is editing
     * the container's environment and restarting the daemon. */
    subagentsAtOnce: z.number().min(1).max(200).default(20),
    subagentsPerTurn: z.number().min(1).max(2000).default(200),
    // Depth 1 = an agent may delegate, but its children may not. The CLI's own default is 3, and it is the one
    // of the three whose runaway case is unbounded rather than merely wide — each level multiplies the last.
    subagentDepth: z.number().min(1).max(10).default(3),
});
export type SandboxSettings = z.infer<typeof SandboxSettingsSchema>;

// One of the two built-in bases, as text: Intentic's own prompt, or Claude Code's preset read out of the CLI
// this sandbox runs (preset-prompt.ts captures it rather than storing a transcription). What the settings page
// shows behind "View" and drops into the editor behind "Edit a copy".
//
// `version` is the CLI build a captured preset came from, so the UI can say WHICH text the user is looking at:
// a custom prompt forked from an older build is a snapshot, and the version is the only honest way to tell.
// Empty for Intentic's prompt, which ships with the app and has no version of its own to report.
export const BuiltinPromptTextSchema = z.object({ text: z.string(), version: z.string() });
export type BuiltinPromptText = z.infer<typeof BuiltinPromptTextSchema>;

/* ---- savings report: what each token-reduction mechanism actually saved ----
 *
 * TWO FAMILIES, deliberately never one list of bars. They are measured differently, and a chart that ranks
 * them side by side claims a confidence and a denominator that only one of them has:
 *
 *   input  — shell output the cleaners trimmed before the model ever saw it. Both sides of the comparison come
 *            off the SAME command (raw in, emitted out), so the counterfactual is observed rather than
 *            estimated: exact, per command, no sample size to argue about.
 *   output — the model's own tokens under the terse steer. There is no second run of the same turn to compare
 *            against, so the only honest number is an experiment: a turn-level holdout, an n per arm, and a
 *            margin. It is absent entirely until both arms are large enough for the delta to mean anything.
 *
 * The two are also in different units of value — a saved tool-output token is saved again on every later
 * request of that conversation, an output token is saved once but costs several times as much — which is the
 * other reason they are separate sections with separate totals rather than one number.
 */

// One mechanism's realized saving, biggest first. `savedTokens` is what THIS stage removed from what reached
// it in pipeline order — sequential attribution, which is why the stages sum exactly to raw − emitted and can
// be drawn as one stacked bar. It is NOT "what turning this cleaner off would cost you": the cap downstream
// would have eaten some of the same lines. `commands` is how many commands the stage ran on. Negative for the
// `footer` stage, which adds the retrieval pointer back — a cost on the same ledger as what it bought.
export const SavingsStageSchema = z.object({ id: z.string(), commands: z.number(), savedTokens: z.number() });

// What the cleaners saved on the way in, aggregated from historyRoot/logs/filter-stats.jsonl — one row per
// agent Bash command, written by agent-output-filter. Every number here is windowed on the ledger's own
// calendar (the UTC day each command ran), so the reader's date range and the figures above it agree.
export const InputSavingsSchema = z.object({
    // When the ledger last recorded a command (epoch ms), so the card can show its age instead of implying
    // freshness it doesn't have. Absent when the ledger has never been written.
    updatedAt: z.number().optional(),
    commands: z.number(),
    rawTokens: z.number(),
    emittedTokens: z.number(),
    savedPct: z.number(),
    // Per-stage attribution, biggest first.
    perCleaner: z.array(SavingsStageSchema),
    // The measured control — commands the holdout left raw — against the cleaned population. A real saved-%
    // for the pipeline as a whole rather than an estimate, and the only whole-pipeline counterfactual there is.
    holdout: z.object({ cleaned: z.number(), heldOut: z.number(), measuredSavedPct: z.number().optional() }),
    /* High-volume commands that matched no cleaner: where the next handler is worth writing. GROUPED by the
     * command text — `commands` is how many times it ran and `tokens` their total — because the question this
     * list is read for is "what is worth a handler", and a handler is worth writing for a command that costs
     * 5k twenty times over, not for the single 60k outlier that happened to sort first. */
    gaps: z.array(z.object({ command: z.string(), commands: z.number(), tokens: z.number() })),
});
export type InputSavings = z.infer<typeof InputSavingsSchema>;

// One arm of a turn-level experiment: the turns that ran with the mechanism, and the turns the holdout ran
// without it. A mean PER TURN, because the arms never hold the same number of turns.
export const SavingsArmSchema = z.object({ turns: z.number(), mean: z.number() });

/* WHAT BECAME OF A TURN'S PRE-TURN RETRIEVAL. `note` is the only outcome that reaches the model; the rest are
 * the ordinary ways it declines, and none of them is an error — each is a turn that proceeded exactly as it
 * would have without the feature.
 *
 *   ineligible — the prompt failed a lexical gate before retrieval ran (it named its own file, or said nothing
 *                to search for). By design, and the largest share by far.
 *   deadline   — the resident engine outran its budget and the turn went on without it.
 *   indexing   — the index had not caught up with disk, so any answer would have been confidently partial.
 *   no-hits    — the query matched nothing.
 *   failed     — retrieval threw; swallowed on purpose, since this is an optimisation nobody asked for.
 *
 * It lives in the contract rather than in the daemon because two things downstream of the daemon have to speak
 * it: the ledger row that records it (UsageTurnSchema.iqContextOutcome) and the experiment that reads it back
 * (TurnExperimentSchema.outcomes). Declared here, above both. */
export const IqContextOutcomeSchema = z.enum(["note", "ineligible", "deadline", "indexing", "no-hits", "failed"]);
export type IqContextOutcome = z.infer<typeof IqContextOutcomeSchema>;

/* ONE METRIC'S READING of a turn-level experiment: the two arms, and whatever the arithmetic over them will
 * stand behind. An experiment can carry several — see TurnExperimentSchema.
 *
 * `metric` says what `mean` counts and what `deltaPct` is a delta in, and choosing it is most of the work.
 *   proseChars      — the terse steer: the thing it steers, and the only part of the model's output that
 *                     responds to being asked to be brief (UsageTurn.proseChars has why output tokens cannot).
 *   searchCalls     — pre-injection: the searches a turn ran, which the retrieval directly removes.
 *   openingSearches — pre-injection, narrower: the searches before the turn first touched a file.
 * Pre-injection used to be judged on COST, and could not be. UsageTurn.searchCalls has the nine days of data
 * that settled it — cost is a whole turn's work, retrieval moves one part of it, and the part sat inside the
 * noise of the rest exactly as the steer's effect once sat inside its tool-call arguments. */
export const TurnMetricReadingSchema = z.object({
    metric: z.enum(["proseChars", "searchCalls", "openingSearches"]),
    on: SavingsArmSchema,
    off: SavingsArmSchema,
    /* HOW MUCH LONGER, when the margin spans zero and the honest answer is "keep collecting": the additional
     * CONTROL turns at which the resolution would reach a width worth acting on (turn-experiments.ts sets it),
     * holding the spread where it sits today.
     *
     * It is aimed at a FIXED resolution rather than at today's delta on purpose. Sized against the observed
     * effect it reported fourteen more turns for an experiment that had gone nine days without resolving — an
     * estimate divided by noise inherits the noise and promises an answer next week indefinitely. Against a
     * fixed target the same ledger asks for a few hundred, which is the fact the reader needs: this holdout is
     * not close, and waiting is not the move.
     *
     * An order-of-magnitude figure, and it reads as one — the point is telling "a few more days" apart from
     * "not at this holdout", which is a decision, where "measuring…" forever is not.
     *
     * Absent ⇒ nothing to wait for: the arms are under `minTurns`, the delta is published, or the resolution is
     * already good enough and the effect is simply smaller than it. */
    controlTurnsNeeded: z.number().optional(),
    /* THE RESOLUTION, present as soon as both arms clear `minTurns`: ± percentage points at 95% (Welch,
     * unequal variances and unequal arms). Present even when the delta below is withheld, because "whatever
     * this mechanism does, it is smaller than ±35 points" is a true and useful thing to be told — it is the
     * reading that says to keep collecting rather than to act. */
    marginPct: z.number().optional(),
    /* THE CLAIM, present only once there is one. Both together, and only when the margin does NOT span zero.
     *
     * A schema that can't express a half-measured experiment is how a 34%-that-becomes-8%-tomorrow never
     * reaches the screen — and clearing `minTurns` turned out not to be enough to buy that. The terse steer
     * crossed its thirtieth control turn and immediately reported +31.2% ± 35.1pp: a confidence interval
     * running from −3.4% to +66.7%, which is to say no effect was measured at all, rendered as an alarming
     * number pointing the wrong way. Thirty turns is where the normal approximation starts to hold, not where
     * this much per-turn spread resolves an effect; requiring the interval to exclude zero is the same
     * withhold-until-it-means-something rule applied to the thing that actually decides whether it does.
     *   deltaPct — change in the metric's mean per turn under the mechanism; negative is a saving.
     *   saved    — what the delta is worth over the turns that actually ran with it, in this window, in the
     *              metric's own unit (characters, or searches). */
    deltaPct: z.number().optional(),
    saved: z.number().optional(),
});
export type TurnMetricReading = z.infer<typeof TurnMetricReadingSchema>;

/* A turn-level A/B — the one shape both of this sandbox's turn experiments report in, because they differ in
 * nothing but which flag flips and what the turns are judged on. Only turns the mechanism was ELIGIBLE for are
 * counted: a turn under a custom system prompt drops the terse steer along with everything else the daemon
 * appends, so it belongs to neither arm.
 *
 * ONE COIN FLIP, SEVERAL READINGS. `metrics` is a list because pre-injection is judged on two — the searches a
 * turn ran, and the ones it ran before touching a file — and they are two readings of the SAME experiment, not
 * two experiments. Splitting them into separate entries would duplicate the arm assignment and the delivery
 * rate below, and let a screen show a turn count on one that disagrees with the other. Headline first: the
 * screens read `metrics[0]` for the big number and the rest as supporting lines. */
export const TurnExperimentSchema = z.object({
    // A head and a tail rather than a plain array, because an experiment judged on nothing is not an experiment:
    // the screens take the first reading for their headline and stack the rest under it, and this is what makes
    // "there is always a headline" a fact the type carries instead of a check every screen repeats. (`.nonempty()`
    // would not do it — in zod 4 it adds a min-length rule and leaves the inferred type a plain array.)
    metrics: z.tuple([TurnMetricReadingSchema], TurnMetricReadingSchema),
    // Turns per arm before a delta is reported at all. Carried on the wire so the screen's "measuring…" state
    // counts toward the daemon's real threshold instead of a number the browser guessed. Shared by every
    // reading: they are the same turns counted differently, so they clear it together.
    minTurns: z.number(),
    // The randomized unit behind the arm counts. Turn mechanisms default to turns; teaching loaded into a
    // provider session randomizes and analyzes whole conversations so repeated turns are not false replicas.
    sampleUnit: z.enum(["turns", "conversations"]).optional(),
    // Content-addressed treatment version. Present where mixing rows from two instruction revisions would turn
    // one experiment into two unnamed ones; the reader filters to this (latest) cohort.
    cohort: z.string().optional(),
    /* How much of the treatment arm the treatment actually REACHED, when that is knowable and less than all of
     * it — pre-injection's arm is the coin flip (intention-to-treat, deliberately), and a turn can be assigned
     * the retrieval and still have nothing to prepend. Measured at four turns in five, which is the difference
     * between a mechanism worth little and one worth five times what the delta says.
     *
     * Absent ⇒ delivery is not a separate question for this experiment (the terse steer always lands) or no
     * turn in the window recorded it. The screen shows the delta as diluted rather than silently scaling it:
     * the correction is a division by a rate this small only when the rate is itself well measured. */
    deliveredPct: z.number().optional(),
    /* WHERE THE REST OF THE TREATMENT ARM WENT, most common first. `deliveredPct` says a mechanism reached one
     * turn in five; this says whether the other four were the eligibility gate declining on purpose or a
     * two-second deadline quietly eating the feature, which are the same number and opposite problems.
     *
     * Absent ⇒ the experiment has no delivery question (the terse steer always lands) or no turn recorded one. */
    outcomes: z.array(z.object({ outcome: IqContextOutcomeSchema, turns: z.number() })).optional(),
});
export type TurnExperiment = z.infer<typeof TurnExperimentSchema>;

// `output`/`context` are absent when that experiment isn't running at all (its flag off, or no holdout set) — a
// section that isn't there reads as "not measured", which is the truth, while zeros would read as "measured,
// worth nothing".
export const SavingsReportSchema = z.object({
    input: InputSavingsSchema,
    output: TurnExperimentSchema.optional(),
    search: TurnExperimentSchema.optional(),
    context: TurnExperimentSchema.optional(),
});
export type SavingsReport = z.infer<typeof SavingsReportSchema>;

// ---- intentic CLI ----

export const IntenticRunSchema = z.object({ args: z.array(z.string()) });

// ---- git ----

// What a commit records — three shapes, each a real git spelling. The last two are for the case where nothing
// is staged yet and the caller has said what to stage; they are alternatives, and a caller sends at most one:
//   absent      ⇒ commit whatever is staged (plain `git commit`)
//   all: true   ⇒ stage every change in the repo, then commit (`commit -a`; VSCode's "stage all and commit")
//   paths       ⇒ `git add` those repo-relative paths, then commit the index
//
// `paths` is emphatically NOT `commit --only`. The index IS git's mechanism for choosing what a commit
// contains, so a second path-selection channel alongside it could only disagree with it: a partial commit over
// a half-staged file records the WORKTREE content while the row the user picked showed the INDEX content. This
// stages and then records the whole index, which is why it is safe — and why it also survives a merge, where
// git refuses a partial commit outright (and refuses it only AFTER moving the index).
export const CommitSchema = RepoParamSchema.extend({
    message: z.string().min(1),
    all: z.boolean().optional(),
    paths: z.array(z.string().min(1)).max(500).optional(),
});
export const DiscardSchema = RepoParamSchema.extend({
    // Repo-relative paths to discard; absent ⇒ discard every uncommitted change in the repo.
    paths: z.array(z.string().min(1)).max(500).optional(),
});
// Index moves. Both are per-path and never touch the worktree, so they are always safe and need no checkpoint.
export const GitStageSchema = RepoParamSchema.extend({ paths: z.array(z.string().min(1)).max(500) });
// `branch` defaults to the checked-out one. There is deliberately no "set upstream" flag: the daemon publishes
// (`push -u`) exactly when the branch has no upstream yet, which is never destructive and is the only way the
// result is coherent — see pushBranch.
export const PushSchema = RepoParamSchema.extend({ branch: z.string().min(1).optional() });
export const GitFileQuerySchema = RepoParamSchema.extend({ path: z.string().min(1) });
export const GitFileWriteSchema = RepoParamSchema.extend({ path: z.string().min(1), content: z.string() });
// Which of the working tree's diffs to open — the same split the Changes panel lists under. A path that is
// staged AND edited again has genuinely different diffs, so the side is required rather than defaulted: a
// caller that doesn't say which one it means doesn't know what it is showing.
//   staged     ⇒ index vs HEAD      (what a bare `git commit` would record)
//   unstaged   ⇒ worktree vs index  (untracked ⇒ no before side)
//   conflicted ⇒ HEAD vs worktree   (what you had vs what the merge left, markers included — an unmerged path
//                                    has no stage 0, so the index is not a side it can be diffed against)
export const GitDiffSideSchema = z.enum(["staged", "unstaged", "conflicted"]);
export type GitDiffSide = z.infer<typeof GitDiffSideSchema>;
export const GitFileDiffQuerySchema = RepoParamSchema.extend({ path: z.string().min(1), side: GitDiffSideSchema });
export const GitStatusSchema = z.object({ branch: z.string(), dirty: z.boolean(), files: z.array(z.string()) });
export const GitFilesSchema = z.object({ files: z.array(z.string()) });
export const GitFileSchema = z.object({ path: z.string(), content: z.string() });
// CommitResultSchema is declared further down, after the RepoChanges/OriginAgent shapes a commit answers with.

// One repo's slice of a workspace-wide git action: the whole repo, or only the repo-relative paths named. The
// same pair the per-repo routes take as {repo} + `paths`, in the one shape a caller that spans repos can send.
export const RepoPathsSchema = z.object({ repo: z.string().min(1), paths: z.array(z.string().min(1)).max(500).optional() });
export type RepoPaths = z.infer<typeof RepoPathsSchema>;

// One change to a file — an uncommitted working-tree change (status vs HEAD, untracked included), an agent
// worktree's delta vs its base, or a file in a commit. `additions`/`deletions` are the numstat line counts,
// undefined for a binary file (git reports "-"/"-") or an untracked file (no HEAD blob to diff against).
export const GitChangeSchema = z.object({
    // Repo-relative path with forward slashes; for "renamed" the NEW path (`from` carries the old one).
    path: z.string(),
    // "conflicted" is git's unmerged state (`U`), and it is not a kind of modification: the index holds "ours"
    // and "theirs" at stages 2/3 with NO stage 0, so there is nothing a commit could record for this path and
    // git refuses to commit while one exists. It belongs to neither side — see RepoChanges.conflicted.
    status: z.enum(["added", "modified", "deleted", "renamed", "type-changed", "conflicted"]),
    from: z.string().optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
});
export type GitChange = z.infer<typeof GitChangeSchema>;

// Where a repo's checked-out branch stands against its remote. Every field is optional-or-zero because every
// one of them is legitimately absent in a healthy repo: no remote configured yet, a branch created locally and
// never pushed, a detached HEAD. `ahead` = commits only we have; `behind` = commits only the upstream has,
// which is meaningful only as of the last fetch — the panel's Fetch button is what refreshes it.
export const GitRemoteStateSchema = z.object({
    // The remote this branch pushes to: its OWN remote when it tracks one, else the first `git remote` lists
    // (where a never-pushed branch would publish). Those differ in a fork — `origin` and `upstream` both
    // configured — and pushing to the wrong one succeeds while leaving `ahead` stuck. Absent ⇒ no remote.
    remote: z.string().optional(),
    // The checked-out branch; absent on a detached HEAD or an unborn repo.
    branch: z.string().optional(),
    // The tracking ref ("origin/main"); absent ⇒ this branch has no upstream, so the next push publishes it.
    upstream: z.string().optional(),
    ahead: z.number(),
    behind: z.number(),
});
export type GitRemoteState = z.infer<typeof GitRemoteStateSchema>;

// A ref name (branch/tag), validated structurally — git enforces the rest of ref-name legality itself.
const RefNameSchema = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    .max(200);

// One local branch, for the switcher. `at` is its tip's committer time in ms (the list sorts newest-first).
export const GitBranchSchema = z.object({
    name: z.string(),
    current: z.boolean(),
    upstream: z.string().optional(),
    ahead: z.number(),
    behind: z.number(),
    // The configured upstream no longer exists on the remote (a merged PR's deleted branch) — distinct from
    // "no upstream", and the signal that this local branch is safe to delete.
    gone: z.boolean().optional(),
    at: z.number(),
});
export type GitBranch = z.infer<typeof GitBranchSchema>;
/* One REMOTE-TRACKING branch — somebody else's tip, as this repo last saw it.
 *
 * A separate shape from GitBranch rather than the same one with optional fields, because the two genuinely
 * differ: a remote-tracking branch has no upstream of its own and no ahead/behind, and giving it those fields
 * as zeroes would make it look like a synced local branch. `name` is the full `origin/main`; `remote` and
 * `branch` are it split, so a selector can group by remote without re-parsing. */
export const GitRemoteBranchSchema = z.object({ name: z.string(), remote: z.string(), branch: z.string(), at: z.number() });
export type GitRemoteBranch = z.infer<typeof GitRemoteBranchSchema>;
// Locals and remote-tracking branches in one response: the switcher pairs them, and two round trips to draw one
// list would only ever show a half-populated one first.
export const GitBranchesSchema = z.object({ branches: z.array(GitBranchSchema), remotes: z.array(GitRemoteBranchSchema) });
// Create at `start` (a sha or ref; absent ⇒ HEAD); `checkout` switches to it immediately (`git switch -c`).
export const GitBranchCreateAtSchema = RepoParamSchema.extend({
    name: RefNameSchema,
    start: z.string().min(1).optional(),
    checkout: z.boolean().optional(),
});
// `force` is the deliberate retry after git refuses to drop an unmerged branch.
export const GitBranchDeleteSchema = RepoParamSchema.extend({ name: RefNameSchema, force: z.boolean().optional() });

/* THE OPERATION A REPO IS HALTED IN THE MIDDLE OF — a merge, rebase, cherry-pick or revert that stopped on a
 * conflict and was never finished or aborted.
 *
 * Every verb the daemon runs itself aborts cleanly on failure, so this is never something the UI started. It is
 * what an agent or a user left behind in a terminal, and it is a state git refuses to do almost anything else
 * from — so a surface listing the conflicted files without naming it leaves the reader with no way out.
 * Absent means the worktree is not mid-anything. */
export const GitOperationSchema = z.enum(["merge", "rebase", "cherry-pick", "revert"]);
export type GitOperation = z.infer<typeof GitOperationSchema>;
export const GitOperationStateSchema = z.object({ repo: z.string(), operation: GitOperationSchema.optional() });
export type GitOperationState = z.infer<typeof GitOperationStateSchema>;

export const RepoChangesSchema = z.object({
    // The {repo} param the per-repo git routes accept: "root" or a repo id (its root-relative dir).
    repo: z.string(),
    // Absent on an unborn HEAD (a repo initialized but never committed).
    branch: z.string().optional(),
    // Unmerged paths — a merge, rebase, cherry-pick or pull that git could not finish. First, because until
    // they are resolved nothing else in this repo can be committed at all: git refuses outright. Held apart
    // from the two sides rather than listed in them, because "staged or not" is not a question an unmerged path
    // has an answer to. Staging one (`git add`) is exactly how you tell git it is resolved.
    conflicted: z.array(GitChangeSchema),
    /* The merge/rebase/cherry-pick/revert this repo is halted in the middle of, when it is. Carried on the SCAN
     * rather than fetched per repo because it belongs beside `conflicted`: the panel already lists the files,
     * and this is the sentence that says why they are conflicted and what ends it. Absent = not mid-anything,
     * which is every repo almost all of the time. */
    operation: GitOperationSchema.optional(),
    // The two sides git actually models, kept apart because a path can appear on BOTH with different statuses
    // (a staged edit that was then edited again — the classic `MM`). `staged` is index-vs-HEAD: exactly what a
    // bare `git commit` would record. `unstaged` is worktree-vs-index plus untracked files. Each side's
    // additions/deletions describe the diff it is listed under, never a conflation of the two.
    staged: z.array(GitChangeSchema),
    unstaged: z.array(GitChangeSchema),
    // How many changes were CUT from the two sides above (conflicts are never cut). A cloned monorepo or a
    // mass delete carries six-figure change lists — a payload no panel can render and no browser should hold —
    // so past the daemon's per-repo budget the lists arrive truncated and this carries the dropped count, which
    // the panel adds to its badges and states under the group. Absent ⇒ the lists are complete.
    truncated: z.number().optional(),
    // Where this repo stands against its remote; `ahead`/`behind` are 0 with no remote or no upstream.
    remote: GitRemoteStateSchema.optional(),
    // WHICH AGENT PUT IT THERE: repo-relative path → the agent ids that landed it, newest land first. Keyed by
    // PATH rather than carried on each GitChange because a path can be listed on two sides at once (staged and
    // edited again) and its origin is the same fact for both. Only branch-backed agents whose work passed
    // through land can appear here; workspace conversations, terminal edits and the user's typing are absent
    // (see agents/origins.ts), so the panel badges an attributable agent and says nothing for anyone else.
    // Ids, not titles: the identity for every id named here rides the response once, in `originAgents`.
    origins: z.record(z.string(), z.array(z.string())).optional(),
    // Why the repo could not be scanned at all, condensed to git's own one-line reason ("fatal: bad object HEAD").
    // A repo left torn by a canceled or failed upload used to be dropped from the response entirely, so it just
    // vanished from the panel with nothing to act on; it now arrives with empty change lists and this set instead.
    error: z.string().optional(),
});
export type RepoChanges = z.infer<typeof RepoChangesSchema>;

// WHO AN ORIGIN ID IS — the display identity of one agent named in `origins`, carried BY THE RESPONSE rather
// than looked up in the client's fleet roster. The roster is the LIVE board and deliberately drops archived
// agents (AgentsRegistry.list), while a landing outlives the agent that made it: archiving a finished agent
// does not commit its lines, so the very common case — land, archive the card, review at leisure — is exactly
// the one a roster lookup cannot answer, and the panel fell back to "Agent 1a2b3c" with a generic icon for it.
// The daemon reads attribution and identity from the same registry in the same pass, so it is the one place
// they cannot disagree. Per response, not per repo: one agent commonly lands into several.
export const OriginAgentSchema = z.object({
    // Absent for an entry that never got a title (a turn that failed before one was derived).
    title: z.string().optional(),
    provider: AgentProviderSchema,
    /* WHAT THE LANDED WORK DID — the same drafted message the agent's own card carries (LandedMessage), on the
     * road that outlives the card. The panel reads the roster's copy first and this one when the roster has no
     * entry left to read, which is the case this whole schema exists for: an archived agent's lines are still
     * in the tree, and the sentence about them has to be too.
     *
     * Absent for a landing nothing was written about, and — for the seconds after a land — for one whose
     * sentence is still being drafted. Those two are told apart by `landedMessageDraft` on the agent's card, and
     * neither has a title-shaped fallback: guessing a subject from the ask is exactly the habit this replaced,
     * so a chip with no message files nothing and simply filters. */
    landedMessage: LandedMessageSchema.optional(),
});
export type OriginAgent = z.infer<typeof OriginAgentSchema>;

// The aggregated review set across every repo (root + every discovered repo); a repo appears when it has changes,
// when it is out of sync with its remote, or when it failed to scan.
export const GitChangesSchema = z.object({
    repos: z.array(RepoChangesSchema),
    // Keyed by agent id; covers every id any repo's `origins` names, and only those. Absent when nothing in
    // the review is attributable. An id can still be missing from it — the retention sweep can retire an
    // entry whose landed lines are somehow still uncommitted — and the panel keeps its id-shaped fallback for
    // exactly that, rather than dropping the chip and re-attributing the file to the user.
    originAgents: z.record(z.string(), OriginAgentSchema).optional(),
    /* WHICH REPOS HAVE A COMMIT RUNNING RIGHT NOW — the daemon's answer, not the browser's.
     *
     * A commit is one request that outlives the tab that fired it. Reload the page mid-commit and that tab's
     * "a git action is running" flag went with it: the button re-armed itself over rows the commit was already
     * recording, the panel invited a second click at the exact moment it could do the least good, and the rows
     * then changed under the user a second later with nothing having said why. A second device watching the
     * same workspace never knew at all.
     *
     * So the fact lives where the commit does. Read at RESPONSE time rather than folded into the scan, because
     * the scan is memoized for half a second and this must describe the instant it is sent. Absent ⇒ nothing is
     * committing, which is the overwhelmingly common case and the reason it is optional rather than an empty
     * array on every response. */
    committing: z.array(z.string()).optional(),
});
export type GitChanges = z.infer<typeof GitChangesSchema>;

/* WHAT THE COMMIT LEFT BEHIND — the committed repo's review row, re-read inside the same repo lock that made
 * the commit, so the panel replaces that repo's rows from THIS answer instead of asking for a fresh
 * workspace-wide scan afterwards.
 *
 * That scan is the daemon's most expensive read (a repo walk plus a `git status` per repo, ~11 git spawns each,
 * for every repo including the ones the commit never touched) and the user sat watching the rows they had just
 * committed until it returned. The commit itself is milliseconds of git; the wait was this.
 *
 * `changes` ABSENT means the repo has nothing the panel would show any more — the same inclusion rule the scan
 * applies, decided in the same place, so a repo the scan would have dropped drops here too. `originAgents`
 * covers the ids this repo's `origins` names and only those, on GitChangesSchema's terms; the panel merges it
 * over what it already holds rather than replacing, since the other repos' rows still name their own agents. */
export const CommitResultSchema = z.object({
    committed: z.boolean(),
    changes: RepoChangesSchema.optional(),
    originAgents: z.record(z.string(), OriginAgentSchema).optional(),
});
export type CommitResult = z.infer<typeof CommitResultSchema>;

/* One module a changed file can be grouped under in the review panels: a repo-relative dir ("_editor/web", or ""
 * for a repo that is itself one package) and the name its package.json declares. Distinct from
 * WorkspacePackage, which is the DEPENDENCY graph's node — that one is pnpm's view of the workspace and carries
 * the grouping axis its diagram colours by; this one is a filesystem fact about where a path lives.
 *
 * Stated HERE, above both readings of it, because there are two trees a review can be of and each groups by its
 * own: the workspace read below (/workspace/modules, the Changes panel) speaks for /work, and every agent's
 * diff carries its own (AgentRepoChanges.modules) because an agent's files live in a worktree /work cannot
 * see. */
export const WorkspaceModuleSchema = z.object({ dir: z.string(), name: z.string() });
export type WorkspaceModule = z.infer<typeof WorkspaceModuleSchema>;
export const RepoModulesSchema = z.object({ repo: z.string(), modules: z.array(WorkspaceModuleSchema) });
export type RepoModules = z.infer<typeof RepoModulesSchema>;
export const WorkspaceModulesSchema = z.object({ repos: z.array(RepoModulesSchema) });
export type WorkspaceModules = z.infer<typeof WorkspaceModulesSchema>;

// One file an agent touched, plus whether that change is ALREADY in the main tree. The review lists the
// agent's CUMULATIVE output (base → worktree), not just the not-yet-landed remainder, because landing is not
// the end of the review: a clean turn auto-lands within milliseconds, and a list scoped to the remainder shows
// the user an empty panel for work they never got to look at. `landed` is what still separates the two — the
// remainder is what "Land now" would apply, and the panel filters on exactly this flag.
export const AgentChangeSchema = GitChangeSchema.extend({ landed: z.boolean() });
export type AgentChange = z.infer<typeof AgentChangeSchema>;

// An agent conversation-worktree's delta vs its recorded base — deliberately NOT RepoChanges. There is no index
// side to speak of here: the question a fleet review answers is "what did this agent write", which is one flat
// set. Sharing the working-tree shape would have forced a meaningless empty `staged` on every
// row and invited the panel to render a staging affordance that cannot work on a worktree the user never checks out.
export const AgentRepoChangesSchema = z.object({
    repo: z.string(),
    branch: z.string().optional(),
    changes: z.array(AgentChangeSchema),
    /* THE PACKAGE LAYOUT OF THE TREE THESE CHANGES CAME FROM, so the review can group them by module the way
     * the workspace's Changes panel does. It rides the changes rather than being fetched beside them, because
     * an agent works in a worktree the main tree cannot see: a package the agent has just created exists only
     * there, so the workspace-wide read (/workspace/modules) does not know its name and every one of its files
     * — which for a new package is all of them — fell into the unnamed "loose in this repo" bucket.
     *
     * Same read, same instant, same tree as the rows it groups: that is what stops the two from disagreeing. */
    modules: z.array(WorkspaceModuleSchema),
});
export type AgentRepoChanges = z.infer<typeof AgentRepoChangesSchema>;
/* The review, plus WHY the last land refused — because a conflict is discovered by the daemon (a clean turn
 * auto-lands the moment it finishes) and acted on in the browser, possibly hours later, on a surface the user
 * reaches by clicking the card's "Resolve conflict". Carrying the report only in the land RESPONSE meant the
 * one path that opens the review already knowing there is a conflict was the one path that could not show it:
 * the panel opened with an empty report, no explanation, and no merge affordance — a dead end at the exact
 * moment the UI had promised something to resolve. It rides the review because that is the surface that
 * resolves it, and it refreshes with it: every land invalidates this query, so the report is never staler
 * than the last attempt. */
export const AgentChangesSchema = z.object({ repos: z.array(AgentRepoChangesSchema), conflicts: z.array(LandConflictSchema).optional() });
export type AgentChanges = z.infer<typeof AgentChangesSchema>;

// ---- git history graph (the "Git Graph" view over a repo's real commits) ----
// A hex sha (full or git-abbreviated): the only shape the graph ever sends back, so the per-commit routes
// constrain to it rather than accepting an arbitrary git revision expression.
const ShaSchema = z.string().regex(/^[0-9a-f]{4,64}$/);
// One commit in the graph. `parents` (0 = root, 1 = normal, 2+ = merge) drive the lane layout, computed
// client-side. `refs` are the branch/tag decorations at this commit (tags keep their `tag: ` prefix; the bare
// "HEAD" marker is lifted into `head` instead). `at` is author time in ms since epoch; `short` is git's
// abbreviated sha; `body` is the message minus its subject line.
export const GitCommitSchema = z.object({
    sha: z.string(),
    short: z.string(),
    parents: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
    author: z.string(),
    email: z.string(),
    at: z.number(),
    refs: z.array(z.string()),
    head: z.boolean(),
});
export type GitCommit = z.infer<typeof GitCommitSchema>;
// One repo's log: commits newest-first across ALL refs (branch topology is the point of a graph), plus the
// checked-out branch (absent on a detached HEAD or an unborn repo).
export const GitLogSchema = z.object({
    repo: z.string(),
    branch: z.string().optional(),
    commits: z.array(GitCommitSchema),
    // Whether a further page exists behind this one. The daemon learns it by asking git for one commit more than
    // it returns — see commitLog. It is also what stops the oldest row of a page from being drawn as a ROOT
    // commit, which is how a truncated history used to claim it began where the page happened to stop.
    hasMore: z.boolean(),
});
export type GitLog = z.infer<typeof GitLogSchema>;
export const GitLogQuerySchema = RepoParamSchema.extend({
    limit: z.coerce.number().int().positive().max(2000).optional(),
    // How many newer commits to step over — the page cursor. Paged rather than one big read because a large
    // repository's log is tens of thousands of rows, and every one of them costs a zod validation, a wire
    // payload and a lane computation before anything is drawn.
    skip: z.coerce.number().int().nonnegative().max(1_000_000).optional(),
});
// Every real git repo under /work as root-relative dir ids ("root" is implicit — the /work repo itself).
export const GitReposSchema = z.object({ repos: z.array(z.string()) });
export type GitRepos = z.infer<typeof GitReposSchema>;
export const GitCommitDiffQuerySchema = RepoParamSchema.extend({ sha: ShaSchema });
// A commit's changed files (vs its first parent; a root commit vs the empty tree) — the graph's detail tree
// renders these (line stats included) and reuses the diff UI on click. Just GitChanges: the line stats live on
// GitChange now, so working-tree and commit files share one shape.
export const GitCommitDiffSchema = z.object({ files: z.array(GitChangeSchema) });
export type GitCommitDiff = z.infer<typeof GitCommitDiffSchema>;
export const GitCommitFileDiffQuerySchema = RepoParamSchema.extend({ sha: ShaSchema, path: z.string().min(1) });
// Git write actions from the graph's commit context menu (VSCode "Git Graph" parity). Non-destructive: branch
// and tag just add a ref (HEAD + worktree untouched, no checkpoint). Sequence ops (revert / cherry-pick /
// merge / rebase / drop) add or replay commits and are auto-checkpointed daemon-side; a conflict aborts and
// reports `ok:false` (an expected outcome, not a throw). Checkout and reset move HEAD (reset --hard discards
// the worktree) — also auto-checkpointed. A `{repo, sha}` names the target commit for every commit-scoped
// action; a ref name (branch/tag) is validated structurally, git enforces the rest of ref-name legality
// (RefNameSchema is declared above, with the branch schemas that first use it).
export const GitBranchCreateSchema = RepoParamSchema.extend({ sha: ShaSchema, name: RefNameSchema });
export const GitTagCreateSchema = RepoParamSchema.extend({ sha: ShaSchema, name: RefNameSchema });
export const GitCheckoutSchema = RepoParamSchema.extend({ ref: RefNameSchema });
// Deleting a tag locally, and — when a remote is named — on that remote too. The remote half is best-effort: a
// tag that was never pushed must not make deleting the local one report a failure.
export const GitTagDeleteSchema = RepoParamSchema.extend({ name: RefNameSchema, remote: RefNameSchema.optional() });
// Publishing ONE tag, named explicitly so it never drags every other unpushed tag along with it.
export const GitTagPushSchema = RepoParamSchema.extend({ name: RefNameSchema, remote: RefNameSchema });
export const GitResetSchema = RepoParamSchema.extend({ sha: ShaSchema, mode: z.enum(["soft", "mixed", "hard"]) });
export const GitCommitActionSchema = RepoParamSchema.extend({ sha: ShaSchema });
export const GitActionResultSchema = z.object({ ok: z.boolean(), reason: z.string().optional() });
export type GitActionResult = z.infer<typeof GitActionResultSchema>;

/* THE STASH — work set aside without committing it, and the one part of a repository's real state the workspace
 * used to be blind to entirely. A `git stash` in a terminal made the agent's (or the user's) work vanish from
 * every surface here.
 *
 * An entry IS a commit: it has a sha, a time, a diff, and parents (HEAD when it was taken, the index, and the
 * untracked tree when `-u` was used). What it does not have is a place in any branch's ancestry, so the graph
 * hangs it off the commit it was taken on rather than flowing it down a lane.
 *
 * `ref` (`stash@{0}`) is the handle every verb takes, and it is POSITIONAL — dropping one renumbers the rest, so
 * a caller must re-read the list after any mutation rather than holding an index across it. */
export const StashEntrySchema = z.object({
    ref: z.string(),
    sha: z.string(),
    short: z.string(),
    // git's own `WIP on <branch>: …` scaffolding stripped, leaving what a reader would call the message.
    subject: z.string(),
    branch: z.string().optional(),
    at: z.number(),
    parents: z.array(z.string()),
});
export type StashEntry = z.infer<typeof StashEntrySchema>;
export const StashListSchema = z.object({ repo: z.string(), stashes: z.array(StashEntrySchema) });
// A stash ref as git numbers them. Constrained rather than free text because it reaches a shell argument.
const StashRefSchema = z.string().regex(/^stash@\{\d{1,4}\}$/);
export const StashPushSchema = RepoParamSchema.extend({ message: z.string().max(500).optional(), includeUntracked: z.boolean().optional() });
// `pop` drops the entry on a clean apply; `apply` keeps it. Git's own distinction, and both are things people
// mean: pop is "resume this", apply is "try this here too".
export const StashApplySchema = RepoParamSchema.extend({ ref: StashRefSchema, pop: z.boolean().optional() });
export const StashRefParamSchema = RepoParamSchema.extend({ ref: StashRefSchema });
export const StashDiffQuerySchema = RepoParamSchema.extend({ ref: StashRefSchema });

/* THE LAST THING THAT MOVED THIS BRANCH, and whether it can be walked back.
 *
 * Complements the Checkpoints timeline rather than duplicating it: a checkpoint restores the WORKING TREE, this
 * moves the BRANCH. After a bad rebase the files are often already right and only the ref is wrong, and
 * restoring a whole worktree snapshot to fix that would drag every unrelated edit since back with it.
 *
 * `description` is git's own reflog subject, so the button can name what it will undo in git's words rather than
 * a guess. `previousSha` is where the branch returns to, and it doubles as the CONCURRENCY TOKEN: the undo is
 * refused when the repository has moved since this was read, so an undo prepared against a stale view cannot
 * land somewhere the user never looked at. Absent = nothing to undo (a fresh branch, a detached HEAD, or a
 * halted operation, which ends by aborting rather than by moving the branch). */
export const UndoKindSchema = z.enum(["commit", "amend", "merge", "rebase", "cherry-pick", "revert", "reset", "pull", "other"]);
export type UndoKind = z.infer<typeof UndoKindSchema>;
export const UndoableActionSchema = z.object({
    kind: UndoKindSchema,
    description: z.string(),
    branch: z.string(),
    sha: z.string(),
    previousSha: z.string(),
    // The action rewrote FILES as well as the ref, so undoing it faithfully needs a hard reset. The UI uses this
    // to decide whether it has to warn about losing work.
    changesWorkingTree: z.boolean(),
});
export type UndoableAction = z.infer<typeof UndoableActionSchema>;
export const GitUndoStateSchema = z.object({ repo: z.string(), action: UndoableActionSchema.optional() });
export type GitUndoState = z.infer<typeof GitUndoStateSchema>;
// `previousSha` is the position the caller was shown; `discardChanges` picks a hard reset over a soft one.
export const GitUndoSchema = RepoParamSchema.extend({ previousSha: ShaSchema, discardChanges: z.boolean().optional() });

// ---- history: daemon-owned workspace snapshots (diff + restore) ----
// The daemon snapshots /work into bare git dirs on /history (outside the agent's reach). A "snapshot" groups
// one commit per scope (root + each nested repo) under a shared id. Only checkpoint triggers (turn / user /
// pre-restore / restore) are listed; "interval" captures are a hidden safety net that dissolves into the next
// visible checkpoint's diff.

export const SnapshotTriggerSchema = z.enum(["turn", "interval", "pre-restore", "restore", "user"]);
export type SnapshotTrigger = z.infer<typeof SnapshotTriggerSchema>;
export const SnapshotSchema = z.object({
    id: z.string(),
    // Committer time, ms since epoch.
    at: z.number(),
    trigger: SnapshotTriggerSchema,
    // Human-readable checkpoint label — the turn's prompt for "turn" snapshots; absent otherwise.
    label: z.string().optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/* WHICH CONVERSATION MESSAGE A TURN ANSWERS — carried alongside the turn so its pre-turn checkpoint can be
 * filed under it (see the sandbox's agent/turn-anchors.ts). `index` is the transcript position the turn began
 * at, which is also how many messages a rewind to it keeps. */
export interface SnapshotTurn {
    readonly conversationId: string;
    readonly index: number;
}
export const SnapshotsListSchema = z.object({ snapshots: z.array(SnapshotSchema) });

/* REWIND — go back to a message and carry on from there. Restores the workspace to that turn's checkpoint,
 * drops every message after it, and forgets the provider session so the next turn opens a fresh one.
 *
 * `index` is the transcript position of the user message being rewound TO, which is also how many messages
 * survive — rewinding to the first message of a conversation keeps none of it and restores the workspace to
 * before it ran. */
export const RewindTurnSchema = z.object({
    conversationId: z.string().min(1),
    index: z.number().int().nonnegative(),
});
export const RewindResultSchema = z.object({
    /* The checkpoint the workspace was restored to, for the History timeline to select. Absent when the
     * conversation works in a checkout of its own: that rewind moved the conversation's own branch, which the
     * workspace timeline does not carry — there is no row there to select. */
    snapshot: z.string().optional(),
    // Messages dropped from the transcript — what the client removes from its own bubbles.
    dropped: z.number().int().nonnegative(),
});
export type RewindResult = z.infer<typeof RewindResultSchema>;
export const SnapshotIdSchema = z.object({ id: z.string().min(1) });
export const SnapshotChangeSchema = z.object({
    scope: z.string(),
    // Scope-relative path with forward slashes.
    path: z.string(),
    status: z.enum(["added", "modified", "deleted", "type-changed"]),
});
export type SnapshotChange = z.infer<typeof SnapshotChangeSchema>;
export const SnapshotDiffSchema = z.object({ changes: z.array(SnapshotChangeSchema) });
export const SnapshotFileDiffQuerySchema = z.object({
    id: z.string().min(1),
    scope: z.string().min(1),
    path: z.string().min(1),
});
// Both sides of a file diff — a snapshot vs its parent, or a working tree vs HEAD; an absent side means the
// file was added/deleted. Binary or oversized content is flagged instead of shipped.
export const FileDiffSchema = z.object({
    before: z.string().optional(),
    after: z.string().optional(),
    binary: z.boolean().optional(),
    truncated: z.boolean().optional(),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

// ---- workspace tree + files ----

/* WHOSE COPY OF THE WORKSPACE A READ MEANS — the half of a file address that used to be implicit, and wrong.
 *
 * There is not one workspace. There is the shared /work tree, and there is one private checkout per isolated
 * conversation, each holding files that conversation created and versions of files it edited. Every workspace
 * read route named a PATH and nothing else, so it could only ever answer from the shared tree — and an agent
 * that had just written `docs/plan.md` in its own checkout described a file the viewer could not open, while
 * an agent that had EDITED a file got something worse: the shared version, same path, different text, with
 * nothing to say so.
 *
 * So the conversation rides the request. Absent ⇒ the shared tree, which is what every existing caller means
 * and why the field is optional rather than a second set of routes. Present ⇒ that conversation's own
 * checkout, resolved daemon-side in ONE place (workspaceRootFor) so the escape guard, the control-plane
 * denylist and the ignore rules apply to it exactly as they do to /work.
 *
 * A conversation that is not isolated resolves BACK to the shared tree rather than failing: the shared tree
 * genuinely is its tree, and a caller should not have to know which mode a conversation runs in to link to a
 * file in it. */
export const WorkspaceScopeSchema = z.object({ agent: ConversationIdSchema.optional() });
export type WorkspaceScope = z.infer<typeof WorkspaceScopeSchema>;

/* One node of the full /work filesystem tree the agent sees (untracked + generated files included), distinct
 * from the git-tracked listing. `path` is root-relative with forward slashes so it feeds straight back to the
 * file route.
 *
 * Recursive, and the type is declared rather than inferred. Zod's getter form does infer one, but it collapses
 * to `{}` below the first level of nesting — so `entry.children[0].name` type-checked as an index-signature
 * read on both sides of the wire, and the tree walker's own suite was reading a `hidden` field off entries
 * that has never existed there without the compiler minding. The interface is the contract; the schema
 * validates against it, and z.ZodType makes a divergence between the two an error here. */
/* A SYMLINK, as the tree reports one. Present only on entries that are links; `type` beside it is the type of
 * whatever the link POINTS AT, so a link to a directory expands and a link to a file opens, exactly like the
 * real thing (the model VSCode uses — its FileType carries SymbolicLink as a bit alongside File/Directory,
 * precisely so every consumer can keep asking "file or folder?").
 *
 * `to` is the link's own text, verbatim — `../../.agents/skills/discord`, not the resolved path. That is what
 * the row shows on hover, because it is what the person who made the link wrote and what they would edit.
 *
 * `state` is absent for the ordinary case: it resolves, and it resolves to somewhere inside the workspace.
 *   - "broken" — nothing at the other end. Listed anyway, because a dangling link is a fact about the
 *     workspace worth seeing rather than an entry to hide.
 *   - "outside" — it resolves to bytes outside the workspace. The daemon will not read, list or descend
 *     through it (workspace-files.ts realWithin), so the row is shown and refused, like a locked one. */
export interface WorkspaceLink {
    readonly to: string;
    readonly state?: "broken" | "outside" | undefined;
}
export const WorkspaceLinkSchema = z.object({
    to: z.string(),
    state: z.enum(["broken", "outside"]).optional(),
});

export interface WorkspaceTreeEntry {
    readonly name: string;
    readonly path: string;
    readonly type: "file" | "dir";
    readonly size?: number | undefined;
    // Ignored-by-tooling (node_modules, .git, .gitignore'd paths, browser profiles): the client grays the row.
    readonly ignored?: boolean | undefined;
    // Set when this entry is a symlink — `type` above is then its TARGET's type. See WorkspaceLink.
    readonly link?: WorkspaceLink | undefined;
    // A DIR without `children` was listed but not descended into — because it's ignored, or because the walk's
    // breadth-first budget stopped above it. Either way the client lazy-loads it via /workspace/children on
    // expand, so "not loaded yet" and "empty directory" (`children: []`) stay distinguishable.
    readonly children?: readonly WorkspaceTreeEntry[] | undefined;
}
export const WorkspaceTreeEntrySchema: z.ZodType<WorkspaceTreeEntry> = z.object({
    name: z.string(),
    path: z.string(),
    type: z.enum(["file", "dir"]),
    size: z.number().optional(),
    ignored: z.boolean().optional(),
    link: WorkspaceLinkSchema.optional(),
    get children() {
        return z.array(WorkspaceTreeEntrySchema).optional();
    },
});
export const WorkspaceTreeSchema = z.object({
    root: z.string(),
    tree: z.array(WorkspaceTreeEntrySchema),
    // How many of the ROOT's own entries the budget cut (0 = complete); per-dir cuts are counted on each dir entry.
    hidden: z.number(),
});
export type WorkspaceTree = z.infer<typeof WorkspaceTreeSchema>;
// Lazy-load one directory's children — for a dir the tree walk listed but didn't descend into. Child dirs again
// carry no `children`, so they lazy-load on their own expand. `hidden` = how many entries the cap cut (0 = all
// listed).
export const WorkspaceChildrenQuerySchema = WorkspaceScopeSchema.extend({ path: z.string().min(1) });
export const WorkspaceChildrenSchema = z.object({
    entries: z.array(WorkspaceTreeEntrySchema),
    hidden: z.number(),
});
export type WorkspaceChildren = z.infer<typeof WorkspaceChildrenSchema>;
// Write routes (delete) and the read they mirror. No scope: a conversation's own checkout is READ-ONLY through
// the file API — see workspaceRootFor for why the refusal lives daemon-side rather than in each screen.
export const WorkspaceFileQuerySchema = z.object({ path: z.string().min(1) });
export const WorkspaceMediaTicketQuerySchema = WorkspaceScopeSchema.extend({ path: z.string().min(1) });
/* The credential a <video>/<audio> element carries to GET /workspace/media, which is the one workspace route a
 * browser cannot put a header on. Minted here, over the ordinary bearer-authenticated contract, and scoped to
 * the single FILE it was asked for — the resolved one, so a ticket minted against a conversation's checkout
 * buys that file and not its shared-tree namesake (see auth/media-tickets.ts for why scope rather than
 * single-use is what bounds it). `expiresAt` is epoch ms so a player can tell a dead ticket from a dead file. */
export const WorkspaceMediaTicketSchema = z.object({ ticket: z.string(), expiresAt: z.number() });
/* A text read is a read of a WINDOW: `offset` is the byte to start at (negative reads that many bytes from the
 * END, which is what following a growing log means — the tail's offset isn't knowable until the size is), and
 * `limit` how many bytes to serve. The daemon clamps `limit` to its own cap, so an omitted or oversized one is
 * the cap rather than the file. Coerced: these arrive as query strings. */
export const WorkspaceFileReadQuerySchema = WorkspaceScopeSchema.extend({
    path: z.string().min(1),
    offset: z.coerce.number().int().optional(),
    limit: z.coerce.number().int().min(1).optional(),
});
// `size` is the whole file; `offset`/`bytes` the byte range `content` decodes from, so the reader can tell a
// window from a whole file (offset > 0 || offset + bytes < size ⇒ there is more) and ask for the next one.
export const WorkspaceFilePresentSchema = z.object({
    present: z.literal(true),
    path: z.string(),
    content: z.string(),
    size: z.number(),
    offset: z.number(),
    bytes: z.number(),
    // Which tree answered. Always true when no `agent` was asked for; true DESPITE one when that conversation's
    // checkout doesn't carry the path (see scopedTarget — its checkout is not a superset of /work), which is
    // the one case the reader has to be told about rather than left to assume.
    shared: z.boolean(),
});
/* NOTHING TO READ AT THAT PATH — an ANSWER, not a failure, which is the whole reason this branch exists.
 *
 * Most reads in this product are "read it if it is there": the file each extension keeps of what its badge has
 * already shown, a repo's documentation index, a run's result, a directory's own UI document. Absent is their
 * ordinary FIRST state, and every one of them already treats it as a value. Answering those with a 404 made the
 * browser log a failed request per read — around a dozen red lines on every page load, none of which meant
 * anything was wrong, and none of which a `catch` can suppress: the log happens in the network stack before any
 * JavaScript sees the response.
 *
 * A read that is REFUSED (an escape, the control plane, a denylisted path) is still an error, because that is a
 * real answer about the caller rather than about the file. */
export const WorkspaceFileAbsentSchema = z.object({ present: z.literal(false), path: z.string() });
export const WorkspaceFileSchema = z.discriminatedUnion("present", [WorkspaceFilePresentSchema, WorkspaceFileAbsentSchema]);
// Resolve a file reference an agent (or a compiler, or a terminal) NAMED to the workspace path it means. Prose
// paths are routinely partial — a model that has been discussing `_editor/web/src` writes
// `pages/workspace/Foo.vue` — so a clickable mention has to be matched as a path SUFFIX against the real tree,
// not read as root-relative. `path` is absent when nothing in the workspace ends in that reference.
export const WorkspaceResolveQuerySchema = WorkspaceScopeSchema.extend({ path: z.string().min(1).max(512) });
export const WorkspaceResolveSchema = z.object({ path: z.string().optional() });
// Direct file management over the /work tree (delete / new folder / rename+move / copy). Byte writes + the
// editor's text save go through the plain POST /workspace/upload route (a body doesn't fit oRPC), not here.
export const WorkspaceDirSchema = z.object({ path: z.string().min(1) });
export const WorkspaceMoveSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });
// Deterministic (no-LLM) classification of the dropped workspace: each repo dir and loose file sorted into one
// coarse bucket. Read-only — the browser turns it into a proposed layout and applies the accepted moves via the
// existing /workspace/move route. `reason` records the winning signal (magic:<mime>, ext:<ext>,
// repository:<marker>, text-content, unknown) so the proposal is explainable.
export const WorkspaceBucketSchema = z.enum(["repositories", "documents", "media", "archives", "other"]);
export type WorkspaceBucket = z.infer<typeof WorkspaceBucketSchema>;
export const WorkspaceClassificationSchema = z.object({
    classifications: z.array(z.object({ path: z.string(), bucket: WorkspaceBucketSchema, reason: z.string() })),
});
export type WorkspaceClassification = z.infer<typeof WorkspaceClassificationSchema>;
// ---- workspace search ----

// The workspace-search wire shape — shared by the daemon's /workspace/search route and the web client.
// (Implementation detail, not part of the contract: the daemon backs this route with a resident in-process iq
// engine; the engine is interchangeable behind this shape.) Groups are relevance-ranked (best first, never path
// order); each hit carries the match-reason tags the fused engines contributed, and the char spans within `text`
// that matched, so clients highlight without re-finding the needle.
export const WorkspaceSearchQuerySchema = z.object({
    query: z.string().min(2).max(512),
    // Search verbs only — anchor/git verbs (outline, context, log, who, …) are CLI-only surface. Natural language
    // has no verb of its own: `q` classifies the query and answers it semantically when the words call for it.
    mode: z.enum(["q", "find", "files", "def", "refs", "sym", "ast"]).optional(),
    includeIgnored: z.stringbool().optional(),
    // How `find` reads the query — the three switches every editor's search box has (VSCode: Aa, ab, .*).
    // `literal` treats it as fixed text instead of a regex; `caseSensitive` off means case-INSENSITIVE, not
    // ripgrep's smart case.
    literal: z.stringbool().optional(),
    word: z.stringbool().optional(),
    caseSensitive: z.stringbool().optional(),
    // Which FILES the query is asked of, in VSCode's files-to-include grammar — as TYPED, because the reading
    // of it is shared (search-globs.ts) rather than each end guessing: comma-separated patterns, each matched
    // at any depth unless `./` anchors it, a leading `!` excluding instead. Distinct from `includeIgnored`,
    // which decides whether the ignored layers are searched at all — this narrows within what that admitted.
    include: z.string().max(512).optional(),
    limit: z.coerce.number().int().positive().optional(),
    after: z.string().optional(),
});
export const WorkspaceSearchTagSchema = z.object({
    kind: z.enum(["def", "text", "sem", "bm25", "rerank", "path", "import", "call", "type", "write", "fuzzy", "heuristic"]),
    score: z.number().optional(),
});
export type WorkspaceSearchTag = z.infer<typeof WorkspaceSearchTagSchema>;
export const WorkspaceSearchSpanSchema = z.object({ start: z.number(), end: z.number() });
export type WorkspaceSearchSpan = z.infer<typeof WorkspaceSearchSpanSchema>;
export const WorkspaceSearchHitSchema = z.object({
    line: z.number(),
    text: z.string(),
    // Every matched span in `text`, in order — a text search marks all of them, the way an editor does. Empty
    // where the LINE is the match and no span of it is (a semantic or definition hit reports none).
    spans: z.array(WorkspaceSearchSpanSchema),
    tags: z.array(WorkspaceSearchTagSchema),
    // Enclosing symbol ("createWidget (fn)") — parent-document context so the reader often needs no follow-up.
    context: z.string().optional(),
});
export type WorkspaceSearchHit = z.infer<typeof WorkspaceSearchHitSchema>;
export const WorkspaceSearchGroupSchema = z.object({
    path: z.string(),
    score: z.number(),
    hits: z.array(WorkspaceSearchHitSchema),
    // This file had more matching lines than the engine keeps per file, so `hits` is a floor — a panel showing a
    // per-file count has to say "50+" rather than "50".
    capped: z.boolean().optional(),
});
export type WorkspaceSearchGroup = z.infer<typeof WorkspaceSearchGroupSchema>;
// `building` = index still filling (progress 0..1, e.g. embeddings pending); `stale` = revalidation was skipped
// (cursor replay). ageMs = time since the index last matched the disk state.
export const WorkspaceSearchFreshnessSchema = z.object({
    state: z.enum(["fresh", "building", "stale"]),
    ageMs: z.number().optional(),
    progress: z.number().optional(),
    // How many files the index has not caught up with, when it is stale. A count is reportable; "stale" alone
    // reads as a warning about the answer, which it almost never is.
    behind: z.number().optional(),
});
export type WorkspaceSearchFreshness = z.infer<typeof WorkspaceSearchFreshnessSchema>;
export const WorkspaceSearchResultSchema = z.object({
    mode: z.string(),
    total: z.number(),
    // Files the query matched in total, which `groups` reports only for the page it carries — the count a
    // results panel puts beside the hit total ("218 results in 61 files").
    files: z.number(),
    shown: z.number(),
    groups: z.array(WorkspaceSearchGroupSchema),
    freshness: WorkspaceSearchFreshnessSchema,
    truncated: z.boolean(),
    // `total` is a FLOOR: at least one file had more matches than the engine keeps per file. Distinct from
    // `truncated`, which is about this PAGE — a result can be complete on the page and still count partially.
    partial: z.boolean().optional(),
    cursor: z.string().optional(),
    hint: z.string().optional(),
    // What the engine did with the query that the query did not ask for — a pattern rerun as literal text
    // because it is not valid regex, grep-style escapes rewritten, a language filter that matched no files. The
    // text surface has always printed this above the results; a JSON caller could not see it at all.
    note: z.string().optional(),
    // Code-graph neighbors of the top hits (definition anchors + the strongest caller of each).
    related: z.array(z.string()).optional(),
    // Ranked `path:line` anchors that placed but were NOT shown, best first — the answer often sits at rank 5–13,
    // behind groups the budget spent itself on. The text surface has always printed this map; a JSON caller could
    // not see it, so it had to page through `cursor` to learn what the terminal was told up front.
    candidates: z.array(z.string()).optional(),
    // Run provenance for benchmarking: retrieval stages DISABLED this invocation (absent = full pipeline).
    features: z.array(z.string()).optional(),
});
export type WorkspaceSearchResult = z.infer<typeof WorkspaceSearchResultSchema>;

// ---- codebase health: one repository's structure and risk, in numbers ----

// The repo-level companion to the management panel and the git-history graph: what the same resident engine's
// `hotspots` (churn × complexity) and `map` (PageRank over the import graph) verbs rank, as figures a panel can
// plot instead of lines a terminal prints.
//
// Every field is a COUNT that can be recounted in the files themselves — commits, branch points, exported
// symbols. Deliberately no composite "maintainability grade": those aren't comparable across projects and can't
// be checked, and a repo-health surface that launders counts into a letter is worse than none.
// How many hotspot files and key modules a report carries when the caller names no limit. A leaderboard, not an
// inventory: past a screenful the ranking stops being the point, and the reader should be reading the files.
export const HEALTH_LIMIT = 20;
export const WorkspaceHealthQuerySchema = z.object({
    // "root" (the /work repo) or a nested repo's root-relative dir — the same {repo} ids the git routes take.
    repo: z.string().min(1),
    // Churn window (2d, 12h, 1w, 3m). Absent = all of history, which is what a hotspot ranking wants by default.
    since: z.string().max(16).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
});
// One file that is BOTH churning and tangled. `score` is the product the ranking sorts by — carried explicitly
// so the panel plots the number it ranks by rather than recomputing it.
export const WorkspaceHotspotSchema = z.object({
    path: z.string(),
    commits: z.number(),
    adds: z.number(),
    dels: z.number(),
    complexity: z.number(),
    score: z.number(),
    // Epoch ms of the latest commit touching the file, within the window.
    latestMs: z.number(),
});
export type WorkspaceHotspot = z.infer<typeof WorkspaceHotspotSchema>;
// A file of the import graph's ranked skeleton — order IS the rank, so no rank number rides along.
export const WorkspaceKeyModuleSchema = z.object({ path: z.string(), exports: z.number() });
export type WorkspaceKeyModule = z.infer<typeof WorkspaceKeyModuleSchema>;
export const WorkspaceHealthSchema = z.object({
    repo: z.string(),
    totals: z.object({
        files: z.number(),
        symbols: z.number(),
        // Summed branch points across the scoped files.
        complexity: z.number(),
        // How many files qualify as hotspots at all — the lists below are capped, this is not.
        hotspots: z.number(),
    }),
    hotspots: z.array(WorkspaceHotspotSchema),
    modules: z.array(WorkspaceKeyModuleSchema),
    // Same index-freshness signal the search route reports: a panel drawn off a half-built index says so.
    freshness: WorkspaceSearchFreshnessSchema,
});
export type WorkspaceHealth = z.infer<typeof WorkspaceHealthSchema>;

// ---- workspace setup (dependency readiness) ----

// One project under /work and whether its dependencies are actually installed. A drop omits node_modules/.venv
// on purpose, so a freshly imported project is present-but-unusable until this says "ready" — the import UI,
// the agent's post-edit type-check, and the agent's turn context all gate on it.
// `dir` is root-relative ("" = the workspace root itself); `manager` is the real binary (pnpm/npm/uv/…);
// `evidence` is the file that decided it ("pnpm-lock.yaml"), so the UI can show WHY, not just what.
// state: ready | installing | needs-setup | unsupported (manager absent from this sandbox — `manager` names it)
//      | stale — installed ONCE and since outgrown: the manifests declare dependencies that are not on disk,
//        which is what an agent leaves behind when it adds one and does not install it. Same command fixes it,
//        so `missing` (how many names cannot resolve) is what separates the two in the UI's wording.
export const ProjectSetupSchema = z.object({
    dir: z.string(),
    ecosystem: z.enum(["node", "python"]),
    manager: z.string(),
    command: z.string(),
    evidence: z.string(),
    state: z.enum(["ready", "installing", "needs-setup", "unsupported", "stale"]),
    missing: z.number().optional(),
});
export type ProjectSetup = z.infer<typeof ProjectSetupSchema>;
export const WorkspaceSetupSchema = z.object({ projects: z.array(ProjectSetupSchema) });
export type WorkspaceSetup = z.infer<typeof WorkspaceSetupSchema>;
// Install these projects' dependencies. Dirs already ready, already installing, or whose manager is missing are
// skipped server-side, so a stale client list can't spawn redundant installs — `started` is what actually ran.
export const WorkspaceInstallSchema = z.object({ dirs: z.array(z.string().max(500)).min(1).max(50) });
export const WorkspaceInstallResultSchema = z.object({ queued: z.array(z.string()) });

// ---- workspace repos ----

// Every discovered repo's id (root-relative dir under /work), sorted — roles included.
export const ReposListSchema = z.object({ repos: z.array(z.string()) });
export const CloneRepoSchema = z.object({ name: z.string().min(1), cloneUrl: z.string().min(1), branch: z.string().optional() });
export const CloneResultSchema = z.object({ name: z.string(), path: z.string() });
// Per-repo result of a workspace sync (fetch + guarded fast-forward). `status` mirrors GitSyncResult plus the
// turn-orchestration outcomes skipped/error; behind/ahead/head/message are present per status (see RepoSyncOutcome).
export const RepoSyncSchema = z.object({
    repo: z.string(),
    status: z.enum(["updated", "current", "dirty", "diverged", "no-remote", "skipped", "error"]),
    behind: z.number().optional(),
    ahead: z.number().optional(),
    head: z.string().optional(),
    message: z.string().optional(),
});
export const WorkspaceSyncSchema = z.object({ repos: z.array(RepoSyncSchema) });
// Add one or more named app instances into an EXISTING monorepo. Each entry pairs a template key from the
// source repo's templates.json manifest (e.g. "api", "web", "landing") with a user-chosen instance name
// (e.g. "shop-api"); {repo} names the target monorepo.
export const AppInstanceInputSchema = z.object({
    template: z.string().min(1),
    name: z
        .string()
        .min(1)
        .regex(/^[a-z][a-z0-9-]*$/),
});
export type AppInstanceInput = z.infer<typeof AppInstanceInputSchema>;
export const AddAppsSchema = z.object({
    repo: z.string(),
    apps: z.array(AppInstanceInputSchema).min(1),
});

// Run vitest for one or more repo-relative project dirs in a named one-shot tmux panel session
// (panel-<repo>--<session>), driven by the apps extension's Run-tests actions. `session` is a slug suffix
// (an app/package name as `<name>__test`, or `tests` for the library section); `dirs` are repo-relative
// package dirs, where "" targets the repo root.
export const RunTestsSchema = z.object({
    repo: z.string(),
    session: z.string(),
    dirs: z.array(z.string()).min(1),
});

// One addable app type the configured source repo offers (from its templates.json), listed for the operator
// panel's Add-app picker: the manifest key + its label/description.
export const TemplateSummarySchema = z.object({ key: z.string(), label: z.string(), description: z.string() });
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;
export const TemplatesListSchema = z.object({ templates: z.array(TemplateSummarySchema) });
export type TemplatesList = z.infer<typeof TemplatesListSchema>;

// One app instance currently in a monorepo, with its own preview dev server + live status (started/stopped
// from the apps extension). `app` is the user-chosen instance name (the _apps/ dir); `kind` is what sort of
// app it is — the manifest key it was scaffolded from (api/web/landing), else the framework detected from its
// dependencies (astro/next/…), and absent when it was discovered purely by its `dev` script. previewUrl is
// https://preview-<repo>--<app>-<sandboxId>.<zone> (absent on loopback — no zone or no connect token).
export const RepoAppSchema = z.object({
    app: z.string(),
    kind: z.string().optional(),
    previewUrl: z.string().optional(),
    running: z.boolean(),
    healthy: z.boolean(),
});
export type RepoApp = z.infer<typeof RepoAppSchema>;
export const AppsListSchema = z.object({ apps: z.array(RepoAppSchema) });
export type AppsList = z.infer<typeof AppsListSchema>;
// One workspace package in a pnpm monorepo, discovered from pnpm-workspace.yaml's packages globs. `dir` is the
// repo-relative package dir (e.g. "_editor/web"); `group` is its top-level dir segment (e.g. "_editor"), the
// dependencies view's coloring axis.
export const WorkspacePackageSchema = z.object({ name: z.string(), dir: z.string(), group: z.string() });
export type WorkspacePackage = z.infer<typeof WorkspacePackageSchema>;
export const WorkspaceDepTypeSchema = z.enum(["prod", "dev", "peer"]);
export type WorkspaceDepType = z.infer<typeof WorkspaceDepTypeSchema>;
// A workspace-internal dependency edge: `from` DEPENDS ON `to` (from's package.json lists to), typed by which
// dependency block declared it. Pure data — layout/direction is the client's concern.
export const WorkspaceDepEdgeSchema = z.object({ from: z.string(), to: z.string(), type: WorkspaceDepTypeSchema });
export type WorkspaceDepEdge = z.infer<typeof WorkspaceDepEdgeSchema>;
export const WorkspaceGraphSchema = z.object({ packages: z.array(WorkspacePackageSchema), edges: z.array(WorkspaceDepEdgeSchema) });
export type WorkspaceGraph = z.infer<typeof WorkspaceGraphSchema>;
// Path params for the per-repo apps routes: the monorepo name (validated in the handler like PanelRepoParam)
// and, for per-app preview control (start/stop), the app key (api/web/landing).
export const RepoAppsParamSchema = z.object({ repo: z.string() });
export const AppParamSchema = z.object({
    repo: z.string(),
    app: z
        .string()
        .min(1)
        .regex(/^[a-z][a-z0-9-]*$/),
});

// ---- inventory: the i.have.* / i.want.service entries in deploy.config.ts's managed region ----
// The daemon renders/parses these; the browser edits them through the inventory routes. Moved here from the
// daemon's deploy-config.ts so the daemon and the browser validate against ONE schema (no cross-repo dupes).

export const InventoryProviderSchema = z.enum(["host", "cloudflare", "github", "gitlab", "stripe"]);
export type InventoryProvider = z.infer<typeof InventoryProviderSchema>;
export const ServiceKindSchema = z.enum(["signoz", "outline", "paperless", "openproject", "invoiceninja", "infisical"]);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;
// Non-secret option values the user provides; secret options (sshKey, apiToken, apiKey) are emitted as env()
// references and never travel over the wire.
export const InventoryValuesSchema = z.record(z.string(), z.union([z.string(), z.number()]));
// `const <name>` binding in deploy.config.ts, so it must be a valid identifier.
const inventoryName = z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
export const BackendEntrySchema = z.object({
    kind: z.literal("backend"),
    provider: InventoryProviderSchema,
    name: z.string(),
    values: InventoryValuesSchema,
});
export const ServiceEntrySchema = z.object({
    kind: z.literal("service"),
    service: ServiceKindSchema,
    name: z.string(),
    values: InventoryValuesSchema,
    on: z.string(),
    expose: z.string(),
});
// i.want.app — a deployable app built from source. Single production environment on `main`; `values.domain` is
// where it's exposed. Multi-env/teams/use wiring is hand-authored outside the managed region.
export const AppEntrySchema = z.object({
    kind: z.literal("app"),
    name: z.string(),
    values: InventoryValuesSchema,
    on: z.string(),
    expose: z.string(),
});
export const InventoryEntrySchema = z.discriminatedUnion("kind", [BackendEntrySchema, ServiceEntrySchema, AppEntrySchema]);
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;
export const AddInventoryInputSchema = z.discriminatedUnion("kind", [
    BackendEntrySchema.extend({ name: inventoryName }),
    ServiceEntrySchema.extend({ name: inventoryName }),
    AppEntrySchema.extend({ name: inventoryName }),
]);
export type AddInventoryInput = z.infer<typeof AddInventoryInputSchema>;
export const InventoryNameParamSchema = z.object({ name: z.string() });
export const InventoryListSchema = z.object({ entries: z.array(InventoryEntrySchema) });

// A deploy-target host self-registering via the connect-host script's POST /enroll (connect-token auth). The SSH
// key (+ optional Cloudflare token) is written to desired-state/.env; the host (+ cf) is upserted into inventory.
export const EnrollHostInputSchema = z.object({
    name: inventoryName,
    user: z.string().min(1),
    address: z.string().min(1),
    port: z.coerce.number().default(22),
    via: z.enum(["direct", "cloudflared"]).default("cloudflared"),
    sshKey: z.string().min(1),
    cfToken: z.string().optional(),
    // The zone the connect script resolved alongside cfToken — recorded on the i.have.cloudflare entry so
    // resolve validates against it (no re-discovery) and the Add-service dialog offers `<subdomain>.<zone>`.
    cfZone: z.string().optional(),
});
export type EnrollHostInput = z.infer<typeof EnrollHostInputSchema>;

// ---- capabilities: the sandbox's unified capability manifest (.intentic/capabilities.json) ----
// Everything a user adds to a sandbox is a capability with an idempotent apply + a status check. The manifest is
// the source of truth for what's active; `mcp`-kind entries also feed the agent's MCP servers each turn. DevOps
// is the capability that scaffolds the intent/desired-state repos — until it's active the sandbox is empty.

export const CapabilityKindSchema = z.enum([
    "devops",
    "monorepo",
    "mcp",
    "service",
    "integration",
    "cli",
    "plugin",
    "extension",
    "ssh",
    "vpn",
    "docker",
    "browser",
    "identity",
    "host",
    "agent",
    "endpoint",
]);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;
export const CapabilityStateSchema = z.enum(["active", "pending", "error", "inactive"]);
export type CapabilityState = z.infer<typeof CapabilityStateSchema>;

// Per-kind config. Secrets (an mcp token) live here and are denylisted like tools.json.
export const McpConfigSchema = z.object({ url: z.url(), token: z.string().optional() });
export const ServiceConfigSchema = z.object({
    service: ServiceKindSchema,
    domain: z.string().min(1),
    on: z.string().min(1),
    expose: z.string().min(1),
});
// External-app credential injected into DEPLOYED apps (i.have.stripe → STRIPE_API_KEY from env). Agent-facing
// connectors are `cli` capabilities instead (see below), not integrations.
// Closed, unlike a `cli` provider: this becomes an `i.have.<provider>` entry in deploy.config.ts, and the
// desired-state resolver only knows the providers in InventoryProviderSchema. So an integration card is NOT
// extension-contributable — the vocabulary belongs to the deploy engine, not to a manifest.
export const IntegrationConfigSchema = z.object({ provider: z.literal("stripe") });
// A `cli` capability gives the AGENT an authenticated command-line tool (not a deployed-app credential like
// `integration`): the credential + any non-secret URL are stored here and injected into the agent's env each
// turn (see cliEnvOf), and an .agents/skills/<id> cheatsheet teaches the agent to use it via curl. The provider
// data (fields, env, skill, image fragment) is DATA in an installed extension's `contributes.capabilities`, not
// a per-provider schema arm — so the config is `provider` + arbitrary string fields, validated against the
// card's declared fields at add-time (see the sandbox's capabilities/contributions.ts) rather than by this schema.
export const CliConfigSchema = z.object({ provider: z.string().min(1) }).catchall(z.string());
// A Claude Code plugin from a git repo. The daemon only owns the checkout; the Agent SDK's plugin loader reads
// its internals (skills/agents/hooks/commands/.mcp.json). `path` = subdirectory for plugins that live inside a
// marketplace/monorepo checkout. `token` = https auth for private repos (never echoed; becomes hasToken).
export const PluginConfigSchema = z.object({
    url: z.url(),
    // Branch / tag / commit sha to pin; absent = the default branch's HEAD.
    ref: z.string().min(1).optional(),
    path: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "path must stay inside the checkout" })
        .optional(),
    token: z.string().min(1).optional(),
});
// An intentic extension from a git repo (an intentic-extension.json checkout — UI bundle + agent contributions
// + processes). Unlike `plugin`, `ref` is a REQUIRED full commit sha: extension code runs trusted in the
// owner's browser, so the owner approves exactly the code that runs — pin by construction, updates are explicit
// re-adds at a new sha. `path`/`token` as in PluginConfigSchema.
export const ExtensionConfigSchema = z.object({
    url: z.url(),
    ref: z.string().regex(/^[0-9a-f]{40}$/, "ref must be a full 40-character commit sha"),
    path: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "path must stay inside the checkout" })
        .optional(),
    token: z.string().min(1).optional(),
    /* The registry row's tier, copied onto the install by the browse pre-fill. `premium` is what the daemon's
     * two pool duties key off: installing (or updating) donates the owner's credits to the publisher — the
     * gate the apply passes through — and enabling needs the owner's membership. An absent tier means free,
     * donates nothing, and asks for nothing; NO usage is metered or reported either way. Self-declared rather
     * than verified against the registry (the daemon is the owner's own machine; a stripped marker skips a
     * donation the owner was choosing to make, which cheats the creator once — and is exactly the honesty the
     * open-source posture accepts and the docs state). */
    tier: z.enum(["free", "premium"]).optional(),
    /* The registry this install's row lives in, copied on by the browse pre-fill like `tier` — what the update
     * check compares the pinned sha against and reads advisories from. Absent (a hand-typed git install) falls
     * back to the official registry: if the extension is listed there, its updates and its blocked-markings
     * concern this owner exactly as much as anyone's. */
    registry: z.url().optional(),
});
// A remote machine the AGENT can reach over SSH. One capability = one machine; the id is its ssh-config Host
// alias, so the agent runs `ssh <id> "…"`. The handler writes a per-machine config block + a 0600 key/password
// file under ~/.ssh (see the ssh handler), so — unlike `cli` — nothing is injected into the agent's env, and
// several machines never collide. Discriminated by auth so exactly one credential shape is required.
export const SshConfigSchema = z.discriminatedUnion("auth", [
    z.object({
        auth: z.literal("key"),
        host: z.string().min(1),
        port: z.coerce.number().default(22),
        user: z.string().min(1),
        privateKey: z.string().min(1),
    }),
    z.object({
        auth: z.literal("password"),
        host: z.string().min(1),
        port: z.coerce.number().default(22),
        user: z.string().min(1),
        password: z.string().min(1),
    }),
]);
// ---- vpn ----
// A VPN the agent's traffic rides. One capability = one tunnel, discriminated by `provider` so a new protocol
// is a new arm (plus a driver in the daemon's vpn/), never a reinterpretation of an existing field:
//   wireguard — a pasted .conf, brought up with wg-quick.
//   fortinet  — a FortiGate SSL-VPN (what FortiClient's <sslvpn> connections speak), dialled with openconnect
//               --protocol=fortinet. openconnect is the client rather than openfortivpn because it routes over
//               tun instead of pppd: it needs exactly the tun + NET_ADMIN grant this kind already carries, and
//               no /dev/ppp device (which the runtime allowlist does not — and should not — include).
//   ipsec     — an IKEv1/IKEv2 tunnel with a pre-shared key and optional XAuth (FortiClient's <ipsecvpn>
//               connections), run by strongSwan. `aggressive` mirrors FortiClient's dial-up default.
// Connecting is NOT a config field: connect/disconnect are live operations (see vpn.contract.ts) that both the
// user and the agent drive, so a stored tunnel's up/down state is read from the OS, never from the manifest.
// `autoConnect` is the only persisted intent — whether the daemon dials this tunnel again on boot.
export const VpnProviderSchema = z.enum(["wireguard", "fortinet", "ipsec"]);
export type VpnProvider = z.infer<typeof VpnProviderSchema>;

const autoConnect = z.enum(["on", "off"]).default("on");

// FortiClient wraps every stored credential in its own "EncX <hex>" (older builds: "Enc <hex>") encryption,
// keyed to the machine that exported the config — it is NOT recoverable from the file. Pasting one is an easy
// mistake to make, because in the XML it sits exactly where the credential belongs, and the failure it causes
// is unreadable: phase 1 negotiates fine and IKE then reports "calculated HASH does not match HASH payload",
// which says nothing about where the bad value came from. Rejecting it here turns that into a sentence at the
// point of entry. (The FortiClient importer already drops these — this catches a hand-paste.)
// Exported so the add form can flag it inline on blur instead of only on a rejected round-trip — one
// definition of what "this is ciphertext, not a credential" means, shared by the browser and the daemon.
export const isForticlientCiphertext = (value: string): boolean => /^Enc[X]?\s+[0-9A-Fa-f]{8,}$/.test(value.trim());

const notForticlientCiphertext = <T extends z.ZodType<string>>(field: T, label: string): T =>
    field.refine((value) => !isForticlientCiphertext(value), {
        message: `That looks like a value copied straight out of a FortiClient config — FortiClient encrypts it with a key tied to the machine that exported it, so it can't be used here. Enter the actual ${label} (ask whoever administers the gateway).`,
    }) as unknown as T;

export const WireguardVpnConfigSchema = z.object({
    provider: z.literal("wireguard"),
    // The pasted .conf ([Interface] + [Peer]) — it holds the private key, so it's this arm's secret field.
    config: z.string().min(1),
    autoConnect,
});
export const FortinetVpnConfigSchema = z.object({
    provider: z.literal("fortinet"),
    // Gateway host only; the port is its own field so a pasted "host:port" can be split on import.
    server: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535).default(443),
    username: z.string().min(1),
    password: notForticlientCiphertext(z.string().min(1), "password"),
    // A FortiGate on a self-signed/private-CA certificate: openconnect pins this digest
    // ("sha256:…", copied from its own refusal message) instead of trusting a CA. Absent ⇒ normal CA validation.
    trustedCert: z.string().min(1).optional(),
    // Some gateways scope a login to a realm/group (openconnect --usergroup, FortiClient's tunnel realm).
    realm: z.string().min(1).optional(),
    autoConnect,
});
export const IpsecVpnConfigSchema = z.object({
    provider: z.literal("ipsec"),
    server: z.string().min(1),
    presharedKey: notForticlientCiphertext(z.string().min(1), "pre-shared key"),
    // The local IKE identity (FortiClient's <localid>) — dial-up FortiGates key their phase-1 selection off it.
    localId: z.string().min(1).optional(),
    remoteId: z.string().min(1).optional(),
    // XAuth (FortiClient's <xauth>) — absent for PSK-only tunnels.
    username: z.string().min(1).optional(),
    password: notForticlientCiphertext(z.string().min(1), "XAuth password").optional(),
    ikeVersion: z.enum(["1", "2"]).default("1"),
    // Perfect Forward Secrecy for phase 2. Must match the gateway EXACTLY: it decides whether a KE payload is
    // sent in quick mode, and a mismatch fails with NO_PROPOSAL_CHOSEN only after phase 1 and XAuth have
    // succeeded — which reads like anything but a phase 2 problem. FortiClient stores it as <pfs> under
    // <ipsec_settings> and defaults it on, so that is the default here too.
    pfs: z.enum(["on", "off"]).default("on"),
    // The Diffie-Hellman group, as FortiClient numbers them. ONE field for both phases on purpose: in IKEv1
    // strongSwan sends a single KE payload in quick mode and the phase-2 group ends up following phase 1, so
    // offering a phase-1 list that starts with a different group than the gateway wants for phase 2 fails with
    // NO_PROPOSAL_CHOSEN no matter what the esp= line says. 14 (modp2048) is FortiClient's phase-2 default;
    // it is <dhgroup> under <ipsec_settings> in an export.
    dhGroup: z.enum(["2", "5", "14", "15", "16", "19", "20"]).default("14"),
    // IKEv1 aggressive mode: insecure by construction, and exactly what FortiGate dial-up with a group PSK
    // requires — hence opt-in per connection rather than a global strongSwan setting.
    aggressive: z.enum(["on", "off"]).default("on"),
    // WHICH networks ride the tunnel — strongSwan's rightsubnet, the traffic selector this client offers in
    // quick mode. The single most consequential setting on an ipsec tunnel, and the one with no visible symptom
    // until it is wrong: 0.0.0.0/0 offers the gateway EVERYTHING the sandbox sends, including the sandbox's own
    // outbound connection to the model endpoint. A gateway that routes only its own networks accepts that
    // selector, assigns a virtual IP, and then black-holes the rest — so the agent goes silent mid-turn, which
    // reads as the agent breaking rather than as a VPN setting. Narrowing this to the networks actually behind
    // the gateway (10.0.0.0/8,192.168.0.0/16) fixes it with nothing lost: the gateway is asked for less, not for
    // something different, and it needs no change of its own to accept that.
    // Comma-separated because strongSwan takes a list; under IKEv1 each entry is its own CHILD_SA, which not
    // every gateway will negotiate — a list that dials as one entry is a gateway limit, not a config error.
    // The DEFAULT STAYS 0.0.0.0/0: narrowing it for everyone would cut existing tunnels off from networks they
    // reach today, and a full tunnel is right whenever the gateway does route the internet.
    routedNetworks: z
        .string()
        .default("0.0.0.0/0")
        .refine(
            (value) =>
                value
                    .split(",")
                    .map((entry) => entry.trim())
                    .every((entry) => z.cidrv4().safeParse(entry).success || z.cidrv6().safeParse(entry).success),
            {
                message:
                    "Routed networks is a comma-separated list of CIDRs, like 10.0.0.0/8,192.168.0.0/16. A single host needs its prefix too (192.168.0.168/32). Leave it at 0.0.0.0/0 to send everything through the gateway.",
            },
        ),
    autoConnect,
});
export const VpnConfigSchema = z.discriminatedUnion("provider", [WireguardVpnConfigSchema, FortinetVpnConfigSchema, IpsecVpnConfigSchema]);
/* What is OPTIONAL about the in-sandbox Docker Engine. The engine itself takes no configuring — the capability
 * either runs dockerd or it doesn't — so this holds only what a user chooses, and the bar for landing here is
 * that the sandbox works without it. (`--privileged` therefore is not here and never will be: dockerd does not
 * run without it, so a switch would offer a broken sandbox as a choice.)
 *
 * TWO FAMILIES, and which one an option belongs to is the most consequential thing about it, because it is the
 * difference between a five-second change and a five-minute one:
 *
 *   IMAGE (`gpu`) — rides the environment overlay. Changing it recomposes the Dockerfile, so it costs an
 *     owner-approved rebuild and a container recreate. Only `fragment()` may read these.
 *   ENGINE (everything below it) — /etc/docker/daemon.json, which dockerd reads at start. Changing one
 *     rewrites the file and restarts dockerd: no rebuild, no new image, but it DOES stop whatever containers
 *     the engine is running, which is why it is disclosed rather than silently applied.
 *
 * Keep the split honest in both directions: an engine option that leaked into the fragment would demand a
 * rebuild for a value dockerd re-reads anyway, and an image option applied by rewriting a file would silently
 * do nothing. The card badges the difference per field (CapabilityField.rebuild).
 *
 * Flat rather than nested, and "on"/"off" rather than booleans, because the capability form carries a flat
 * bag of strings — one spelling of a two-state config across the manifest (the vpn's pfs/aggressive) beats a
 * second one for the same shape. */
export const DockerConfigSchema = z.object({
    gpu: z.enum(["on", "off"]).default("off"),
    /* A pull-through cache or mirror, for a slow, metered or air-gapped link. The nested engine starts with an
     * empty image store, so the first `docker compose up` in a workspace pulls everything from scratch. */
    registryMirror: z.url().optional(),
    // Registries reachable over plain http or with a self-signed certificate — a LAN registry, or the one a
    // homelab runs beside the sandbox. Space- or comma-separated host:port entries.
    insecureRegistries: z.string().optional(),
    /* The subnet the nested engine carves its container networks out of. Docker's default (172.17/16 and the
     * 172.16/12 pools around it) is the single most common collision with a corporate VPN or a homelab LAN,
     * and the failure it produces is unusually cruel: the sandbox keeps working, dockerd keeps working, and
     * exactly the internal hosts the user was reaching for become unreachable — routed into a bridge instead
     * of down the tunnel. One CIDR, and the pool is carved from it. */
    addressPool: z.string().optional(),
});
// A logged-in browser session the AGENT drives via Playwright MCP tools — for social platforms whose APIs can't
// cover "all the actions" (X reads are paywalled; X community-join and YouTube community-posts have no API). The
// session lives in a persisted Chromium profile under .intentic/browser/<id>, established through the guided-login
// WebSocket (/system/browser-login) or by the agent signing in itself. Chromium itself rides this kind's
// Dockerfile fragment, applied on an owner rebuild.
//
// ONE CAPABILITY = ONE ACCOUNT, not one platform: several entries may name the same `platform` (reddit-work and
// reddit-personal), and the ID is what the profile, the login, the passkey and the agent's tool prefix are all
// keyed by — so each account signs in separately and is disconnected on its own.
//
// `platform` is an OPEN slug, not an enum, for the reason `cli`'s `provider` is: a platform is a card, a login URL
// and a skill in an installed extension's `contributes.capabilities`, so the set of them is not a fact this
// contract can know. The add route validates it against the contributed entry instead (see contributions.ts).
//
// `username`/`password` are the account's SIGN-IN CREDENTIALS, on every card rather than declared per platform
// (which box a login form wants filled is the same fact everywhere). Both optional: a profile that signed in by
// hand needs neither, and the password is the entry's SECRET — stored so the daemon can type it into the page on
// the agent's behalf (the accounts tools), never so the agent can read it. When the agent signs UP it has the
// daemon generate and store one here, so the credential outlives the profile's cookies.
//
// `catchall`, the `cli` precedent, for the card that carries no site at all: a GENERIC browser session, where the
// page to open and what the account is for are answered on the form instead of pinned in a manifest. A site card
// pins its URLs and declares no fields; the generic one declares fields and pins nothing — one kind, because
// nothing downstream of the URLs differs. Which other keys are legal is the CARD's business, checked against its
// declared fields at add-time (validateContributionConfig), not this schema's.
//
// `identity` names the identity capability this account was born from (or was filed under): the account then
// lives INSIDE that identity's browser — one profile, one set of cookies — which is what makes "Continue with
// Google" one click instead of a second Google login the platform would block. Absent ⇒ the account keeps its
// own private profile, exactly as every hand-connected account always has.
//
// `purpose` and `openedAt` are the ACCOUNT's own history, core for the same reason `identity` is: what this
// account was opened for and when are facts about the sandbox's own past, not about any site, and a site card
// that declared no fields (every one of them — a pinned-URL card declares none) could not carry them otherwise.
// They are what makes the roster answerable months later, when "do we already have an account here" is asked by
// a session that was not the one that signed up. Both optional: an account the owner connected by hand has no
// signup story to tell, and an empty purpose is better than a fabricated one.
export const BrowserConfigSchema = z
    .object({
        platform: z.string().min(1),
        username: z.string().optional(),
        password: z.string().optional(),
        identity: z.string().optional(),
        purpose: z.string().optional(),
        // ISO-8601 date, stamped when the agent opens the account — absent for one connected by hand.
        openedAt: z.string().optional(),
    })
    .catchall(z.string());
/* ONE EMAIL IDENTITY THE SANDBOX ACTS AS ONLINE — the container platform accounts are born from, and the answer
 * to "who is this sandbox on the internet" being twelve separate logins today.
 *
 * WHAT IT OWNS IS A BROWSER. An identity is one persisted Chromium profile the way a person's own browser is
 * one: Google signed in once (by the OWNER's hand, in the guided window — automated Google logins are exactly
 * what Google blocks), and every account born from it sharing those cookies, so a platform's "Continue with
 * Google" is a click rather than an email round-trip. Browser accounts join it by naming it in their `identity`
 * field; accounts that name no identity keep their own private profile, which is how work and personal stay two
 * containers — two identities, not one profile with a flag.
 *
 * WHY A CAPABILITY AND NOT A PERSONA: this card holds SECRETS (an email password the daemon types but never
 * shows) and a live profile's identity, and the personas file is committed to git precisely because it holds
 * neither (personas-store.ts). A persona is how a session BEHAVES; an identity is who the browser IS SIGNED IN
 * as. A persona may point at accounts that live inside an identity, and neither card needs to know the other
 * exists.
 *
 * `email` is the identity itself — what signup forms get typed into their username box, and how the guided
 * login knows where to start (gmail.com ⇒ accounts.google.com; `loginUrl` overrides for any other provider).
 * `password` is the entry's SECRET, the browser-config precedent: typed by the daemon, never readable.
 * `mailbox` names a connected mail capability (imap, google) the narrow code tool reads — the agent asks for
 * "the latest code from this site" and gets six digits, not an inbox.
 * `openAccounts` is THE consent switch, off by default and a select rather than a boolean (the host-scope
 * precedent — form values arrive as strings): automated signup is against most platforms' terms, so minting
 * accounts unattended is an explicit, per-identity, informed choice — never a silent global default. */
export const IdentityConfigSchema = z.object({
    email: z.string().min(3),
    password: z.string().optional(),
    mailbox: z.string().optional(),
    loginUrl: z.url().optional(),
    openAccounts: z.enum(["on", "off"]).default("off"),
});
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;
/* A connected COMPUTER of the user's own — the inverse of `ssh`, which reaches a server the sandbox can dial.
 * A machine behind NAT can't be dialled, so it dials US: the @intentic/host agent (installed by a one-liner,
 * enrolled with a single-use pairing token) holds one outbound WebSocket to this daemon and serves an MCP tool
 * surface — shell, files, screenshots — from the far end. The daemon tunnels the agent's JSON-RPC over it and
 * never implements a tool itself, so the machine's capabilities evolve with ITS binary, not with a daemon release.
 *
 * One capability = one machine. The id is the machine's name and namespaces its tools (mcp__laptop__run_command),
 * so several connected machines never collide — the `ssh` precedent. `platform` splits the SKILL pack: a Windows
 * machine is taught PowerShell and a Linux one systemd/D-Bus, and neither carries the other's noise.
 *
 * SCOPES ARE THE GRANT, and they are enforced ON THE MACHINE, never here: the daemon pushes them down on every
 * connect, and the agent refuses out-of-scope calls itself. So a sandbox that is compromised — or an agent talked
 * into it by something it read on the internet — still cannot exceed what the owner ticked. `roots` bounds file
 * reads AND writes to a set of directories (empty ⇒ the user's home).
 *
 * Like a browser `platform`, this is an OPEN slug: an OS is a card plus a skill pack in an installed extension's
 * `contributes.capabilities`, and teaching the agent a new one should not need a daemon release. */
// on/off rather than a boolean: capability configs arrive from the add form as strings (the vpn autoConnect
// precedent), and a select is what the form renders for an enum.
const hostScope = z.enum(["on", "off"]);
export const HostScopesSchema = z.object({
    // Run commands in a real shell (PowerShell on Windows, the login shell on Linux). Off ⇒ files/screen only.
    shell: hostScope.default("on"),
    // Create, modify and trash files under `roots`. Reads are always allowed within them; this is the write half.
    write: hostScope.default("off"),
    // Capture the screen. Off ⇒ screenshot refuses, and the agent is told so rather than getting a black frame.
    screen: hostScope.default("on"),
    /* Move the pointer, click, type and scroll — GUI work, for the things with no command-line way in. Its own
     * switch rather than part of `screen` because looking and touching are not the same permission: a screenshot
     * is bounded by what is on the display, while one click can confirm a dialog nobody read. Default off, like
     * `write`, and for the same reason — a user who has not thought about it should not discover the agent has
     * been driving their desktop. */
    control: hostScope.default("off"),
    /* Start, stop and restart the Intentic sandboxes running on this machine — the grant that makes one sandbox
     * the machine's supervisor. Its own switch rather than a use of `shell` because it is NARROWER: a user can
     * hand an agent the sandbox fleet without handing it a shell, and the fleet operations are named rather than
     * whatever a model improvises with docker. Default off, like every switch that changes the machine. */
    sandboxes: hostScope.default("off"),
    /* Remove a sandbox from this machine — its container, its network, and the named volumes holding its /work
     * and /history. Its own switch rather than part of `sandboxes` because the two differ in the only way that
     * matters here: everything `sandboxes` grants is undone by doing it again, and this is undone by nothing.
     * A user who delegated "restart my sandboxes when they wedge" did not thereby agree to lose one. */
    sandboxRemove: hostScope.default("off"),
    // One directory per line. Empty ⇒ the machine's home directory, which is what the agent reports at connect.
    roots: z.string().optional(),
});
export type HostScopes = z.infer<typeof HostScopesSchema>;
export const HostConfigSchema = HostScopesSchema.extend({ platform: z.string().min(1) });
// An ACP (Agent Client Protocol) agent served as a chat provider: the daemon spawns `command` as a long-lived
// subprocess speaking JSON-RPC over stdio, and the capability id becomes the provider id in the chat picker
// (see AgentProviderSchema). `command` is split on whitespace — no shell quoting. `env` is a pasted KEY=VALUE
// block (one per line); credentials ride here, so the whole block is the secret field (echoed as hasSecret) —
// the vpn-conf precedent. `loginCommand` is an interactive login the user completes in a visible terminal
// (device-code flows); the agent persists credentials in its own store inside the container. `name` is the
// picker's display label; absent = the id.
export const AcpAgentConfigSchema = z.object({
    command: z.string().min(1),
    name: z.string().min(1).optional(),
    env: z.string().optional(),
    loginCommand: z.string().min(1).optional(),
});

/* A MODEL API THE USER POINTED US AT — one shape for every server that serves models over HTTP, whether it runs
 * beside this container or in another datacentre. There is deliberately NO local/remote axis: an Ollama on the
 * docker host, a vLLM on the GPU box down the hall, a LiteLLM gateway and OpenRouter differ only in the URL, and
 * inventing a distinction would mean two code paths, two cards and two sets of bugs for one concept.
 *
 * `protocol` is the only real fork, and it is about the WIRE, not about where the server lives:
 *   openai    — the endpoint speaks OpenAI /v1/chat/completions (Ollama, vLLM, llama.cpp, LM Studio, TGI,
 *               OpenRouter, most gateways). The Claude Code harness speaks only the Anthropic Messages API, so
 *               these are re-served through the bundled translator, which is already in the image for exactly
 *               this job (agent/translator.ts). The user's key stays in the translator's config on /history and
 *               never reaches the harness — it gets the loopback bearer instead.
 *   anthropic — the endpoint already speaks the Anthropic Messages API (LiteLLM's /v1/messages, a Bedrock or
 *               Vertex router, a corporate Anthropic gateway). Nothing to translate: the harness is pointed
 *               straight at it with the user's own key.
 *
 * `headers` is a pasted `Name: value` block, one per line — the extra headers gateways ask for (a tenant id, a
 * routing hint). The key is the secret field; the header block is not, because it is where non-credential
 * routing metadata lives and hiding it would make a misrouted endpoint undiagnosable. */
export const EndpointProtocolSchema = z.enum(["openai", "anthropic"]);
export type EndpointProtocol = z.infer<typeof EndpointProtocolSchema>;
export const EndpointConfigSchema = z.object({
    // The API root, INCLUDING the version segment the server publishes (…:11434/v1). Taken verbatim rather than
    // normalised: "which suffix does this server want" is the one thing that actually varies between them, and
    // guessing it is how a working URL becomes an unexplainable 404.
    baseUrl: z.url(),
    protocol: EndpointProtocolSchema.default("openai"),
    apiKey: z.string().optional(),
    headers: z.string().optional(),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;
export type CliConfig = z.infer<typeof CliConfigSchema>;
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
export type ExtensionConfig = z.infer<typeof ExtensionConfigSchema>;
export type SshConfig = z.infer<typeof SshConfigSchema>;
export type WireguardVpnConfig = z.infer<typeof WireguardVpnConfigSchema>;
export type FortinetVpnConfig = z.infer<typeof FortinetVpnConfigSchema>;
export type IpsecVpnConfig = z.infer<typeof IpsecVpnConfigSchema>;
export type VpnConfig = z.infer<typeof VpnConfigSchema>;
export type DockerConfig = z.infer<typeof DockerConfigSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type HostConfig = z.infer<typeof HostConfigSchema>;
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;
export type EndpointConfig = z.infer<typeof EndpointConfigSchema>;

export const CapabilitySchema = z.discriminatedUnion("kind", [
    z.object({ id: entryId, kind: z.literal("devops"), config: z.object({}) }),
    // A pnpm+turbo monorepo the user scaffolds as its own repo; the `id` is the repo name. No config — apps are
    // added into it afterwards from its operator panel.
    z.object({ id: entryId, kind: z.literal("monorepo"), config: z.object({}) }),
    z.object({ id: entryId, kind: z.literal("mcp"), config: McpConfigSchema }),
    z.object({ id: entryId, kind: z.literal("service"), config: ServiceConfigSchema }),
    z.object({ id: entryId, kind: z.literal("integration"), config: IntegrationConfigSchema }),
    z.object({ id: entryId, kind: z.literal("cli"), config: CliConfigSchema }),
    z.object({ id: entryId, kind: z.literal("plugin"), config: PluginConfigSchema }),
    z.object({ id: entryId, kind: z.literal("extension"), config: ExtensionConfigSchema }),
    z.object({ id: entryId, kind: z.literal("ssh"), config: SshConfigSchema }),
    // No IFNAMSIZ cap on the id: the tunnel's interface name is DERIVED (see the daemon's vpn/vpn-paths.ts
    // interfaceName) rather than being the id itself, so a descriptive name is free.
    z.object({ id: entryId, kind: z.literal("vpn"), config: VpnConfigSchema }),
    // The in-sandbox Docker Engine (baked into the base image, dormant by default). Its `--privileged` runtime
    // directive is not in the config and never will be: dockerd does not work without it (see the handler's
    // isPrivileged), so a switch there would offer a broken sandbox as a choice. What IS optional lives in
    // DockerConfigSchema. No remove — the engine's state (/var/lib/docker) and whatever runs on it make a
    // silent de-privilege more destructive than useful.
    z.object({ id: entryId, kind: z.literal("docker"), config: DockerConfigSchema }),
    z.object({ id: entryId, kind: z.literal("browser"), config: BrowserConfigSchema }),
    // One email identity the sandbox acts as online — the browser-owning container accounts are born from
    // (IdentityConfigSchema). Browser entries join it via their `identity` field.
    z.object({ id: entryId, kind: z.literal("identity"), config: IdentityConfigSchema }),
    z.object({ id: entryId, kind: z.literal("host"), config: HostConfigSchema }),
    z.object({ id: entryId, kind: z.literal("agent"), config: AcpAgentConfigSchema }),
    // A model API (EndpointConfigSchema). The id becomes `endpoint/<id>` in the chat picker — the `agent` kind's
    // precedent, with the prefix because these two are the only capability kinds that mint providers and they
    // want opposite ability records (an ACP agent owns its own loop; an endpoint runs the full Claude Code one).
    z.object({ id: entryId, kind: z.literal("endpoint"), config: EndpointConfigSchema }),
]);
export type Capability = z.infer<typeof CapabilitySchema>;

/* A NAMED PERSONA THE SANDBOX SHOWS THE OUTSIDE WORLD — "work-reddit", "the studio account" — and the layer
 * that decides which connected accounts a given turn may act through.
 *
 * IT ANSWERS FOUR QUESTIONS AND NO MORE: who it speaks as, what it may do, where it works, and what it is told.
 * Making one is then a name, a few accounts, some switches and — only if you want one — a prompt. That is the
 * whole of what an owner is deciding, and short enough that they finish.
 *
 *   NO PUBLISH-OR-DRAFT SWITCH. It read as a lock and was a sentence: it asked the turn to route outward things
 *   through the approvals queue and could not stop it posting. The queue is the mechanism, and a control whose
 *   label promises more than it delivers is worse than no control — it is the one an owner trusts.
 *
 *   THE FOURTH QUESTION IS THE SYSTEM PROMPT, NOT A TONE NOTE, and the difference is why the field that used to
 *   sit here was removed and this one is not it. What was removed was a paragraph on how a persona WRITES:
 *   optional, answered by almost nobody, and shaping nothing a person could see afterwards. `systemPromptMode`
 *   is the same setting the sandbox has, asked per card — it replaces the whole prompt, and with the kit folder
 *   beside it (persona-kit.ts) a card can carry its own skills and tools too. That is a persona being a working
 *   posture rather than a label, and it shows: a release-notes writer and a code reviewer are two prompts, not
 *   two adjectives.
 *
 * THE CARD AND THE KEYS ARE DELIBERATELY SEPARATE. This is the card: a name, the accounts it speaks for, what a
 * session wearing it may do, where it works. It carries NO credential, which is what lets it be the one thing under
 * .intentic that is committed and reviewed like the workspace's instructions are (see personas-store.ts for
 * the exclude carve-out that makes that true). The keys — the logged-in browser profile, its cookies, its
 * passkey — stay where they already are: private to the sandbox, never exported without an explicit opt-in. So a
 * cloned workspace arrives listing its personas, each visibly unconnected, waiting for one sign-in apiece.
 *
 * WHAT IT IS NOT is a security boundary. A chat still reaches every connected account by default (that is the
 * owner's chosen posture — a chat has a human in the room), and an agent with a shell can reach a token whatever
 * this file says. What it prevents is the mistake this codebase already names as the one that cannot be undone:
 * a post from the wrong account. Where nobody is watching — an unattended wake — it is a real fence, because
 * there the resolver's default is NOTHING rather than everything (see turnPersona in personas.ts). */
/* WHAT A PERSONA MAY DO — the shelves, one switch each, and the half of the card that bounds the turn rather
 * than the account it speaks for.
 *
 * SHELVES, NOT TOOL NAMES. Every field here is a phrase a person decides about ("run commands", "read the
 * web"), never the name of a tool. Tool names drift with every runtime upgrade, one power answers to several of
 * them, and a connector is not a tool at all — it is a shell command plus a credential. Naming the shelf means
 * a tool added next month lands inside an answer the owner already gave, and a card written today still means
 * what it said after the SDK renames something.
 *
 * TWO STRENGTHS, AND THE DIFFERENCE IS VISIBLE FROM HERE. Everything capability-shaped (`connectors`,
 * `computers`, `mcp`, and the accounts in `capabilities`) is enforced by ABSENCE — the credential is never
 * injected, the server never mounted, the browser never launched — which is the same mechanism the account
 * filter already uses and needs no cooperation from the model. The plain switches are enforced by taking the
 * tools out of the turn's context, which holds for every tool the harness owns and cannot reach a program the
 * agent runs for itself.
 *
 * WHICH IS WHY `shell` IS THE ONE THAT DECIDES. A session with a shell can read a credential this card never
 * granted it, so switching it off is what turns the rest of these into a fence; leaving it on leaves them a
 * strong default. The card's own UI says so at the switch — see PersonaForm.vue — because a limit that is
 * weaker than it looks is worse than no limit at all.
 *
 * PERMISSIVE BY DEFAULT, deliberately, and the opposite of the account rule directly below it. An unrepeatable
 * public post is worth defaulting to nothing for; an over-powered turn inside a container the owner can throw
 * away is not, and it is the same reasoning that makes bypassPermissions this sandbox's default posture. So an
 * absent `powers` means today's full toolbox, and a workspace that never opens this notices nothing. */
export const PersonaPowersSchema = z.object({
    // "read" is look-and-search only; "write" adds creating and changing; "none" takes both away.
    files: z.enum(["none", "read", "write"]).default("write"),
    // Shell commands, and with them the terminals, the test runs, and every CLI on the image. See the header:
    // this is the switch the others' strength depends on.
    shell: z.boolean().default(true),
    /* The JS execution backend (AgentCapabilities.execution): the model writes a script instead of a command
     * line, run in a permission-fenced Node subprocess. Its fence is REAL where the shell's is not — reads and
     * writes follow the `files` answer, and it can start no other program unless `shell` is also on — with one
     * stated gap: the fence cannot cut the network, so a script can fetch whatever `web` says. */
    code: z.boolean().default(true),
    // Fetch a page, run a search.
    web: z.boolean().default(true),
    // The credential-free browser. The SIGNED-IN browsers are `capabilities` below — a different question, and
    // the reason this one is safe to leave on: it holds nobody's account.
    browser: z.boolean().default(true),
    // Spawn sub-agents and run workflows.
    delegate: z.boolean().default(true),
    /* Change the sandbox itself: its settings and manifests, and the public outbox that publishes a file to
     * anyone with the link. Enforced as a refusal on the paths that carry those, not as a tool switch — there
     * is no "install a capability" tool to take away, only files that mean it. */
    sandbox: z.boolean().default(true),
    /* The connected accounts and services this persona may reach, BY ID. Absent means every one of them, which
     * is what a card that has never thought about it should get; an empty list means none. That tri-state is the
     * whole reason these are optional rather than defaulted arrays — "all" and "none" are both real answers and
     * an empty default could only spell one of them. */
    connectors: z.array(entryId).max(100).optional(),
    computers: z.array(entryId).max(50).optional(),
    mcp: z.array(entryId).max(50).optional(),
});
export type PersonaPowers = z.infer<typeof PersonaPowersSchema>;

/* WHERE A PERSONA WORKS — the third question after who it is and what it may do.
 *
 * `folders` is the one field here that promises less than it looks like it promises, and the card says so where
 * it is set: it is enforced by refusing file tool calls that point outside, which stops a misread instruction
 * and an honest mistake, and does not stop a shell. The workspace-wide fence is the container. */
/* WHERE A SESSION WEARING THIS CARD WORKS — the folder it opens in, and the folders its file tools may touch.
 *
 * There is no placement field, and that is a decision rather than an omission. A card used to be able to ask
 * for the SHARED tree instead of its own copy; every surface already defaults to a private worktree
 * (conversation.ts), so the setting existed only to opt out of the isolation that makes parallel work safe —
 * expressed in three words ("whatever started it", "its own copy", "the shared workspace") that a reader had no
 * way to choose between. A persona starts where it is told and works in its own copy. */
export const PersonaWorkspaceSchema = z.object({
    // The repo (or folder) under the workspace a session starts in. Absent ⇒ the workspace root, as today.
    startIn: z.string().max(200).optional(),
    // Workspace-relative folders the file tools may touch. Absent ⇒ anywhere under the workspace.
    folders: z.array(z.string().min(1)).max(50).optional(),
});
export type PersonaWorkspace = z.infer<typeof PersonaWorkspaceSchema>;

export const PersonaSchema = z.object({
    id: entryId,
    // What the owner calls it in the composer chip. Absent ⇒ surfaces read the id, which is already human-chosen.
    label: z.string().max(60).optional(),
    /* The capability ids this persona acts THROUGH — the logged-in browser accounts (and, later, the credential
     * connectors) that are its hands. Ids rather than platforms, because "two accounts of one site" is the whole
     * problem: `reddit-work` and `reddit-personal` are two capabilities and exactly one of them belongs here.
     *
     * An id naming a capability that isn't connected is not an error — it is a card describing an account this
     * sandbox has yet to sign into, which is precisely what a freshly cloned workspace looks like. */
    capabilities: z.array(entryId).max(50),
    /* Which workspace repos prefer this persona, so a chat opened on a project starts with the right chip already
     * selected. A PREFERENCE, not a fence — the owner's chosen chat default is still "every account" — and it
     * lives on the card rather than in each project's own config so that one account named by three repos stays
     * one definition instead of three that drift. */
    repos: z.array(z.string().min(1)).max(50).optional(),
    // What a session wearing this card may do, and where it works. Both absent ⇒ the full toolbox and the whole
    // workspace, so a card written before these existed keeps behaving exactly as it did.
    powers: PersonaPowersSchema.optional(),
    workspace: PersonaWorkspaceSchema.optional(),
    /* WHICH SYSTEM PROMPT A SESSION WEARING THIS CARD RUNS ON — the same three bases the sandbox chooses
     * between, asked per card. ABSENT is the fourth answer and the default: follow the sandbox, which is what
     * every card meant before this field existed and what almost every card will go on meaning.
     *
     * Absent rather than a fifth enum value spelling the same thing. "inherit" and "not set" would be two
     * spellings of one answer, and the surface that offers four options maps its first to leaving this off.
     *
     * THE TEXT IS NOT HERE. Under "custom" it is `PROMPT.md` in the card's own kit folder
     * (personas/persona-kit.ts), for two reasons that point the same way: a system prompt is prose, and prose
     * belongs in a file where it diffs line by line rather than as one escaped string inside a record nobody
     * writes by hand — and the kit is already where that persona's skills and tools live, so there is one folder
     * to look in rather than a field here and a directory there.
     *
     * "custom" with no PROMPT.md written yet falls back to the sandbox's answer rather than running the turn on
     * an empty prompt: the card is half-made, and a half-made card should behave like the one it was before
     * somebody started editing it. */
    systemPromptMode: SystemPromptModeSchema.optional(),
});
export type Persona = z.infer<typeof PersonaSchema>;

/* THE ONE CARD ID THE PRODUCT NAMES ITSELF — the read-only persona a public web chat answers through.
 *
 * Nothing else is stock: a fresh workspace has no personas at all, and every card on the Personas page is one
 * the owner wrote. This id is the exception because a Doorbell is driven by a stranger with nobody watching, so
 * it is the one wake whose bounds cannot be left to the prompt's wording — the daemon writes the card the moment
 * a Doorbell is saved (personas/front-desk.ts) and the automations form fills a blank Doorbell persona with it.
 *
 * It lives HERE because those two are in different packages and must agree exactly. A literal in each would
 * drift into a Doorbell pinned to a card nobody creates, and turnPersona answers a missing card by denying
 * everything — a public chat that cannot even read, which is safe and useless.
 *
 * It is FRONT DESK and not "visitor": the card is who answers the people who arrive, not the person arriving. */
export const FRONT_DESK_PERSONA = "front-desk";

/* HOW BOUNDED A CARD IS, in one phrase — for the row badge on the Personas page and for the sentence under the
 * automations composer's persona picker.
 *
 * It lives in the contract rather than in either surface because those two are in different packages and would
 * otherwise each grow their own vocabulary for the same card: a workspace where the Personas page says
 * "Read-only" and the automation under it says "3 limits" is one where the reader cannot tell whether they are
 * looking at the same thing.
 *
 * TWO NAMED SHAPES AND THEN A COUNT. "Read-only" and "no shell" are the two people actually reach for, so they
 * get words; everything else gets a number, because listing four switched-off shelves in a badge produces a line
 * nobody reads and buries the one fact that matters — that this card is limited at all. */
export const personaBounds = (persona: Persona): string => {
    const powers = persona.powers;
    if (powers === undefined) {
        return "Full powers";
    }
    const resolved = PersonaPowersSchema.parse(powers);
    if (resolved.files === "read" && !resolved.shell) {
        return "Read-only";
    }
    if (!resolved.shell) {
        return "No shell";
    }
    const limits = [
        resolved.files === "none",
        !resolved.code,
        !resolved.web,
        !resolved.browser,
        !resolved.delegate,
        !resolved.sandbox,
        resolved.connectors !== undefined,
        resolved.computers !== undefined,
        resolved.mcp !== undefined,
    ].filter(Boolean).length;
    return limits === 0 ? "Full powers" : `${limits} limit${limits === 1 ? "" : "s"}`;
};

export const PersonaIdParamSchema = z.object({ id: entryId });
/* Every persona, plus which of the accounts they name this sandbox is actually signed into. The second half is
 * what makes the list honest on a freshly cloned workspace: every card is present and most of them cannot act
 * yet, and a surface that showed only the cards would present a persona that is one login away from working as
 * though it already did. Ids the manifest has no capability for at all are `connected: false` too — a card may
 * name an account nobody has added here. */
export const PersonasListSchema = z.object({
    personas: z.array(PersonaSchema),
    connected: z.array(z.string()),
});

/* A PERSONA'S KIT, as one read — the prompt it runs on and the skills it carries.
 *
 * ONE ROUTE FOR BOTH because they are one folder and one screen: the card's editor draws them together, and two
 * requests to render one section is two chances for it to arrive half-drawn. The skills come back as name and
 * description only, for the same reason the sandbox's own skill list does — a body runs to thousands of words
 * and a group of one-line rows should not cost a hundred kilobytes to draw.
 *
 * An empty prompt is a card with no PROMPT.md, which is every card until somebody writes one. It is "" rather
 * than absent because the field behind it is a textarea, and a textarea's empty value is "". */
export const PersonaKitSchema = z.object({
    prompt: z.string(),
    skills: z.array(z.object({ name: z.string(), description: z.string() })),
});
export type PersonaKit = z.infer<typeof PersonaKitSchema>;

export const PersonaPromptSchema = PersonaIdParamSchema.extend({ prompt: z.string().max(20000) });
export const PersonaSkillSchema = PersonaIdParamSchema.extend(SkillDraftSchema.shape);
export const PersonaSkillNameSchema = PersonaIdParamSchema.extend({ name: SkillNameSchema });
// One kit skill's instructions, for editing it — the same split the sandbox's own skills make between a listing
// and a body, and for the same reason.
export const PersonaSkillBodySchema = z.object({ name: z.string(), description: z.string(), body: z.string() });

/* `code` is a credential the owner has to TYPE SOMEWHERE ELSE to finish this connection — WhatsApp's
 * link-a-device code, typed into the phone. It is not part of `detail` because the card does not merely print
 * it: it sets it in a size you can read across a desk, next to a copy button, and replaces it in place when the
 * provider mints a new one. A sentence with a code buried in it cannot be any of those things. */
export const CapabilityStatusSchema = z.object({
    state: CapabilityStateSchema,
    detail: z.string().optional(),
    code: z.string().optional(),
});
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
// The list row: manifest entry + live status. Secrets are never returned (an mcp token becomes hasToken).
export const CapabilitySummarySchema = z.object({
    id: z.string(),
    kind: CapabilityKindSchema,
    status: CapabilityStatusSchema,
    config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
/* A capability the WORKSPACE asks for but the manifest doesn't carry — derived from what is checked out under
 * /work, not from anything the user configured. It exists because the failures it prevents are illegible: a
 * compose-backed dev database (`pnpm db:up`) dies on a missing /var/run/docker.sock, and nothing on that error
 * points at the one-time privileged rebuild that fixes it; a workspace full of GitHub repos gets an agent that
 * cannot read one issue until somebody thinks to go looking for the card.
 *
 * KEYED BY CATALOG CARD, NOT BY KIND, because github, gitlab, komodo and every other connector share the single
 * `cli` kind — a kind cannot say which card to open, and matching on one badged all of them at once.
 *
 * WHAT IS STORED IS WHAT WAS SEEN. `evidence` is the artifact itself — a workspace-relative path, a git remote —
 * rendered verbatim so the claim is checkable rather than believed, and `reason` is the same claim in the user's
 * words with the evidence NOT repeated into it. A recommendation is re-derived on every read rather than
 * remembered, so one whose evidence has since moved simply stops being made.
 *
 * `prefill` is the non-secret config the scan could read (a self-hosted instance url, a Komodo core) — it fills
 * the card's form so the user supplies only the credential. Secrets are NEVER in here, even when one is sitting
 * in a checked-in file: the flow points at such a file as evidence, it does not absorb what is in it. */
export const CapabilityRecommendationSchema = z.object({
    card: z.string(),
    evidence: z.string(),
    reason: z.string(),
    prefill: z.record(z.string(), z.string()),
});
export type CapabilityRecommendation = z.infer<typeof CapabilityRecommendationSchema>;
export const CapabilitiesListSchema = z.object({
    capabilities: z.array(CapabilitySummarySchema),
    // Defaulted for the daemon-older-than-browser seam: the platform's web app talks to whichever sandbox
    // version the user has, and a required field here would fail the parse — taking the whole Capabilities page
    // down on every sandbox predating this route, to hide a badge.
    recommendations: z.array(CapabilityRecommendationSchema).default([]),
});
export const CapabilityIdParamSchema = z.object({ id: z.string() });
/* One capability's config VERBATIM — secrets included — for the connection route (capabilities.connection).
 * The one read on this surface that does not echo secrets as hasToken booleans, which is exactly why it is
 * never served to a browser: its handler refuses any caller with a member identity, leaving only the daemon's
 * header grants (an extension backend's minted token, which must declare the route in permissions.daemon).
 * The values are the strings the capability stored; the caller knows its own kind's field names. */
export const CapabilityConnectionSchema = z.object({
    id: z.string(),
    kind: z.string(),
    config: z.record(z.string(), z.string()),
});
export type CapabilityConnection = z.infer<typeof CapabilityConnectionSchema>;
// DELETE /capabilities/recommendations/{card}: the user said this one is not wanted. The EVIDENCE it was
// declined against is recorded daemon-side rather than sent, so the client cannot dismiss a claim other than the
// one it was shown — and so the recommendation comes back by itself when the workspace changes under it.
export const CapabilityCardParamSchema = z.object({ card: z.string() });
// POST /capabilities/{id}/secret body: replace just the capability's secret field (its key is per-kind, see the
// sandbox's secretField) and re-run its idempotent apply — the /secrets page's edit path.
export const CapabilitySecretInputSchema = z.object({ id: z.string(), value: z.string().min(1) });
/* POST /capabilities/{id}/rename body: the name this connection should answer to from now on.
 *
 * A capability's id IS the agent's handle for it — its skill file, its tool prefix, its env suffix, the alias
 * `ssh <name>` resolves — so renaming one is a migration and not a label edit. The shape of a name is therefore
 * the same rule the add form enforces, spelled here because the daemon is the gate: letters and digits to start,
 * then hyphens and underscores. Which KINDS may be renamed at all is the handler's own answer (capability.ts
 * `rename`), not something a schema can say. */
export const CapabilityRenameSchema = z.object({
    id: z.string(),
    to: z
        .string()
        .min(1)
        .max(60)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
});
// POST /capabilities/{id}/login response: the interactive tmux session running the agent's loginCommand,
// which the web surfaces in the terminal panel for the user to complete the sign-in.
export const CapabilityLoginSchema = z.object({ session: z.string() });
// GET /capabilities/{id}/otp response: one freshly minted TOTP code off the capability's stored seed — what the
// in-sandbox `otp` command prints. The seed itself never crosses; secondsRemaining is the caller's cue to
// re-mint rather than submit a code about to die.
export const CapabilityOtpSchema = z.object({ code: z.string(), secondsRemaining: z.number() });

// ---- hosts: the user's own connected computers (the `host` capability's live half) ----
// The manifest says which machines the user INTENDS to have connected; this says which are actually holding a
// socket right now. Nothing here is remembered across a daemon restart except the enrollment itself: a machine
// is "online" exactly while its WebSocket is attached, so a laptop that closed its lid reads as offline within
// a heartbeat rather than staying green until someone asks it to do something.

// What a machine reports about itself once, at connect (the agent's own `host.describe`, cached until it
// reconnects). It is the difference between an agent guessing what is on the box and knowing: the SKILL pack
// tells it HOW to drive Windows, this tells it WHICH Windows this is.
export const HostFactsSchema = z.object({
    // The OS's own name for itself — "Windows 11 Pro 24H2", "Ubuntu 24.04.1 LTS".
    os: z.string(),
    arch: z.string(),
    // The shell run_command actually spawns, so the agent writes for the right one from its first command.
    shell: z.string(),
    // The machine's home directory, and the default root when the capability declares none.
    home: z.string(),
    // Roots in force right now (the capability's `roots`, or [home]) — the agent sees its own boundary.
    roots: z.array(z.string()),
});
export type HostFacts = z.infer<typeof HostFactsSchema>;

export const HostSummarySchema = z.object({
    // The capability id — the machine's name, and the prefix of its tools (mcp__<id>__run_command).
    id: z.string(),
    platform: z.string().min(1),
    online: z.boolean(),
    // The agent binary's version, so a machine running an old build is visible rather than mysteriously lacking
    // a tool. Absent until the machine has connected once.
    version: z.string().optional(),
    // Epoch ms of the last time this machine held a socket. Absent ⇒ it has not connected since this daemon
    // booted — liveness is a fact about a socket, so a restart forgets it rather than claiming stale uptime.
    lastSeen: z.number().optional(),
    facts: HostFactsSchema.optional(),
});
export type HostSummary = z.infer<typeof HostSummarySchema>;
export const HostsListSchema = z.object({ hosts: z.array(HostSummarySchema) });

// ---- vpn: live tunnel state + connect/disconnect ----
// The manifest says which VPNs EXIST; this says which are UP right now. Every field is read back from the OS
// (wg show / ip / openconnect's pidfile / swanctl), never remembered by the daemon — so a tunnel the agent
// dropped from a shell and one the UI dropped read identically, and a daemon restart loses nothing.

export const VpnStateSchema = z.enum([
    // The tunnel is up and carrying traffic.
    "connected",
    // Dialling: openconnect authenticated but the interface has no address yet, or strongSwan is negotiating.
    "connecting",
    // Configured and idle — the normal resting state for a tunnel nobody asked for.
    "disconnected",
    // The tunnel's client isn't installed yet: the capability's image fragment needs an owner-run rebuild.
    "unavailable",
    // The last dial failed; `detail` carries the client's own message.
    "failed",
]);
export type VpnState = z.infer<typeof VpnStateSchema>;

export const VpnLinkSchema = z.object({
    id: z.string(),
    provider: VpnProviderSchema,
    state: VpnStateSchema,
    // The gateway this tunnel dials — host:port for fortinet, the [Peer] endpoint for wireguard, the IKE peer
    // for ipsec. Display only; never a secret.
    gateway: z.string().optional(),
    // The tun/wg interface carrying the tunnel, once it exists.
    interface: z.string().optional(),
    // The address the gateway assigned this sandbox — the single most useful "am I on the VPN?" fact.
    address: z.string().optional(),
    // The CIDRs routed into the tunnel ("0.0.0.0/0" = full tunnel). Empty until the link is up.
    routes: z.array(z.string()).default([]),
    // DNS servers the tunnel pushed, when it pushed any.
    dns: z.array(z.string()).default([]),
    // Epoch ms the link came up — the UI renders "connected 14m ago". Absent unless connected.
    since: z.number().optional(),
    // Whether the daemon re-dials this tunnel on boot (the manifest's autoConnect).
    autoConnect: z.boolean(),
    // Why it is failed/unavailable, or an extra note on a healthy link. Never carries credentials.
    detail: z.string().optional(),
});
export type VpnLink = z.infer<typeof VpnLinkSchema>;
export const VpnListSchema = z.object({ links: z.array(VpnLinkSchema) });

// POST /vpn/{id}/connect body. `otp` is a one-time 2FA code, supplied per dial and NEVER stored — a FortiGate
// with token auth rejects the dial without it, and the daemon surfaces that as a retry-with-a-code error.
export const VpnConnectInputSchema = z.object({ id: z.string(), otp: z.string().min(1).optional() });
export const VpnIdParamSchema = z.object({ id: z.string() });

// POST /vpn/import-forticlient: parse an exported FortiClient configuration (the XML FortiClient writes from
// File → Settings → Backup) into addable connections. Credentials in that file are wrapped in FortiClient's
// proprietary "EncX …" encryption, which is NOT reversible here — so a parsed connection carries the endpoint
// and, when it was stored in the clear, the username; the password is always typed by the user afterwards.
export const ForticlientImportInputSchema = z.object({ xml: z.string().min(1) });
export const ForticlientConnectionSchema = z.object({
    // FortiClient's connection name, slugged into a legal capability id.
    id: z.string(),
    // The original <name>, shown so the user recognises the connection they picked.
    label: z.string(),
    provider: VpnProviderSchema,
    server: z.string(),
    port: z.number(),
    // Present only when FortiClient stored it unencrypted; an EncX-wrapped username is dropped, not guessed.
    username: z.string().optional(),
    description: z.string().optional(),
    // ipsec-only, and only when the file stored them in the clear.
    localId: z.string().optional(),
    aggressive: z.boolean().optional(),
    // Phase-2 settings, read from <ipsec_settings> — the pair that decides whether quick mode can succeed.
    pfs: z.boolean().optional(),
    dhGroup: z.string().optional(),
    // What the user still has to supply for this connection to dial (always at least the password).
    needs: z.array(z.string()),
});
export type ForticlientConnection = z.infer<typeof ForticlientConnectionSchema>;
export const ForticlientImportSchema = z.object({ connections: z.array(ForticlientConnectionSchema) });

// Browse an extension/plugin registry (a git repo with .claude-plugin/marketplace.json — see
// @intentic/registry for the format). POST so the optional token for a private registry never rides a URL or
// an access log.
export const MarketplaceRequestSchema = z.object({ url: z.url(), token: z.string().min(1).optional() });
// The rows are RegistryEntry — the curated decision joined to the resolved pointer and the scanner's upstream
// facts, exactly as the site's gallery renders them, so browsing in the app and browsing the web show one list.
export const MarketplaceSchema = z.object({ name: z.string(), plugins: z.array(RegistryEntrySchema) });
export type Marketplace = z.infer<typeof MarketplaceSchema>;

// ---- extensions: installed extension-kind capabilities resolved to their manifests ----
// What the web extension host boots from: each row is an extension capability whose checkout still parses —
// the approved manifest (contribution declarations), and the checked-out commit (the code identity; the bundle
// route's ETag). A rotted checkout is skipped here; its capability row still shows status.
// The routing handle: a git-installed extension uses its capability entry id; an image-baked one has no
// capability entry and is addressed by the manifest-derived publisher.name — hence the dot in the pattern.
const extensionId = z
    .string()
    .min(1)
    .max(121)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);

// ---- extension updates: what the registry check found, and what the owner decided to do about such findings ----

// The owner's per-extension update posture. `updates` is the ladder: `notify` (badge and wait — the default),
// `agent` (the discovery also prepares an agent diff-read of the new sha), `auto` (apply unattended, but only
// a verified listing whose powers didn't grow, health-watched with auto-revert — anything less falls back to
// notify). `advisories` is separate because its safe direction is the opposite: disabling runs no new code, so
// `auto-disable` is the default and `notify` is the opt-out.
export const ExtensionUpdatePolicySchema = z.object({
    updates: z.enum(["notify", "agent", "auto"]),
    advisories: z.enum(["auto-disable", "notify"]),
});
export type ExtensionUpdatePolicy = z.infer<typeof ExtensionUpdatePolicySchema>;

// A newer sha the registry lists for an installed extension — the "update available" badge's substance. The
// pointer (url/path) rides along because updating follows the ROW as it stands now, not the install as it was.
export const ExtensionUpdateSchema = z.object({
    ref: z.string(),
    version: z.string().optional(),
    url: z.string(),
    path: z.string().optional(),
    trust: z.enum(["verified", "listed"]),
    // The listing says this release fixes a security problem in earlier ones — the badge goes loud, because
    // here the OLD version is the dangerous one.
    securityFix: z.boolean().optional(),
    registry: z.string(),
    at: z.string(),
    // Why the auto rung refused this one and fell back to notify ("powers grew", "not verified") — the card
    // leads with it so the owner knows the click is theirs for a reason.
    needsReview: z.string().optional(),
    // The agent-prepared rung's work: the conversation where the owner's agent already read the diff between
    // the installed sha and this one. The card links it instead of offering to start it.
    review: z.object({ conversationId: z.string(), at: z.string() }).optional(),
});
export type ExtensionUpdate = z.infer<typeof ExtensionUpdateSchema>;

// The registry blocked this installed extension's listing. Delisting protects people browsing; this record is
// for the person already running it — the reason verbatim, and whether the daemon already pulled the switch.
export const ExtensionAdvisorySchema = z.object({
    reason: z.string(),
    registry: z.string(),
    at: z.string(),
    autoDisabled: z.boolean(),
});
export type ExtensionAdvisory = z.infer<typeof ExtensionAdvisorySchema>;

// The post-update watch: validation catches broken, not wrong, so for a minute after a swap the daemon checks
// that what the new version declared actually came up (autoStart processes running, backend activated).
// `fromRef` is the sha the kept-previous checkout holds — what a revert returns to.
export const ExtensionHealthSchema = z.object({
    state: z.enum(["watching", "healthy", "unhealthy"]),
    detail: z.string().optional(),
    fromRef: z.string().optional(),
    at: z.string(),
    // The auto rung's failure path already ran: the update was rolled back unattended, and the record stays to
    // say so rather than pretending the attempt never happened.
    autoReverted: z.boolean().optional(),
});
export type ExtensionHealth = z.infer<typeof ExtensionHealthSchema>;

// The mechanical comparison of two manifests' declared reach (extension-manifest's diffPowers) — plain
// sentences, so the update dialog renders exactly what approval is being asked to cover.
export const PowersDiffSchema = z.object({ added: z.array(z.string()), removed: z.array(z.string()), unchanged: z.array(z.string()) });
export type PowersDiff = z.infer<typeof PowersDiffSchema>;

// What an owner reads before clicking Update: the offered sha's manifest folded to the version story, the
// engines verdict, and the powers diff against the installed manifest. `ref` optional on the way in — absent
// means "the update the check recorded", which is the only caller most of the time.
export const ExtensionUpdateActionSchema = z.object({
    id: extensionId,
    ref: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional(),
});
export const ExtensionUpdatePreviewSchema = z.object({
    ref: z.string(),
    version: z.string(),
    installedVersion: z.string(),
    engines: z.string(),
    compatible: z.boolean(),
    powers: PowersDiffSchema,
});
// `rebuildNeeded` (update only): the new version's environment fragment changed the composed overlay, so the
// card must say a one-time image rebuild is pending rather than let the update read as wholly landed.
export const ExtensionUpdateAppliedSchema = z.object({ ok: z.literal(true), ref: z.string(), rebuildNeeded: z.boolean().optional() });
export const ExtensionUpdatePolicyInputSchema = z.object({
    id: extensionId,
    updates: z.enum(["notify", "agent", "auto"]).optional(),
    advisories: z.enum(["auto-disable", "notify"]).optional(),
});
export const ExtensionUpdatesCheckedSchema = z.object({ ok: z.literal(true), checkedAt: z.string() });

export const ExtensionSummarySchema = z.object({
    id: extensionId,
    manifest: ExtensionManifestSchema,
    commit: z.string(),
    /* Where the code comes from — which is also what the web varies per row: `builtin` (image-baked, no git
     * checkout, not removable) hides the uninstall affordance, `installed` (a git capability) shows the pinned
     * commit, `workspace` (a directory under .intentic/workspace-extensions/, created and edited in place —
     * typically by an agent) is "uninstalled" by deleting its directory. */
    source: z.enum(["builtin", "installed", "workspace"]),
    // The owner's switch (.intentic/extension-enablement.json). A disabled extension is still listed — that's
    // what makes it switchable back on — but the daemon wires none of its contributions up and the web host
    // doesn't activate it.
    enabled: z.boolean(),
    /* THE SWITCH IS FIXED ON — this extension is the only control surface for an engine the daemon runs
     * regardless. The automations scheduler fires turns on a clock whether or not anything draws them, and
     * hiding the one page that can see, stop or approve those fires would not stop the spend — it would only
     * remove the owner's ability to notice it. So the daemon refuses the flip, and the tab draws the switch as
     * fixed with this fact as the reason.
     *
     * Declared by the CORE about its own engines' surfaces, never by a manifest: a field an extension could set
     * on itself would be a pack making itself un-removable, which is a self-granted privilege the approval flow
     * exists to prevent. */
    essential: z.boolean().optional(),
    /* How much of the reach this extension asked for it has actually used, keyed by the DECLARED entry so a row
     * joins straight onto `permissions.sandbox`. Absent for an extension that has never been observed calling
     * anything, which is a different claim from "uses none of them" and has to stay tellable: a freshly installed
     * extension has an empty ledger and an unexercised one does too, and reading either as "these permissions are
     * unnecessary" would turn this from evidence into a guess with a number on it. */
    usage: z.record(z.string(), z.object({ calls: z.number().int().nonnegative(), last: z.string() })).optional(),
    /* The BACKEND half's state, present only for an extension whose manifest ships a `server` bundle: what the
     * daemon's backend host reports for it (running / an activation error with its message), or what only the
     * daemon can know (absent — the code is not in this image; incompatible — its engines exclude this daemon;
     * starting/stopped — the host itself is between states). The tab renders it beside the row so a backend
     * that failed to activate is a sentence, not a namespace that 404s. */
    backend: z
        .object({
            state: z.enum(["running", "error", "absent", "incompatible", "starting", "stopped"]),
            detail: z.string().optional(),
        })
        .optional(),
    /* The update lifecycle, present only where it can exist — a git-installed extension. `update` is the badge,
     * `advisory` the alarm, `health` the after-the-click watch, `previous` the way back (the kept one-back
     * checkout's sha), `updatePolicy` the owner's standing answer. A builtin updates with the image and a
     * workspace one is live-edited, so all five stay absent for them. */
    update: ExtensionUpdateSchema.optional(),
    advisory: ExtensionAdvisorySchema.optional(),
    health: ExtensionHealthSchema.optional(),
    previous: z.object({ ref: z.string(), version: z.string().optional() }).optional(),
    updatePolicy: ExtensionUpdatePolicySchema.optional(),
});
export type ExtensionSummary = z.infer<typeof ExtensionSummarySchema>;
// A workspace-extension directory that failed to enumerate, and why. Its only feedback channel: there is no
// install moment to reject a bad manifest, so the parse failure (or id collision) rides the list instead of
// silently dropping the row — the Extensions tab renders it, and an authoring agent reads it off GET /extensions.
export const InvalidWorkspaceExtensionSchema = z.object({ dir: z.string(), error: z.string() });
export type InvalidWorkspaceExtension = z.infer<typeof InvalidWorkspaceExtensionSchema>;
export const ExtensionsListSchema = z.object({
    extensions: z.array(ExtensionSummarySchema),
    invalid: z.array(InvalidWorkspaceExtensionSchema),
    // When the registry comparison last ran — absent until the first check completes. Serving it on the list is
    // what lets the tab say "checked an hour ago" instead of presenting staleness as certainty.
    updatesCheckedAt: z.string().optional(),
});
// The extension's contributes.settings values, persisted daemon-side (.intentic/extension-settings.json) keyed
// by the manifest-derived extension id — the checkout stays pristine, so a re-clone update never loses them.
// Secret-marked values are stripped from `settings`; `secretsSet` lists the secret keys that DO hold a value,
// so the UI renders "•••• (set)" without ever receiving the secret back.
export const ExtensionSettingsSchema = z.object({
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    secretsSet: z.array(z.string()),
});
export type ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>;
export const ExtensionSettingsInputSchema = z.object({
    id: z.string(),
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
// Flip one extension on or off. Persisted by publisher.name (like settings), so the choice outlives the
// checkout; the daemon's immediate half of the flip — declared processes — converges in the same handler.
export const ExtensionEnabledInputSchema = z.object({ id: z.string(), enabled: z.boolean() });
/* Create a workspace extension: the identity, and deliberately nothing else. What gets written is the daemon's
 * decision, not a form the author fills in — the point of the action is that a running extension exists a second
 * after it is asked for, and shaping it happens by editing the files it wrote (or by asking an agent to). The two
 * slugs are the same shape the manifest schema demands, checked again here because `name` becomes a directory. */
export const WorkspaceExtensionCreateSchema = z.object({
    publisher: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
});
// Where it landed. `dir` is workspace-root-relative so the caller can name the files it should open next.
export const WorkspaceExtensionCreatedSchema = z.object({ id: z.string(), dir: z.string() });
/* A batch of calls the host observed against this extension's declared routes — entry → how many since the last
 * report. Counts rather than events, and declared entries rather than concrete paths, because the question the
 * ledger answers is "is this permission earned?": a finer record would be a log of what the owner was doing,
 * indexed by extension, which is not a thing this product should be accumulating to answer it. */
export const ExtensionUsageInputSchema = z.object({ id: z.string(), used: z.record(z.string(), z.number().int().positive()) });
// One declared background process (contributes.processes) — status/start/stop, addressed by the capability
// entry id + the manifest's process name. Undeclared names are NOT_FOUND, the manifest-honesty rule again.
export const ExtensionProcessParamSchema = z.object({ id: z.string(), name: z.string() });
export const ExtensionProcessStatusSchema = z.object({
    name: z.string(),
    running: z.boolean(),
    port: z.number().optional(),
    previewUrl: z.string().optional(),
});
export type ExtensionProcessStatus = z.infer<typeof ExtensionProcessStatusSchema>;

// ---- automations: scheduled agent wake-ups (.intentic/automations.json) ----
// An automation wakes the agent autonomously: the daemon's scheduler fires each enabled automation on its
// trigger, runs the optional guard command (a shell command in the workspace; non-zero exit skips the wake),
// then runs one agent turn with the prompt. The manifest is user config; run history is daemon-recorded.

// `schedule` fires on its cron; `event` fires when an external system POSTs /automations/{id}/fire?token=…
// (a plain Hono route — webhook bodies are arbitrary). The token is the webhook's own auth (senders can't do
// Google ID tokens): optional on input — the daemon generates one on upsert — and always present in stored and
// listed automations, so the owner's UI can render the copyable URL.
// `listener` fires from a realtime source's connection to the provider (an extension's gateway process holds
// it, e.g. Discord) — no cron, no token, never reachable via /fire. channelId narrows to one channel; absent ⇒
// every channel the bot can read. eventType narrows to one kind of event (a Discord message, a live voice
// utterance batch, or a finished voice transcript); absent ⇒ all event kinds the source emits. mentioned
// narrows message events to those that @mention one of the workspace's bots or reply to a bot's message;
// absent ⇒ all messages. `provider` and `eventType` are open strings — a realtime source is now extension-
// declared (contributes.listener), so the daemon validates a listener trigger at upsert against `webchat` ∪ the
// installed extensions' declared providers/events rather than a hardcoded enum here.
// `webchat` is the exception: it has no gateway. An embeddable widget POSTs a visitor's message to
// /webchat/<id>/message and the agent's reply streams back over SSE. Its address is the public automation id, so
// allowedOrigins (the widget's embed sites) + a per-conversation rate limit are its abuse boundary — no secret
// token can live in a browser.
// `ci` is the other gateway-less source: the daemon's own pipeline receiver (ci/events.ts) dispatches it from a
// provider webhook, or from the REST poller on a sandbox whose hooks could not be registered. Its channelId is
// the workspace repo, and `branch` is its SECOND narrowing axis — a fleet pushes a branch per agent, so a
// pipeline trigger that can only say "this repo" says "every agent's every failure".
// `workspace` fires from the sandbox's OWN codebase instead of the outside world — see WorkspaceEventKindSchema.

// What the daemon emits as the fleet works, and what a `workspace` trigger names. These are the events a code
// CHORE runs on (continuous review, post-land checks): the daemon is both producer and consumer, so unlike
// `event` there is no token and no route — nothing outside the sandbox can reach them.
//
// The two OVERLAP on the common path: a clean turn auto-lands, firing both. A chore should name exactly one.
// `turn.settled` fires once per isolated turn whatever its outcome, so it also covers the errored and
// conflicted turns most worth a second pair of eyes, and it fires while the user is still looking at the diff —
// before they decide to land. `agent.landed` fires only when work actually reached the main tree, including an
// explicit Land from the review panel long after the turn ended.
//
// The `deps.*` pair fires from the dependency verifier (workspace/verify-deps.ts) rather than a turn: after a
// land drifts dependencies, the daemon installs them and runs the tree's own checks, and these are that chain's
// EDGES — `deps.broken` when the checks go red after a landed change, `deps.fixed` when a later land turns them
// green again. Edges, not states, on the ci-events precedent (pipeline_broken): a tree that is red and stays
// red emits nothing, so a fix chore is woken by the breakage, never by the standing colour.
export const WorkspaceEventKindSchema = z.enum(["turn.settled", "agent.landed", "deps.broken", "deps.fixed"]);
export type WorkspaceEventKind = z.infer<typeof WorkspaceEventKindSchema>;

// The payload a workspace-triggered wake carries: one JSON object, in $AUTOMATION_PAYLOAD for the guard and
// appended to the prompt for the turn.
//
// `repos` names the change to look at as an OPEN span — `git -C <dir> diff <from>`, with no upper bound. Each
// `from` is where that repo stood before the turn (its last landed tip, or the base it branched from); the
// other end is deliberately the working tree rather than a sha, because a turn that ERRORED left its work
// uncommitted in the worktree and a commit-to-commit span would report it as nothing at all. `dir` is that
// repo's dir inside the agent's own checkout, so a chore reads the agent's work without touching /work.
//
// No diffstat rides along on purpose: the registry's counts are refreshed at land, so an errored or conflicted
// turn would carry stale numbers, and a guard that wants a size threshold gets the true one from
// `git -C <dir> diff --numstat <from>` for the price of one spawn.
export const WorkspaceEventSchema = z.object({
    event: WorkspaceEventKindSchema,
    agentId: z.string(),
    title: z.string().optional(),
    branch: z.string(),
    // `ready` is a clean turn whose delta was HELD on the branch (auto-land off) — for a chore, the moment
    // before the user's deliberate Land, which is exactly when a pre-land review wants to run.
    outcome: z.enum(["landed", "conflict", "ready", "idle", "error"]),
    repos: z.array(z.object({ repo: z.string(), from: z.string(), dir: z.string() })),
    /* The `deps.*` events' own facts, absent on every turn-borne event. What a fix chore needs to start
     * without rediscovering it: which project broke, the exact command that judged it, how it exited, and the
     * tail of its output — bounded, because the payload rides a prompt and a guard's environment, and the full
     * log is one attach away in the project's `--verify` terminal panel. `attempt` counts consecutive red
     * verifies since the last green, so a guard can cap retries in one visible line of shell. */
    deps: z
        .object({
            project: z.string(),
            command: z.string(),
            exitCode: z.number(),
            attempt: z.number(),
            logTail: z.string(),
        })
        .optional(),
});
export type WorkspaceEvent = z.infer<typeof WorkspaceEventSchema>;

export const TriggerSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("schedule"), cron: z.string().min(1) }),
    z.object({ kind: z.literal("event"), token: z.string().min(1).optional() }),
    z.object({
        kind: z.literal("listener"),
        provider: z.string().min(1),
        channelId: z.string().min(1).optional(),
        eventType: z.string().min(1).optional(),
        mentioned: z.boolean().optional(),
        // ci only: the git ref the pipeline ran on. Absent ⇒ every branch of the matched repos.
        branch: z.string().min(1).optional(),
        // webchat only: the website origins allowed to POST to the widget endpoint. Absent/empty ⇒ none admitted.
        allowedOrigins: z.array(z.string()).optional(),
    }),
    // `repo` narrows to events whose span touches one workspace repo ("root" or a repo id); absent ⇒ any.
    z.object({ kind: z.literal("workspace"), event: WorkspaceEventKindSchema, repo: z.string().min(1).optional() }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

/* The Doorbell widget's settings — everything about the embeddable chat that isn't the automation's prompt.
 * Present only on `webchat` listener automations; the trigger keeps `allowedOrigins` because that one is the
 * admission gate the message route reads, not a rendering choice.
 *
 * Split deliberately into what the WIDGET may read (title/greeting/accent/position/access/googleClientId/
 * turnstileSiteKey — all public by construction, they ship to a stranger's browser) and what only the daemon
 * may read (turnstileSecret). GET /webchat/<id>/config serves the first group by naming it, never by omitting
 * the second: a field added here is invisible to the widget until it is listed there. */
export const WebchatConfigSchema = z.object({
    // `public` admits anyone; `google` refuses a message that carries no verifiable Google ID token. Absent ⇒
    // public — a Doorbell with no access setting is the anonymous support box it looks like.
    access: z.enum(["public", "google"]).optional(),
    // Ask an anonymous visitor for a display name before the first message. Cosmetic: the name is typed, so it
    // reaches the model as untrusted `displayName`, never as identity.
    requireName: z.boolean().optional(),
    /* The bot ceiling. `turnstile` is Cloudflare's (invisible, needs the site's own keys); `pow` is a
     * hashcash-style challenge the daemon issues and the widget solves in a worker, so a site with no
     * Cloudflare account still has something. Absent ⇒ off: the origin allowlist and the rate limit are then
     * the whole boundary, which is the right default for an internal or invite-only page. */
    antiBot: z.enum(["turnstile", "pow"]).optional(),
    turnstileSiteKey: z.string().optional(),
    turnstileSecret: z.string().optional(),
    // The site's OWN Google OAuth web client id. It cannot be intentic's: Google Identity Services only issues
    // a token to an authorized JavaScript origin, and intentic's client can't list every customer domain.
    googleClientId: z.string().optional(),
    /* Widget chrome. `position` picks the launcher corner.
     *
     * `accent` is a HEX colour, not any CSS colour, because the widget derives values from its channels rather
     * than just painting it: a glyph step for the scheme, a 14% wash for the send button, a bubble edge, a focus
     * ring, and the label that goes on top (see webchat-widget's styles.ts). A colour we cannot read is a widget
     * with half its accent silently missing, so the unreadable case is rejected here instead. */
    title: z.string().max(80).optional(),
    greeting: z.string().max(500).optional(),
    accent: z
        .string()
        .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "accent must be a hex colour, e.g. #e47100")
        .optional(),
    position: z.enum(["top-right", "top-left", "bottom-right", "bottom-left"]).optional(),
    /* Two ceilings on top of the route's fixed per-minute window, because a public endpoint's real exposure is
     * cost, not request rate: `dailyMessageMax` caps the whole automation per UTC day, `conversationMessageMax`
     * caps one visitor thread for its lifetime.
     *
     * `dailyMessageMax` absent ⇒ WEBCHAT_DAILY_MAX_DEFAULT, not uncapped. Every message here is an agent turn
     * billed to the owner, and the per-minute window bounds the RATE without bounding the DAY — twenty a minute,
     * sustained, is tens of thousands of turns before anyone notices. A Doorbell nobody configured should not be
     * able to spend that, so the safe number is the one you get for free and the owner raises it deliberately.
     * `conversationMessageMax` stays optional-means-uncapped: it is per visitor thread, which the daily ceiling
     * already bounds in aggregate. */
    dailyMessageMax: z.number().int().positive().optional(),
    conversationMessageMax: z.number().int().positive().optional(),
    // (WEBCHAT_DAILY_MAX_DEFAULT, below the schema, is the number `dailyMessageMax` falls back to.)
    // How long a visitor thread keeps resuming the same conversation before the next message starts a fresh
    // one. Absent ⇒ WEBCHAT_SESSION_TTL_MS (the daemon's default).
    sessionTtlMinutes: z.number().int().positive().optional(),
});
export type WebchatConfig = z.infer<typeof WebchatConfigSchema>;

/* The daily agent-turn ceiling a Doorbell gets when its owner sets none. Lives here rather than beside the
 * route that enforces it because both ends need the number: the daemon to apply it, and the automation editor
 * to show the owner what they are already protected by (an invisible limit is one people hit and file as a bug).
 *
 * 200 is chosen to be irrelevant to real support traffic and decisive against a script. A Doorbell answering
 * two hundred questions in one UTC day is a busy one; a scripted flood reaches that in ten seconds and then
 * stops costing anything. */
export const WEBCHAT_DAILY_MAX_DEFAULT = 200;

/* ---- the widget wire: three shapes GET /webchat/<id>/config, GET …/challenge and POST …/message speak ----
 *
 * They live here, beside the stored config they derive from, because the Doorbell widget is a SECOND client of
 * this daemon — a bundle running on a stranger's page — and the reason this package exists is that both ends of
 * a wire read one definition. The widget imports these as types only (`import type`), so zod never reaches a
 * visitor's browser. */

// What the widget is told about itself. Fully RESOLVED — every default is applied daemon-side, so the widget
// carries no fallback logic and one place decides what an unset field means. Everything here is public by
// construction: it ships to any browser that can reach the endpoint from an allowed origin.
export const WebchatPublicConfigSchema = z.object({
    automationId: z.string(),
    title: z.string(),
    greeting: z.string(),
    accent: z.string(),
    position: z.enum(["top-right", "top-left", "bottom-right", "bottom-left"]),
    access: z.enum(["public", "google"]),
    requireName: z.boolean(),
    // "off" is spelled out rather than left absent: the widget branches on this, and a missing field that means
    // "no challenge" is the kind of default that turns one serialization bug into an open door.
    antiBot: z.enum(["turnstile", "pow", "off"]),
    turnstileSiteKey: z.string().optional(),
    googleClientId: z.string().optional(),
});
export type WebchatPublicConfig = z.infer<typeof WebchatPublicConfigSchema>;

// A proof-of-work challenge: find a nonce whose SHA-256 of `${salt}:${nonce}` starts with `difficulty` zero
// bits. Issued per visitor conversation, spent on its first message.
export const WebchatChallengeSchema = z.object({ salt: z.string(), difficulty: z.number().int().positive() });
export type WebchatChallenge = z.infer<typeof WebchatChallengeSchema>;

// One visitor message. `conversationId` is the widget's own localStorage id — it threads the visitor's messages
// into ONE sandbox conversation, so it is the thread key, not a secret (anyone can mint one; the origin
// allowlist, the challenge and the rate limit are the gate).
export const WebchatMessageSchema = z.object({
    conversationId: z.string().min(1).max(200),
    content: z.string().min(1),
    // What the visitor TYPED as their name. Never identity — it reaches the model tagged as unverified, and a
    // signed-in visitor's verified name comes from the ID token instead.
    displayName: z.string().max(200).optional(),
    // A Google ID token from the site's own client id, verified daemon-side against Google's JWKS.
    idToken: z.string().optional(),
    // The anti-bot answer, whichever kind the config asked for. Checked once per conversation, not per message.
    turnstileToken: z.string().optional(),
    powNonce: z.string().optional(),
    // The widget's own transcript, sent ONLY on the first message of a thread — after that the sandbox
    // conversation resumes and carries its own context.
    history: z
        .array(z.object({ author: z.string().optional(), content: z.string() }))
        .max(50)
        .optional(),
});
export type WebchatMessage = z.infer<typeof WebchatMessageSchema>;

export const AutomationSchema = z.object({
    id: entryId,
    trigger: TriggerSchema,
    // Shell command run in the workspace root before waking; exit 0 ⇒ wake, non-zero ⇒ the run is "skipped".
    guard: z.string().min(1).optional(),
    prompt: z.string().min(1),
    // The Doorbell widget's settings — `webchat` listener automations only, ignored on every other trigger.
    webchat: WebchatConfigSchema.optional(),
    /* NARROW THIS ONE JOB FURTHER than the persona it runs as — raw tool names, and the escape hatch under the
     * shelves rather than the way anyone is expected to answer this question.
     *
     * The persona (`actsAs` below) is where a session's toolbox is decided now, because the answer is worth
     * reusing: the same bounds apply to the chat, the workflow and the Doorbell that name the same card. This
     * stays for the job that needs LESS than its persona allows — and only less, which is a rule the composer
     * enforces rather than a convention: an edit here can never hand back a shelf the persona switched off. */
    allowedTools: z.array(z.string().min(1)).optional(),
    // Which provider adapter serves the wake; absent ⇒ claude. Same dispatch as a chat turn (AgentTurnSchema.agent).
    agent: AgentProviderSchema.optional(),
    /* Which connected account of that provider serves the wake; absent ⇒ the provider's first account, exactly
     * as for a chat turn (AgentTurnSchema.account).
     *
     * An automation needs this more than a chat does, and for a reason a chat never meets: nobody is watching.
     * A sandbox holds several accounts side by side, and when the first one is out of headroom — or belongs to
     * an organization that has disabled the plan — every fire of every automation errors against it until a
     * human happens to read the row. Pinning the wake to an account that can actually run is the difference
     * between "my nightly sweep is quiet" and a Doorbell that turns visitors away all day. */
    account: z.string().optional(),
    /* WHICH FACE THE WAKE SHOWS THE OUTSIDE WORLD (AgentTurnSchema.actsAs — read its note for why this is not
     * spelled `account`, which is the field directly above and means who PAYS).
     *
     * Absent ⇒ the wake reaches NO logged-in account at all. That is the one place this whole layer stops being
     * a convenience and becomes a boundary, and it is deliberately the strictest default in the schema: an
     * automation fires with nobody at the composer, on a prompt that — for a Doorbell — a stranger helped write.
     * `allowedTools` above already carries this exact reasoning for tools; an unrepeatable public post deserves
     * it at least as much. An automation that genuinely means "post as us" says so, once, in a field a reviewer
     * can see. */
    actsAs: entryId.optional(),
    // Which harness (agentic loop) runs the wake; absent ⇒ native. Same semantics as AgentTurnSchema.harness.
    harness: AgentHarnessSchema.optional(),
    // Which model the wake runs on (see agent-catalog.ts modelsFor); absent ⇒ the provider's default.
    model: z.string().optional(),
    // When true, a fire doesn't wake the agent — it's held in the approvals queue until the owner approves.
    requireApproval: z.boolean().optional(),
    /* The middle ground between firing instantly and requiring a click: the fire is held in the same approvals
     * queue, visibly, and the daemon runs it ITSELF once the hold has elapsed AND no agent turn is live — the
     * owner's window to cancel or start it early, with silence as consent. What a fix chore wants: time to see
     * "checks broke, a fix is about to start" without a standing decision to make. `requireApproval` wins when
     * both are set — an explicit "ask me" must never quietly become "unless I'm slow". */
    holdForSeconds: z.number().optional(),
    // A code CHORE: maintenance of THIS codebase rather than a reaction to the outside world. Purely a
    // classification — the daemon fires a chore exactly like any other automation — but it cannot be derived
    // from the trigger, which is why it is stored: a nightly `pnpm audit` sweep and a nightly Stripe poll are
    // both `schedule`, and belong on different shelves. Absent ⇒ an ordinary automation.
    chore: z.boolean().optional(),
    enabled: z.boolean(),
});
export type Automation = z.infer<typeof AutomationSchema>;

// A wake held for owner approval (.intentic/approvals/<id>.json, one file per held wake). It snapshots the
// trigger payload so an approved run replays exactly what fired, even across a daemon restart. The id is minted
// by the daemon (an entryId-safe filename).
export const AutomationApprovalSchema = z.object({
    id: entryId,
    automationId: z.string(),
    // The event/listener payload the wake would have carried; absent for schedule triggers.
    payload: z.string().optional(),
    // The provenance + title the held wake would have opened its conversation with — snapshotted alongside the
    // payload so an approved external wake surfaces on the fleet exactly as an auto one would have.
    origin: AgentOriginSchema.optional(),
    title: z.string().optional(),
    /* The CONTINUING THREAD this wake belonged to, when it had one — the conversation the dispatcher had
     * already opened for it and the provider session that conversation last ran on.
     *
     * Snapshotted for the same reason the payload is, and it is the half that was missing: without it an
     * approved wake fell through to minting a fresh conversation, so a Doorbell visitor's chat became one card
     * per approved message instead of the single thread the dispatcher had opened for them — a second worktree
     * each time, and an agent that met the visitor again on every turn. Absent for a schedule or a webhook,
     * which own no thread. */
    conversationId: z.string().optional(),
    sessionId: z.string().optional(),
    createdAt: z.number(),
    /* Epoch ms after which the daemon may run this wake itself (a `holdForSeconds` hold) — the countdown the
     * row renders, and the deadline the scheduler's tick checks against. Absent on a `requireApproval` hold,
     * which only the owner may release. */
    autoRunAt: z.number().optional(),
});
export type AutomationApproval = z.infer<typeof AutomationApprovalSchema>;

// `rev` is the registry revision this roster was read at — a counter the daemon bumps on every registry change.
// It is what makes the browser's optimistic writes safe: the fleet is published as full snapshots (last frame
// wins), so without an ordering stamp a roster READ before a mutation but delivered after it silently puts the
// mutated agents back. The browser drops any roster older than the newest it has applied, and holds its own
// pending change until a roster at or past the revision that applied it arrives. See useAgents.ts.
// `held` is the approvals queue projected onto the board — the wakes waiting at the door, so "needs you" sits
// beside "running" instead of in a page nobody opens. Defaulted so an older daemon's roster still parses.
export const AgentsListSchema = z.object({
    agents: z.array(AgentSummarySchema),
    rev: z.number(),
    held: z.array(AutomationApprovalSchema).default([]),
});
export type AgentsList = z.infer<typeof AgentsListSchema>;

export const AutomationApprovalsListSchema = z.object({ approvals: z.array(AutomationApprovalSchema) });
export const AutomationApprovalIdParamSchema = z.object({ id: z.string() });

export const AutomationRunSchema = z.object({
    at: z.number(),
    // skipped = the guard said no; error = the guard passed but the agent turn surfaced an error; interrupted =
    // the daemon died mid-wake, so the run reached no outcome of its own (see agent/turn-journal.ts). Without
    // that last one an interrupted fire records NOTHING and simply vanishes from the row's history, which reads
    // as "it never fired" — the one reading a 3 a.m. automation must not be given.
    outcome: z.enum(["completed", "skipped", "error", "interrupted"]),
    detail: z.string().optional(),
    // The stable conversation opened by the wake, so the row can open the provider-neutral agent transcript.
    // Absent only for a run skipped before a conversation was needed.
    conversationId: z.string().optional(),
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;

// The list row: the stored automation + its recent runs + the next scheduled fire (absent when disabled).
export const AutomationSummarySchema = AutomationSchema.extend({
    runs: z.array(AutomationRunSchema),
    nextRun: z.number().optional(),
});
export type AutomationSummary = z.infer<typeof AutomationSummarySchema>;
export const AutomationsListSchema = z.object({ automations: z.array(AutomationSummarySchema) });
export const AutomationIdParamSchema = z.object({ id: z.string() });
export const AutomationEnabledInputSchema = z.object({ id: z.string(), enabled: z.boolean() });

/* ---- the automation catalogue: everything that can wake an agent here, and what to start from ----
 *
 * ONE ANSWER TO ONE QUESTION, and that is the whole reason it exists. The composer used to carry a hand-written
 * list of every source and every template — CI, Komodo, Sentry, Stripe, email, the website widget, the chore
 * book — while the daemon's upsert carried a SECOND hand-written list of the providers it would accept. Two
 * lists, edited in different packages, disagreeing was a matter of time; and every area that gained something
 * worth waking on had to edit the automations surface to say so, which is the dependency pointing backwards.
 *
 * Now the daemon merges what IT emits with what every installed extension declares, and serves the result. The
 * composer draws whatever comes back and knows the name of nothing; `upsert` validates against the same merge.
 * An area gains a trigger by declaring it, and the surface it appears on does not change.
 *
 * WHERE A SOURCE IS DECLARED IS WHERE ITS EVENTS COME FROM — `webchat` and `ci` are the daemon's own (it holds
 * the widget endpoint and the pipeline webhook receiver), every other one belongs to the extension whose
 * gateway or backend dispatches it.
 *
 * A TEMPLATE SITS BESIDE THE SOURCE IT FIRES ON, because the source's starter and the template's prompt
 * describe the same payload, and one payload described in two packages is two descriptions to keep in step. A
 * template on the generic `event` webhook has no source to sit beside, so it goes with the pack carrying the
 * capability card it names — which is the same pack the user connected to make it work at all. */

// A source's per-source narrowing field, as the generic editor draws it. Absent ⇒ the editor offers no such
// filter rather than inventing one the provider has no meaning for.
const TriggerFieldSchema = z.object({ label: z.string().min(1), placeholder: z.string().min(1), hint: z.string().min(1).optional() });

export const TriggerSourceSchema = z.object({
    // The slug a listener trigger fires on (Trigger.provider).
    provider: z.string().min(1),
    label: z.string().min(1),
    // Simple-icons slug, or an app glyph — the same logo/icon split a capability card and an extension mark draw.
    logo: z.string().min(1).optional(),
    icon: z.string().min(1).optional(),
    events: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })),
    channel: TriggerFieldSchema,
    // A SECOND narrowing axis, for sources whose events carry one — `ci` narrows by git ref as well as by repo.
    branchField: TriggerFieldSchema.optional(),
    // Only sources whose `message` events distinguish addressed messages set this; absent ⇒ no mention-only filter.
    mentionLabel: z.string().min(1).optional(),
    // The provider owns the payload vocabulary, so it owns the first prompt that explains that payload.
    starterPrompt: z.string().min(1).optional(),
    /* Capability providers that make this source WORK — any one of them connected is enough (a CI trigger rides
     * github or gitlab). Empty ⇒ nothing to connect, the source is usable as it stands. Availability is computed
     * in the browser rather than served, because the browser's capability facts are pushed live and a served
     * boolean would be stale between polls. */
    requires: z.array(z.string().min(1)).default([]),
    /* Whether the extension declaring this is switched ON. Disabled ones are still listed, and that is the
     * point: a stored automation must stay readable and editable while the pack that supplied its provider is
     * off, showing the real label instead of degrading to a bare slug. */
    enabled: z.boolean(),
});
export type TriggerSource = z.infer<typeof TriggerSourceSchema>;

/* HOW A TEMPLATE IS OFFERED. Absent ⇒ it lives in the create dialog's gallery, where you go once you know what
 * you want. The two named forms are for what a user would never think to go looking for:
 *   create    — a shelf card on the page that makes the automation in one click, switched off, ready to read.
 *               The chores are all of these: upkeep nobody opens an automations page hunting for.
 *   configure — a shelf card that opens the dialog PREFILLED, for a template that cannot work unconfigured (a
 *               Doorbell with no allowed sites admits nobody, and a row that silently does nothing is worse
 *               than a form). */
export const TemplateOfferSchema = z.enum(["create", "configure"]);

export const AutomationTemplateSchema = z.object({
    // Prefills the automation name, so it is also what "does one of these already exist" is asked by.
    id: z.string().min(1),
    title: z.string().min(1),
    logo: z.string().min(1).optional(),
    icon: z.string().min(1).optional(),
    // Same rule as a source's: any one connected is enough, empty ⇒ always offered.
    requires: z.array(z.string().min(1)).default([]),
    trigger: TriggerSchema,
    // Prefills the guard command (a shell one-liner; non-zero exit skips the wake).
    guard: z.string().min(1).optional(),
    // Prefills the countdown hold: each fire waits this long, visibly and cancellably, before starting itself.
    holdForSeconds: z.number().int().positive().optional(),
    prompt: z.string().min(1),
    // The card's disclosure under the title — "instant", "checks every 5 min", "skips changes under 20 lines".
    note: z.string().min(1).optional(),
    // Post-save instructions: where to paste the webhook URL this automation just minted.
    setup: z.string().min(1).optional(),
    // What the shelf card says under the title. Only offered templates need one; a gallery entry has its
    // trigger beside it for context.
    description: z.string().min(1).optional(),
    offer: TemplateOfferSchema.optional(),
    /* WHETHER THE AUTOMATION THIS MAKES WATCHES THIS CODEBASE — the flag the created record stores, which is
     * what puts its row on the chores shelf rather than among the integrations.
     *
     * Carried rather than inferred from the trigger, because a nightly dependency sweep and a nightly Stripe
     * poll are both `schedule` and only one of them is about your code. */
    chore: z.boolean().optional(),
});
export type AutomationTemplate = z.infer<typeof AutomationTemplateSchema>;

export const AutomationCatalogSchema = z.object({
    sources: z.array(TriggerSourceSchema),
    templates: z.array(AutomationTemplateSchema),
});
export type AutomationCatalog = z.infer<typeof AutomationCatalogSchema>;

// ---- workflows: a designed graph of sessions ----
/* THE THIRD DRIVER. An automation answers "run this at 3am", a loop answers "run this until it is done", and a
 * workflow answers "run these, in this order, each handing its result to the next".
 *
 * IT IS A GRAPH OF LOOPS, and that is the whole implementation. A step is not a new kind of execution — it is
 * a Loop with a declared output and a place in a dependency graph, driven on a conversation of its own. So
 * every step gets the fleet card, the worktree, the transcript, the cost ledger, the Stop button, the stall
 * detector and the spend ceiling without a line of new code, and this file's job is only to say what the steps
 * are and what depends on what.
 *
 * WHY IT IS NOT "AN AUTOMATION WITH SEVERAL PROMPTS". Because the value is in the SEAM between steps: the
 * output of one is validated before the next is allowed to start, the reviewing step is a different session
 * from the implementing one, and a step that cannot converge stops the branch below it rather than feeding
 * garbage forward. None of that exists in a prompt that says "then do X".
 */

// A step id: short and slug-shaped because it is spliced into the derived conversation id (`wf-<run>-<step>`),
// which is itself a branch name and a directory name. The regex is the injection guard, the length cap is what
// keeps the derived id inside ConversationIdSchema's 64.
const StepIdSchema = z
    .string()
    .min(1)
    .max(24)
    .regex(/^[a-z0-9][a-z0-9-]*$/);

/* HOW A STEP MEETS ITS PREDECESSOR — the fork the whole feature turns on, and the one the user has to choose
 * because neither answer is right twice in a row.
 *
 * `fresh` opens a NEW conversation: its own fleet card, its own session, its own worktree when the run is
 * isolated. What it knows about the step before it is exactly what that step declared as output. This is the
 * only honest way to run a review, an audit or a second opinion — a session that spent nine turns arguing for
 * an approach is the worst available judge of whether that approach worked, and the fix is not a better prompt,
 * it is a different session.
 *
 * `continue` sends the next prompt into the SAME conversation. The model keeps everything it learned, the
 * prefix stays cached, and — when the run is isolated — the work stays in one worktree on one branch, which is
 * the only way a chain like implement → test → document can build on itself at all. Requires exactly one
 * predecessor: two upstream sessions cannot both be continued into one.
 */
export const WorkflowHandoffSchema = z.enum(["fresh", "continue"]);
export type WorkflowHandoff = z.infer<typeof WorkflowHandoffSchema>;

// Enough steps for a real pipeline, few enough that a workflow stays legible as one picture. A design past
// this is two workflows, and reading it as one graph was never going to work.
const WORKFLOW_STEPS_MAX = 24;

export const WorkflowStepSchema = z.object({
    id: StepIdSchema,
    // What the node says on the graph. Short — the prompt is where the detail goes.
    title: z.string().min(1).max(60),
    /* What "done" means for this step, in the user's words. Put to the judge, and restated to the model unless
     * its instruction already carries it (loop-brief); it is the sentence the step is measured against.
     *
     * ABSENT ⇒ THE RUN'S OWN REQUEST IS THE GOAL, which is the ordinary case and not the exotic one. A saved
     * workflow is a SHAPE — "two models on one task" — and for most of its steps the thing being asked for is
     * whatever the person typed this time. Writing a goal here as well means saying the same thing twice and
     * keeping the two in agreement forever; leaving it out means the step is measured against the request,
     * which is what anyone would have written anyway. Declare one only where the step's bar is genuinely its
     * own ("the suite is green") rather than the run's.
     */
    goal: z.string().min(1).optional(),
    /* What the step is told to DO. A different sentence from the goal: "the suite is green" is the goal,
     * "run the tests, take the top failure, fix it" is the instruction.
     *
     * ABSENT ⇒ THE REQUEST IS HANDED OVER VERBATIM, with none of the workflow's own framing around it (see
     * briefForStep). That is the default because the framing is not free: every heading between the reader's
     * sentence and the model is a chance for the model to answer the frame instead of the question, and a step
     * whose whole job is "do what was asked" has nothing to add to it. A step that DOES declare a prompt is
     * saying it has a job of its own — review this, merge those — and gets the full brief, request included.
     */
    prompt: z.string().min(1).optional(),
    // The steps that must finish before this one starts. Empty ⇒ a root, started when the run starts. The
    // graph must be acyclic and every id must exist; both are checked when the workflow is saved.
    needs: z.array(StepIdSchema),
    handoff: WorkflowHandoffSchema,
    output: LoopOutputSchema,
    checks: z.array(LoopCheckSchema),
    // How the step's own ITERATIONS meet each other — the Ralph question, one level down from `handoff`. A
    // long-running step wants `fresh` (no context rot); a short refine-this step wants `continue`.
    context: LoopContextSchema,
    /* Iteration/stall limits remain scheduler backstops rather than form questions. Spend is different: it is
     * the one resource the owner cannot recover after an unattended fan-out, and the underlying loop already
     * enforces it exactly. Absent remains uncapped for short, person-started work. */
    maxSpendUsd: z.number().positive().optional(),
    agent: AgentProviderSchema.optional(),
    harness: AgentHarnessSchema.optional(),
    account: z.string().optional(),
    model: z.string().optional(),
    /* Which persona the step acts as — the same field a chat turn and an automation carry (AgentTurnSchema.
     * actsAs), because a step IS an unattended turn under the loop machinery. Unpinned, a step keeps the
     * strict unattended default: full tools, no logged-in accounts. Pinning a card is how a gated release
     * check gets a voice, a folder scope, or the one Reddit it is allowed to post from — a decision the owner
     * already wrote down once, on the card. */
    actsAs: entryId.optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

/* THE GATE — how a finished run becomes a release decision, and how a machine with no identity asks for one.
 *
 * A workflow is a DESIGN; a gate is a PROMISE ABOUT ITS RESULT, and keeping the two separable is the whole
 * point. What a run does — how many sessions, whether they drive a browser, which repos they touch — stays the
 * graph's business, because the value of running a release check this way is that the check is a workflow like
 * any other: an acceptance sweep today, a security review or a performance budget next month, with nothing
 * here ever learning what any of them are.
 *
 * So a gate reads exactly one thing: a named FIELD off a named STEP's declared output (output-fields.ts). That
 * field already exists for precisely the reason this needs it — a declared field is the one part of a session's
 * answer that was VALIDATED rather than parsed back out of the prose the model was talking to a person in —
 * and pointing at one is the entire rule.
 */
export const WorkflowGateSchema = z.object({
    // Which step's declared output carries the decision. Ordinarily a leaf that weighs up the steps before it;
    // nothing requires that, and a one-step workflow naming its only step is the common small case.
    step: StepIdSchema,
    // Which of that step's declared fields is read. Checked against what the step actually declares when the
    // workflow is saved — a gate pointed at a field nobody writes answers `blocked` on every run, forever.
    field: z.string().min(1),
    /* The values of that field that mean SHIP IT. Everything else fails the gate.
     *
     * An allowlist rather than a blocklist, because the two are not symmetric under a model's vocabulary. A
     * step that answers "mostly-pass", "pass-with-notes" or "pass (2 minor defects)" must not ship, and the
     * allowlist gets that right without anyone having had to enumerate the ways a model can hedge.
     */
    pass: z.array(z.string().min(1)).min(1),
    // The webhook's own auth, minted on save exactly as an event automation's is. The caller is a pipeline
    // runner with no Google identity, so this is the only credential in the exchange.
    token: z.string().optional(),
    /* Runs per UTC day, across every caller. A gate is a paid endpoint reachable with no person in the loop:
     * one of these wired into a push-triggered pipeline is a fan-out of sessions per commit, and the
     * per-request deadline bounds one call's WALL CLOCK without bounding the day's SPEND. Absent ⇒
     * GATE_DAILY_MAX_DEFAULT, not uncapped, for the reason the Doorbell's ceiling is not optional either.
     */
    dailyMax: z.number().int().positive().optional(),
});
export type WorkflowGate = z.infer<typeof WorkflowGateSchema>;

/* The gate's daily ceiling when its author sets none. Deliberately small next to the Doorbell's 200: a
 * Doorbell message is one turn, a gate run is a whole graph of sessions, and the honest comparison is cost
 * rather than count. Twenty is a busy day of merges and a script's first minute. */
export const GATE_DAILY_MAX_DEFAULT = 20;

/* What a gate answers a pipeline, and the three-way split is load-bearing.
 *
 * `blocked` exists for the same reason acceptance's verdict has one: "we could not reach a judgment" is not
 * "the product is broken". A gate that reported them the same way would go red for its own outages, and a team
 * that cannot tell the two apart turns the gate off — so `blocked` is meant to be the honest answer far more
 * often than it is the convenient one. It maps to a NEUTRAL pipeline exit, never a failed build.
 */
export const GateOutcomeSchema = z.enum(["pass", "fail", "blocked"]);
export type GateOutcome = z.infer<typeof GateOutcomeSchema>;

// What the gate route answers with. `value` is the field as the step actually wrote it, absent when the gate
// never got one to read — which is every `blocked` that is not a disagreement about the value.
export const GateVerdictSchema = z.object({
    outcome: GateOutcomeSchema,
    // One line: why. Realistically the only part of this a pipeline log will ever show.
    reason: z.string(),
    runId: z.string(),
    value: z.string().optional(),
});
export type GateVerdict = z.infer<typeof GateVerdictSchema>;

export const WorkflowSchema = z.object({
    id: entryId,
    name: z.string().min(1).max(80),
    description: z.string().max(400).optional(),
    steps: z.array(WorkflowStepSchema).min(1).max(WORKFLOW_STEPS_MAX),
    // Present ⇒ this design can be run by a machine and answers a release decision. Absent ⇒ an ordinary
    // workflow, started by a person from the workflows page, with no public door onto it at all.
    gate: WorkflowGateSchema.optional(),
    /* EVERY STEP RUNS IN ITS OWN WORKTREE, always, with no toggle — the same thing an isolated agent session
     * does, which is what every session in this product already is.
     *
     * It was a per-workflow choice between worktrees and the shared /work tree, and the shared side never
     * earned its place: parallel steps on one tree collide, a `fresh` step there sees a half-finished
     * predecessor's edits as if they were the workspace, and the pinned-base-to-branch comparisons that make
     * a fan-in READABLE (see workflow-brief) only exist on the isolated side. A setting whose other value is a
     * subtle trap is not a setting, it is a mistake waiting for somebody to make it.
     */
    // How many steps may run at once. Bounded because a fan-out of twelve is twelve provider sessions, twelve
    // worktrees and twelve times the burn rate — and because the machine this runs on is one machine.
    maxParallel: z.number().int().min(1).max(8),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

// The rules a graph has to clear before it can be saved or run — the acyclic `needs`, the once-only
// continuation — are in workflow-faults.ts, because they are about the graph rather than about any field here.

/* How one step ended. `skipped` is the one that carries information the others cannot: it means the step never
 * ran because something it waited for did not finish, which is why a failed workflow shows one red node and a
 * trail of grey ones rather than a wall of failures that all say the same thing.
 */
export const WorkflowStepStateSchema = z.enum(["pending", "running", "done", "failed", "skipped", "stopped"]);
export type WorkflowStepState = z.infer<typeof WorkflowStepStateSchema>;

export const WorkflowStepRunSchema = z.object({
    stepId: StepIdSchema,
    state: WorkflowStepStateSchema,
    // The conversation this step ran on — derived, and the door from a node on the graph to a real transcript.
    // Shared with the predecessor when the handoff is `continue`, which is what makes those steps one card.
    conversationId: z.string(),
    startedAt: z.number().optional(),
    endedAt: z.number().optional(),
    iterations: z.number().int().min(0),
    costUsd: z.number().optional(),
    // How the step's LOOP ended — `exhausted` and `stalled` both land as a `failed` step, and the difference
    // between them is the difference between "give it more room" and "more room will not help".
    loopState: LoopStateSchema.optional(),
    detail: z.string().optional(),
    // What the step produced. Present once the step has written a valid document, which for a `json` output
    // means it matched the declared fields. This is what the steps downstream are given.
    document: LoopDocumentSchema.optional(),
    /* A bounded preview of the step's closing words. The complete response lives at `reportPath`, so a long-form
     * handoff is not silently reduced to its last few thousand characters and the ledger stays bounded. */
    report: z.string().optional(),
    // Workspace-relative shared-state artifact containing the complete response. Fresh worktrees and a resumed
    // daemon see the same .intentic mount, so downstream steps can read it without copying it into their prompt.
    reportPath: z.string().optional(),
});
export type WorkflowStepRun = z.infer<typeof WorkflowStepRunSchema>;

// `done` means every step that ran finished; a run with skipped steps is `failed`, because a graph that did not
// reach its leaves did not do what it was asked whatever the survivors managed.
export const WorkflowRunStateSchema = z.enum(["running", "done", "failed", "stopped", "overspent", "error"]);
export type WorkflowRunState = z.infer<typeof WorkflowRunStateSchema>;

export const WorkflowRunSchema = z.object({
    runId: z.string().min(1),
    /* The workflow AS IT WAS WHEN THE RUN STARTED, snapshotted rather than referenced. Three things need this
     * and none of them tolerate a live lookup: the run view draws the graph the run actually ran (not the one
     * that has been edited twice since), the boot resume needs the step definitions of a workflow that may have
     * been deleted, and a history row for a deleted workflow is otherwise an id and nothing else. */
    workflow: WorkflowSchema,
    /* The workspace as this run began, one immutable commit per repository. Every fresh step branches from
     * these exact commits, even if main moves while a wide fan-out is still opening worktrees. Handoffs use the
     * same bases in their diff commands, so provenance works in nested repositories as well as at root. */
    repos: z.array(RepoBaseSchema).min(1).max(50),
    /* WHAT THIS RUN WAS ASKED TO DO — the sentence the user typed when they started it, handed to every step
     * on top of its own prompt. Absent for a run started from the workflows page, which has no composer.
     *
     * It is what makes one saved design worth keeping: "two models, one task" is a SHAPE, and the task is
     * different every time. Without this the only way to point a workflow at today's job is to open the
     * designer and retype a step's prompt, which means the design and the request are the same document —
     * and editing a graph to ask a question is not something anybody does twice.
     *
     * Snapshotted on the run beside the workflow, and for the same reason: the run has to stay readable, and
     * "what was this one about" is the first thing anyone asks of a row in the history.
     */
    request: z.string().optional(),
    state: WorkflowRunStateSchema,
    startedAt: z.number(),
    endedAt: z.number().optional(),
    // How many daemon boots have picked this run back up — the same counter, and the same reason, as a loop's.
    resumed: z.number().int().min(0),
    detail: z.string().optional(),
    // One entry per step, in the workflow's own order. Written at start with every step `pending`, so the graph
    // is complete from the first frame and a node's absence never has to mean two things.
    steps: z.array(WorkflowStepRunSchema),
    /* When the run was ARCHIVED (ms epoch) — off the board, exactly as an agent's `archivedAt` takes a card off
     * it, and the same promise: the run record stays readable in the history and every step's branch,
     * transcript and counters are untouched. Absent ⇒ live on the board.
     *
     * A RUN AND ITS STEPS ARCHIVE AS ONE, which is the whole reason this field exists rather than the record
     * simply being dropped. A run's steps have no card of their own — the run's row is what stands for them —
     * so deleting the record was releasing five loose conversations back onto the board at the moment the user
     * said they were finished with the job. Archiving the run archives its sessions with it and unarchiving
     * brings both back, so "done with this" means the same thing for a workflow as it does for an agent. */
    archivedAt: z.number().optional(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

// The list row: the stored workflow plus the runs it has had, newest first.
export const WorkflowSummarySchema = WorkflowSchema.extend({ runs: z.array(WorkflowRunSchema) });
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;

export const WorkflowsListSchema = z.object({ workflows: z.array(WorkflowSummarySchema) });
export const WorkflowRunsListSchema = z.object({ runs: z.array(WorkflowRunSchema) });
export const WorkflowIdParamSchema = z.object({ id: z.string() });
export const WorkflowRunIdParamSchema = z.object({ runId: z.string() });
/* Starting a run: which design, and what to point it at. The request is optional because the workflows page
 * starts runs with no composer to read one from — a design whose steps already say what they want is complete
 * on its own, and only a design written as a shape needs today's sentence. */
export const WorkflowRunStartSchema = WorkflowIdParamSchema.extend({ request: z.string().min(1).max(20_000).optional() });

// Creation and replacement are deliberately distinct. An id collision on create is a conflict; an update of
// a missing id is not an implicit create. That makes the daemon, rather than a browser naming convention, the
// authority that prevents one saved design from overwriting another.
export const WorkflowSaveSchema = z.object({ workflow: WorkflowSchema, create: z.boolean() });

// ---- ci: pipeline runs on the workspace repos' github/gitlab remotes ----
// The daemon maps each workspace repo to the CI project behind its remote (a connected github/gitlab
// capability supplies the token), registers a webhook so completed pipelines dispatch `ci` listener
// automations instantly, and serves the Pipelines rail view from a webhook-freshened cache backfilled over the
// same REST clients. `host` names WHICH provider API serves a repo; the listener provider is always `ci` — one
// automation covers both hosts because the repo, not the vendor, is what a trigger narrows to.

export const CiHostSchema = z.enum(["github", "gitlab"]);
export type CiHost = z.infer<typeof CiHostSchema>;

// Terminal-or-not over both vendors' vocabularies: github's status+conclusion pair and gitlab's single status
// both collapse onto these five. `running` covers everything non-terminal (queued, manual, preparing …) — the
// view only needs "still moving" vs the three ways it stopped.
export const PipelineStatusSchema = z.enum(["running", "success", "failed", "canceled", "skipped"]);
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;

export const PipelineRunSchema = z.object({
    // The workspace repo dir (the panels `repo` convention) — the join key back to the tree and to triggers.
    repo: z.string(),
    host: CiHostSchema,
    // owner/name (github) or the full project path (gitlab).
    project: z.string(),
    // The vendor's numeric run/pipeline id — what rerun/cancel address.
    runId: z.number(),
    // The run's headline: github's display_title (the commit subject, or the PR title when a PR triggered it),
    // gitlab's pipeline name or the head commit's subject. Absent ⇒ the view falls back to ref@sha.
    title: z.string().optional(),
    // Who the vendor credits for the run — the actor who set it off, matching what both vendors' own UIs
    // show. The avatar is a vendor-hosted URL; absent ⇒ the view draws the author's initials instead.
    authorName: z.string().optional(),
    authorAvatarUrl: z.string().optional(),
    // What set the run off, in the vendor's own vocabulary: gitlab's pipeline `source` (push, schedule,
    // merge_request_event, web, api, trigger…) or github's `event` (push, pull_request, schedule,
    // workflow_dispatch…). Left raw rather than flattened into a shared enum — the vendor's word is the
    // precise one, and the view only calls it out when it isn't the everyday push.
    trigger: z.string().optional(),
    branch: z.string(),
    sha: z.string(),
    status: PipelineStatusSchema,
    // The vendor's run page — the deep link out.
    url: z.string(),
    createdAt: z.number(),
    durationSeconds: z.number().optional(),
    // Names of the failed jobs — fetched only for failed runs (one extra call), so a wake or a view names what broke.
    failedJobs: z.array(z.string()).optional(),
});
export type PipelineRun = z.infer<typeof PipelineRunSchema>;

/* One job inside a pipeline run. The view fetches these lazily (one extra call per visible run) so the list
 * endpoint stays cheap. Both GitHub Actions jobs and GitLab CI jobs normalize onto these fields.
 *
 * HOW THE VIEW LEARNS THE RUN'S SHAPE, in descending order of truth:
 *   1. `needs` — the dependencies the pipeline itself declares. The real graph, and the only one that can say
 *      a job waited on THIS one rather than on everything before it. Neither vendor's jobs API returns it, so
 *      it is read out of the pipeline definition (github: workflowGraph.ts) and is absent whenever that could
 *      not be resolved — a private workflow file, a deleted one, a name no declared job matches.
 *   2. `stage` — GitLab's native sequential grouping, returned by its jobs API and used verbatim.
 *   3. The timestamps — the last resort, and GitHub's before `needs` existed: overlapping runtimes ⇒ the jobs
 *      ran in parallel. Honest about when things happened, silent about what actually gated what.
 * Both timestamps are epoch ms; absent while a job is still queued. */
export const PipelineJobSchema = z.object({
    name: z.string(),
    status: PipelineStatusSchema,
    stage: z.string().optional(),
    // Names of jobs IN THIS RUN that this one declared it waits on. Absent ⇒ nothing was resolved and the view
    // must fall back; an empty array is the different, load-bearing claim that this job is a root.
    needs: z.array(z.string()).optional(),
    startedAt: z.number().optional(),
    finishedAt: z.number().optional(),
    durationSeconds: z.number().optional(),
    // The job's page on its host — the shortest path from "this step failed" to the log that says why.
    webUrl: z.string().optional(),
});
export type PipelineJob = z.infer<typeof PipelineJobSchema>;

export const CiJobsResponseSchema = z.object({
    jobs: z.array(PipelineJobSchema),
});
export type CiJobsResponse = z.infer<typeof CiJobsResponseSchema>;

// One mapped repo's CI wiring state. `hookWarning` is the manual-setup story when webhook registration was
// refused (token scope, role) or impossible (no public URL): what happened plus the target URL + secret to
// paste into the repo's webhook settings — the git-access sshRegistrationWarning pattern.
export const CiRepoSchema = z.object({
    repo: z.string(),
    host: CiHostSchema,
    project: z.string(),
    // The project's home page on its host.
    url: z.string(),
    hookWarning: z.string().optional(),
});
export type CiRepo = z.infer<typeof CiRepoSchema>;

/* How often the daemon polls a repo whose webhook could NOT be registered (ci/poller.ts) — the fallback that
 * keeps a `ci` automation firing on a sandbox with no public URL or a token without hook scope.
 *
 * Here rather than beside the poller because both ends need the number: the daemon to run on it, and the
 * automation editor to tell the owner what a `hookWarning` actually costs them. "Webhooks are off" is a fact
 * about infrastructure; "this fires within two minutes instead of instantly" is the answer to the question
 * they were really asking. */
export const CI_POLL_INTERVAL_MS = 2 * 60_000;

export const CiRunsResponseSchema = z.object({
    repos: z.array(CiRepoSchema),
    // Newest first, across all mapped repos.
    runs: z.array(PipelineRunSchema),
    // When the owner last opened the pipelines view. Rides the runs response so the rail can decide what is
    // NEW without a second call — a breakage older than this has already been seen and must not badge again.
    // Absent ⇒ never opened, so everything counts as unseen.
    seenAt: z.number().optional(),
});
export type CiRunsResponse = z.infer<typeof CiRunsResponseSchema>;

// Stamping the view as read hands back the timestamp it wrote, so the client updates without a refetch.
export const CiSeenResponseSchema = z.object({ seenAt: z.number() });
export type CiSeenResponse = z.infer<typeof CiSeenResponseSchema>;

// rerun/cancel/fix address a run by repo + vendor id; the daemon re-resolves repo → project + token per call,
// so a stale card can't act on a project the workspace no longer maps to.
export const CiRunParamSchema = z.object({ repo: z.string(), runId: z.number() });
export type CiRunParam = z.infer<typeof CiRunParamSchema>;

// Fixing takes one thing the vendor proxies do not: which model to open the session on, when the user reached
// for the caret beside the button rather than pressing it (AgentRunPickSchema). Absent is the ordinary path.
export const CiFixParamSchema = CiRunParamSchema.extend({ pick: AgentRunPickSchema });
export type CiFixParam = z.infer<typeof CiFixParamSchema>;

// The fix route opens an isolated conversation (fleet card + chat tab) seeded with the failure context.
export const CiFixResponseSchema = z.object({ conversationId: z.string() });
export type CiFixResponse = z.infer<typeof CiFixResponseSchema>;

/* ---- the pre-push check: the workspace's own answer to "would this push go red" ----
 *
 * WHERE THIS SITS. A fleet of 5-20 agents lands work into the main tree, the user reviews and commits it by
 * parts, pushes, and CI answers minutes later. The check front-runs that answer at the push itself — the last
 * moment before the work leaves the machine, and the first moment at which what will be pushed is finally
 * settled.
 *
 * WHY THE PUSH AND NOT THE LAND, which is where this used to run. A post-land verdict is about a tree that
 * keeps moving: the user commits by parts, another agent lands, an edit arrives — so the verdict spent its life
 * either stale or being recomputed, and needed a content fingerprint, a staleness rule and a badge to say which.
 * All of that machinery existed to answer a question the push asks for free, because at the push there is
 * exactly one artifact and the user is standing in front of it waiting.
 *
 * SO THERE IS NO STORED VERDICT AND NOTHING IS POLLED AT REST. A run exists while it runs, reports to the
 * dialog that started it, and is gone. Nothing survives a daemon restart because nothing needs to: the next
 * push asks again. */

/* Where a run is.
 *
 *   idle      — nothing has run in this daemon's life, or the last run was cleared.
 *   running   — the check is live. Its output is the terminal's (`session`), not this object's.
 *   passed    — exited 0. The push goes.
 *   failed    — exited non-zero, or was killed by prepushTimeoutMs (`timedOut`). The state a fix answers.
 *   error     — the check could not run at all: the command was not spawnable. NOT a fix-able failure, because
 *               there is nothing wrong with the code — the command is misconfigured, and saying "tests failed"
 *               would send an agent hunting a bug that isn't there.
 *   cancelled — the user stopped the run.
 */
export const PrepushStatusSchema = z.enum(["idle", "running", "passed", "failed", "error", "cancelled"]);
export type PrepushStatus = z.infer<typeof PrepushStatusSchema>;

export const PrepushRunSchema = z.object({
    status: PrepushStatusSchema,
    // The command this run executed, echoed rather than read back from settings: a result read after the
    // setting changed still has to say what produced it.
    command: z.string(),
    startedAt: z.number().optional(),
    finishedAt: z.number().optional(),
    exitCode: z.number().optional(),
    timedOut: z.boolean().optional(),
    /* The tmux session the suite runs in, for the browser to open the terminals panel on — the check is a
     * visible terminal like every other shell command the daemon runs on a click (terminal/terminal-run.ts), so
     * WATCHING it is not this object's job and never was. Absent where the sandbox has no tmux wrapper (local
     * dev): the runner falls back to an invisible shell, and a name nothing can attach to would send the browser
     * after a tab that is never going to be listed. */
    session: z.string().optional(),
    /* What the fix proposal quotes, and its only reader — tail-capped (PREPUSH_OUTPUT_BYTES) so a prompt seeded
     * from a red run stays about fixing rather than scrolling. The TAIL, not the head: a suite's verdict and its
     * failure summary are at the end. PLAIN TEXT, not what the terminal received: the suite's colour codes and
     * redrawn progress lines are resolved away (terminal/plain-text.ts) before the cap, so a quoted tail reads
     * as a failure instead of as litter. Empty while the run is going, and for a run that was killed: the pane
     * (and its log) is where the whole of it lives. */
    output: z.string(),
});
export type PrepushRun = z.infer<typeof PrepushRunSchema>;

// ---- drafts: agent-proposed posts awaiting owner approval (.intentic/drafts/<id>.json) ----
// One JSON file per draft. The AGENT creates drafts with its normal file tools — it can't call daemon routes,
// the same split as the environment proposal — while the daemon edits/deletes them on the owner's behalf, so
// the two writers never share a file. The id IS the filename (entryId charset ⇒ path-safe); the body never
// carries it. Posting is the agent's job too (there is no typed publish path): a "publish approved drafts"
// automation wakes the agent for due drafts, which posts via the platform skills and flips the status.

export const DraftStatusSchema = z.enum(["proposed", "approved", "posting", "posted", "failed"]);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

// The on-disk file body. proposed (agent) → approved (owner) → posting (publisher, set BEFORE acting so a dead
// turn can't double-post) → posted | failed. Reject = delete the file; retry = re-approve a failed draft.
export const DraftSchema = z.object({
    // Which skill posts it: "x" | "reddit" | "youtube" | "discord" | … — a bare string so new platforms need
    // no contract change; an unknown platform simply fails at posting time.
    platform: z.string().min(1),
    /* WHOSE NAME THIS GOES OUT UNDER — a PersonaSchema id, handed to the publish turn as AgentTurnSchema.actsAs.
     * Required in practice for every platform outside DIRECT_PUBLISH_PLATFORMS, and the reason is the whole
     * shape of turnPersona: publishing through a browser needs a logged-in account, and an UNATTENDED turn that
     * names no persona is denied every account there is. Without this field the publisher could only wake such a
     * turn — one structurally unable to reach the login the post needs, which read from inside the turn as "this
     * account is not connected" and cost two approved posts before anyone traced it back here.
     *
     * A PERSONA RATHER THAN AN ACCOUNT ID, because that is the vocabulary the rest of the system already speaks:
     * `actsAs` is the only pin turnPersona honours, and a card carries the workspace scope the turn also needs to
     * write this file's own status back. Naming the account directly would invent a second way to say the same
     * thing, and the two would disagree the first time a card's accounts changed.
     *
     * The daemon never guesses it. One site can be connected several times over — five Reddit logins here — and
     * picking for the owner means picking wrong in public, with no undo. A draft that needs a turn and names
     * nobody is failed with that sentence instead of sent. */
    actsAs: entryId.optional(),
    content: z.string().min(1),
    // Reddit posts / YouTube uploads need one.
    title: z.string().optional(),
    /* Where on the platform: subreddit / Discord channel id / community — OR the URL of the thing this draft
     * replies to. A URL target means the draft is a reply, and on reddit the difference between a thread's
     * address and one comment's permalink is the difference between talking to the room and answering the
     * person: the publisher opens exactly this and replies where it lands. */
    target: z.string().optional(),
    // Workspace-relative attachment paths, e.g. ".intentic/drafts/media/chart.png".
    media: z.array(z.string()).optional(),
    // Suggested post time (epoch ms, the at/nextRun convention). Optional — the agent may propose without a
    // date and the owner sets one at approval; an approved draft with no date posts as soon as it's picked up.
    scheduledAt: z.number().optional(),
    // Agent-written files only need platform + content; status defaults, the rest are optional, so a
    // well-formed proposal never lands in `invalid` just for omitting bookkeeping fields.
    status: DraftStatusSchema.default("proposed"),
    createdAt: z.number().optional(),
    // When sending STARTED, stamped with status "posting". The publisher needs it to tell a send that is under
    // way from one whose run died mid-flight, and those two are indistinguishable from the due time — a post
    // scheduled for last week is not a post that has been sending since last week.
    postingAt: z.number().optional(),
    postedAt: z.number().optional(),
    // Where it landed, when the platform hands back an address for it. The one thing a posted row can offer
    // that reading the draft cannot: the post itself, to go and look at.
    postedUrl: z.string().optional(),
    // Why posting failed; set with status "failed". Written for the owner to read in the queue, so it is a
    // sentence rather than a code.
    error: z.string().optional(),
});
export type Draft = z.infer<typeof DraftSchema>;

// The list row / upsert input: the file body plus its filename id.
export const DraftSummarySchema = DraftSchema.extend({ id: entryId });
export type DraftSummary = z.infer<typeof DraftSummarySchema>;
// `invalid` = filenames that failed to parse. Agent-written files are a trust boundary — without this a typo'd
// draft would silently never post.
export const DraftsListSchema = z.object({ drafts: z.array(DraftSummarySchema), invalid: z.array(z.string()) });
export type DraftsList = z.infer<typeof DraftsListSchema>;
// entryId, not a bare string: the id becomes a filename under .intentic/drafts/.
export const DraftIdParamSchema = z.object({ id: entryId });

// ---- panels: per-repository dev servers + the content facts extensions detect on ----
// Every discovered git repo under /work is one list row: its runnable-panel runtime status (a `dev` script at
// operator/ or the repo root; the daemon runs it, auto-assigns a free port, and the preview proxy routes
// preview-<panelKey>-<sandboxId>.<zone> to it) PLUS content facts — evidence the web app's extensions run their
// detect() over, computed daemon-side in one pass so the browser never scans /work file-by-file.

export const PanelSummarySchema = z.object({
    // The repo id: its root-relative dir under /work (slashes become `--` in the preview subdomain label).
    repo: z.string(),
    // Whether the repo ships a runnable dev server (a package.json `dev` script at operator/ or the root).
    hasPanel: z.boolean(),
    running: z.boolean(),
    // Whether anything this repo owns is answering — see `servers`. Not the same question as `running`: a panel
    // whose install is still going is running and not yet healthy, and a dev server someone started in their own
    // terminal is healthy without the daemon running it.
    healthy: z.boolean(),
    // The dev server's OS-assigned port; absent when not running. What the daemon TOLD the repo to bind (the
    // preview proxy forwards it) — `servers` is what the repo actually bound, which for a repo that pins its own
    // ports is a different number entirely.
    port: z.number().optional(),
    // Every dev server the repo is really serving, discovered from the sandbox's listening sockets and probed for
    // the scheme each speaks (a Vite on a committed dev cert serves https). One entry for the ordinary repo; a
    // monorepo whose `dev` fans out across packages has one per app, which is why `dir` is here — `_editor/web` vs
    // `_site/site` is the only thing that tells them apart. Empty when nothing answers.
    //
    // `session` is the terminal it is running in: the panel's own when the daemon started it, the user's when
    // they ran it by hand, and ABSENT when nothing in the sandbox owns it. That last case is the one worth
    // designing for — the repo is plainly answering, and no terminal here can show, stop or restart it.
    servers: z.array(z.object({ url: z.string(), dir: z.string().optional(), session: z.string().optional() })),
    // https://preview-<repo>-<sandboxId>.<zone>; absent when the sandbox has no zone or connect token (loopback/tests).
    previewUrl: z.string().optional(),
    // The workspace role this repo dir occupies (the three fixed dirs); absent for extra clones.
    role: z.enum(["intent", "desired-state", "app"]).optional(),
    // Content facts: deploy.config.ts (the intent ledger's day-one marker), desired-state.json (present after
    // the first resolve), .intentic/ui/index.html (a sandboxed directory UI), pnpm-workspace.yaml +
    // turbo.json (a pnpm+turbo monorepo), vitest evidence (a root vitest.config.ts, or "vitest" in the
    // root manifest / workspace catalog), docs/user-stories (a directory of stories an agent can test
    // against the running app — the one fact here that says nothing about the repo's language), and
    // docs/architecture (the repo carries generated architecture documentation).
    deployConfig: z.boolean(),
    desiredState: z.boolean(),
    directoryUi: z.boolean(),
    monorepo: z.boolean(),
    vitest: z.boolean(),
    userStories: z.boolean(),
    docs: z.boolean(),
});
export type PanelSummary = z.infer<typeof PanelSummarySchema>;
export const PanelsListSchema = z.object({ panels: z.array(PanelSummarySchema) });
export type PanelsList = z.infer<typeof PanelsListSchema>;
// The {repo} path param on the start/stop/terminals routes (a bare string: unknown repo is a handler NOT_FOUND).
export const PanelRepoParamSchema = z.object({ repo: z.string() });

// ---- ports: every listening TCP socket in the sandbox + explicit port forwarding ----
// Anything run in a terminal (a turbo TUI fanning out dev servers, `python -m http.server`, an agent's ad-hoc
// process) binds ports the daemon never assigned — the panel machinery can't see them. The /ports routes are
// the generic complement: `list` reports the live listeners (procfs scan, on demand), `forward` makes one
// reachable at port-<slot>-<sandboxId>.<zone> through the preview proxy. Forwarding is an explicit gesture —
// previews are public, so nothing is exposed until the owner (or an agent acting for them) asks.

export const PortSummarySchema = z.object({
    port: z.number(),
    // The loopback address the listener actually answers at inside the sandbox — a `localhost` bind can land
    // on ::1 only (Vite). The preview proxy and the desktop mirror (Mutagen forward) both dial this.
    host: z.enum(["127.0.0.1", "::1"]),
    // Whether the proxy can actually reach the listener at `host`. False for a bind to a loopback alias like
    // Docker's embedded DNS (127.0.0.11), which answers only at its own address, not 127.0.0.1 — such rows are
    // listed for transparency but the Ports view hides Preview and forwarding them is refused.
    forwardable: z.boolean(),
    // Which bucket the Ports view files it under: `workspace` = user-run (dev servers in repos, terminal
    // processes, published container ports) — the previewable set; `system` = the sandbox's own machinery
    // (agent runtimes, translator, dockerd, sshd), listed for transparency but nobody previews it.
    kind: z.enum(["workspace", "system"]),
    // The owning process, resolved from procfs; absent when no /proc/*/fd entry matched the socket's inode.
    pid: z.number().optional(),
    // How the row is labeled: the process argv joined with spaces ("node /work/app/node_modules/.bin/vite"),
    // falling back to the kernel `comm` name when argv is empty, or a synthesized name for attributable
    // infrastructure the pid walk can't reach ("Docker embedded DNS"). Absent only when wholly unattributable.
    command: z.string().optional(),
    // The process working directory (how the UI attributes a port to a repo).
    cwd: z.string().optional(),
    // The tmux session the listener descends from — the terminal to watch it in or stop it from. Absent when
    // nothing in its ancestry is a pane (a daemon-managed runtime, a published container's docker-proxy), which
    // is the honest "you cannot reach this from here" rather than a terminal that would open onto nothing.
    session: z.string().optional(),
    forwarded: z.boolean(),
    // https://port-<slot>-<sandboxId>.<zone>; present only while forwarded AND the sandbox has a zone + id.
    previewUrl: z.string().optional(),
});
export type PortSummary = z.infer<typeof PortSummarySchema>;
export const PortsListSchema = z.object({ ports: z.array(PortSummarySchema) });
export type PortsList = z.infer<typeof PortsListSchema>;

export const PortParamSchema = z.object({ port: z.number().int().min(1).max(65535) });
// `previewUrl` is absent on a loopback/no-tunnel sandbox — the slot is mapped, but no public hostname exists.
export const PortForwardResultSchema = z.object({ previewUrl: z.string().optional() });
export type PortForwardResult = z.infer<typeof PortForwardResultSchema>;

// ---- computers: what ONE of the user's own machines is running ----
/* The other end of desktop sync, stated as a fact instead of a claim.
 *
 * Everything here already existed — as `intentic-sync status` output on a terminal nobody running the desktop app
 * has open, and as `docker ps` rows only the desktop app could see. Three surfaces each held a third of it: the
 * desktop app knew the containers and nothing about sync, the Desktop sync card knew an enrollment record and
 * printed "Manage: intentic-sync status" for the rest, and the folder a machine syncs into was known to neither
 * (SYNC_DIR is local agent state; the daemon is never told it). This is that one shape, so the same report can
 * be produced by the agent, read by the daemon, and rendered by one component in both apps.
 *
 * The producer is `intentic-sync status --json` in every carrier — the desktop app spawns it, the mirror watcher
 * posts it, a `host` capability runs it over run_command. One producer is what keeps the three from drifting,
 * the same argument as the desktop app spawning connect.sh rather than reimplementing it.
 *
 * WHO FILLS WHAT is the disclosure rule, made structural. The agent reports only what it uniquely knows — its
 * own pairings, folders, ports, watcher — and NEVER `sandboxes`: enumerating a machine's other containers to one
 * of them is the leak this design exists to avoid, and a sync agent has no business doing it anyway. The docker
 * half is supplied by whoever is READING (the desktop app from its own `docker ps`, the daemon from a
 * `host`-capability one), which is also the only side that has a reason to be trusted with it.
 *
 * What remains is scoping: a report reaching a sandbox carries that sandbox's pairing, not its siblings', and a
 * `mirror` enrollment — a collaborator's own laptop — drops `localDir` with it. So a member who mirrors one
 * dev-server port does not hand the sandbox's owner a map of their machine. */

// One sandbox container on the machine — the docker half, filled in by the reader, never by the sync agent.
export const MachineSandboxSchema = z.object({
    slug: z.string(),
    container: z.string(),
    // The display name, when the machine has one recorded. Docker knows only the container name.
    name: z.string().optional(),
    running: z.boolean(),
    image: z.string(),
    // Absent when the sandbox has no cloudflared sidecar AT ALL (reached over the user's own proxy) — which is
    // not the same fact as a sidecar that is down, and must not render as one.
    tunnelRunning: z.boolean().optional(),
});
export type MachineSandbox = z.infer<typeof MachineSandboxSchema>;

/* ONE OPERATION ON ONE SANDBOX ON ONE MACHINE — the Computers view's buttons, and the only thing that changes a
 * machine's fleet from a browser.
 *
 * All eight ops travel one route because they are one decision to the person clicking, however differently they
 * behave underneath: three are a docker call that returns in a second, three run the `ic` flow for minutes, one
 * deletes, and one only reads. Splitting them by duration would put the same button on two doors and give the
 * view two shapes to render. So every op answers as a STREAM of lines ending in a result — the fast ones simply
 * have little to say, and `logs` is the case where the lines ARE the answer.
 *
 * `logs` is here rather than on a route of its own for the same reason: it is a button in the same row as the
 * other seven, on a container that may be too broken to answer any other way, and the stream shape already
 * carries "many lines, then an outcome" exactly as a log tail wants to arrive.
 *
 * The machine enforces which of them it will do: `sandboxes` covers the first six and the log tail, removal takes
 * its own switch, and a refusal comes back as the machine's own sentence naming the control to flip. */
export const MachineSandboxOpSchema = z.enum(["start", "stop", "restart", "update", "rebuild", "rollback", "remove", "logs"]);
export type MachineSandboxOp = z.infer<typeof MachineSandboxOpSchema>;

export const MachineSandboxFlowSchema = z.object({
    op: MachineSandboxOpSchema,
    slug: z.string().min(1),
    // The approved overlay's sha256 — required by `rebuild` and meaningless to the rest. It is the trust anchor:
    // only content that still hashes to what the owner reviewed is ever built.
    hash: z.string().optional(),
});
export type MachineSandboxFlow = z.infer<typeof MachineSandboxFlowSchema>;

// The same input plus which machine it is for — the browser's half, since the daemon reaches the machine by id.
export const MachineSandboxFlowInputSchema = MachineSandboxFlowSchema.extend({ id: z.string().min(1) });
export type MachineSandboxFlowInput = z.infer<typeof MachineSandboxFlowInputSchema>;

/* What a running operation says, in the one line shape every streamed flow in this product already uses
 * (IntenticLineSchema, which the browser's reader parses): `line` as the machine prints it, then exactly one
 * terminal frame — `result` when it worked, `error` when it did not, carrying the machine's own words either
 * way rather than a code this side invented. */
export const MachineFlowLineSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("line"), text: z.string() }),
    z.object({ kind: z.literal("result"), message: z.string() }),
    z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type MachineFlowLine = z.infer<typeof MachineFlowLineSchema>;

// One paired sandbox as the local agent holds it. `localDir` is the answer to the question the Desktop sync card
// has never been able to answer: which folder on that computer this sandbox's /work actually is.
export const MachinePairingSchema = z.object({
    sandboxId: z.string(),
    mode: z.enum(["sync", "mirror"]),
    // Set only for mode "sync", and only for the sandbox being reported to — see the redaction note above.
    localDir: z.string().optional(),
    // Mutagen's own word for what the session is doing ("watching", "scanning", "transitioning", "halted-…").
    // Carried verbatim rather than mapped to a traffic light: the halted states name their own cause, and a UI
    // that reduces them to "problem" sends the user back to the terminal this report exists to replace.
    mutagenStatus: z.string().optional(),
    // Conflicts Mutagen is holding rather than clobbering (the sync mode is two-way-SAFE). Nothing else in the
    // product surfaces these, so a file edited on both ends stays stuck until someone runs the CLI.
    conflicts: z.number().int().nonnegative().optional(),
    paused: z.boolean().optional(),
});
export type MachinePairing = z.infer<typeof MachinePairingSchema>;

/* One sandbox port and what became of it on this machine's localhost. The rows that did NOT make it are the
 * reason this carries a state rather than being a list of live forwards: two sandboxes on one computer routinely
 * serve the same dev-server port and only one can own localhost:6480, so the loser's port is simply missing from
 * localhost with nothing anywhere saying why. Today that fact exists only as a line in mirror.log. */
export const MachinePortStateSchema = z.enum([
    // Forwarded: the sandbox's listener answers on this machine's localhost at the same number.
    "mirrored",
    // Another PAIRED SANDBOX got there first (first paired wins) — `heldBy` names it, because "busy on this
    // machine" sends people hunting for a process that does not exist.
    "held-by-sandbox",
    // Something else on this computer already binds the port — a local dev server, another tool. Not ours to
    // name, and not ours to take.
    "busy",
]);

export const MachinePortSchema = z.object({
    port: z.number().int().min(1).max(65535),
    host: z.enum(["127.0.0.1", "::1"]),
    // The sandbox serving the port — whose /ports listed it, not whoever ended up holding the local bind.
    sandboxId: z.string(),
    state: MachinePortStateSchema,
    // Set only for "held-by-sandbox": the sandbox id that owns the local bind instead.
    heldBy: z.string().optional(),
    // What is listening on the sandbox side ("node …/vite"), for a row the user has to recognise to act on.
    command: z.string().optional(),
});
export type MachinePort = z.infer<typeof MachinePortSchema>;

/* The resident watcher's liveness. This is the field that decides whether everything ELSE in the report is still
 * true: a healthy session list under a dead watcher means new dev-server ports stop appearing on localhost and
 * commits stop arriving in the local clones, while every other row keeps reading exactly as it did. */
export const MachineWatcherSchema = z.object({
    running: z.boolean(),
    pid: z.number().int().optional(),
    lastTickAt: z.number().optional(),
});

export const MachineReportSchema = z.object({
    /* The OS hostname, and the JOIN KEY. A machine can arrive here two ways at once — volunteered by its sync
     * agent, and read through its `host` capability — and those two know it by different names (the enrolled
     * key's comment vs. the capability id the user typed). The hostname is the one thing both can state about
     * the same box, so it is what dedupes them into a single row. */
    hostname: z.string(),
    os: z.string(),
    // Which of this machine's agents are installed, and at what version — a machine running an old build is
    // visible rather than mysteriously lacking a field. Same argument as HostSummary.version. `host` is filled
    // by the daemon at merge time (it already knows it from the socket), not by the sync agent, which would have
    // to go reading another agent's config to guess at it.
    agents: z.object({ sync: z.string().optional(), host: z.string().optional() }),
    // Filled by the READER, never the agent (see above). Empty is the resting state: no Docker on the machine,
    // or nothing has looked. Neither is an error, and neither means "no sandboxes exist".
    sandboxes: z.array(MachineSandboxSchema),
    pairings: z.array(MachinePairingSchema),
    ports: z.array(MachinePortSchema),
    watcher: MachineWatcherSchema,
    // When the machine took this reading — NOT when the daemon received it. A report is a snapshot from a box
    // that may since have gone to sleep, and the UI ages it against this rather than presenting it as now.
    capturedAt: z.number(),
});
export type MachineReport = z.infer<typeof MachineReportSchema>;

// Why a computer that is plainly THERE has no report to show. Each is a different errand for the reader, which is
// the whole reason they are not collapsed into one "unavailable".
export const ComputerGapSchema = z.enum([
    // A host capability that is enrolled but has no socket right now. Laptops sleep; this is not a fault.
    "offline",
    // Connected, but "Run commands" is switched off on its capability card — so the daemon may not ask it
    // anything. The one gap the user can close in a single click, and the UI says which switch.
    "scope-off",
    // Reachable, asked, but has no `intentic-sync` on it — so nothing knows about folders or mirrored ports there.
    "no-agent",
    // A sync-enrolled machine that has not posted a report yet: either it just enrolled, or its agent predates
    // machine reports. Distinct from "no-agent" because the agent IS there and the folders ARE syncing.
    "unreported",
]);
export type ComputerGap = z.infer<typeof ComputerGapSchema>;

/* ONE COMPUTER, however the sandbox happens to be able to see it — and it may be both ways at once.
 *
 * A machine reaches a sandbox through two independent doors: a desktop-sync enrollment (which volunteers its own
 * report) and a `host` capability (which the daemon can ask). They know the same box by different names — the
 * enrolled ssh key's comment vs. the capability id the user typed — so the two are reconciled on the `hostname`
 * their reports agree on, and left as separate rows when there is nothing to reconcile them by. Guessing that two
 * differently-named machines are the same one would merge two people's laptops on a shared sandbox. */
export const ComputerSchema = z.object({
    // Stable row key: the reported hostname when either door produced one, else the name that door knows it by.
    key: z.string(),
    // What to call it on screen — the user's own name for the machine wherever one exists.
    label: z.string(),
    // Whether a desktop-sync enrollment exists for this machine (it syncs files and/or mirrors ports).
    syncEnrolled: z.boolean(),
    // The host capability's id, when this machine is also a connected computer. Absent otherwise.
    hostId: z.string().optional(),
    // Host-capability liveness. Absent when there is no host capability — which is NOT the same as offline.
    online: z.boolean().optional(),
    /* WHAT THE COMPUTER IS, as distinct from how it is reachable — the half a row used to leave out entirely,
     * so a Windows laptop and a Linux desktop were two identical lines of text with different names on them.
     *
     * It is carried BESIDE the report rather than inside it because the rows that need it most are the ones with
     * no report: a connected computer with no sync agent, or one that is asleep, still knows its own OS. Nothing
     * here depends on an agent being installed, and the daemon has held all of it since the machine connected.
     *
     * `platform` is the slug this side classifies the machine by — the host capability's own card ("windows",
     * "linux"), or the platform token a sync report carries, normalised to the same words. `facts` is the
     * machine's connect-time description of ITSELF, which is what says which Windows and which shell. */
    platform: z.string().optional(),
    facts: HostFactsSchema.optional(),
    // The host agent's version and when the machine last held a socket — how a connected computer AGES. An old
    // agent explains a row that lacks something newer machines have, and "last seen" is the one honest thing an
    // offline row can still say about itself.
    hostAgent: z.string().optional(),
    lastSeen: z.number().optional(),
    report: MachineReportSchema.optional(),
    gap: ComputerGapSchema.optional(),
});
export type Computer = z.infer<typeof ComputerSchema>;
export const ComputersListSchema = z.object({ computers: z.array(ComputerSchema) });

// GET /system/sync — the enrollment state the Desktop sync card is built on, plus what each enrolled machine has
// said about itself. `machines` is optional because a daemon predating machine reports omits it, and an SPA is
// routinely newer than the daemon it is pointed at during a rolling update.
export const SyncStatusSchema = z.object({
    enrolled: z.boolean(),
    /* Whether this sandbox can do desktop sync at all. It used to be the SSH hostname the laptop would dial, and
     * its absence meant "this sandbox's reachability can't carry SSH" — true of every sandbox on the platform's
     * own fabric, which is what made sync fail on the default path. The transport rides the daemon's own HTTPS
     * surface now, so a sandbox that can answer this read can also sync. Kept as a field rather than assumed,
     * because the card branches on it and a daemon too old to say is one that should not be offered sync. */
    available: z.boolean().optional(),
    // The single machine holding file sync, and when its heartbeat last landed.
    syncingFrom: z.string().optional(),
    syncSeenAt: z.number().optional(),
    mirroredBy: z.array(z.string()).optional(),
    machines: z.array(MachineReportSchema).optional(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

// ---- public: the workspace outbox ----
// The mirror image of the reference shelf. Files under the workspace's `public/` directory are served as static
// files at public-<slot>-<sandboxId>.<zone>, with no auth in front of them — the process-free half of preview
// (a panel needs a running dev server; a file needs nothing). The directory's existence is the switch: it is
// absent until something is published and removed again when the last file leaves, so "publishing is off" is
// the resting state rather than a flag someone has to remember to set back.

export const PublicFileSchema = z.object({
    // Outbox-relative, forward-slash ("report.pdf", "site/index.html").
    path: z.string(),
    size: z.number(),
    modifiedAt: z.number(),
    // The file's public URL. Absent when the sandbox has no tunnel, or when a guard refuses this file.
    url: z.string().optional(),
    // Why a file sitting in the outbox is NOT served — a hidden name, a credential-shaped name, contents that
    // match a known token format, or sheer size. The publisher reads it here; a stranger requesting the same
    // file only ever gets the same 404 every other miss returns, so this list can't be probed from outside.
    blocked: z.string().optional(),
});
export type PublicFile = z.infer<typeof PublicFileSchema>;

// `url` is the outbox root — the base every file's URL hangs off, and what the view shows as "your public
// address". Absent on a loopback/no-tunnel sandbox, which has nowhere to publish to.
export const PublicListSchema = z.object({ url: z.string().optional(), files: z.array(PublicFileSchema) });
export type PublicList = z.infer<typeof PublicListSchema>;

// A WORKSPACE-relative path (the space the file tree speaks) to copy into the outbox. A copy, not a move: the
// repo a build output came from must not lose it because someone shared it.
export const PublishSchema = z.object({ path: z.string().min(1) });
// An OUTBOX-relative path to withdraw — the path space PublicFile.path speaks, not the workspace's.
export const UnpublishSchema = z.object({ path: z.string().min(1) });
export const PublishResultSchema = z.object({ path: z.string(), url: z.string().optional() });
export type PublishResult = z.infer<typeof PublishResultSchema>;

// ---- share: a conversation published as a page ----
/* The outbox holds FILES; a conversation is not one, so sharing it means RENDERING it into one. The result is
 * an ordinary published page under the same `public-<slot>` hostname, with the same guards in front of it —
 * which is the whole reason this rides the outbox rather than inventing a second public surface with its own
 * auth story to get wrong.
 *
 * A share is a SNAPSHOT, not a window. The page holds the conversation as it read at the moment of sharing and
 * does not move again until the owner re-takes it, because the alternative — a link that keeps publishing
 * whatever is said next — makes every later turn a disclosure the user did not consciously make. `sharedAt`
 * is therefore load-bearing on the row: it dates what the recipient can actually see. */

/* HOW MUCH OF A CONVERSATION TRAVELS, decided per share rather than by a setting, because the two answers suit
 * genuinely different acts. `messages` is the two speakers' words and nothing else — what you send a friend to
 * show what the thing said. `everything` adds the agent's work (its tool cards, the diffs of what it edited,
 * the pictures it took) and its thinking — what you send a colleague to show HOW it got there, and which
 * necessarily publishes the code and command output that appear in those cards.
 *
 * Two levels, not a set of switches: every extra toggle is another thing to get wrong about a link that cannot
 * be recalled once sent, and the honest distinction here is between "the conversation" and "the record". */
export const ShareDetailSchema = z.enum(["messages", "everything"]);
export type ShareDetail = z.infer<typeof ShareDetailSchema>;

// One shared conversation, as the Public view lists it.
export const SharedConversationSchema = z.object({
    /* The share's own id, and the name its page is filed under in the outbox. NOT the conversation's id: that
     * one is a memorable pair (`swift-otter-k9m2`, see conversation-ids.ts) chosen to be guessable BY A HUMAN
     * at a glance, which is the opposite of what should name a page whose only protection is that its address
     * is not enumerable. Minted per share, so re-sharing the same conversation twice yields two links. */
    id: z.string(),
    // Which conversation the snapshot was taken from — what Update re-reads, and what the chat matches against
    // to know it already has a share.
    conversationId: z.string(),
    title: z.string(),
    detail: ShareDetailSchema,
    // When the snapshot was taken (epoch ms). A share is frozen, so this dates what a recipient can see —
    // not when the conversation happened.
    sharedAt: z.number(),
    // How many messages the snapshot holds, so a row can say how much is behind the link without opening it.
    messages: z.number(),
    // The page's public URL. Absent on a sandbox with no tunnel, which has nowhere to publish to — the same
    // rule (and the same cause) as PublicFile.url.
    url: z.string().optional(),
});
export type SharedConversation = z.infer<typeof SharedConversationSchema>;

export const ShareListSchema = z.object({ shares: z.array(SharedConversationSchema) });
export type ShareList = z.infer<typeof ShareListSchema>;

// The title is the sharer's, not the conversation's: the chat's own name is only the default the dialog opens
// with. Bounded at the registry's title budget (title.ts MAX_LENGTH) so one surface can't store what the others
// truncate away.
export const ShareCreateSchema = z.object({
    conversationId: z.string().min(1),
    title: z.string().min(1).max(80),
    detail: ShareDetailSchema,
});
// Re-take an existing share's snapshot, keeping its id — and therefore its link, which has already been sent.
export const ShareUpdateSchema = z.object({ id: z.string().min(1) });
export const ShareRemoveSchema = z.object({ id: z.string().min(1) });

// ---- terminal ----
// EVERY live surface in the sandbox the web app's ONE global panel can show. Mostly tmux sessions (the
// interactive I/O is the /system/terminal WebSocket, not oRPC), plus the agent's browser, which is not a
// terminal at all — no more than a `process` row is — but IS the same question: what is running right now,
// and can I look at it? One list, because the panel that answers that question is one panel.
//
// `shell` = a web-* session the user opened (numbered pill),
// `panel` = a panel-* dev-server session (labeled by its panel key, started via Start; running:false =
// untracked, e.g. a finished one-shot job's lingering shell), `agent` = an agent-* session the Claude agent's
// Bash commands run in (live-watchable, AI-marked in the UI; running:false once every window is a finished
// command's dead pane, which is what lets the panel sweep it), `job` = a job-* session the daemon's terminal
// runner executes user-triggered flows in (capability adds, infra check), `process` = a managed background
// process riding a panel session (an extension's declared processes, dockerd) — surfaced in the panel's
// background-processes popover with read-only log views, never as a killable tab; running is the actual
// process (a lingering shell after a crash reads false). A process row that maps to an installed extension's
// declared process carries extensionId+processName, the address for its /extensions start/stop routes. The
// `{name}` kill-route param is a bare string validated in the handler (a bad name is a BAD_REQUEST) since the
// same charset gates a `tmux kill-session -t` shell-out. The agent's BROWSER is deliberately NOT one of these
// kinds: a Chromium with its own tab strip is a surface in its own right, not a pane in the terminal panel, so
// it lists from /system/browsers with the pages it has open (BrowserSessionSchema below).
//
// `activityAt` (epoch ms of the session's last output) and `exitCode` (the LAST window's exit status, absent
// while that pane still lives) describe a session beyond "it exists": the panel's work popover orders its live
// rows by the one and dates them off it, and the daemon's retention sweep ages sessions out by the same clock.
// 0 is "tmux didn't say" — treated as unknown by both, never as 1970.
export const TerminalSessionSchema = z.object({
    name: z.string(),
    label: z.string().optional(),
    kind: z.enum(["shell", "panel", "agent", "job", "process"]),
    running: z.boolean(),
    activityAt: z.number(),
    exitCode: z.number().optional(),
    extensionId: z.string().optional(),
    processName: z.string().optional(),
    // The agent has parked on a command that stopped for a PERSON — an OTP prompt, a security-key touch, a
    // confirm it cannot answer — and is waiting at this session's live pane. `message` is its own account of
    // what it needs. The terminal panel renders it as a banner over that session's tab (where the prompt the
    // user has to answer already is) and its buttons settle the parked card through `POST /agent/reply` with
    // `requestId`, exactly as the chat card does. The same shape as a browser's `help` below, on purpose: the
    // two handovers differ in WHERE the person acts, not in what is being asked. Present only while open.
    help: z.object({ requestId: z.string(), message: z.string(), requestedAt: z.number() }).optional(),
});
export const TerminalsListSchema = z.object({ sessions: z.array(TerminalSessionSchema) });
export type TerminalsList = z.infer<typeof TerminalsListSchema>;
export const TerminalNameParamSchema = z.object({ name: z.string() });

// One session's PANE HISTORY as plain text. This route exists because the browser cannot reach it any other
// way: a tmux client runs on the ALTERNATE screen, which has no scrollback of its own, so what the wheel moves
// through lives in tmux on the far side of the socket and never enters the xterm buffer the page could select.
// `lines` is how far back to ask for — tmux clamps it to the history it actually has, and `truncated` says the
// answer stopped at the request rather than at the beginning.
export const TerminalScrollbackQuerySchema = z.object({
    name: z.string(),
    lines: z.coerce.number().min(1).max(100_000).default(20_000),
});
export const TerminalScrollbackSchema = z.object({
    name: z.string(),
    // Oldest line first, wrapped lines rejoined so a copied URL or path comes back whole.
    text: z.string(),
    lines: z.number(),
    truncated: z.boolean(),
});
export type TerminalScrollback = z.infer<typeof TerminalScrollbackSchema>;

/* ---- browsers: the Chromium the agent drives through its @playwright/mcp tools ----
 *
 * A `browser-<sdk session>` Chromium (browser/browser-sessions.ts), watchable live over the
 * /system/browser-view WebSocket. It lists apart from the terminals because it is shaped differently in the one
 * way that decides a UI: a terminal is ONE stream of bytes, while a browser holds SEVERAL pages at once and the
 * question "what is the agent looking at?" only has an answer if the wire carries all of them. So `pages` is the
 * point of this schema — the view renders them as a tab strip and binds the screencast to whichever the user
 * picks, and `active` is the one the agent itself last touched (what the view follows until the user says
 * otherwise).
 *
 * `id` is opaque and minted per session, and it is what makes a tab survive a relist: it is stable for the life
 * of the page, unlike its url (the agent navigates away) or its position (a closed tab renumbers the rest). */
export const BrowserPageSchema = z.object({
    id: z.string(),
    // The page's own title. Absent mid-navigation, which is exactly when a tab still needs to render.
    title: z.string().optional(),
    url: z.string(),
    // The page the agent last drove — on a finished session, the one it ended on. Exactly one page has it.
    active: z.boolean(),
});
export const BrowserSessionSchema = z.object({
    name: z.string(),
    // The pill's text: the active page's title, else its host, else which browser this is.
    label: z.string(),
    // Which MCP server drives it: `web` (the credential-free browser) or a logged-in capability's id — the
    // difference between a throwaway page and one signed in as the user, which is worth saying out loud.
    server: z.string(),
    // False once that Chromium is gone (the turn ended, the agent closed it, it crashed). A finished session
    // still lists for a while, with the pages it had — the record of where the agent went.
    running: z.boolean(),
    activityAt: z.number(),
    // When that Chromium went away, for the "closed 20m ago" line a finished session leads with. Absent while
    // running, which is the same fact as `running` — but the view needs the timestamp, not just the flag.
    finishedAt: z.number().optional(),
    // The agent has hit something only a person can clear (a captcha, a password it does not hold, a phone
    // check) and is PARKED on it: `message` is its own account of what it needs, in the user's language. The
    // Browsers view renders it as a banner over the live stage — where "Take control" already is — and its
    // buttons settle the parked card through `POST /agent/reply` with `requestId`, exactly as the chat card
    // does; the field clears when the waiter settles, never by direct edit. Present only while open.
    help: z.object({ requestId: z.string(), message: z.string(), requestedAt: z.number() }).optional(),
    pages: z.array(BrowserPageSchema),
});
export type BrowserPage = z.infer<typeof BrowserPageSchema>;
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;
export const BrowsersListSchema = z.object({ sessions: z.array(BrowserSessionSchema) });
export type BrowsersList = z.infer<typeof BrowsersListSchema>;
export const BrowserNameParamSchema = z.object({ name: z.string() });

/* ---- subagents: the agents an agent starts ----
 *
 * The third thing a turn spawns that the operator can be shown, after its shell and its browser — and the only
 * one that is itself an agent. Two kinds land in this one list, because from outside they are the same fact
 * (another agent, working, that you did not start):
 *   • `subagent` — the SDK's Agent/Task tool. The daemon learns of it from the SubagentStart/SubagentStop hooks
 *     and the task_* stream messages, joined on `toolUseId`.
 *   • `codex` / `grok` — a CLI the agent drove from its own Bash (agent/delegation.ts). Detected in the Bash
 *     PreToolUse hook, bound to its thread/session id from the command's output.
 *
 * `id` IS THE SPAWNING TOOL CALL'S id — the Agent card's, or the Bash card's for a delegation. It is the one key
 * every source already carries (the SDK's subagent meta, its task_* messages, and the `parentToolUseId` the
 * client nests inner frames under), so nothing has to be correlated: a card links to its subagent with the id it
 * already has, and the subagent points back at the card the same way. The ids the transcripts are actually READ
 * with — the SDK's agent id, a Codex thread, an OpenCode session — stay daemon-side, because no surface asks a
 * question they answer.
 *
 * WHAT A KIND CHANGES, and it is only ever the live view: a subagent has no process of its own to look at, so
 * watching it means reading its transcript. A delegation runs in a tmux window, so it has both — `terminal`
 * names it, and the card keeps its existing "Watch in terminal" beside the transcript door. */
export const SubagentKindSchema = z.enum(["subagent", "codex", "grok"]);
export type SubagentKind = z.infer<typeof SubagentKindSchema>;

// running/pending/blocked are live; the rest are terminal. Deliberately the SDK's own task vocabulary
// (SDKTaskUpdatedMessage.patch.status) rather than AgentStatus: this is not a fleet card's lifecycle (no
// draft/landed/conflict), and mapping the two would invent states neither side reports. `blocked` is the one
// addition the SDK never says: it comes from a delegated CLI's own signals (a Codex PermissionRequest hook, an
// OpenCode permission ask — agent/delegation-signals.ts), and it exists because "the child needs an answer" is
// the one live state a parent or an operator acts on differently from "the child is working".
export const SubagentStatusSchema = z.enum(["pending", "running", "blocked", "completed", "failed", "killed", "paused"]);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

export const SubagentSessionSchema = z.object({
    id: z.string(),
    kind: SubagentKindSchema,
    // The conversation whose turn spawned this — what the area groups its rows by, and the way back to the chat
    // the card lives in.
    conversationId: z.string(),
    // What it is and what it was asked to do: the subagent type (`Explore`, `general-purpose`) or the delegated
    // provider's model, and the caller's one-line description. The area's row and the card's title read as
    // `Explore · Locate claimIndexer definition`.
    agentType: z.string().optional(),
    description: z.string().optional(),
    model: z.string().optional(),
    // How deep in the spawn tree (1 = spawned by the turn itself). From the SDK's meta.json; a subagent may
    // itself delegate, and a flat list that cannot say so reads as though the turn started all of them.
    spawnDepth: z.number().optional(),
    // Backgrounded: the parent went on working instead of waiting for it. This is the whole reason the list
    // exists — a backgrounded child used to be invisible until its result landed, sometimes minutes later.
    background: z.boolean().optional(),
    status: SubagentStatusSchema,
    startedAt: z.number(),
    endedAt: z.number().optional(),
    activityAt: z.number(),
    // What it has spent and done so far (task_progress). Tokens are the child's own, so a parent's cost line and
    // the sum of its children's are two different true numbers.
    tokens: z.number().optional(),
    toolUses: z.number().optional(),
    lastTool: z.string().optional(),
    // Its report — the last assistant message (SubagentStop) or the task summary. The answer to "what did it
    // conclude?" without opening the transcript, which is the question a finished child is read for.
    summary: z.string().optional(),
    error: z.string().optional(),
    // A delegation's live view: the tmux session its command runs in. Absent for an SDK subagent, which has no
    // process of its own to attach to.
    terminal: z.string().optional(),
});
export type SubagentSession = z.infer<typeof SubagentSessionSchema>;
export const SubagentsListSchema = z.object({ sessions: z.array(SubagentSessionSchema) });
export type SubagentsList = z.infer<typeof SubagentsListSchema>;
export const SubagentIdParamSchema = z.object({ id: z.string() });

// ---- environment: the overlay Dockerfile extending the sandbox image ----
// The approved file is DAEMON-COMPOSED: pinned FROM + capability fragments + the owner-approved custom section.
// The agent drafts one file per thing it needs (.intentic/environment.d/<tool>.Dockerfile — custom-section
// content only, no FROM) with its normal file tools, and the daemon folds those into the single proposal file
// (.intentic/environment.Dockerfile) the owner reads. The owner approves it in the browser, which stores it as
// the custom file and recomposes the approved artifact whose sha256 the rebuild executor pins. Both composed
// files are written only when the composition CHANGES — see writeComposed, and the read loop it exists to end.
// Status is derived, never stored:
// applied = sha256(approved) === appliedHash; pending rebuild = approved present but hashes differ; proposed =
// proposal present with a hash different from custom's.

const environmentFileSchema = z.object({ content: z.string(), hash: z.string() });
export const EnvironmentSchema = z.object({
    proposal: environmentFileSchema.optional(),
    // The owner-approved agent-written custom section (.intentic/environment.custom.Dockerfile).
    custom: environmentFileSchema.optional(),
    approved: environmentFileSchema.optional(),
    // sha256 of the overlay the running container was built from (SANDBOX_ENVIRONMENT_HASH); absent = stock image.
    appliedHash: z.string().optional(),
    // config.sandbox.name — the UI derives the rebuild one-liner's slug from it.
    container: z.string().optional(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;
export const EnvironmentApproveSchema = z.object({ hash: z.string().min(1) });

/* ---- environment CONTENTS: what the sandbox has, as opposed to how it was built ----
 *
 * The overlay above answers "what was added on top, and do you approve it?". Nobody opens the Environment tab
 * asking that — they ask "can this sandbox compile my Rust app / transcode a video / drive a browser?", and a
 * build recipe is a bad answer to it: it is install plumbing, it names packages rather than abilities, and it is
 * only the DELTA, so an inventory read off it alone would claim a sandbox has ffmpeg and no Node.
 *
 * So this is a second read of the same sandbox, and its authority is different in a way that matters: NAMES,
 * GROUPING and RATIONALE come from the recipe (which is where the agent wrote them), while PRESENCE and VERSION
 * come from asking the environment itself. That split is what makes it honest. A version is never parsed out of
 * an install line — half the entries pin nothing, and a pinned number is a lie the moment something is approved
 * but not yet rebuilt — so an item whose tools cannot be probed carries no version at all rather than a guess.
 * And presence is OBSERVED, which is what makes per-item state exact without diffing anything: an item the
 * recipe contains and the probe cannot find is precisely one that arrives with the next rebuild.
 */

const environmentToolSchema = z.object({
    // The binary as it is invoked (`rustc`, `ffmpeg`), because that is what somebody types next.
    name: z.string(),
    // What the binary itself reports, absent when it is not installed (yet) or answers no version flag.
    version: z.string().optional(),
});

export const EnvironmentItemSchema = z.object({
    id: z.string(),
    // The block's own name — how the thing is referred to, not the packages it happens to install.
    name: z.string(),
    /* WHY IT IS HERE, which is also whether the reader may remove it: `custom` is what an agent asked for and the
     * owner approved for this workspace, `capability` is the cost of a capability they turned on, `base` comes
     * with every sandbox and is nobody's decision. */
    origin: z.enum(["custom", "capability", "base"]),
    // Which capability/extension/pack pulled it in — the answer to "why do I have this?" for an origin the
    // reader did not choose item by item.
    originLabel: z.string().optional(),
    // Observed, not inferred: `active` means the probe found it, `after-rebuild` that the recipe has it and the
    // container does not, `awaiting-approval` that it is in a proposal nobody has approved yet.
    state: z.enum(["active", "after-rebuild", "awaiting-approval"]),
    // Every binary this one block puts on PATH, with the version each reports. Usually one; a toolchain is several.
    tools: z.array(environmentToolSchema),
    // How many further packages the block installs that are not commands anyone runs (libraries, headers). A
    // count rather than a list: eleven rows of `libssl-dev` is noise, "+11 packages" is the same fact.
    extras: z.number().optional(),
    // One standalone line, from the block's opening comment — the part everyone reads.
    purpose: z.string().optional(),
    /* That comment in full, as prose, absent when the line above already is the whole of it. NOT the remainder
     * after the line: `purpose` is a summary of this (a parenthetical dropped, an over-long sentence cut back to
     * its claim), so the two overlap by design and it is the reader's view that picks one. Long — the rationale
     * for a toolchain runs to paragraphs — so it lives behind a disclosure rather than on the row. */
    detail: z.string().optional(),
    // The block's own instruction lines, for the reader who wants to see exactly what runs.
    commands: z.string().optional(),
});
export type EnvironmentItem = z.infer<typeof EnvironmentItemSchema>;
export const EnvironmentContentsSchema = z.object({ items: z.array(EnvironmentItemSchema) });
export type EnvironmentContents = z.infer<typeof EnvironmentContentsSchema>;

/* ---- portability: exporting a sandbox's environment and restoring it into a fresh one ----
 *
 * A sandbox is four stores, not one: `/work` (the workspace and the daemon's manifests), `/history` (every
 * repo's real git dir, the fleet registry, the ledgers), the CONTAINER (the built overlay image plus the env
 * the run contract replays) and the AI-provider credential root. A bundle carries the first two, declared entry
 * by entry in WORKSPACE_STATE_FILES / HISTORY_STATE_FILES. It cannot carry the other two, and the honest
 * consequence is that an import ends in a REPORT rather than a claim of equivalence — the container has no
 * docker socket, so only the host can rebuild the image the overlay describes.
 */

// What the bundle says about itself, written as its first tar entry so a reader learns the shape before the
// bytes. `secrets` is the owner's export-time choice; the restorer re-derives every decision from the manifests
// rather than trusting this, and uses it only to explain what is missing.
export const BundleManifestSchema = z.object({
    // Bumped when the layout changes in a way an older daemon would misread. Refused rather than guessed at.
    version: z.literal(1),
    // Where it came from, for the report's first line. Never used to authorize anything.
    sandbox: z.object({ name: z.string() }).optional(),
    createdAt: z.number(),
    secrets: z.boolean(),
    /* The environment the target has to reproduce, carried as FACTS rather than as the composed file (which the
     * target recomposes against its OWN base image on first boot). `customDockerfile` is the owner-approved
     * source section; `capabilities` names what contributed the remaining fragments, so the report can list what
     * to re-add when the configs themselves did not travel. */
    environment: z.object({
        customDockerfile: z.string().optional(),
        baseImage: z.string().optional(),
        approvedHash: z.string().optional(),
        capabilities: z.array(z.object({ id: z.string(), kind: z.string() })),
    }),
    // Every path class the bundle deliberately left out, with the manifest's own note where it has one. This is
    // what turns "the export skipped things" from a silence into a list the owner can act on.
    excluded: z.array(z.object({ path: z.string(), portability: z.string(), note: z.string().optional() })),
});
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

// What a restore actually did. `needsAction` is the part that matters: the environment rebuild command, the
// credentials to re-enter, the logins to redo — each one a thing the target cannot do for itself.
export const ImportReportSchema = z.object({
    restored: z.object({ workspaceFiles: z.number(), historyFiles: z.number(), repos: z.array(z.string()), bytes: z.number() }),
    // Entries the bundle carried that this daemon refused to write (an identity file, an escaping path) — empty
    // for any bundle a matching exporter produced, and a tamper signal when it is not.
    refused: z.array(z.string()),
    needsAction: z.array(z.object({ subject: z.string(), detail: z.string() })),
});
export type ImportReport = z.infer<typeof ImportReportSchema>;

/* ---- migrations: importing a FOREIGN assistant's setup (Hermes, OpenClaw) ----
 *
 * A different crossing than a bundle restore, and deliberately a different surface: a bundle is our own format,
 * re-derived entry by entry against the state manifests, while a migration reads a directory some OTHER
 * program laid out (`~/.hermes`) and TRANSLATES it into native things — skills, automations, capabilities,
 * merged memory. Nothing foreign is executed or copied verbatim into daemon state; every item lands through the
 * same write paths the settings/skills/automations/capabilities surfaces use, which is what keeps an imported
 * setup editable and deletable in the ordinary UI the day after (docs/assistant-import-design.md).
 *
 * The flow is PREVIEW-FIRST, mirroring what these tools' own `migrate` commands taught their users to expect:
 * `plan` parses the uploaded archive into an itemized checklist and holds the upload in memory under a token;
 * `apply` names the ticked item ids and the token. The plan is RE-DERIVED from the held archive at apply — the
 * wire plan is a rendering for the owner, never the input the write trusts (restore.ts's rule, kept). */
export const MigrationSourceSchema = z.enum(["hermes", "openclaw"]);
export type MigrationSource = z.infer<typeof MigrationSourceSchema>;

// What an item becomes here, not what it was there — the apply loop dispatches on this, and the checklist
// groups by it so the owner reads "3 skills, 2 automations" rather than a foreign directory listing.
export const MigrationTargetSchema = z.enum(["memory", "skill", "automation", "capability", "secret", "file"]);
export type MigrationTarget = z.infer<typeof MigrationTargetSchema>;

export const MigrationItemSchema = z.object({
    // Deterministic (derived from the source artifact, e.g. `skill:weather`), so the ids the owner ticked name
    // the same items when the plan is re-derived at apply.
    id: z.string(),
    target: MigrationTargetSchema,
    // The checklist line, plain words: "Skill — weather", "Nightly digest (9:00 every day)".
    label: z.string(),
    detail: z.string().optional(),
    /* The default tick. False marks the items the owner should read before taking — a server URL that points at
     * localhost on the OLD machine, an .env key that looks like tuning rather than a credential. They still
     * import fine when ticked; the flag is the adapter's judgment, not a gate. */
    recommended: z.boolean(),
    // Names of the secrets this item would store (never values — values stay in the held archive until apply,
    // and only move when the apply says includeSecrets). Empty for items that carry none.
    secrets: z.array(z.string()),
});
export type MigrationItem = z.infer<typeof MigrationItemSchema>;

export const MigrationNeedsActionSchema = z.object({ subject: z.string(), detail: z.string() });

export const MigrationPlanSchema = z.object({
    source: MigrationSourceSchema,
    // Names the held upload for the apply call. Minted per plan; a new upload replaces the held one.
    token: z.string(),
    items: z.array(MigrationItemSchema),
    // What the adapter saw and will not move — sessions, logs, pairing state — listed rather than silent.
    refused: z.array(z.string()),
    // What is already known not to move mechanically (channels to reconnect, a model to pick) — the same
    // honesty ImportReportSchema carries, surfaced at PREVIEW time so the owner ticks with open eyes.
    needsAction: z.array(MigrationNeedsActionSchema),
});
export type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

/* One of the owner's own computers, as an import SOURCE — the answer to "where is my setup" that needs no
 * packing at all. Read on the card's first render for every enrolled machine, so the offer appears before the
 * owner has read a single instruction.
 *
 * `found` absent means "connected, and nothing to import here" — which is a real answer worth rendering
 * quietly, not an error: the machine may simply be a different one from the machine the assistant runs on. */
export const MigrationHostSchema = z.object({
    id: z.string(),
    online: z.boolean(),
    found: MigrationSourceSchema.optional(),
    // Why this machine cannot be read right now, when it cannot — offline, or its own refusal, in its words.
    detail: z.string().optional(),
});
export const MigrationHostsSchema = z.object({ hosts: z.array(MigrationHostSchema) });
export type MigrationHost = z.infer<typeof MigrationHostSchema>;

// Read the setup off a connected computer instead of an upload. Answers with a plan, exactly as the upload
// route does — everything after this point is identical whichever door the setup came through.
export const MigrationScanSchema = z.object({ host: z.string().min(1) });

export const MigrationApplySchema = z.object({
    token: z.string(),
    // The ticked item ids. Ids the re-derived plan does not contain are ignored rather than erroring — the
    // archive is the truth, and a stale checklist must not block the items that still exist.
    items: z.array(z.string()),
    // The owner's explicit consent to move credential VALUES (mirrors the bundle export's `?secrets=`, and the
    // `--include-secrets` these tools' own migrate commands require). Off: secret items are skipped and
    // capability configs land without their keys.
    includeSecrets: z.boolean(),
});
export type MigrationApply = z.infer<typeof MigrationApplySchema>;

export const MigrationReportSchema = z.object({
    applied: z.array(z.object({ id: z.string(), target: MigrationTargetSchema, label: z.string() })),
    // Items that were ticked and did not land, each with the reason — a full disk, an env store that needs
    // DevOps active. Distinct from `refused`, which is the class of things never attempted.
    failed: z.array(z.object({ id: z.string(), label: z.string(), error: z.string() })),
    refused: z.array(z.string()),
    needsAction: z.array(MigrationNeedsActionSchema),
});
export type MigrationReport = z.infer<typeof MigrationReportSchema>;

/* One export sitting in the daemon's export directory — the ARTIFACT a bundle is, rather than the request that
 * produced it. Packing takes minutes over a real workspace, so tying it to a response made it a property of one
 * browser tab: a refresh abandoned the work and left nothing to come back to. It is a file now, and every field
 * below is read off that file rather than remembered anywhere.
 *
 * `status` is derived from the extension (.part / .tar.gz / .failed) and `bytes` is the file's own size, which
 * is what makes a live pack's progress free to report. */
export const BundleExportSchema = z.object({
    // The finished bundle's filename, which is the id in every route — and, once downloaded, the name the owner
    // sees on disk. Carries its own timestamp and a `-with-secrets` marker so it stays self-describing there.
    name: z.string(),
    status: z.enum(["packing", "ready", "failed"]),
    // Bytes written so far while packing; the finished size once ready.
    bytes: z.number(),
    // mtime: when packing ended for a finished bundle, when it last made progress for a live one.
    createdAt: z.number(),
    secrets: z.boolean(),
    // Why it stopped, for a failed one. Read from the .failed marker's own contents.
    error: z.string().optional(),
});
export type BundleExport = z.infer<typeof BundleExportSchema>;
export const BundleExportsSchema = z.object({ exports: z.array(BundleExportSchema) });

// ---- secrets: user-supplied env-var secrets the daemon writes to desired-state/.env ----
// The web posts a Cloudflare token / GitHub PAT / another-host SSH key straight to the sandbox daemon (never
// through the platform); `apply` reloads .env each run so a new secret is picked up with NO restart. `list`
// returns KEYS ONLY — the values never leave the sandbox; `reveal` is the one deliberate, owner-only exception.
export const SecretSetSchema = z.object({
    key: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .max(128),
    value: z.string().min(1),
});
export const SecretKeysSchema = z.object({ keys: z.array(z.string()) });
export const SecretKeyParamSchema = z.object({ key: z.string() });
export const SecretRevealSchema = z.object({ value: z.string() });

// One entry per secret the sandbox knows about, across every store: intent env secrets and intentic-generated
// passwords (from the desired-state repo), capability credentials, and AI-provider accounts. Values never ride
// this shape — `revealable` says whether `reveal` can return one (everything but provider accounts).
export const SecretInventoryEntrySchema = z.object({
    // Env-var key for env|generated; `<provider>:<accountId>` for provider entries; capability instance id
    // otherwise. Unique within the inventory — several accounts of one provider each get their own entry.
    key: z.string(),
    kind: z.enum(["env", "generated", "capability", "provider"]),
    // Display name for provider entries: "<ProviderName> · <accountLabel>". Absent on env/generated entries.
    label: z.string().optional(),
    status: z.enum(["missing", "set", "connected"]),
    // The artifact resources referencing this secret ({$secret} refs); [] for capability/provider entries.
    requiredBy: z.array(z.object({ resourceId: z.string(), type: z.string() })),
    // Human-readable provenance, e.g. "desired-state/.env" — the UI's "where does this live" line.
    storedAt: z.string(),
    revealable: z.boolean(),
    // Forgejo Actions replication state, present only after adopt on env|generated entries.
    ci: z.object({ synced: z.boolean(), pushedAt: z.string().optional() }).optional(),
    /* The newest row of the use ledger that concerns this entry — when the agent last SPENT it, on which lane
     * (a shell command, a JS run's script, a browser field), and where it went (the head of the command or
     * script, or the page's host). Names and destinations only, never values. Absent while a secret has never
     * been used, which most never are. */
    lastUse: z.object({ at: z.number(), lane: z.enum(["shell", "code", "browser"]), detail: z.string().optional() }).optional(),
});
export type SecretInventoryEntry = z.infer<typeof SecretInventoryEntrySchema>;
export const SecretInventorySchema = z.object({ entries: z.array(SecretInventoryEntrySchema) });

// ---- system ----

// version: what this daemon runs (baked). latest/updateAvailable: the daemon compares its version to the
// latest published `stable` release so the web can offer a non-blocking update (see system/version-check.ts).
/* Whether an agent runtime can serve a turn right now, probed off the turn path (see the sandbox's
 * agent/adapter-health.ts). "unknown" is a real answer — a probe that could not run must not read as
 * "unavailable" and grey out a provider the user can in fact use — so surfaces treat it as
 * available-but-unverified rather than as a soft no. */
export const AdapterHealthSchema = z.object({
    state: z.enum(["ready", "unavailable", "unknown"]),
    // Why it cannot serve, in the user's terms and naming what to do about it. Absent when ready.
    detail: z.string().optional(),
    checkedAt: z.number(),
});
export type AdapterHealthReport = z.infer<typeof AdapterHealthSchema>;

export const InfoSchema = z.object({
    name: z.string().optional(),
    image: z.string().optional(),
    version: z.string().optional(),
    latest: z.string().optional(),
    updateAvailable: z.boolean().optional(),
    // Keyed by AgentCapabilities.runtime. Absent until the first background sweep lands, which reads the same
    // as every entry being "unknown" — one of the two cannot go stale, so the daemon sends the absence.
    runtimes: z.record(z.string(), AdapterHealthSchema).optional(),
    /* Which release channel this sandbox follows (`stable` unless it was moved), and the base image the last
     * swap replaced — both set on the container by the host script that performed the swap, since neither is
     * knowable from inside afterwards. `previousImage` is what a rollback returns to; absent means there is
     * nothing to go back to and no rollback is offered. */
    channel: z.string().optional(),
    previousImage: z.string().optional(),
    /* WHAT IS IN THE UPDATE, in the words of the people it is for — the user-facing lines from every release
     * between `version` and `latest`, newest first (platform/release-notes.ts reads them off the published
     * GitHub Releases).
     *
     * The update card's other half. It could always say an update exists and what taking it costs — recreating
     * the container interrupts every agent mid-turn — and never what the update was worth, which left the
     * decision it asks for with nothing on one side of it.
     *
     * Absent, or empty, whenever there is nothing to say: the notes cache is cold, GitHub is unreachable, or
     * every release in the gap changed only things nobody outside the project would notice. All three read the
     * same way on the card, which shows the offer without them, exactly as it did before. */
    updateNotes: z.array(z.string()).optional(),
    // How many further notes the gap holds beyond the ones sent, for a sandbox that has been left alone a long
    // time. Absent or 0 ⇒ `updateNotes` is the whole of it.
    moreUpdateNotes: z.number().optional(),
    /* WHAT THE UPDATE TAKES AWAY — the "Breaking changes" lines from every release in the same gap, uncapped
     * (a warning that fell off a truncated list is a breaking update taken unwarned). Their presence is what
     * turns the update card from an offer into a warning that asks to be read before it hands over the
     * command. Absent for the overwhelming majority of updates, which break nothing. */
    breakingNotes: z.array(z.string()).optional(),
});
export type Info = z.infer<typeof InfoSchema>;

/* WHAT THE DAEMON COULD NOT READ IN ITS OWN STATE FILES.
 *
 * Every manifest under `.intentic/` is read through a schema and falls back when that schema says no, which
 * keeps the daemon up and — until this route — ended there. A settings file with one bad character read as
 * every setting at its default, a misspelled flag was stripped in silence, and a skipped capability said so
 * only in the daemon log. All three look identical from a browser: the feature is simply off.
 *
 * `kind` is what to do about it, which is why it is not just a message:
 *   unreadable   — the whole file is being ignored. Everything in it is at its default.
 *   unknownKey   — one key this build does not know. Only that key is ignored, and `suggestion` carries the
 *                  name it was probably meant to be, when one is close enough to guess honestly.
 *   invalidEntry — one entry of a list was skipped. The rest of the file is unaffected.
 *
 * Reported per file rather than as one flat list because the file is the unit a person fixes — and only for the
 * files a person CAN fix (REPORTED_MANIFEST_PATHS in workspace-state.ts). A daemon-written ledger that stops
 * matching a tightened schema is not a repair job to hand the owner; it recovers on its own next write. */
export const ManifestProblemSchema = z.object({
    kind: z.enum(["unreadable", "unknownKey", "invalidEntry"]),
    detail: z.string(),
    suggestion: z.string().optional(),
});
export type ManifestProblem = z.infer<typeof ManifestProblemSchema>;

// Workspace-relative path (`.intentic/settings.json`) and everything currently wrong with that file. A file
// with nothing wrong is absent from the list rather than present and empty.
export const ManifestProblemReportSchema = z.object({ path: z.string(), problems: z.array(ManifestProblemSchema) });
export type ManifestProblemReport = z.infer<typeof ManifestProblemReportSchema>;

export const ManifestProblemsSchema = z.array(ManifestProblemReportSchema);

// A daemon-minted session (system.session): the steady-state browser credential, exchanged for a verified
// Google ID token so Google UI is a sign-in moment instead of an hourly renewal. `expiresAt` is epoch ms —
// the browser renews ahead of it without parsing the token; `email` is who the daemon verified.
export const DaemonSessionSchema = z.object({ token: z.string(), expiresAt: z.number(), email: z.string() });
export type DaemonSession = z.infer<typeof DaemonSessionSchema>;

// ---- activity: the activity audit log (historyRoot/activity.jsonl) ----
// One provider-agnostic event per agent↔provider interaction, appended by the daemon only (never the agent —
// the log lives under historyRoot, outside /work, so the agent can't read or rewrite its own trail). Discord
// is the first source; other cli providers reuse the same shape.

export const ActivityEventSchema = z.object({
    id: z.string(),
    // Epoch ms; also the paging cursor.
    at: z.number(),
    // "discord", …; absent on provider-less system events (a cron automation.run).
    provider: z.string().optional(),
    // Which provider account handled the turn — the attribution key for per-account usage totals. Absent on
    // provider-less events and turns that ran on the provider's default account.
    account: z.string().optional(),
    direction: z.enum(["in", "out", "system"]),
    // in: message.received | voice_utterance.received | voice_transcript.received
    // out: message.send | reaction.add | messages.read | api.call (unclassified provider endpoint)
    // system: gateway.login_failed | dispatch.failed | voice.session_started | voice.session_ended | automation.run
    //         | turn.started | turn.plan | turn.error | turn.completed (agent turn lifecycle; provider = claude/codex)
    //         | rule.blocked_push | rule.held_work | rule.continued_turn (a rule DID something — see RuleSchema.
    //           Only the three outcomes a person would otherwise have no explanation for: a push that did not
    //           go, work that did not arrive, a turn that did not end. A rule that ran and passed says nothing,
    //           because a feed that logs every green check is one the eye learns to skip.)
    type: z.string(),
    channelId: z.string().optional(),
    // Inbound author display name.
    author: z.string().optional(),
    // Full message text (inbound) or sent payload content (outbound).
    content: z.string().optional(),
    // Outbound HTTP method + endpoint path (tokens ride headers, never URLs).
    method: z.string().optional(),
    endpoint: z.string().optional(),
    // The agent turn that made/handled it — the join key between an inbound wake and its outbound calls.
    sessionId: z.string().optional(),
    /* ONE TURN'S EVENTS, TIED TOGETHER. A turn writes four lifecycle events plus one per outbound provider call,
     * and read as five rows they say one thing five times — so the feed groups on this instead. It cannot be
     * sessionId: the runtime does not mint one until the stream's first frame, which is AFTER turn.started, so
     * the very event carrying the prompt is the one that could never be joined. Minted by the turn itself. */
    turnId: z.string().optional(),
    // The stable conversation the turn belongs to. Outlives sessionId, which a provider/account/harness switch
    // retires mid-conversation — so this, not sessionId, is what "the same agent" means across a feed.
    conversationId: z.string().optional(),
    // The conversation's display title as it stood when the event was written. Denormalised on purpose: the
    // registry entry it came from is prunable and renameable, and an audit row must still read as words years
    // later. Absent on the first event of a fresh conversation — the auto-namer has not run yet.
    title: z.string().optional(),
    // What woke the conversation from outside, when something did (see AgentOriginSchema) — the feed's "who
    // called me" attribution, and how a turn is filed under Discord rather than under the runtime that served it.
    origin: AgentOriginSchema.optional(),
    automationIds: z.array(z.string()).optional(),
    outcome: z.enum(["ok", "error"]).optional(),
    error: z.string().optional(),
    // Source-specific detail: guildId, attachments, transcript path, participants…
    extra: z.record(z.string(), z.unknown()).optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const ActivityQuerySchema = z.object({
    provider: z.string().optional(),
    limit: z.coerce.number().min(1).max(500).default(100),
    // `at` cursor, exclusive — newest-first paging.
    before: z.coerce.number().optional(),
});
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;
export const ActivityListSchema = z.object({ events: z.array(ActivityEventSchema) });

// Live connection health, probed per provider capability (not stored): gateway state from the client pool
// (idle = the gateway is up but has no enabled listener automation to connect for — distinct from a
// connection that should be up but isn't; pairing = the socket is up but the credential is a ceremony nobody
// has finished, which no amount of waiting fixes), lastError from the newest system-error event in the log.
export const ActivityConnectionSchema = z.object({
    capabilityId: z.string(),
    provider: z.string(),
    gateway: z.enum(["ready", "connecting", "pairing", "disconnected", "idle"]),
    lastError: z.string().optional(),
});
export const ActivityStatusSchema = z.object({
    connections: z.array(ActivityConnectionSchema),
    // The daemon's live voice session, when one is up.
    voice: z.object({ channelId: z.string(), channelName: z.string(), startedAt: z.number(), participants: z.array(z.string()) }).optional(),
});
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;

// ---- usage: the durable spend ledger ----
// One row per attributed turn, appended at turn end and NEVER pruned. This exists because the activity log
// can't answer a money question: it prunes to its most recent entries, so a month's spend is unanswerable and
// — worse for a cost readout — the totals SHRINK as newer turns evict older ones. The ledger keeps the raw
// per-turn facts and the rollup projects them on read, so a new grouping (by day, by model, by conversation)
// needs no new storage and no migration.
export const UsageTurnSchema = z.object({
    // Epoch ms at turn end. Kept alongside `day` so a future timezone-aware rollup is a pure change over data
    // already on disk.
    at: z.number(),
    // The UTC calendar day (YYYY-MM-DD) `at` fell in — precomputed so a rollup never re-derives a timezone.
    day: z.string(),
    provider: z.string(),
    // Absent on an env-token turn, which has no account to attribute to (same rule as the activity log).
    account: z.string().optional(),
    // The model the turn ACTUALLY ran, resolved past the client's pick and every provider default. Absent only
    // when the provider's own subscription default served it without the daemon naming one.
    model: z.string().optional(),
    harness: z.string(),
    // The conversation this turn belonged to, so spend can join to a fleet agent. Absent only for an internal
    // one-shot turn that has no conversation identity.
    conversationId: z.string().optional(),
    // The provider's own turn count for the request (a Claude "turn" can be several under the hood), so turns
    // and cost stay comparable across providers. 1 when the provider reported none.
    turns: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
    costUsd: z.number(),
    durationMs: z.number(),
    /* Which arm of the terse experiment this turn ran on (settings.terseHoldout) — the only record of it, and
     * the reason the savings report can say what the steer is worth instead of guessing.
     *
     * ABSENT means "not part of the experiment", not "off": a turn under a custom system prompt drops the
     * steer along with everything else the daemon appends, and a turn run with the experiment switched off has
     * no control to be compared against. Pooling those into the off-arm would compare steered turns against a
     * population selected by something other than the coin flip, which is not a control at all. */
    terse: z.boolean().optional(),
    /* Which arm of the pre-injection experiment this turn ran on (settings.iqContextHoldout), on the same terms
     * as `terse` above: absent ⇒ outside the experiment.
     *
     * TRUE means the turn was ASSIGNED the retrieved context, not that a note was necessarily prepended — a
     * treatment turn whose retrieval came back empty or unconfident injects nothing. That is deliberate: the
     * arms have to be the coin flip's populations, and re-labelling a turn by what retrieval happened to find
     * would sort turns by how searchable their question was, which is a property of the question. The control
     * arm contains the same unsearchable questions in the same proportion, so they cancel. */
    iqContext: z.boolean().optional(),
    /* WHAT ACTUALLY HAPPENED to the retrieval on this turn — the companion to `iqContext`, and the answer to the
     * question that field's design deliberately refuses to answer.
     *
     * Keeping the arm on the coin flip is right, and it costs something: the treatment arm contains turns the
     * treatment never reached, so the delta it yields is diluted by however many those are. Measured over nine
     * days of real use that was four turns in five, which makes the difference between "this mechanism is worth
     * little" and "this mechanism is worth five times what the number says".
     *
     * IT RECORDS THE REASON, not merely a yes/no, because the yes/no left the whole loss unexplained. 81% of an
     * assigned arm delivering nothing is either a gate doing its job or a deadline quietly eating the feature,
     * and those call for opposite responses — one is working as designed, the other is a two-second timeout to
     * raise. A boolean cannot tell them apart, so nothing downstream could act on the number it produced.
     *
     * `note` is delivery; every other value is a turn that ran exactly as the control arm would have, labelled
     * with what took the treatment away. Absent ⇒ outside the experiment, exactly as for the arm. */
    iqContextOutcome: IqContextOutcomeSchema.optional(),
    /* Which arm of the iq SEARCH-TEACHING experiment this conversation runs on
     * (settings.iqSearchHoldout). Stable for every turn in one conversation: the treatment is instruction
     * loaded into a provider session, so flipping it per turn would call a remembered treatment a control.
     * Absent ⇒ measurement is off; true/false ⇒ taught/cold. */
    iqSearchArm: z.boolean().optional(),
    // Hash of the plugin nudge + skill body used for this arm. Control turns carry it too, so a report can keep
    // both sides of one treatment revision together and exclude older wording after an upgrade.
    iqSearchCohort: z.string().optional(),
    /* Wall time spent deciding the pre-turn retrieval outcome, including the full deadline on a timeout.
     * Absent on rows written before latency was recorded or turns outside the retrieval experiment. Keeping it
     * per outcome is what lets the report distinguish a slow engine from an eligibility gate. */
    iqContextDurationMs: z.number().nonnegative().optional(),
    /* Characters of the model's own PROSE this turn — the `delta` frames only, so no tool-call arguments and no
     * thinking. What the terse steer is judged on, and the reason it can be judged at all.
     *
     * `outputTokens` cannot serve: measured over a day of real turns it is 91.6% tool-call arguments (an Edit's
     * old_string and new_string, a Write's whole file body) and 7.8% prose. The steer moves prose. So a fifth
     * off the model's narration moves the total by 1.6% — against a margin of ±35 points, which is to say the
     * experiment was structurally unable to see its own treatment, and the number it printed instead was
     * whichever arm happened to draw the bigger tasks.
     *
     * CHARACTERS, not tokens, because the provider bills a total and never breaks it down — a token figure here
     * would be chars÷4 wearing a unit it had not earned. For a comparison of two arms the constant cancels
     * anyway, and the honest unit is the one actually counted.
     *
     * Absent ⇒ the turn predates this being measured; `armOf` drops it from the population rather than reading
     * it as a silent turn. */
    proseChars: z.number().optional(),
    /* SEARCHES THIS TURN RAN — every tool call that went looking for code, the dedicated search tools and the
     * CLI searches alike (isSearchCall owns the rule; `iq q` is Bash and would otherwise not be counted at all).
     * What pre-injection is judged on, and the same correction `proseChars` is to the terse steer.
     *
     * COST PER TURN CANNOT SERVE, which is what this replaced. Nine days of real use reported +27.0% ± 29.9pp on
     * cost, an interval from −2.9% to +56.9%, and reading it against the transcripts showed the gap was not the
     * mechanism: every raw per-turn outcome moved with it (reads +58%, duration +73%, cache-read tokens +28%)
     * and every one of them was flat to within a point once turn size was divided out. It was the coin flip
     * handing the treatment arm the bigger jobs. Cost is a whole turn's worth of work, and retrieval touches one
     * part of it, so the part lives inside the noise of the rest — exactly the shape that made output tokens
     * unable to see the steer.
     *
     * Searches are what the mechanism acts on directly: a turn handed the anchors up front does not go and find
     * them. Turns that never search stay in the population at zero rather than being filtered out — they dilute
     * both arms equally, while selecting on "did it search" would select on the treatment itself.
     *
     * Absent ⇒ the turn predates this being measured; `armOf` drops it rather than reading it as a turn that
     * searched nothing. */
    searchCalls: z.number().optional(),
    /* …and how many of them came BEFORE the turn first opened or changed a file — the orientation burst, which
     * is the part retrieval is actually aimed at. A turn that already knows where to look starts working; one
     * that doesn't goes hunting first, and pre-injection's whole claim is that it removes that hunt.
     *
     * The narrower of the two readings and the less confounded: `searchCalls` still grows with the size of the
     * job, while the walk up to the first file is roughly the same act whatever the job turns out to be.
     *
     * A turn that never reads or edits counts all of its searches here — it never arrived, so all of it was
     * orientation. Dropping those instead would select the population by an OUTCOME the treatment moves (a turn
     * handed its anchors is likelier to reach a file), which is the one bias an arm-based reading cannot absorb.
     *
     * Absent ⇒ as for `searchCalls`. */
    openingSearches: z.number().optional(),
});
export type UsageTurn = z.infer<typeof UsageTurnSchema>;

// The ledger grouped by day × provider × account × model × harness × conversation — the finest grouping any
// dashboard panel needs, and a handful of rows per active day instead of one per turn, so a year of history is
// well under a MB over the tunnel. Every panel (spend per day, cost by model, cost by agent, cache hit rate) is
// a projection of these.
// The conversation is in the KEY, not merely along for the ride, because cost-by-agent has to answer within the
// same window as every other panel on the screen. The fleet registry also carries a per-agent total, but only a
// cumulative, all-time one — reading it beside a "last 7 days" filter would print an all-time number under a
// windowed heading, which is the shrinking-totals bug wearing a different hat.
export const UsageRollupRowSchema = z.object({
    day: z.string(),
    provider: z.string(),
    account: z.string().optional(),
    model: z.string().optional(),
    harness: z.string(),
    conversationId: z.string().optional(),
    turns: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
    costUsd: z.number(),
    durationMs: z.number(),
});
export type UsageRollupRow = z.infer<typeof UsageRollupRowSchema>;
// Inclusive UTC day bounds (YYYY-MM-DD). Both absent ⇒ the whole ledger. Shared by every windowed read of a
// daemon ledger (spend, savings): one window shape, so a screen that filters two ledgers at once filters them
// with the same calendar.
export const DayWindowQuerySchema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
});
export type DayWindowQuery = z.infer<typeof DayWindowQuerySchema>;
export const UsageRollupSchema = z.object({ rows: z.array(UsageRollupRowSchema) });

// ---- usage: per-account token/cost totals ----
// The account picker's headroom readout, folded from the ledger above (all-time, not a log window), grouped by
// provider+account. `account` is the attribution key, so env-token turns are excluded rather than pooled under
// a blank id — an unattributed turn belongs to no account's total.
export const UsageAccountSchema = z.object({
    provider: z.string(),
    account: z.string(),
    turns: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
    costUsd: z.number(),
});
export type UsageAccount = z.infer<typeof UsageAccountSchema>;
export const UsageSummarySchema = z.object({ accounts: z.array(UsageAccountSchema) });

// ---- logs: daemon-owned debug logs (historyRoot/logs) ----
// Terminal pipe-pane captures (terminals/), intentic CLI run logs (intentic-runs/), and the daemon's own pino
// file (daemon.log) — written by the daemon/tmux only, under historyRoot so the agent can't rewrite them.

export const LogFileEntrySchema = z.object({
    // Path relative to the logs root, e.g. "terminals/web-1-%0.log" or "daemon.log".
    name: z.string(),
    sizeBytes: z.number(),
    // Epoch ms mtime.
    modifiedAt: z.number(),
});
export type LogFileEntry = z.infer<typeof LogFileEntrySchema>;
export const LogsListSchema = z.object({ files: z.array(LogFileEntrySchema) });

// `name` rides the query (log names contain slashes, which don't fit a path segment); `bytes` is the tail
// size — the newest bytes win when the file is larger.
export const LogReadQuerySchema = z.object({
    name: z.string().min(1),
    bytes: z.coerce.number().min(1).max(1_048_576).default(65_536),
});
export const LogReadSchema = z.object({
    name: z.string(),
    sizeBytes: z.number(),
    // The tail text; truncated when the file holds more than the requested bytes.
    text: z.string(),
    truncated: z.boolean(),
});
export type LogRead = z.infer<typeof LogReadSchema>;

// A tab's self-report of what it is looking at, keyed by its /events connection's clientId. Full replace,
// not a merge — an absent field means "cleared", so a tab leaving a file drops the path with the same report.
export const PresenceReportSchema = z.object({
    clientId: z.string(),
    idle: z.boolean(),
    view: z.string().optional(),
    sessionId: z.string().optional(),
    path: z.string().optional(),
});
export type PresenceReport = z.infer<typeof PresenceReportSchema>;

// ---- push: web-push notifications to the owner's devices ----
// The daemon is the only tier that knows what the agent is doing, so it is the sender. Subscriptions are
// per-BROWSER (the endpoint is minted by that browser's push service — Google's, Mozilla's, Apple's), which
// is why they live here and not on the platform: the platform is off the command path and would have to be
// told about every turn to be useful.

// A browser's PushSubscription, in the exact shape `web-push` consumes — the browser produces it via
// PushManager.subscribe() and the client posts it back verbatim, so the daemon never reshapes it.
export const PushSubscriptionSchema = z.object({
    endpoint: z.url(),
    keys: z.object({
        // The client's public key and auth secret for payload encryption (RFC 8291). Opaque base64url here.
        p256dh: z.string().min(1),
        auth: z.string().min(1),
    }),
});
export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;

// What the service worker renders. `url` is the in-app route the notification opens (the click handler
// focuses an existing tab there rather than spawning a new one); `tag` collapses repeats — a second
// "waiting on you" for the same conversation REPLACES the first instead of stacking. Push payloads are
// capped by the push services themselves (~4KB after encryption), which is why nothing here carries a
// transcript or a diff — the notification is a pointer back into the workspace, not a delivery mechanism
// for content.
export const PushNotificationSchema = z.object({
    title: z.string().min(1),
    body: z.string(),
    url: z.string().optional(),
    tag: z.string().optional(),
    // Whether the notification stays on screen until dismissed. Set for the "agent is blocked on you" cases,
    // where a notification that auto-dismisses is a request that silently went unanswered.
    requireInteraction: z.boolean().optional(),
});
export type PushNotification = z.infer<typeof PushNotificationSchema>;

// The VAPID public key a browser needs to subscribe, plus whether this browser's endpoint is already known —
// so the settings toggle can render its true state instead of trusting the browser's permission alone (a
// granted permission with no server-side row would notify nothing).
export const PushConfigSchema = z.object({ publicKey: z.string(), subscribed: z.boolean() });
export const PushEndpointSchema = z.object({ endpoint: z.url() });
// The optional `endpoint` says WHICH browser is asking; without it `subscribed` could only speak for the
// sandbox as a whole, which is never the question the settings toggle needs answered.
export const PushConfigQuerySchema = z.object({ endpoint: z.url().optional() });

// What a test send actually achieved. `{ ok: true }` would be a lie the one place it matters most: the button
// exists to prove a chain the user cannot inspect, so "the daemon accepted the request" is not the answer to
// the question being asked. A count separates "your OS swallowed it" from "nothing was sent at all".
export const PushTestSchema = z.object({ delivered: z.number().int().nonnegative() });
export type PushTest = z.infer<typeof PushTestSchema>;

// ---- maintenance: the standing evidence a chore is decided from ----

/* THE DAEMON SERVES FACTS; THE BROWSER DECIDES. Everything below is measurement — what a tool reported, what the
 * manifests say, when a chore last ran. Not one field here says "you should do something", and that is the whole
 * boundary: which chore is DUE is computed by @intentic/sandbox-contract/chores, which both the Maintenance view and its rail
 * badge run, so the number on the tile and the reason in the panel can never disagree. Put the verdict on the wire
 * instead and a daemon one image behind would be quietly arguing with the browser about what needs doing.
 *
 * The split inside the evidence is by COST, not by subject:
 *   probes   subprocesses (pnpm outdated, pnpm audit, knip, jscpd) — minutes, so they are cached on disk with a
 *            TTL and refreshed by a background runner. A route hit never waits on one.
 *   signals  things the daemon already knows — the resident iq index's health ranking, the package manifests it
 *            reads for the dependency graph, its own node version. Recomputed per request; all of it is cheap. */

export const PROBE_IDS = ["outdated", "audit", "knip", "jscpd", "ui", "bundle"] as const;
export const ProbeIdSchema = z.enum(PROBE_IDS);
export type ProbeId = z.infer<typeof ProbeIdSchema>;

// One dependency the registry has moved past. `kind` is the SEMVER distance, which is the whole reason this is
// not one number: forty patch releases behind is a morning's work and one major is a project.
export const OutdatedPackageSchema = z.object({
    name: z.string(),
    current: z.string(),
    latest: z.string(),
    kind: z.enum(["major", "minor", "patch"]),
    // "dependencies" / "devDependencies" / "optionalDependencies" — a dev-only major is a different risk.
    section: z.string(),
});
export type OutdatedPackage = z.infer<typeof OutdatedPackageSchema>;

// One advisory, reduced to what a decision needs. No CVSS vector and no reference list: those are for reading on
// the advisory page, and carrying them would put a kilobyte of prose per finding on every poll of this route.
export const AdvisorySchema = z.object({
    name: z.string(),
    severity: z.enum(["critical", "high", "moderate", "low", "info"]),
    title: z.string(),
    // The range that fixes it, when the advisory names one. Absent ⇒ no patch published yet, which is the case
    // where a chore must NOT offer to bump and say so instead.
    patched: z.string().optional(),
    // Whether it reaches a production dependency path. A build-time-only tool's transitive CVE is a different
    // problem, and the chore's prompt says so rather than treating every advisory alike.
    dev: z.boolean(),
});
export type Advisory = z.infer<typeof AdvisorySchema>;

// knip's counts, by the kind of thing it found unreachable. Counts plus a sample rather than the full list: the
// agent re-runs knip itself against the live tree (a list from a probe hours old would send it at files that are
// already gone), so what travels here only has to be enough to decide whether the turn is worth starting.
export const DeadCodeSchema = z.object({
    files: z.number().int().nonnegative(),
    exports: z.number().int().nonnegative(),
    types: z.number().int().nonnegative(),
    dependencies: z.number().int().nonnegative(),
    devDependencies: z.number().int().nonnegative(),
    // A handful of the unreferenced files, for the panel to show instead of asking the reader to take "31" on faith.
    sample: z.array(z.string()),
});
export type DeadCode = z.infer<typeof DeadCodeSchema>;

// jscpd's headline plus the biggest clones. `percentage` is of scanned lines, which is the figure a threshold is
// worth setting against — a clone COUNT grows with the repo and would mean something different every quarter.
export const DuplicationSchema = z.object({
    percentage: z.number(),
    clones: z.number().int().nonnegative(),
    top: z.array(z.object({ lines: z.number().int().nonnegative(), first: z.string(), second: z.string() })),
});
export type Duplication = z.infer<typeof DuplicationSchema>;

/* ONE SWEEP OF THE UI SOURCE, serving three chores. Component files, Tailwind classes that hard-code a value, and
 * files still on a replaced framework idiom are three questions about the same tree, and asking them in three
 * probes would walk it three times for nothing.
 *
 * Counts per FILE rather than the matched text. A reader deciding whether to open something is served better by
 * "Checkout.vue · 11 hard-coded values" than by eleven class attributes, and a file path is an identity a digest
 * can be built from while a class string is not. */
export const UiScanSchema = z.object({
    // Framework-shaped source files — tests, stories and generated output excluded. The inventory that makes a
    // duplication finding a COMPONENT duplication finding rather than a generic one.
    components: z.array(z.string()),
    // Where the design system was routed around, and how often in each file.
    bypasses: z.array(z.object({ path: z.string(), count: z.number().int().positive() })),
    // Files still on an idiom their framework has replaced, grouped by which one. `id` is looked up in the stack
    // table rather than enumerated here: the rules are a product decision that ships with the browser, and a
    // daemon an image behind must be able to report one this schema has never heard of.
    idioms: z.array(z.object({ id: z.string(), files: z.array(z.string()) })),
});
export type UiScan = z.infer<typeof UiScanSchema>;

/* WHAT THE LAST BUILD ACTUALLY PRODUCED. Measured from the build output already on disk, never by running the
 * build: a maintenance probe that mutates the owner's working tree — and `dist/` appearing in their `git status`
 * is exactly that — is a worse surprise than a measurement that is sometimes a commit behind. It also means this
 * never needs the env vars, secrets or network a real production build would.
 *
 * Gzip alongside raw because gzip is what crosses the wire, and the ratio between them is the difference between
 * "this chunk is big" and "this chunk is big and incompressible", which are different problems. */
export const BundleSchema = z.object({
    // Which directory was measured, so the panel can say what it is talking about rather than implying it built.
    dir: z.string(),
    totalBytes: z.number().int().nonnegative(),
    totalGzip: z.number().int().nonnegative(),
    assets: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), gzip: z.number().int().nonnegative() })),
});
export type Bundle = z.infer<typeof BundleSchema>;

/* One probe's cached result. The three states are deliberately distinct, because a panel that collapses them
 * lies about the most important case:
 *   ok           the tool ran and reported. `facts` carries its findings — including "nothing found", which is
 *                a real answer and the one that keeps a chore quiet.
 *   unavailable  the tool is not part of this repo (knip is not a devDependency, there is no lockfile to audit).
 *                Not a failure and not evidence of health: the chore renders as unmeasured, and can never badge.
 *   failed       the tool ran and broke — a network-less audit, a jscpd that ran out of memory. Says so, with
 *                the tail of what it printed, rather than reading as "clean".
 * Merging `unavailable` into `ok`-with-zeros is how a maintenance surface ends up reporting a green repository
 * it has never actually measured. */
export const ProbeStateSchema = z.enum(["ok", "unavailable", "failed"]);
export type ProbeState = z.infer<typeof ProbeStateSchema>;

// The findings, discriminated by which probe produced them. Absent while the probe has never completed, and on
// `unavailable`/`failed` — a reader must go through `state` to reach facts, so there is no shape in which a
// missing measurement can be mistaken for a zero.
export const ProbeFactsSchema = z.discriminatedUnion("id", [
    z.object({ id: z.literal("outdated"), packages: z.array(OutdatedPackageSchema) }),
    z.object({ id: z.literal("audit"), advisories: z.array(AdvisorySchema) }),
    z.object({ id: z.literal("knip"), deadCode: DeadCodeSchema }),
    z.object({ id: z.literal("jscpd"), duplication: DuplicationSchema }),
    z.object({ id: z.literal("ui"), scan: UiScanSchema }),
    z.object({ id: z.literal("bundle"), bundle: BundleSchema }),
]);
export type ProbeFacts = z.infer<typeof ProbeFactsSchema>;

export const ProbeResultSchema = z.object({
    id: ProbeIdSchema,
    state: ProbeStateSchema,
    // When the probe last COMPLETED — the age the panel shows, and what the runner's TTL is measured from.
    ranAt: z.number(),
    // How long it took. Shown because a seven-minute jscpd is why the tier-2 refresh is weekly, and a reader
    // deciding whether to force a refresh deserves to know what they are asking for.
    tookMs: z.number().int().nonnegative(),
    facts: ProbeFactsSchema.optional(),
    // On `failed`, how it broke — a bounded quote of the tool's own output, never a summary of it. On
    // `unavailable`, what is missing, in the probe spec's own words ("no lockfile"): there is no tool output to
    // quote when the tool never ran, and the alternative — a sentence built from the probe's name — would have an
    // unmeasured probe claiming there is nothing to measure.
    reason: z.string().optional(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

// One workspace package as its manifest declares it — what the daemon already reads to build the dependency
// graph, carried through so chores can reason about the repo's own shape without a probe. `documented` is the
// one derived field: whether <dir>/README.md exists, a stat per package. A package's architecture document IS
// its README in this workspace, which is what makes that a stat on the package itself rather than a lookup.
export const ChorePackageSchema = z.object({
    dir: z.string(),
    name: z.string(),
    // The manifest's `engines` map, verbatim — the runtime chore compares it against what the daemon is running.
    engines: z.record(z.string(), z.string()).optional(),
    dependencies: z.array(z.string()),
    devDependencies: z.array(z.string()),
    documented: z.boolean(),
});
export type ChorePackage = z.infer<typeof ChorePackageSchema>;

/* The cheap half of the evidence: what the daemon knows without starting anything. `hotspots` and `keyModules`
 * are the same rankings GET /workspace/health serves, capped tighter — a chore only ever asks whether a file has
 * ENTERED the top of the ranking, so a leaderboard is enough and a full report per repo per poll is not. */
/* WHAT THIS REPOSITORY IS MADE OF — the facts that decide whether a chore is a QUESTION worth asking of it at
 * all, as opposed to whether the answer happens to be yes.
 *
 * The distinction is the difference between a maintenance surface that reads as attentive and one that reads as
 * generic. "Re-read the documentation against the code" in a repository with no documentation is not a chore
 * that is currently clear — it is a chore that will never make sense here, and showing it teaches the owner that
 * this list was written by someone who had not looked. Same for a Docker chore with no Dockerfile, or a CI chore
 * with no pipeline.
 *
 * These are all paths, deliberately: presence of a FILE is checkable, cheap, and cannot be argued with, which is
 * the same evidence-over-identity rule the extension activation facts follow. Every field is a list rather than a
 * boolean where the paths themselves are worth showing — a chore that says "not applicable: no Dockerfile" is
 * useful, and one that says "3 Dockerfiles: ./Dockerfile, _editor/web/Dockerfile, …" is more so. */
export const ChoreShapeSchema = z.object({
    // The repository MAP, when one exists (docs/architecture/*.md), capped — the count is what matters, and the
    // drift survey needs to know there is something to re-read. Package pages are READMEs and are counted per
    // package by `ChorePackage.documented`; a repo with a map has been through the documentation flow at all,
    // which is the question this gate actually asks.
    docs: z.array(z.string()),
    dockerfiles: z.array(z.string()),
    // CI pipeline definitions: .github/workflows/*.yml, .gitlab-ci.yml, and the other single-file conventions.
    ci: z.array(z.string()),
    // Whether dependencies are resolved to a lockfile — what makes an audit mean anything.
    lockfile: z.boolean(),
    // A package.json at the repo root. The gate for every chore whose subject is the JavaScript dependency tree:
    // a Rust or Go repository has no majors to be behind on and no engines field to be pinned by, and offering it
    // those chores would be this surface guessing at what it is looking at.
    packageManifest: z.boolean(),
    /* EVERY DEPENDENCY NAME DECLARED ANYWHERE IN THE REPO — the root manifest's blocks unioned with every
     * workspace package's, sorted and deduplicated.
     *
     * It is here rather than derived from `packages` because `packages` is EMPTY for a repository that is not a
     * pnpm workspace, and the repositories these names exist to recognise — a Vite app, a Next app, an Angular
     * CLI project — are overwhelmingly single-package. A framework gate built on `packages` would be dark in
     * exactly the repositories it was written for, silently, which is the worst way for a gate to be wrong.
     *
     * NAMES, not a `framework: "react"` verdict. Which names amount to "this is a React app" is a product
     * decision, and product decisions live in the chore book that ships with the browser — a daemon baked into an
     * image months ago must not be the thing that decides Svelte is not a UI framework. */
    deps: z.array(z.string()),
});
export type ChoreShape = z.infer<typeof ChoreShapeSchema>;

export const ChoreSignalsSchema = z.object({
    packages: z.array(ChorePackageSchema),
    shape: ChoreShapeSchema,
    hotspots: z.array(WorkspaceHotspotSchema),
    keyModules: z.array(WorkspaceKeyModuleSchema),
    totals: z.object({ files: z.number(), symbols: z.number(), complexity: z.number(), hotspots: z.number() }),
    // Whether the index these rankings came from is current. A chore must not fire on a half-built index, and
    // this is how the browser knows to hold its verdict rather than act on a partial ranking.
    indexed: z.boolean(),
});
export type ChoreSignals = z.infer<typeof ChoreSignalsSchema>;

// What a finished chore turn left behind — written by the agent, read back to decide whether the chore is still
// due. `clean` is the load-bearing one: an agent that looked and found the tool's findings to be false positives
// must be able to say so, or the next poll starts the same turn again forever.
export const ChoreOutcomeSchema = z.enum(["acted", "reported", "clean"]);
export type ChoreOutcome = z.infer<typeof ChoreOutcomeSchema>;

/* One chore's history in one repo. The DIGEST is what makes this a debounce rather than a suppression: it is a
 * hash of the evidence that was standing when the turn ran, so a chore whose evidence has since changed is due
 * again on its own merits while one whose evidence is unchanged stays quiet — with the run still visible in the
 * panel, saying when it ran and what it concluded. Nothing here can hide a chore from the view; it only decides
 * whether the rail is allowed to speak. */
export const ChoreLedgerEntrySchema = z.object({
    repo: z.string(),
    chore: z.string(),
    ranAt: z.number(),
    runId: z.string(),
    outcome: ChoreOutcomeSchema,
    digest: z.string(),
    // Set by the owner from the panel — the chore stays visible and stays out of the badge until this passes.
    // Distinct from opting out, which is the absence of the chore from `enabled` in the sandbox's settings.
    snoozedUntil: z.number().optional(),
});
export type ChoreLedgerEntry = z.infer<typeof ChoreLedgerEntrySchema>;

/* A measurement that is HAPPENING, as opposed to one that has happened. The probe cache can only ever describe
 * finished work — `ranAt` is the completion stamp — so a surface reading it alone has no way to say "we are
 * measuring this right now", and the panel's re-measure button spent its whole life looking like it did nothing:
 * the request is an ack, the sweep takes minutes, and every visible fact on the row went on describing the
 * measurement it was replacing.
 *
 * `startedAt` is when the probe actually began, absent while it is still waiting behind another one — the runner
 * has ONE lane across the whole sandbox, so "queued" is a real and common state, and a reader told "measuring"
 * about a probe that has not started is being lied to about how long it has left. */
export const RunningProbeSchema = z.object({
    repo: z.string(),
    id: ProbeIdSchema,
    // When this was asked for. Always present, so a waiting probe can still say how long it has been waiting.
    askedAt: z.number(),
    startedAt: z.number().optional(),
});
export type RunningProbe = z.infer<typeof RunningProbeSchema>;

// GET /chores — every discovered repo's standing evidence, plus the ledger, in one read. One route rather than
// one per repo because the rail badge scans ALL of them on a timer, and N requests a minute to answer "is
// anything due" is the kind of poll that shows up in a battery graph.
export const ChoresReportSchema = z.object({
    repos: z.array(z.object({ repo: z.string(), probes: z.array(ProbeResultSchema), signals: ChoreSignalsSchema })),
    ledger: z.array(ChoreLedgerEntrySchema),
    // What the runner is measuring and what is waiting behind it, right now. Part of the standing read rather
    // than a route of its own: it is the same question ("what does this repo currently say") asked about work in
    // flight, and a panel that had to ask twice would show the two halves disagreeing.
    running: z.array(RunningProbeSchema),
    // The daemon's own runtime, for the chore that asks whether this sandbox is running something end-of-life.
    // Read off the process rather than a manifest: what is INSTALLED is the fact that matters, and an `engines`
    // range is a wish.
    node: z.string(),
});
export type ChoresReport = z.infer<typeof ChoresReportSchema>;

// POST /chores/probe — force one probe to re-run now, ahead of its TTL. Returns immediately; the runner does the
// work and the next GET /chores carries the result, the same shape the panel already polls.
export const ChoreProbeRequestSchema = z.object({ repo: z.string().min(1), id: ProbeIdSchema });
// POST /chores/ledger — record a run, or snooze. Written daemon-side rather than by the browser so a chore turn
// started from anywhere (the panel, an automation, the agent itself) lands in one ledger.
export const ChoreLedgerWriteSchema = ChoreLedgerEntrySchema;

/* One publishability check and what it found. `warn` is a real third state, not a soft failure: the permissions
 * check has nothing to say about an extension nobody has exercised yet, and reporting that as a pass would be
 * the check lying at the exact moment it matters most. */
export const ReadinessCheckSchema = z.object({
    id: z.string(),
    label: z.string(),
    status: z.enum(["pass", "warn", "fail"]),
    detail: z.string(),
});
export const ExtensionReadinessSchema = z.object({ checks: z.array(ReadinessCheckSchema) });
